use crate::client::{
    Client, ClientOptions, RetryPolicy, api_error, bounded_body, endpoint, valid_capability,
    valid_logical_path, valid_media_type, valid_timestamp, valid_uuid_v7,
};
use crate::error::{Error, client_error, invalid_input, invalid_response};
use crate::types::CollectionReference;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Debug, Formatter};
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BuilderSubject {
    pub subject_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    pub roles: BTreeSet<String>,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CapabilityResource {
    Collection,
    Prefix { path_prefix: String },
    Entry { entry_id: String },
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadAccessOperation {
    List,
    MetadataRead,
    ContentRead,
    Search,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateCapabilitySessionRequest {
    pub subject: BuilderSubject,
    pub operations: Vec<ReadAccessOperation>,
    pub resource: CapabilityResource,
    pub audience: String,
    pub lifetime_seconds: u16,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilitySessionGrant {
    pub session_id: String,
    pub token: String,
    pub operations: Vec<ReadAccessOperation>,
    pub resource: CapabilityResource,
    pub audience: String,
    pub policy_revision: u64,
    pub issuer_epoch: u64,
    pub expires_at: String,
}

impl Debug for CapabilitySessionGrant {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CapabilitySessionGrant")
            .field("session_id", &self.session_id)
            .field("token", &"[REDACTED]")
            .field("operations", &self.operations)
            .field("resource", &self.resource)
            .field("audience", &self.audience)
            .field("policy_revision", &self.policy_revision)
            .field("issuer_epoch", &self.issuer_epoch)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateUploadRequest {
    pub path: String,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
    pub declared_media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_origin: Option<String>,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectUploadHeader {
    pub name: String,
    pub value: String,
}

impl Debug for DirectUploadHeader {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectUploadHeader")
            .field("name", &self.name)
            .field("value", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectUploadPart {
    pub part_number: u16,
    pub offset_bytes: u64,
    pub length_bytes: u64,
    pub method: String,
    pub url: String,
    pub headers: Vec<DirectUploadHeader>,
    pub one_use: bool,
}

impl Debug for DirectUploadPart {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectUploadPart")
            .field("part_number", &self.part_number)
            .field("offset_bytes", &self.offset_bytes)
            .field("length_bytes", &self.length_bytes)
            .field("method", &self.method)
            .field("url", &"[REDACTED]")
            .field("headers", &"[REDACTED]")
            .field("one_use", &self.one_use)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectUploadDescriptor {
    pub descriptor_id: String,
    pub protocol: String,
    pub requests: Vec<DirectUploadPart>,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
    pub one_use: bool,
    pub expires_at: String,
}

impl Debug for DirectUploadDescriptor {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("DirectUploadDescriptor")
            .field("descriptor_id", &self.descriptor_id)
            .field("protocol", &self.protocol)
            .field("requests", &"[REDACTED]")
            .field("expected_size_bytes", &self.expected_size_bytes)
            .field("content_sha256", &self.content_sha256)
            .field("one_use", &self.one_use)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateUploadOutcome {
    pub transfer_session_id: String,
    pub entry_id: String,
    pub generation_id: String,
    pub descriptor: DirectUploadDescriptor,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DirectUploadPartCompletion {
    pub part_number: u16,
    pub etag: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FinalizeUploadRequest {
    pub descriptor_id: String,
    pub protocol: String,
    pub etag: Option<String>,
    pub provider_version: Option<String>,
    pub parts: Vec<DirectUploadPartCompletion>,
    pub size_bytes: u64,
    pub content_sha256: String,
}

#[derive(Clone)]
enum WorkloadSession {
    Value(String),
    Provider(Arc<dyn Fn() -> Option<String> + Send + Sync>),
}

pub struct ServerClientOptions {
    base_url: String,
    workload_session: WorkloadSession,
    timeout: Duration,
}

impl ServerClientOptions {
    pub fn new(base_url: impl Into<String>, workload_session: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into(),
            workload_session: WorkloadSession::Value(workload_session.into()),
            timeout: Duration::from_secs(30),
        }
    }

    pub fn workload_session_provider(
        mut self,
        provider: Arc<dyn Fn() -> Option<String> + Send + Sync>,
    ) -> Self {
        self.workload_session = WorkloadSession::Provider(provider);
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CapabilityDataClientOptions {
    pub timeout: Duration,
    pub retry: RetryPolicy,
}

impl Default for CapabilityDataClientOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::new(1, Duration::from_millis(100), Duration::from_secs(2)),
        }
    }
}

pub struct CapabilityDataClientSession {
    pub grant: CapabilitySessionGrant,
    pub data_client: Client,
}

#[derive(Clone)]
pub struct ServerClient {
    base_url: Url,
    workload_session: WorkloadSession,
    http: reqwest::Client,
}

impl ServerClient {
    pub fn new(options: ServerClientOptions) -> Result<Self, Error> {
        let base_url = endpoint(&options.base_url, false)?;
        if options.timeout.is_zero() || options.timeout > Duration::from_secs(300) {
            return Err(invalid_input());
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(options.timeout)
            .build()
            .map_err(|_| invalid_input())?;
        Ok(Self {
            base_url,
            workload_session: options.workload_session,
            http,
        })
    }

    pub async fn create_capability_session(
        &self,
        reference: &CollectionReference,
        request: &CreateCapabilitySessionRequest,
        operation_id: &str,
    ) -> Result<CapabilitySessionGrant, Error> {
        validate_request(request)?;
        let path = management_collection_path(reference, "/capability-sessions")?;
        let grant = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                operation_id,
                Some(request),
                StatusCode::CREATED,
            )
            .await?;
        validate_grant(&grant)?;
        Ok(grant)
    }

    pub async fn create_upload(
        &self,
        reference: &CollectionReference,
        request: &CreateUploadRequest,
        operation_id: &str,
    ) -> Result<CreateUploadOutcome, Error> {
        validate_create_upload_request(request)?;
        let path = management_collection_path(reference, "/uploads")?;
        let outcome = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                operation_id,
                Some(request),
                StatusCode::CREATED,
            )
            .await?;
        validate_create_upload_outcome(&outcome)?;
        Ok(outcome)
    }

    pub async fn finalize_upload(
        &self,
        reference: &CollectionReference,
        transfer_session_id: &str,
        request: &FinalizeUploadRequest,
        operation_id: &str,
    ) -> Result<crate::types::FileGeneration, Error> {
        if !valid_uuid_v7(transfer_session_id) {
            return Err(invalid_input());
        }
        validate_finalize_upload_request(request)?;
        let path = management_collection_path(
            reference,
            &format!("/uploads/{transfer_session_id}/finalize"),
        )?;
        let generation = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                operation_id,
                Some(request),
                StatusCode::OK,
            )
            .await?;
        if !valid_file_generation(&generation) {
            return Err(invalid_response());
        }
        Ok(generation)
    }

    pub async fn create_capability_data_client(
        &self,
        reference: &CollectionReference,
        request: &CreateCapabilitySessionRequest,
        operation_id: &str,
        options: CapabilityDataClientOptions,
    ) -> Result<CapabilityDataClientSession, Error> {
        let grant = self
            .create_capability_session(reference, request, operation_id)
            .await?;
        let data_client = Client::new(
            ClientOptions::new(self.base_url.as_str())
                .capability(grant.token.clone())
                .origin(grant.audience.clone())
                .timeout(options.timeout)
                .retry(options.retry),
        )?;
        Ok(CapabilityDataClientSession { grant, data_client })
    }

    pub async fn revoke_capability_session(
        &self,
        reference: &CollectionReference,
        session_id: &str,
        operation_id: &str,
    ) -> Result<String, Error> {
        if !valid_uuid_v7(session_id) {
            return Err(invalid_input());
        }
        let path =
            management_collection_path(reference, &format!("/capability-sessions/{session_id}"))?;
        let disposition: String = self
            .request_json::<(), String>(
                Method::DELETE,
                &path,
                &reference.tenant_id,
                operation_id,
                None,
                StatusCode::OK,
            )
            .await?;
        if !matches!(disposition.as_str(), "applied" | "exact_replay") {
            return Err(invalid_response());
        }
        Ok(disposition)
    }

    async fn request_json<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        tenant_id: &str,
        operation_id: &str,
        body: Option<&B>,
        expected_status: StatusCode,
    ) -> Result<T, Error> {
        if !valid_uuid_v7(tenant_id) || !valid_uuid_v7(operation_id) {
            return Err(invalid_input());
        }
        let evidence = match &self.workload_session {
            WorkloadSession::Value(value) => value.clone(),
            WorkloadSession::Provider(provider) => {
                provider().ok_or_else(|| client_error("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"))?
            }
        };
        if !valid_workload_session(&evidence) {
            return Err(invalid_input());
        }
        let mut headers = HeaderMap::new();
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("MetamorphWorkload {evidence}"))
                .map_err(|_| invalid_input())?,
        );
        headers.insert(
            "idempotency-key",
            HeaderValue::from_str(operation_id).map_err(|_| invalid_input())?,
        );
        headers.insert(
            "x-almira-tenant-id",
            HeaderValue::from_str(tenant_id).map_err(|_| invalid_input())?,
        );
        let url = self
            .base_url
            .join(path.trim_start_matches('/'))
            .map_err(|_| invalid_input())?;
        let mut builder = self.http.request(method, url).headers(headers);
        if let Some(body) = body {
            let bytes = serde_json::to_vec(body).map_err(|_| invalid_input())?;
            builder = builder.header(CONTENT_TYPE, "application/json").body(bytes);
        }
        let response = builder
            .send()
            .await
            .map_err(|_| client_error("ALMIRA_CLIENT_NETWORK"))?;
        if response.status() != expected_status {
            return Err(api_error(response).await);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if content_type != Some("application/json") {
            return Err(invalid_response());
        }
        let bytes = bounded_body(response, 2 * 1024 * 1024).await?;
        serde_json::from_slice(&bytes).map_err(|_| invalid_response())
    }
}

fn validate_request(request: &CreateCapabilitySessionRequest) -> Result<(), Error> {
    if !valid_opaque(&request.subject.subject_id)
        || request
            .subject
            .organization_id
            .as_ref()
            .is_some_and(|value| !valid_opaque(value))
        || request.subject.roles.len() > 16
        || request
            .subject
            .roles
            .iter()
            .any(|value| !valid_label(value))
        || request.subject.attributes.len() > 16
        || request
            .subject
            .attributes
            .iter()
            .any(|(key, value)| !valid_label(key) || !valid_opaque(value))
        || request.operations.is_empty()
        || request.operations.len() > 4
        || request.operations.iter().collect::<BTreeSet<_>>().len() != request.operations.len()
        || validate_resource(&request.resource).is_err()
        || !(60..=900).contains(&request.lifetime_seconds)
        || endpoint(&request.audience, true).is_err()
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn validate_grant(grant: &CapabilitySessionGrant) -> Result<(), Error> {
    if !valid_uuid_v7(&grant.session_id)
        || !grant.token.starts_with("alm_cap_v1.")
        || !valid_capability(&grant.token)
        || grant.operations.is_empty()
        || grant.operations.len() > 4
        || grant.operations.iter().collect::<BTreeSet<_>>().len() != grant.operations.len()
        || validate_resource(&grant.resource).is_err()
        || endpoint(&grant.audience, true).is_err()
        || grant.policy_revision == 0
        || grant.issuer_epoch == 0
        || !valid_timestamp(&grant.expires_at)
    {
        return Err(invalid_response());
    }
    Ok(())
}

fn validate_create_upload_request(request: &CreateUploadRequest) -> Result<(), Error> {
    if !valid_logical_path(&request.path)
        || request.expected_size_bytes == 0
        || request.expected_size_bytes > 10_737_418_240
        || !valid_content_sha256(&request.content_sha256)
        || !valid_media_type(&request.declared_media_type)
        || request
            .browser_origin
            .as_ref()
            .is_some_and(|value| !valid_browser_origin(value))
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn validate_create_upload_outcome(outcome: &CreateUploadOutcome) -> Result<(), Error> {
    if !valid_uuid_v7(&outcome.transfer_session_id)
        || !valid_uuid_v7(&outcome.entry_id)
        || !valid_uuid_v7(&outcome.generation_id)
        || !valid_direct_upload_descriptor(&outcome.descriptor)
    {
        return Err(invalid_response());
    }
    Ok(())
}

fn valid_direct_upload_descriptor(descriptor: &DirectUploadDescriptor) -> bool {
    if !valid_uuid_v7(&descriptor.descriptor_id)
        || !matches!(descriptor.protocol.as_str(), "single_put" | "multipart")
        || descriptor.protocol == "single_put" && descriptor.requests.len() != 1
        || descriptor.protocol == "multipart" && !(2..=256).contains(&descriptor.requests.len())
        || descriptor.expected_size_bytes == 0
        || descriptor.expected_size_bytes > 10_737_418_240
        || !valid_content_sha256(&descriptor.content_sha256)
        || !descriptor.one_use
        || !valid_timestamp(&descriptor.expires_at)
    {
        return false;
    }
    let mut offset = 0_u64;
    for (index, part) in descriptor.requests.iter().enumerate() {
        if part.part_number != u16::try_from(index + 1).unwrap_or(u16::MAX)
            || part.offset_bytes != offset
            || part.length_bytes == 0
            || part.method != "PUT"
            || !part.one_use
            || !valid_transfer_url(&part.url)
            || part.headers.len() > 32
        {
            return false;
        }
        let mut names = BTreeSet::new();
        for header in &part.headers {
            if !valid_header_name(&header.name)
                || header.value.is_empty()
                || header.value.len() > 4096
                || header.value.chars().any(char::is_control)
                || !names.insert(&header.name)
            {
                return false;
            }
        }
        let Some(next) = offset.checked_add(part.length_bytes) else {
            return false;
        };
        offset = next;
    }
    offset == descriptor.expected_size_bytes
}

fn validate_finalize_upload_request(request: &FinalizeUploadRequest) -> Result<(), Error> {
    if !valid_uuid_v7(&request.descriptor_id)
        || !matches!(request.protocol.as_str(), "single_put" | "multipart")
        || request
            .etag
            .as_ref()
            .is_some_and(|value| !valid_provider_receipt(value))
        || request
            .provider_version
            .as_ref()
            .is_some_and(|value| !valid_provider_version(value))
        || request.size_bytes == 0
        || request.size_bytes > 10_737_418_240
        || !valid_content_sha256(&request.content_sha256)
        || !valid_completion_parts(&request.protocol, &request.parts)
        || request.protocol == "single_put"
            && (request.etag.is_none()
                || request.parts.first().map(|part| &part.etag) != request.etag.as_ref())
        || request.protocol == "multipart"
            && (request.etag.is_some() || request.provider_version.is_some())
    {
        return Err(invalid_input());
    }
    Ok(())
}

fn valid_completion_parts(protocol: &str, parts: &[DirectUploadPartCompletion]) -> bool {
    let count_valid = if protocol == "single_put" {
        parts.len() == 1
    } else {
        (2..=256).contains(&parts.len())
    };
    count_valid
        && parts.iter().enumerate().all(|(index, part)| {
            part.part_number == u16::try_from(index + 1).unwrap_or(u16::MAX)
                && valid_provider_receipt(&part.etag)
        })
}

fn valid_file_generation(generation: &crate::types::FileGeneration) -> bool {
    valid_uuid_v7(&generation.entry_id)
        && valid_uuid_v7(&generation.generation_id)
        && generation.generation_number > 0
        && matches!(
            generation.state.as_str(),
            "pending_transfer" | "aborted" | "safety_pending" | "available" | "unavailable"
        )
        && generation.expected_size_bytes > 0
        && generation.expected_size_bytes <= 10_737_418_240
        && valid_content_sha256(&generation.content_sha256)
        && valid_media_type(&generation.declared_media_type)
        && matches!(
            generation.malware_scan_requirement.as_str(),
            "not_required" | "required"
        )
        && matches!(
            generation.safety_state.as_str(),
            "not_required" | "scan_pending" | "clean" | "blocked"
        )
        && generation.revision > 0
        && valid_timestamp(&generation.created_at)
}

fn valid_content_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn valid_provider_receipt(value: &str) -> bool {
    (1..=256).contains(&value.len()) && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

fn valid_provider_version(value: &str) -> bool {
    valid_provider_receipt(value)
        && !value
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'?' | b'#' | b'\\'))
}

fn valid_header_name(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_transfer_url(value: &str) -> bool {
    if value.len() > 8192 || value.chars().any(char::is_control) || value.contains([' ', '\\']) {
        return false;
    }
    Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

fn valid_browser_origin(value: &str) -> bool {
    endpoint(value, true).is_ok_and(|url| {
        (url.scheme() == "https"
            && url.host_str().is_some_and(|host| {
                let host = host.as_bytes();
                !host.is_empty()
                    && (host[0].is_ascii_lowercase() || host[0].is_ascii_digit())
                    && host.iter().all(|byte| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || matches!(byte, b'.' | b'-')
                    })
            }))
            || (url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1")))
    })
}

fn validate_resource(resource: &CapabilityResource) -> Result<(), Error> {
    match resource {
        CapabilityResource::Collection => Ok(()),
        CapabilityResource::Prefix { path_prefix } if valid_logical_path(path_prefix) => Ok(()),
        CapabilityResource::Entry { entry_id } if valid_uuid_v7(entry_id) => Ok(()),
        _ => Err(invalid_input()),
    }
}

fn valid_opaque(value: &str) -> bool {
    (1..=255).contains(&value.chars().count())
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn valid_label(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase()
            } else {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b':' | b'-')
            }
        })
}

fn valid_workload_session(value: &str) -> bool {
    (2..=48 * 1024).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn management_collection_path(
    reference: &CollectionReference,
    suffix: &str,
) -> Result<String, Error> {
    if !valid_uuid_v7(&reference.tenant_id)
        || !valid_uuid_v7(&reference.project_id)
        || !valid_uuid_v7(&reference.environment_id)
        || !valid_uuid_v7(&reference.collection_instance_id)
    {
        return Err(invalid_input());
    }
    Ok(format!(
        "/v1/projects/{}/environments/{}/collections/{}{}",
        reference.project_id, reference.environment_id, reference.collection_instance_id, suffix
    ))
}
