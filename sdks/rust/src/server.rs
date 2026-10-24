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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubjectProjectReference {
    pub tenant_id: String,
    pub project_id: String,
}

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectReference {
    pub namespace: String,
    pub subject_id: String,
}

impl Debug for SubjectReference {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubjectReference")
            .field("namespace", &self.namespace)
            .field("subject_id", &"[REDACTED]")
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectBinding {
    pub binding_id: String,
    pub subject: SubjectReference,
    pub environment_id: String,
    pub collection_instance_id: String,
    pub entry_id: String,
    pub entry_lifecycle: String,
    pub created_at: String,
}

impl Debug for SubjectBinding {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubjectBinding")
            .field("binding_id", &self.binding_id)
            .field("subject", &"[REDACTED]")
            .field("environment_id", &self.environment_id)
            .field("collection_instance_id", &self.collection_instance_id)
            .field("entry_id", &self.entry_id)
            .field("entry_lifecycle", &self.entry_lifecycle)
            .field("created_at", &self.created_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectBindingOutcome {
    pub disposition: String,
    pub binding: SubjectBinding,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectBindingPage {
    pub items: Vec<SubjectBinding>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubjectBindingPageOptions {
    pub limit: u16,
    pub cursor: Option<String>,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectExportArtifact {
    pub artifact_id: String,
    pub manifest_sha256: String,
    pub content_sha256: String,
    pub size_bytes: u64,
    pub expires_at: String,
}

impl Debug for SubjectExportArtifact {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubjectExportArtifact")
            .field("artifact_id", &self.artifact_id)
            .field("manifest_sha256", &self.manifest_sha256)
            .field("content_sha256", &self.content_sha256)
            .field("size_bytes", &self.size_bytes)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectLifecycleOperation {
    pub operation_id: String,
    pub kind: String,
    pub state: String,
    pub subject: SubjectReference,
    pub matched_entries: u64,
    pub completed_entries: u64,
    pub pending_entries: u64,
    pub manifest_digest: String,
    pub artifact: Option<SubjectExportArtifact>,
    pub created_at: String,
    pub updated_at: String,
}

impl Debug for SubjectLifecycleOperation {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubjectLifecycleOperation")
            .field("operation_id", &self.operation_id)
            .field("kind", &self.kind)
            .field("state", &self.state)
            .field("subject", &"[REDACTED]")
            .field("matched_entries", &self.matched_entries)
            .field("completed_entries", &self.completed_entries)
            .field("pending_entries", &self.pending_entries)
            .field("manifest_digest", &self.manifest_digest)
            .field("artifact", &self.artifact)
            .field("created_at", &self.created_at)
            .field("updated_at", &self.updated_at)
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectLifecycleOutcome {
    pub operation: SubjectLifecycleOperation,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectLifecycleItem {
    pub binding_id: String,
    pub environment_id: String,
    pub collection_instance_id: String,
    pub entry_id: String,
    pub entry_revision: i64,
    pub disposition: String,
    pub content_path: Option<String>,
    pub recycle_until: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubjectLifecyclePage {
    pub operation: SubjectLifecycleOperation,
    pub items: Vec<SubjectLifecycleItem>,
    pub next_cursor: Option<String>,
}

impl Default for SubjectBindingPageOptions {
    fn default() -> Self {
        Self {
            limit: 50,
            cursor: None,
        }
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateMultipartPartGrantRequest {
    pub part_number: u16,
    pub content_sha256: String,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectUploadHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Eq, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PortableDownloadDescriptor {
    pub descriptor_id: String,
    pub method: String,
    pub url: String,
    pub headers: Vec<DirectUploadHeader>,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
    pub one_use: bool,
    pub expires_at: String,
}

impl Debug for PortableDownloadDescriptor {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PortableDownloadDescriptor")
            .field("descriptor_id", &self.descriptor_id)
            .field("method", &self.method)
            .field("url", &"[REDACTED]")
            .field("headers", &"[REDACTED]")
            .field("expected_size_bytes", &self.expected_size_bytes)
            .field("content_sha256", &self.content_sha256)
            .field("one_use", &self.one_use)
            .field("expires_at", &self.expires_at)
            .finish()
    }
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
    pub part_size_bytes: Option<u64>,
    pub part_count: u16,
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
            .field("part_size_bytes", &self.part_size_bytes)
            .field("part_count", &self.part_count)
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
                Some(operation_id),
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
        let outcome: CreateUploadOutcome = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                Some(operation_id),
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
                Some(operation_id),
                Some(request),
                StatusCode::OK,
            )
            .await?;
        if !valid_file_generation(&generation) {
            return Err(invalid_response());
        }
        Ok(generation)
    }

    pub async fn create_upload_part(
        &self,
        reference: &CollectionReference,
        transfer_session_id: &str,
        request: &CreateMultipartPartGrantRequest,
        operation_id: &str,
    ) -> Result<DirectUploadPart, Error> {
        if !valid_uuid_v7(transfer_session_id)
            || request.part_number == 0
            || request.part_number > 10_000
            || !valid_content_sha256(&request.content_sha256)
        {
            return Err(invalid_input());
        }
        let path = management_collection_path(
            reference,
            &format!("/uploads/{transfer_session_id}/parts"),
        )?;
        let part: DirectUploadPart = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                Some(operation_id),
                Some(request),
                StatusCode::CREATED,
            )
            .await?;
        if part.part_number != request.part_number || !valid_direct_upload_part(&part) {
            return Err(invalid_response());
        }
        Ok(part)
    }

    pub async fn bind_subject(
        &self,
        reference: &crate::types::FileReference,
        subject: &SubjectReference,
        operation_id: &str,
    ) -> Result<SubjectBindingOutcome, Error> {
        if !valid_subject_reference(subject) || !valid_uuid_v7(&reference.entry_id) {
            return Err(invalid_input());
        }
        let path = management_collection_path(
            &reference.collection,
            &format!("/files/{}/subject-bindings", reference.entry_id),
        )?;
        let outcome: SubjectBindingOutcome = self
            .request_json(
                Method::POST,
                &path,
                &reference.collection.tenant_id,
                Some(operation_id),
                Some(subject),
                StatusCode::CREATED,
            )
            .await?;
        if !matches!(
            outcome.disposition.as_str(),
            "applied" | "already_bound" | "exact_replay"
        ) || !valid_subject_binding(&outcome.binding)
        {
            return Err(invalid_response());
        }
        Ok(outcome)
    }

    pub async fn list_subject_bindings(
        &self,
        reference: &SubjectProjectReference,
        subject: &SubjectReference,
        options: &SubjectBindingPageOptions,
    ) -> Result<SubjectBindingPage, Error> {
        if !valid_uuid_v7(&reference.project_id)
            || !valid_subject_reference(subject)
            || options.limit == 0
            || options.limit > 100
            || options
                .cursor
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 2048)
        {
            return Err(invalid_input());
        }
        #[derive(Serialize)]
        #[serde(deny_unknown_fields)]
        struct Request<'a> {
            subject: &'a SubjectReference,
            limit: u16,
            #[serde(skip_serializing_if = "Option::is_none")]
            cursor: Option<&'a str>,
        }
        let path = format!(
            "/v1/projects/{}/subject-bindings/search",
            reference.project_id
        );
        let page: SubjectBindingPage = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                None,
                Some(&Request {
                    subject,
                    limit: options.limit,
                    cursor: options.cursor.as_deref(),
                }),
                StatusCode::OK,
            )
            .await?;
        if page.items.len() > 100
            || page
                .next_cursor
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 2048)
            || page
                .items
                .iter()
                .any(|binding| !valid_subject_binding(binding))
        {
            return Err(invalid_response());
        }
        Ok(page)
    }

    pub async fn start_subject_lifecycle_operation(
        &self,
        reference: &SubjectProjectReference,
        subject: &SubjectReference,
        kind: &str,
        operation_id: &str,
    ) -> Result<SubjectLifecycleOutcome, Error> {
        if !valid_uuid_v7(&reference.project_id)
            || !valid_subject_reference(subject)
            || !matches!(kind, "restrict" | "export" | "delete")
        {
            return Err(invalid_input());
        }
        #[derive(Serialize)]
        #[serde(deny_unknown_fields)]
        struct Request<'a> {
            subject: &'a SubjectReference,
            kind: &'a str,
        }
        let path = format!(
            "/v1/projects/{}/subject-lifecycle-operations",
            reference.project_id
        );
        let outcome: SubjectLifecycleOutcome = self
            .request_json_any(
                Method::POST,
                &path,
                &reference.tenant_id,
                Some(operation_id),
                Some(&Request { subject, kind }),
                &[StatusCode::CREATED, StatusCode::ACCEPTED],
            )
            .await?;
        if !valid_subject_lifecycle_operation(&outcome.operation) {
            return Err(invalid_response());
        }
        Ok(outcome)
    }

    pub async fn read_subject_lifecycle_operation(
        &self,
        reference: &SubjectProjectReference,
        lifecycle_operation_id: &str,
        options: &SubjectBindingPageOptions,
    ) -> Result<SubjectLifecyclePage, Error> {
        if !valid_uuid_v7(&reference.project_id)
            || !valid_uuid_v7(lifecycle_operation_id)
            || options.limit == 0
            || options.limit > 100
            || options
                .cursor
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 2048)
        {
            return Err(invalid_input());
        }
        #[derive(Serialize)]
        #[serde(deny_unknown_fields)]
        struct Request<'a> {
            operation_id: &'a str,
            limit: u16,
            #[serde(skip_serializing_if = "Option::is_none")]
            cursor: Option<&'a str>,
        }
        let path = format!(
            "/v1/projects/{}/subject-lifecycle-operations/search",
            reference.project_id
        );
        let page: SubjectLifecyclePage = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                None,
                Some(&Request {
                    operation_id: lifecycle_operation_id,
                    limit: options.limit,
                    cursor: options.cursor.as_deref(),
                }),
                StatusCode::OK,
            )
            .await?;
        if !valid_subject_lifecycle_operation(&page.operation)
            || page.items.len() > 100
            || page
                .next_cursor
                .as_ref()
                .is_some_and(|value| value.is_empty() || value.len() > 2048)
            || page
                .items
                .iter()
                .any(|item| !valid_subject_lifecycle_item(item))
        {
            return Err(invalid_response());
        }
        Ok(page)
    }

