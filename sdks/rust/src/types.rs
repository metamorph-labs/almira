use crate::error::{Error, client_error};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollectionReference {
    pub tenant_id: String,
    pub project_id: String,
    pub environment_id: String,
    pub collection_instance_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileReference {
    pub collection: CollectionReference,
    pub entry_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImmutableGenerationReference {
    pub file: FileReference,
    pub generation_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DerivativeReference {
    pub generation: ImmutableGenerationReference,
    pub variant_key: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ListFilesOptions {
    pub limit: Option<u8>,
    pub cursor: Option<String>,
    pub path_prefix: Option<String>,
    pub tag: Option<String>,
    pub metadata_key: Option<String>,
    pub metadata_value: Option<CustomMetadataValue>,
    pub verified_media_type: Option<String>,
    pub minimum_size_bytes: Option<u64>,
    pub maximum_size_bytes: Option<u64>,
    pub created_after: Option<String>,
    pub created_before: Option<String>,
    pub extraction_kind: Option<String>,
    pub extraction_state: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FileMetadataFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_value: Option<CustomMetadataValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extraction_state: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub enum CustomMetadataValue {
    Boolean(bool),
    Integer(i64),
    String(String),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SearchInput {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<FileMetadataFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub facets: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(untagged)]
pub enum ReturnedMetadataValue {
    Boolean(bool),
    Integer(i64),
    String(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileGeneration {
    pub entry_id: String,
    pub generation_id: String,
    pub generation_number: u64,
    pub state: String,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
    pub declared_media_type: String,
    pub malware_scan_requirement: String,
    pub safety_state: String,
    pub revision: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub entry_id: String,
    pub logical_path: String,
    pub lifecycle: String,
    pub revision: u64,
    pub metadata_revision: u64,
    pub tags: Vec<String>,
    pub custom_metadata: BTreeMap<String, ReturnedMetadataValue>,
    pub current_generation_id: Option<String>,
    pub current_generation: Option<FileGeneration>,
    pub deleted_at: Option<String>,
    pub recycle_until: Option<String>,
    pub latest_generation: FileGeneration,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FileEntryPage {
    pub entries: Vec<FileEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct IndexedRevision {
    pub project: u64,
    pub environment: u64,
    pub entry: u64,
    pub metadata: u64,
    pub generation: u64,
    pub extraction: u64,
    pub collection: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SearchHit {
    pub entry: FileEntry,
    pub indexed_revision: IndexedRevision,
    pub score: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SearchFacetValue {
    pub value: ReturnedMetadataValue,
    pub count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SearchFacet {
    pub field: String,
    pub values: Vec<SearchFacetValue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub facets: Vec<SearchFacet>,
    pub next_cursor: Option<String>,
    pub facet_coverage: String,
    pub consistency: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MediaDerivative {
    pub derivative_id: String,
    pub job_id: String,
    pub entry_id: String,
    pub generation_id: String,
    pub variant_key: String,
    pub kind: String,
    pub media_type: String,
    pub content_sha256: String,
    pub size_bytes: u64,
    pub width_px: Option<u64>,
    pub height_px: Option<u64>,
    pub duration_millis: Option<u64>,
    pub source_content_sha256: String,
    pub media_config_revision: u64,
    pub processor_id: String,
    pub processor_version: String,
    pub runtime_digest: String,
    pub revision: u64,
    pub created_at: String,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ReadOptions {
    pub range: Option<String>,
    pub if_none_match: Option<String>,
}

pub struct BinaryResponse {
    pub status: u16,
    pub content_length: Option<u64>,
    pub content_range: Option<String>,
    pub content_type: Option<String>,
    pub etag: Option<String>,
    pub(crate) response: reqwest::Response,
}

impl BinaryResponse {
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, Error> {
        self.response
            .chunk()
            .await
            .map(|chunk| chunk.map(|value| value.to_vec()))
            .map_err(|_| client_error("ALMIRA_CLIENT_NETWORK"))
    }
}
