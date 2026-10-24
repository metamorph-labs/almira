package almira

import (
	"io"
	"net/http"
	"time"
)

const ContractVersion = "0.1.0-dev.57"

// RetryPolicy opts safe data reads and read-only search into bounded retries.
type RetryPolicy struct {
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
}

type CollectionReference struct {
	TenantID             string
	ProjectID            string
	EnvironmentID        string
	CollectionInstanceID string
}

type FileReference struct {
	CollectionReference
	EntryID string
}

type ImmutableGenerationReference struct {
	FileReference
	GenerationID string
}

type DerivativeReference struct {
	ImmutableGenerationReference
	VariantKey string
}

type ListFilesOptions struct {
	Limit             int
	Cursor            string
	PathPrefix        string
	Tag               string
	MetadataKey       string
	MetadataValue     any
	VerifiedMediaType string
	MinimumSizeBytes  int64
	MaximumSizeBytes  int64
	CreatedAfter      string
	CreatedBefore     string
	ExtractionKind    string
	ExtractionState   string
}

type FileMetadataFilter struct {
	Tag               string `json:"tag,omitempty"`
	MetadataKey       string `json:"metadata_key,omitempty"`
	MetadataValue     any    `json:"metadata_value,omitempty"`
	VerifiedMediaType string `json:"verified_media_type,omitempty"`
	MinimumSizeBytes  int64  `json:"minimum_size_bytes,omitempty"`
	MaximumSizeBytes  int64  `json:"maximum_size_bytes,omitempty"`
	CreatedAfter      string `json:"created_after,omitempty"`
	CreatedBefore     string `json:"created_before,omitempty"`
	ExtractionKind    string `json:"extraction_kind,omitempty"`
	ExtractionState   string `json:"extraction_state,omitempty"`
}

type SearchInput struct {
	Query      string              `json:"query"`
	Mode       string              `json:"mode,omitempty"`
	PathPrefix string              `json:"path_prefix,omitempty"`
	Filter     *FileMetadataFilter `json:"filter,omitempty"`
	Facets     []string            `json:"facets,omitempty"`
	PageSize   int                 `json:"page_size,omitempty"`
	Cursor     string              `json:"cursor,omitempty"`
}

type FileGeneration struct {
	EntryID                string `json:"entry_id"`
	GenerationID           string `json:"generation_id"`
	GenerationNumber       int64  `json:"generation_number"`
	State                  string `json:"state"`
	ExpectedSizeBytes      int64  `json:"expected_size_bytes"`
	ContentSHA256          string `json:"content_sha256"`
	DeclaredMediaType      string `json:"declared_media_type"`
	MalwareScanRequirement string `json:"malware_scan_requirement"`
	SafetyState            string `json:"safety_state"`
	Revision               int64  `json:"revision"`
	CreatedAt              string `json:"created_at"`
}

type FileEntry struct {
	EntryID             string          `json:"entry_id"`
	LogicalPath         string          `json:"logical_path"`
	Lifecycle           string          `json:"lifecycle"`
	Revision            int64           `json:"revision"`
	MetadataRevision    int64           `json:"metadata_revision"`
	Tags                []string        `json:"tags"`
	CustomMetadata      map[string]any  `json:"custom_metadata"`
	CurrentGenerationID *string         `json:"current_generation_id"`
	CurrentGeneration   *FileGeneration `json:"current_generation"`
	DeletedAt           *string         `json:"deleted_at"`
	RecycleUntil        *string         `json:"recycle_until"`
	LatestGeneration    FileGeneration  `json:"latest_generation"`
	CreatedAt           string          `json:"created_at"`
	UpdatedAt           string          `json:"updated_at"`
}

type FileEntryPage struct {
	Entries    []FileEntry `json:"entries"`
	NextCursor *string     `json:"next_cursor"`
}

type IndexedRevision struct {
	Project     int64 `json:"project"`
	Environment int64 `json:"environment"`
	Entry       int64 `json:"entry"`
	Metadata    int64 `json:"metadata"`
	Generation  int64 `json:"generation"`
	Extraction  int64 `json:"extraction"`
	Collection  int64 `json:"collection"`
}

type SearchHit struct {
	Entry           FileEntry       `json:"entry"`
	IndexedRevision IndexedRevision `json:"indexed_revision"`
	Score           *string         `json:"score"`
}

type SearchFacetValue struct {
	Value any   `json:"value"`
	Count int64 `json:"count"`
}

type SearchFacet struct {
	Field  string             `json:"field"`
	Values []SearchFacetValue `json:"values"`
}

type SearchPage struct {
	Items         []SearchHit   `json:"items"`
	Facets        []SearchFacet `json:"facets"`
	NextCursor    *string       `json:"next_cursor"`
	FacetCoverage string        `json:"facet_coverage"`
	Consistency   string        `json:"consistency"`
}

type MediaDerivative struct {
	DerivativeID        string `json:"derivative_id"`
	JobID               string `json:"job_id"`
	EntryID             string `json:"entry_id"`
	GenerationID        string `json:"generation_id"`
	VariantKey          string `json:"variant_key"`
	Kind                string `json:"kind"`
	MediaType           string `json:"media_type"`
	ContentSHA256       string `json:"content_sha256"`
	SizeBytes           int64  `json:"size_bytes"`
	WidthPX             *int64 `json:"width_px"`
	HeightPX            *int64 `json:"height_px"`
	DurationMillis      *int64 `json:"duration_millis"`
	SourceContentSHA256 string `json:"source_content_sha256"`
	MediaConfigRevision int64  `json:"media_config_revision"`
	ProcessorID         string `json:"processor_id"`
	ProcessorVersion    string `json:"processor_version"`
	RuntimeDigest       string `json:"runtime_digest"`
	Revision            int64  `json:"revision"`
	CreatedAt           string `json:"created_at"`
}

type ReadOptions struct {
	Range       string
	IfNoneMatch string
}

type BinaryResponse struct {
	StatusCode    int
	Header        http.Header
	Body          io.ReadCloser
	ContentLength *int64
	ContentRange  string
	ContentType   string
	ETag          string
}

type ClientError struct {
	Code string
}

func (e *ClientError) Error() string { return e.Code }

type APIError struct {
	Code              string
	RequestID         string
	StatusCode        int
	RetryAfterSeconds *int
}

func (e *APIError) Error() string { return e.Code }