    pub async fn create_subject_export_download(
        &self,
        reference: &SubjectProjectReference,
        lifecycle_operation_id: &str,
        subject: &SubjectReference,
        operation_id: &str,
    ) -> Result<PortableDownloadDescriptor, Error> {
        if !valid_uuid_v7(&reference.project_id)
            || !valid_uuid_v7(lifecycle_operation_id)
            || !valid_subject_reference(subject)
        {
            return Err(invalid_input());
        }
        #[derive(Serialize)]
        #[serde(deny_unknown_fields)]
        struct Request<'a> {
            subject: &'a SubjectReference,
        }
        let path = format!(
            "/v1/projects/{}/subject-lifecycle-operations/{lifecycle_operation_id}/download",
            reference.project_id
        );
        let descriptor: PortableDownloadDescriptor = self
            .request_json(
                Method::POST,
                &path,
                &reference.tenant_id,
                Some(operation_id),
                Some(&Request { subject }),
                StatusCode::CREATED,
            )
            .await?;
        if !valid_portable_download_descriptor(&descriptor) {
            return Err(invalid_response());
        }
        Ok(descriptor)
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
                Some(operation_id),
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
        operation_id: Option<&str>,
        body: Option<&B>,
        expected_status: StatusCode,
    ) -> Result<T, Error> {
        self.request_json_any(
            method,
            path,
            tenant_id,
            operation_id,
            body,
            &[expected_status],
        )
        .await
    }

