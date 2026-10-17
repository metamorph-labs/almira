use crate::error::{ApiError, Error, client_error, invalid_input, invalid_response};
use crate::types::{
    BinaryResponse, CollectionReference, CustomMetadataValue, DerivativeReference, FileEntry,
    FileEntryPage, FileMetadataFilter, FileReference, ImmutableGenerationReference,
    ListFilesOptions, MediaDerivative, ReadOptions, SearchInput, SearchPage,
};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, HeaderMap,
    HeaderValue, IF_NONE_MATCH, ORIGIN, RANGE, RETRY_AFTER,
};
use reqwest::{Method, StatusCode, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
enum Capability {
    Token(String),
    Provider(Arc<dyn Fn() -> Option<String> + Send + Sync>),
}

pub struct ClientOptions {
    base_url: String,
    capability: Option<Capability>,
    origin: Option<String>,
    timeout: Duration,
    retry: RetryPolicy,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RetryPolicy {
    pub max_attempts: u8,
    pub base_delay: Duration,
    pub maximum_delay: Duration,
}

impl RetryPolicy {
    #[must_use]
    pub const fn new(max_attempts: u8, base_delay: Duration, maximum_delay: Duration) -> Self {
        Self {
            max_attempts,
            base_delay,
            maximum_delay,
        }
    }
}

impl ClientOptions {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            capability: None,
            origin: None,
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::new(1, Duration::from_millis(100), Duration::from_secs(2)),
        }
    }

    pub fn capability(mut self, token: impl Into<String>) -> Self {
        self.capability = Some(Capability::Token(token.into()));
        self
    }

    pub fn capability_provider(
        mut self,
        provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        self.capability = Some(Capability::Provider(provider));
        self
    }

    pub fn origin(mut self, origin: impl Into<String>) -> Self {
        self.origin = Some(origin.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn retry(mut self, retry: RetryPolicy) -> Self {
        self.retry = retry;
        self
    }
}

#[derive(Clone)]
pub struct Client {
    base_url: Url,
    capability: Option<Capability>,
    origin: Option<HeaderValue>,
    http: reqwest::Client,
    retry: RetryPolicy,
}

impl Client {
    pub fn new(options: ClientOptions) -> Result<Self, Error> {
        let base_url = endpoint(&options.base_url, false)?;
        let origin = match options.origin {
            Some(origin) => {
                endpoint(&origin, true)?;
                Some(HeaderValue::from_str(&origin).map_err(|_| invalid_input())?)
            }
            None => None,
        };
        if options.timeout.is_zero() || options.timeout > Duration::from_secs(300) {
            return Err(invalid_input());
        }
        if options.retry.max_attempts == 0
            || options.retry.max_attempts > 5
            || options.retry.base_delay > Duration::from_secs(10)
            || options.retry.maximum_delay < options.retry.base_delay
            || options.retry.maximum_delay > Duration::from_secs(60)
        {
            return Err(invalid_input());
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(options.timeout)
            .build()
            .map_err(|_| invalid_input())?;
        Ok(Self {
            base_url,
            capability: options.capability,
            origin,
            http,
            retry: options.retry,
        })
    }

    pub async fn list_files_with_capability(
        &self,
        reference: &CollectionReference,
        options: &ListFilesOptions,
    ) -> Result<FileEntryPage, Error> {
        validate_list_options(options)?;
        let mut url = self.url(&collection_path(reference, "/files")?)?;
        {
            let mut query = url.query_pairs_mut();
            if let Some(value) = options.limit {
                query.append_pair("limit", &value.to_string());
            }
            append_option(&mut query, "cursor", options.cursor.as_deref());
            append_option(&mut query, "path_prefix", options.path_prefix.as_deref());
            append_option(&mut query, "tag", options.tag.as_deref());
            append_option(&mut query, "metadata_key", options.metadata_key.as_deref());
            if let Some(value) = &options.metadata_value {
                let value = serde_json::to_string(value).map_err(|_| invalid_input())?;
                query.append_pair("metadata_value", &value);
            }
            append_option(
                &mut query,
                "verified_media_type",
                options.verified_media_type.as_deref(),
            );
            if let Some(value) = options.minimum_size_bytes {
                query.append_pair("minimum_size_bytes", &value.to_string());
            }
            if let Some(value) = options.maximum_size_bytes {
                query.append_pair("maximum_size_bytes", &value.to_string());
            }
            append_option(
                &mut query,
                "created_after",
                options.created_after.as_deref(),
            );
            append_option(
                &mut query,
                "created_before",
                options.created_before.as_deref(),
            );
            append_option(
                &mut query,
                "extraction_kind",
                options.extraction_kind.as_deref(),
            );
            append_option(
                &mut query,
                "extraction_state",
                options.extraction_state.as_deref(),
            );
        }
        self.json(Method::GET, url, None).await
    }

    pub async fn search_files_with_capability(
        &self,
        reference: &CollectionReference,
        input: &SearchInput,
    ) -> Result<SearchPage, Error> {
        validate_search(input)?;
        let body = serde_json::to_vec(input).map_err(|_| invalid_input())?;
        let url = self.url(&collection_path(reference, "/search")?)?;
        self.json(Method::POST, url, Some(body)).await
    }

    pub async fn get_file_metadata_with_capability(
        &self,
        reference: &FileReference,
    ) -> Result<FileEntry, Error> {
        let path = format!(
            "{}/{}",
            collection_path(&reference.collection, "/files")?,
            uuid(&reference.entry_id)?
        );
        self.json(Method::GET, self.url(&path)?, None).await
    }

    pub async fn list_derivatives_with_capability(
        &self,
        reference: &ImmutableGenerationReference,
    ) -> Result<Vec<MediaDerivative>, Error> {
        let path = format!("{}/derivatives", generation_data_path(reference)?);
        self.json(Method::GET, self.url(&path)?, None).await
    }

    pub async fn read_immutable_generation(
        &self,
        reference: &ImmutableGenerationReference,
        options: &ReadOptions,
    ) -> Result<BinaryResponse, Error> {
        self.bytes(
            self.url(&delivery_path(reference)?)?,
            options,
            CapabilityMode::Optional,
        )
        .await
    }

    pub async fn read_derivative(
        &self,
        reference: &DerivativeReference,
        options: &ReadOptions,
    ) -> Result<BinaryResponse, Error> {
        let path = format!(
            "{}/variants/{}",
            delivery_path(&reference.generation)?,
            variant(&reference.variant_key)?
        );
        self.bytes(self.url(&path)?, options, CapabilityMode::Optional)
            .await
    }

    pub async fn read_share(
        &self,
        share_token: &str,
        options: &ReadOptions,
    ) -> Result<BinaryResponse, Error> {
        if !valid_share_token(share_token) {
            return Err(invalid_input());
        }
        self.bytes(
            self.url(&format!("/v1/shares/{share_token}"))?,
            options,
            CapabilityMode::Forbidden,
        )
        .await
    }

    async fn json<T: DeserializeOwned>(
        &self,
        method: Method,
        url: Url,
        body: Option<Vec<u8>>,
    ) -> Result<T, Error> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        if body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let response = self
            .request(method, url, headers, body, CapabilityMode::Required)
            .await?;
        if !response.status().is_success() {
            return Err(api_error(response).await);
        }
        let content_type = header(&response, CONTENT_TYPE);
        if content_type
            .as_deref()
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            != Some("application/json")
        {
            return Err(invalid_response());
        }
        let body = bounded_body(response, 2 * 1024 * 1024).await?;
        serde_json::from_slice(&body).map_err(|_| invalid_response())
    }

    async fn bytes(
        &self,
        url: Url,
        options: &ReadOptions,
        mode: CapabilityMode,
    ) -> Result<BinaryResponse, Error> {
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/octet-stream"));
        if let Some(value) = &options.range {
            if value.len() > 64 || !valid_byte_range(value) {
                return Err(invalid_input());
            }
            headers.insert(
                RANGE,
                HeaderValue::from_str(value).map_err(|_| invalid_input())?,
            );
        }
        if let Some(value) = &options.if_none_match {
            if value.is_empty() || value.len() > 512 || value.contains('\r') || value.contains('\n')
            {
                return Err(invalid_input());
            }
            headers.insert(
                IF_NONE_MATCH,
                HeaderValue::from_str(value).map_err(|_| invalid_input())?,
            );
        }
        let response = self.request(Method::GET, url, headers, None, mode).await?;
        if !matches!(
            response.status(),
            StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::NOT_MODIFIED
        ) {
            return Err(api_error(response).await);
        }
        Ok(BinaryResponse {
            status: response.status().as_u16(),
            content_length: header(&response, CONTENT_LENGTH).and_then(|value| safe_length(&value)),
            content_range: header(&response, CONTENT_RANGE),
            content_type: header(&response, CONTENT_TYPE),
            etag: header(&response, ETAG),
            response,
        })
    }

    async fn request(
        &self,
        method: Method,
        url: Url,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
        mode: CapabilityMode,
    ) -> Result<reqwest::Response, Error> {
        for attempt in 1..=self.retry.max_attempts {
            let mut request_headers = headers.clone();
            if mode != CapabilityMode::Forbidden {
                if let Some(origin) = &self.origin {
                    request_headers.insert(ORIGIN, origin.clone());
                }
                let capability = match &self.capability {
                    Some(Capability::Token(value)) => Some(value.clone()),
                    Some(Capability::Provider(provider)) => Some(
                        provider()
                            .ok_or_else(|| client_error("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"))?,
                    ),
                    None => None,
                };
                if let Some(capability) = capability {
                    if !valid_capability(&capability) {
                        return Err(invalid_input());
                    }
                    request_headers.insert(
                        AUTHORIZATION,
                        HeaderValue::from_str(&format!("Bearer {capability}"))
                            .map_err(|_| invalid_input())?,
                    );
                } else if mode == CapabilityMode::Required {
                    return Err(invalid_input());
                }
            }
            let mut request = self
                .http
                .request(method.clone(), url.clone())
                .headers(request_headers);
            if let Some(body) = body.clone() {
                request = request.body(body);
            }
            match request.send().await {
                Ok(response)
                    if attempt < self.retry.max_attempts && retryable_status(response.status()) =>
                {
                    let retry_after_seconds =
                        header(&response, RETRY_AFTER).and_then(|value| retry_after(&value));
                    drop(response);
                    tokio::time::sleep(retry_delay(self.retry, attempt, retry_after_seconds)).await;
                }
                Ok(response) => return Ok(response),
                Err(_) if attempt < self.retry.max_attempts => {
                    tokio::time::sleep(retry_delay(self.retry, attempt, None)).await;
                }
                Err(_) => return Err(client_error("ALMIRA_CLIENT_NETWORK")),
            }
        }
        Err(client_error("ALMIRA_CLIENT_NETWORK"))
    }

    fn url(&self, path: &str) -> Result<Url, Error> {
        let mut url = self.base_url.clone();
        url.set_path(path);
        url.set_query(None);
        url.set_fragment(None);
        Ok(url)
    }
}

fn retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::TOO_MANY_REQUESTS
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn retry_delay(
    policy: RetryPolicy,
    failed_attempt: u8,
    retry_after_seconds: Option<u32>,
) -> Duration {
    retry_after_seconds.map_or_else(
        || {
            policy
                .base_delay
                .saturating_mul(1_u32 << u32::from(failed_attempt.saturating_sub(1)))
                .min(policy.maximum_delay)
        },
        |seconds| Duration::from_secs(u64::from(seconds)).min(policy.maximum_delay),
    )
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CapabilityMode {
    Required,
    Optional,
    Forbidden,
}

pub(crate) async fn bounded_body(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| client_error("ALMIRA_CLIENT_NETWORK"))?
    {
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(invalid_response());
        }
        body.extend_from_slice(&chunk);
    }
    if body.is_empty() {
        return Err(invalid_response());
    }
    Ok(body)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApiErrorBody {
    code: String,
    request_id: String,
}

pub(crate) async fn api_error(response: reqwest::Response) -> Error {
    let status = response.status().as_u16();
    let retry_after_seconds = header(&response, RETRY_AFTER).and_then(|value| retry_after(&value));
    let body = match bounded_body(response, 64 * 1024).await {
        Ok(body) => body,
        Err(error) => return error,
    };
    let value: ApiErrorBody = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return invalid_response(),
    };
    if !valid_api_code(&value.code) || !valid_uuid_v7(&value.request_id) {
        return invalid_response();
    }
    Error::Api(ApiError {
        code: value.code,
        request_id: value.request_id,
        status,
        retry_after_seconds,
    })
}

fn validate_list_options(options: &ListFilesOptions) -> Result<(), Error> {
    if options.limit == Some(0)
        || options.limit.is_some_and(|value| value > 100)
        || options
            .cursor
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 2048)
        || options
            .path_prefix
            .as_ref()
            .is_some_and(|value| !valid_logical_path(value))
    {
        return Err(invalid_input());
    }
    validate_filter(&FileMetadataFilter {
        tag: options.tag.clone(),
        metadata_key: options.metadata_key.clone(),
        metadata_value: options.metadata_value.clone(),
        verified_media_type: options.verified_media_type.clone(),
        minimum_size_bytes: options.minimum_size_bytes,
        maximum_size_bytes: options.maximum_size_bytes,
        created_after: options.created_after.clone(),
        created_before: options.created_before.clone(),
        extraction_kind: options.extraction_kind.clone(),
        extraction_state: options.extraction_state.clone(),
    })
}

