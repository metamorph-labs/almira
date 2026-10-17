use crate::client::{
    Client, ClientOptions, RetryPolicy, api_error, bounded_body, endpoint, valid_capability,
    valid_logical_path, valid_timestamp, valid_uuid_v7,
};
use crate::error::{Error, client_error, invalid_input, invalid_response};
use crate::types::CollectionReference;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
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

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
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