    async fn request_json_any<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        tenant_id: &str,
        operation_id: Option<&str>,
        body: Option<&B>,
        expected_statuses: &[StatusCode],
    ) -> Result<T, Error> {
        if !valid_uuid_v7(tenant_id) || operation_id.is_some_and(|value| !valid_uuid_v7(value)) {
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
        if let Some(operation_id) = operation_id {
            headers.insert(
                "idempotency-key",
                HeaderValue::from_str(operation_id).map_err(|_| invalid_input())?,
            );
        }
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
        if !expected_statuses.contains(&response.status()) {
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
        || request
            .protocol
            .as_ref()
            .is_some_and(|value| !matches!(value.as_str(), "auto" | "single_put" | "multipart"))
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

pub(crate) fn valid_direct_upload_descriptor(descriptor: &DirectUploadDescriptor) -> bool {
    if !valid_uuid_v7(&descriptor.descriptor_id)
        || !matches!(descriptor.protocol.as_str(), "single_put" | "multipart")
        || descriptor.protocol == "single_put"
            && (descriptor.requests.len() != 1
                || descriptor.part_size_bytes.is_some()
                || descriptor.part_count != 1)
        || descriptor.protocol == "multipart"
            && (!descriptor.requests.is_empty()
                || descriptor.part_size_bytes.is_none()
                || descriptor.part_count == 0
                || descriptor.part_count > 10_000)
        || descriptor.expected_size_bytes == 0
        || descriptor.expected_size_bytes > 10_737_418_240
        || !valid_content_sha256(&descriptor.content_sha256)
        || !descriptor.one_use
        || !valid_timestamp(&descriptor.expires_at)
    {
        return false;
    }
    if descriptor.protocol == "multipart" {
        let part_size = descriptor.part_size_bytes.unwrap_or(0);
        let Some(lower_bound) = part_size.checked_mul(u64::from(descriptor.part_count - 1)) else {
            return false;
        };
        let Some(upper_bound) = part_size.checked_mul(u64::from(descriptor.part_count)) else {
            return false;
        };
        if part_size == 0
            || lower_bound >= descriptor.expected_size_bytes
            || upper_bound < descriptor.expected_size_bytes
        {
            return false;
        }
    }
    let mut offset = 0_u64;
    for (index, part) in descriptor.requests.iter().enumerate() {
        if part.part_number != u16::try_from(index + 1).unwrap_or(u16::MAX)
            || part.offset_bytes != offset
            || !valid_direct_upload_part(part)
        {
            return false;
        }
        let Some(next) = offset.checked_add(part.length_bytes) else {
            return false;
        };
        offset = next;
    }
    descriptor.protocol == "multipart" || offset == descriptor.expected_size_bytes
}

pub(crate) fn valid_direct_upload_part(part: &DirectUploadPart) -> bool {
    if part.part_number == 0
        || part.part_number > 10_000
        || part.length_bytes == 0
        || part.length_bytes > 10_737_418_240
        || part.method != "PUT"
        || !part.one_use
        || !valid_transfer_url(&part.url)
        || part.headers.len() > 32
    {
        return false;
    }
    let mut names = BTreeSet::new();
    part.headers.iter().all(|header| {
        valid_header_name(&header.name)
            && !header.value.is_empty()
            && header.value.len() <= 4096
            && !header.value.chars().any(char::is_control)
            && names.insert(&header.name)
    })
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
        (1..=10_000).contains(&parts.len())
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

fn valid_subject_reference(subject: &SubjectReference) -> bool {
    let namespace = subject.namespace.as_bytes();
    !namespace.is_empty()
        && namespace.len() <= 128
        && namespace[0].is_ascii_lowercase()
        && namespace.iter().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b':' | b'-')
        })
        && !subject.subject_id.is_empty()
        && subject.subject_id.len() <= 255
        && subject.subject_id.trim() == subject.subject_id
        && !subject.subject_id.chars().any(char::is_control)
}

fn valid_subject_binding(binding: &SubjectBinding) -> bool {
    valid_uuid_v7(&binding.binding_id)
        && valid_subject_reference(&binding.subject)
        && valid_uuid_v7(&binding.environment_id)
        && valid_uuid_v7(&binding.collection_instance_id)
        && valid_uuid_v7(&binding.entry_id)
        && matches!(
            binding.entry_lifecycle.as_str(),
            "active" | "restricted" | "deleted"
        )
        && valid_timestamp(&binding.created_at)
}

fn valid_subject_lifecycle_operation(operation: &SubjectLifecycleOperation) -> bool {
    valid_uuid_v7(&operation.operation_id)
        && valid_subject_reference(&operation.subject)
        && matches!(operation.kind.as_str(), "restrict" | "export" | "delete")
        && matches!(operation.state.as_str(), "complete" | "pending")
        && operation
            .completed_entries
            .checked_add(operation.pending_entries)
            == Some(operation.matched_entries)
        && (operation.state == "complete") == (operation.pending_entries == 0)
        && (operation.kind == "export" && operation.state == "complete")
            == operation.artifact.is_some()
        && operation
            .artifact
            .as_ref()
            .is_none_or(valid_subject_export_artifact)
        && valid_content_sha256(&operation.manifest_digest)
        && valid_timestamp(&operation.created_at)
        && valid_timestamp(&operation.updated_at)
}

fn valid_subject_export_artifact(artifact: &SubjectExportArtifact) -> bool {
    valid_uuid_v7(&artifact.artifact_id)
        && valid_content_sha256(&artifact.manifest_sha256)
        && valid_content_sha256(&artifact.content_sha256)
        && (1..=9_007_199_254_740_991).contains(&artifact.size_bytes)
        && valid_timestamp(&artifact.expires_at)
}

fn valid_portable_download_descriptor(descriptor: &PortableDownloadDescriptor) -> bool {
    valid_uuid_v7(&descriptor.descriptor_id)
        && descriptor.method == "GET"
        && (1..=9_007_199_254_740_991).contains(&descriptor.expected_size_bytes)
        && valid_content_sha256(&descriptor.content_sha256)
        && descriptor.one_use
        && valid_timestamp(&descriptor.expires_at)
        && (1..=16).contains(&descriptor.headers.len())
        && valid_transfer_url(&descriptor.url)
        && Url::parse(&descriptor.url)
            .is_ok_and(|url| url.query().is_none() && url.fragment().is_none())
        && descriptor.headers.iter().all(|header| {
            valid_header_name(&header.name)
                && (1..=8192).contains(&header.value.len())
                && !header.value.contains(['\r', '\n'])
        })
}

fn valid_subject_lifecycle_item(item: &SubjectLifecycleItem) -> bool {
    valid_uuid_v7(&item.binding_id)
        && valid_uuid_v7(&item.environment_id)
        && valid_uuid_v7(&item.collection_instance_id)
        && valid_uuid_v7(&item.entry_id)
        && item.entry_revision > 0
        && matches!(
            item.disposition.as_str(),
            "export_ready"
                | "restricted"
                | "already_restricted"
                | "already_deleted"
                | "deleted_pending_retention"
                | "deleted"
                | "shared_resource_restricted"
                | "shared_resource_released"
                | "export_pending_bundle"
                | "export_pending_restriction"
                | "export_pending_retention"
        )
        && (item.disposition == "export_ready") == item.content_path.is_some()
        && item
            .content_path
            .as_ref()
            .is_none_or(|path| path.starts_with("/v1/projects/") && path.len() <= 512)
        && item
            .recycle_until
            .as_ref()
            .is_none_or(|value| valid_timestamp(value))
}

fn valid_content_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

pub(crate) fn valid_provider_receipt(value: &str) -> bool {
    (1..=256).contains(&value.len()) && value.bytes().all(|byte| (b'!'..=b'~').contains(&byte))
}

pub(crate) fn valid_provider_version(value: &str) -> bool {
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