fn validate_search(input: &SearchInput) -> Result<(), Error> {
    if input.query.is_empty()
        || input.query.trim() != input.query
        || input.query.len() > 1024
        || has_control(&input.query)
        || input
            .mode
            .as_ref()
            .is_some_and(|value| !matches!(value.as_str(), "lexical" | "semantic" | "hybrid"))
        || input
            .path_prefix
            .as_ref()
            .is_some_and(|value| !valid_logical_path(value))
        || input.page_size == Some(0)
        || input.page_size.is_some_and(|value| value > 50)
        || input
            .cursor
            .as_ref()
            .is_some_and(|value| value.is_empty() || value.len() > 8192)
    {
        return Err(invalid_input());
    }
    if let Some(facets) = &input.facets {
        let unique = facets.iter().collect::<BTreeSet<_>>();
        if facets.len() > 8
            || facets.len() != unique.len()
            || facets.iter().any(|value| !valid_facet(value))
        {
            return Err(invalid_input());
        }
    }
    if let Some(filter) = &input.filter {
        validate_filter(filter)?;
    }
    Ok(())
}

fn validate_filter(filter: &FileMetadataFilter) -> Result<(), Error> {
    if filter.tag.as_ref().is_some_and(|value| !valid_metadata_name(value))
        || filter.metadata_key.as_ref().is_some_and(|value| !valid_metadata_name(value))
        || filter.metadata_key.is_some() != filter.metadata_value.is_some()
        || filter.metadata_value.as_ref().is_some_and(|value| {
            matches!(value, CustomMetadataValue::String(text) if text.is_empty() || text.chars().count() > 512)
        })
        || filter.verified_media_type.as_ref().is_some_and(|value| !valid_media_type(value))
        || filter.minimum_size_bytes.is_some_and(|value| value == 0 || value > 10_737_418_240)
        || filter.maximum_size_bytes.is_some_and(|value| value == 0 || value > 10_737_418_240)
        || matches!((filter.minimum_size_bytes, filter.maximum_size_bytes), (Some(minimum), Some(maximum)) if minimum > maximum)
        || filter.created_after.as_ref().is_some_and(|value| !valid_timestamp(value))
        || filter.created_before.as_ref().is_some_and(|value| !valid_timestamp(value))
        || filter.extraction_kind.is_some() != filter.extraction_state.is_some()
        || filter.extraction_kind.as_ref().is_some_and(|value| {
            !matches!(value.as_str(), "technical" | "content" | "ocr" | "transcription")
        })
        || filter.extraction_state.as_ref().is_some_and(|value| {
            !matches!(value.as_str(), "pending" | "running" | "succeeded" | "failed" | "unsupported")
        })
    {
        return Err(invalid_input());
    }
    Ok(())
}

pub(crate) fn endpoint(value: &str, origin: bool) -> Result<Url, Error> {
    if value.is_empty() || has_url_control(value) || origin && value.ends_with('/') {
        return Err(invalid_input());
    }
    let url = Url::parse(value).map_err(|_| invalid_input())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(invalid_input());
    }
    Ok(url)
}

fn collection_path(reference: &CollectionReference, suffix: &str) -> Result<String, Error> {
    Ok(format!(
        "/v1/data/{}/{}/{}/{}{}",
        uuid(&reference.tenant_id)?,
        uuid(&reference.project_id)?,
        uuid(&reference.environment_id)?,
        uuid(&reference.collection_instance_id)?,
        suffix
    ))
}

fn generation_data_path(reference: &ImmutableGenerationReference) -> Result<String, Error> {
    Ok(format!(
        "{}/{}/versions/{}",
        collection_path(&reference.file.collection, "/files")?,
        uuid(&reference.file.entry_id)?,
        uuid(&reference.generation_id)?
    ))
}

fn delivery_path(reference: &ImmutableGenerationReference) -> Result<String, Error> {
    Ok(format!(
        "/v1/delivery/{}/{}/{}/{}/{}/{}",
        uuid(&reference.file.collection.tenant_id)?,
        uuid(&reference.file.collection.project_id)?,
        uuid(&reference.file.collection.environment_id)?,
        uuid(&reference.file.collection.collection_instance_id)?,
        uuid(&reference.file.entry_id)?,
        uuid(&reference.generation_id)?
    ))
}

fn uuid(value: &str) -> Result<&str, Error> {
    if valid_uuid_v7(value) {
        Ok(value)
    } else {
        Err(invalid_input())
    }
}

pub(crate) fn valid_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[14] == b'7'
        && bytes[18] == b'-'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes[23] == b'-'
        && bytes.iter().enumerate().all(|(index, value)| {
            matches!(index, 8 | 13 | 18 | 23)
                || value.is_ascii_digit()
                || matches!(*value, b'a'..=b'f')
        })
}

fn variant(value: &str) -> Result<String, Error> {
    if value.is_empty()
        || value.len() > 160
        || value.contains("//")
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._/-".contains(&byte)
        })
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(invalid_input());
    }
    Ok(value.to_owned())
}

pub(crate) fn valid_logical_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 1024
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment.len() <= 255
                && !matches!(segment, "." | "..")
                && segment
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._~-".contains(&byte))
        })
}

fn valid_metadata_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_lowercase()
        && (bytes.len() == 1 || bytes.last().is_some_and(u8::is_ascii_alphanumeric))
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(byte))
}

fn valid_media_type(value: &str) -> bool {
    let mut parts = value.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(first), Some(second), None) if valid_media_part(first) && valid_media_part(second))
}

fn valid_media_part(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"!#$&^_.+-".contains(&byte)
        })
}

pub(crate) fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(20..=64).contains(&bytes.len())
        || !matches!(bytes.get(4), Some(b'-'))
        || !matches!(bytes.get(7), Some(b'-'))
        || !matches!(bytes.get(10), Some(b'T' | b't'))
        || !matches!(bytes.get(13), Some(b':'))
        || !matches!(bytes.get(16), Some(b':'))
        || !digits(bytes, 0, 4)
        || !digits(bytes, 5, 7)
        || !digits(bytes, 8, 10)
        || !digits(bytes, 11, 13)
        || !digits(bytes, 14, 16)
        || !digits(bytes, 17, 19)
    {
        return false;
    }
    let number = |start: usize, end: usize| value[start..end].parse::<u8>().unwrap_or(u8::MAX);
    if !(1..=12).contains(&number(5, 7))
        || !(1..=31).contains(&number(8, 10))
        || number(11, 13) > 23
        || number(14, 16) > 59
        || number(17, 19) > 60
    {
        return false;
    }
    let mut tail = &value[19..];
    if let Some(fraction) = tail.strip_prefix('.') {
        let digits = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        tail = &fraction[digits..];
    }
    if matches!(tail, "Z" | "z") {
        return true;
    }
    let Some(offset) = tail.strip_prefix(['+', '-']) else {
        return false;
    };
    offset.len() == 5
        && matches!(offset.as_bytes().get(2), Some(b':'))
        && digits(offset.as_bytes(), 0, 2)
        && digits(offset.as_bytes(), 3, 5)
        && offset[..2].parse::<u8>().is_ok_and(|hours| hours <= 23)
        && offset[3..].parse::<u8>().is_ok_and(|minutes| minutes <= 59)
}

fn digits(value: &[u8], start: usize, end: usize) -> bool {
    value
        .get(start..end)
        .is_some_and(|value| value.iter().all(u8::is_ascii_digit))
}

fn valid_facet(value: &str) -> bool {
    matches!(value, "tags" | "verified_media_type")
        || value
            .strip_prefix("custom.")
            .is_some_and(valid_metadata_name)
}

pub(crate) fn valid_capability(value: &str) -> bool {
    let Some((prefix, payload)) = value.split_once('.') else {
        return false;
    };
    matches!(prefix, "alm_cap_v1" | "alm_local_v1")
        && (20..=24_576).contains(&payload.len())
        && payload
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
}

fn valid_share_token(value: &str) -> bool {
    value.strip_prefix("alm_share_v1.").is_some_and(|payload| {
        payload.len() == 43
            && payload
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

fn valid_api_code(value: &str) -> bool {
    value.strip_prefix("ALMIRA_").is_some_and(|suffix| {
        (1..=120).contains(&suffix.len())
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn valid_byte_range(value: &str) -> bool {
    let Some(value) = value.strip_prefix("bytes=") else {
        return false;
    };
    let Some((start, end)) = value.split_once('-') else {
        return false;
    };
    !start.is_empty()
        && start.bytes().all(|byte| byte.is_ascii_digit())
        && end.bytes().all(|byte| byte.is_ascii_digit())
}

fn header(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(str::to_owned)
}

fn safe_length(value: &str) -> Option<u64> {
    if value.is_empty() || value.len() > 16 || value.len() > 1 && value.starts_with('0') {
        return None;
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|value| *value <= 9_007_199_254_740_991)
}

fn retry_after(value: &str) -> Option<u32> {
    if value.is_empty() || value.len() > 8 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn has_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character < ' ' || character == '\u{7f}')
}

fn has_url_control(value: &str) -> bool {
    value
        .chars()
        .any(|character| character <= ' ' || character == '\u{7f}')
}

fn append_option(
    query: &mut url::form_urlencoded::Serializer<'_, url::UrlQuery<'_>>,
    name: &str,
    value: Option<&str>,
) {
    if let Some(value) = value {
        query.append_pair(name, value);
    }
}
