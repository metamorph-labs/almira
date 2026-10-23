package almira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	workloadSessionPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	labelPattern            = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,63}$`)
	subjectNamespacePattern = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,127}$`)
	contentSHA256Pattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	headerNamePattern       = regexp.MustCompile(`^[a-z0-9-]{1,128}$`)
	browserHostPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]*$`)
)

type WorkloadSessionProvider func(context.Context) (string, error)

type BuilderSubject struct {
	SubjectID      string            `json:"subject_id"`
	OrganizationID *string           `json:"organization_id,omitempty"`
	Roles          []string          `json:"roles"`
	Attributes     map[string]string `json:"attributes"`
}

type SubjectProjectReference struct {
	TenantID  string
	ProjectID string
}

type SubjectReference struct {
	Namespace string `json:"namespace"`
	SubjectID string `json:"subject_id"`
}

func (subject SubjectReference) String() string {
	return "SubjectReference{Namespace:" + subject.Namespace + ", SubjectID:[REDACTED]}"
}

func (subject SubjectReference) GoString() string { return subject.String() }

type SubjectBinding struct {
	BindingID            string           `json:"binding_id"`
	Subject              SubjectReference `json:"subject"`
	EnvironmentID        string           `json:"environment_id"`
	CollectionInstanceID string           `json:"collection_instance_id"`
	EntryID              string           `json:"entry_id"`
	EntryLifecycle       string           `json:"entry_lifecycle"`
	CreatedAt            string           `json:"created_at"`
}

func (binding SubjectBinding) String() string {
	return "SubjectBinding{BindingID:" + binding.BindingID + ", Subject:[REDACTED], EntryID:" + binding.EntryID + "}"
}

func (binding SubjectBinding) GoString() string { return binding.String() }

type SubjectBindingOutcome struct {
	Disposition string         `json:"disposition"`
	Binding     SubjectBinding `json:"binding"`
}

type SubjectBindingPage struct {
	Items      []SubjectBinding `json:"items"`
	NextCursor *string          `json:"next_cursor"`
}

type SubjectBindingPageOptions struct {
	Limit  int
	Cursor string
}

type SubjectLifecycleOperation struct {
	OperationID      string           `json:"operation_id"`
	Kind             string           `json:"kind"`
	State            string           `json:"state"`
	Subject          SubjectReference `json:"subject"`
	MatchedEntries   uint64           `json:"matched_entries"`
	CompletedEntries uint64           `json:"completed_entries"`
	PendingEntries   uint64           `json:"pending_entries"`
	ManifestDigest   string           `json:"manifest_digest"`
	CreatedAt        string           `json:"created_at"`
	UpdatedAt        string           `json:"updated_at"`
}

func (operation SubjectLifecycleOperation) String() string {
	return "SubjectLifecycleOperation{OperationID:" + operation.OperationID + ", Subject:[REDACTED], State:" + operation.State + "}"
}

func (operation SubjectLifecycleOperation) GoString() string { return operation.String() }

type SubjectLifecycleOutcome struct {
	Operation SubjectLifecycleOperation `json:"operation"`
}

type SubjectLifecycleItem struct {
	BindingID            string  `json:"binding_id"`
	EnvironmentID        string  `json:"environment_id"`
	CollectionInstanceID string  `json:"collection_instance_id"`
	EntryID              string  `json:"entry_id"`
	EntryRevision        int64   `json:"entry_revision"`
	Disposition          string  `json:"disposition"`
	ContentPath          *string `json:"content_path"`
	RecycleUntil         *string `json:"recycle_until"`
}

type SubjectLifecyclePage struct {
	Operation  SubjectLifecycleOperation `json:"operation"`
	Items      []SubjectLifecycleItem    `json:"items"`
	NextCursor *string                   `json:"next_cursor"`
}

type CapabilityResource struct {
	Kind       string `json:"kind"`
	PathPrefix string `json:"path_prefix,omitempty"`
	EntryID    string `json:"entry_id,omitempty"`
}

type CreateCapabilitySessionRequest struct {
	Subject         BuilderSubject     `json:"subject"`
	Operations      []string           `json:"operations"`
	Resource        CapabilityResource `json:"resource"`
	Audience        string             `json:"audience"`
	LifetimeSeconds int                `json:"lifetime_seconds"`
}

type CapabilitySessionGrant struct {
	SessionID      string             `json:"session_id"`
	Token          string             `json:"token"`
	Operations     []string           `json:"operations"`
	Resource       CapabilityResource `json:"resource"`
	Audience       string             `json:"audience"`
	PolicyRevision int64              `json:"policy_revision"`
	IssuerEpoch    int64              `json:"issuer_epoch"`
	ExpiresAt      string             `json:"expires_at"`
}

func (grant CapabilitySessionGrant) String() string {
	return "CapabilitySessionGrant{SessionID:" + grant.SessionID + ", Token:[REDACTED], Audience:" + grant.Audience + "}"
}

func (grant CapabilitySessionGrant) GoString() string { return grant.String() }

type CreateUploadRequest struct {
	Path              string  `json:"path"`
	ExpectedSizeBytes int64   `json:"expected_size_bytes"`
	ContentSHA256     string  `json:"content_sha256"`
	DeclaredMediaType string  `json:"declared_media_type"`
	BrowserOrigin     *string `json:"browser_origin,omitempty"`
	Protocol          string  `json:"protocol,omitempty"`
}

type CreateMultipartPartGrantRequest struct {
	PartNumber    int    `json:"part_number"`
	ContentSHA256 string `json:"content_sha256"`
}

type DirectUploadHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func (header DirectUploadHeader) String() string {
	return "DirectUploadHeader{Name:" + header.Name + ", Value:[REDACTED]}"
}

func (header DirectUploadHeader) GoString() string { return header.String() }

type DirectUploadPart struct {
	PartNumber  int                  `json:"part_number"`
	OffsetBytes int64                `json:"offset_bytes"`
	LengthBytes int64                `json:"length_bytes"`
	Method      string               `json:"method"`
	URL         string               `json:"url"`
	Headers     []DirectUploadHeader `json:"headers"`
	OneUse      bool                 `json:"one_use"`
}

func (part DirectUploadPart) String() string {
	return "DirectUploadPart{PartNumber:" + strconv.Itoa(part.PartNumber) + ", URL:[REDACTED], Headers:[REDACTED]}"
}

func (part DirectUploadPart) GoString() string { return part.String() }

type DirectUploadDescriptor struct {
	DescriptorID      string             `json:"descriptor_id"`
	Protocol          string             `json:"protocol"`
	Requests          []DirectUploadPart `json:"requests"`
	ExpectedSizeBytes int64              `json:"expected_size_bytes"`
	ContentSHA256     string             `json:"content_sha256"`
	OneUse            bool               `json:"one_use"`
	ExpiresAt         string             `json:"expires_at"`
	PartSizeBytes     *int64             `json:"part_size_bytes"`
	PartCount         int                `json:"part_count"`
}

func (descriptor DirectUploadDescriptor) String() string {
	return "DirectUploadDescriptor{DescriptorID:" + descriptor.DescriptorID + ", Requests:[REDACTED]}"
}

func (descriptor DirectUploadDescriptor) GoString() string { return descriptor.String() }

type CreateUploadOutcome struct {
	TransferSessionID string                 `json:"transfer_session_id"`
	EntryID           string                 `json:"entry_id"`
	GenerationID      string                 `json:"generation_id"`
	Descriptor        DirectUploadDescriptor `json:"descriptor"`
}

type DirectUploadPartCompletion struct {
	PartNumber int    `json:"part_number"`
	ETag       string `json:"etag"`
}

type FinalizeUploadRequest struct {
	DescriptorID    string                       `json:"descriptor_id"`
	Protocol        string                       `json:"protocol"`
	ETag            *string                      `json:"etag"`
	ProviderVersion *string                      `json:"provider_version"`
	Parts           []DirectUploadPartCompletion `json:"parts"`
	SizeBytes       int64                        `json:"size_bytes"`
	ContentSHA256   string                       `json:"content_sha256"`
}

type ServerClientOptions struct {
	BaseURL                 string
	WorkloadSession         string
	WorkloadSessionProvider WorkloadSessionProvider
	Transport               http.RoundTripper
	Timeout                 time.Duration
}

type CapabilityDataClientOptions struct {
	Transport http.RoundTripper
	Timeout   time.Duration
	Retry     *RetryPolicy
}

type CapabilityDataClientSession struct {
	Grant      CapabilitySessionGrant
	DataClient *Client
}

func (session CapabilityDataClientSession) String() string {
	return "CapabilityDataClientSession{Grant:" + session.Grant.String() + ", DataClient:[REDACTED]}"
}

func (session CapabilityDataClientSession) GoString() string { return session.String() }

type ServerClient struct {
	baseURL                 string
	workloadSession         string
	workloadSessionProvider WorkloadSessionProvider
	http                    *http.Client
}

func (c *ServerClient) String() string { return "almira.ServerClient{workloadSession:[REDACTED]}" }

func (c *ServerClient) GoString() string { return c.String() }

func NewServerClient(options ServerClientOptions) (*ServerClient, error) {
	base, err := parseEndpoint(options.BaseURL, false)
	if err != nil || options.WorkloadSession != "" && options.WorkloadSessionProvider != nil {
		return nil, invalidInput()
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if timeout < 0 || timeout > 5*time.Minute || options.WorkloadSession == "" && options.WorkloadSessionProvider == nil {
		return nil, invalidInput()
	}
	transport := options.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &ServerClient{
		baseURL:                 strings.TrimSuffix(base.String(), "/"),
		workloadSession:         options.WorkloadSession,
		workloadSessionProvider: options.WorkloadSessionProvider,
		http: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
	}, nil
}

func (c *ServerClient) CreateCapabilitySession(
	ctx context.Context,
	reference CollectionReference,
	request CreateCapabilitySessionRequest,
	operationID string,
) (CapabilitySessionGrant, error) {
	var zero CapabilitySessionGrant
	if err := validateCapabilityRequest(request); err != nil {
		return zero, err
	}
	path, err := managementCollectionPath(reference, "/capability-sessions")
	if err != nil {
		return zero, err
	}
	grant, err := serverRequestJSON[CapabilitySessionGrant](c, ctx, http.MethodPost, path, reference.TenantID, operationID, request, http.StatusCreated)
	if err != nil {
		return zero, err
	}
	if err := validateCapabilityGrant(grant); err != nil {
		return zero, err
	}
	return grant, nil
}

func (c *ServerClient) CreateUpload(
	ctx context.Context,
	reference CollectionReference,
	request CreateUploadRequest,
	operationID string,
) (CreateUploadOutcome, error) {
	var zero CreateUploadOutcome
	if err := validateCreateUploadRequest(request); err != nil {
		return zero, err
	}
	path, err := managementCollectionPath(reference, "/uploads")
	if err != nil {
		return zero, err
	}
	outcome, err := serverRequestJSON[CreateUploadOutcome](c, ctx, http.MethodPost, path, reference.TenantID, operationID, request, http.StatusCreated)
	if err != nil {
		return zero, err
	}
	if err := validateCreateUploadOutcome(outcome); err != nil {
		return zero, err
	}
	return outcome, nil
}

func (c *ServerClient) FinalizeUpload(
	ctx context.Context,
	reference CollectionReference,
	transferSessionID string,
	request FinalizeUploadRequest,
	operationID string,
) (FileGeneration, error) {
	var zero FileGeneration
	if _, err := uuid(transferSessionID); err != nil {
		return zero, err
	}
	if err := validateFinalizeUploadRequest(request); err != nil {
		return zero, err
	}
	path, err := managementCollectionPath(reference, "/uploads/"+transferSessionID+"/finalize")
	if err != nil {
		return zero, err
	}
	generation, err := serverRequestJSON[FileGeneration](c, ctx, http.MethodPost, path, reference.TenantID, operationID, request, http.StatusOK)
	if err != nil {
		return zero, err
	}
	if !validFileGeneration(generation) {
		return zero, invalidResponse()
	}
	return generation, nil
}

func (c *ServerClient) CreateUploadPart(
	ctx context.Context,
	reference CollectionReference,
	transferSessionID string,
	request CreateMultipartPartGrantRequest,
	operationID string,
) (DirectUploadPart, error) {
	var zero DirectUploadPart
	if _, err := uuid(transferSessionID); err != nil {
		return zero, err
	}
	if request.PartNumber < 1 || request.PartNumber > 10_000 || !contentSHA256Pattern.MatchString(request.ContentSHA256) {
		return zero, invalidInput()
	}
	path, err := managementCollectionPath(reference, "/uploads/"+transferSessionID+"/parts")
	if err != nil {
		return zero, err
	}
	part, err := serverRequestJSON[DirectUploadPart](c, ctx, http.MethodPost, path, reference.TenantID, operationID, request, http.StatusCreated)
	if err != nil {
		return zero, err
	}
	if part.PartNumber != request.PartNumber || !validDirectUploadPart(part) {
		return zero, invalidResponse()
	}
	return part, nil
}

func (c *ServerClient) BindSubject(
	ctx context.Context,
	reference FileReference,
	subject SubjectReference,
	operationID string,
) (SubjectBindingOutcome, error) {
	var zero SubjectBindingOutcome
	if !validSubjectReference(subject) {
		return zero, invalidInput()
	}
	path, err := managementCollectionPath(reference.CollectionReference, "/files/"+reference.EntryID+"/subject-bindings")
	if err != nil {
		return zero, err
	}
	if _, err := uuid(reference.EntryID); err != nil {
		return zero, err
	}
	outcome, err := serverRequestJSON[SubjectBindingOutcome](
		c, ctx, http.MethodPost, path, reference.TenantID, operationID, subject, http.StatusCreated,
	)
	if err != nil {
		return zero, err
	}
	if !validSubjectBinding(outcome.Binding) ||
		outcome.Disposition != "applied" && outcome.Disposition != "already_bound" && outcome.Disposition != "exact_replay" {
		return zero, invalidResponse()
	}
	return outcome, nil
}

func (c *ServerClient) ListSubjectBindings(
	ctx context.Context,
	reference SubjectProjectReference,
	subject SubjectReference,
	options SubjectBindingPageOptions,
) (SubjectBindingPage, error) {
	var zero SubjectBindingPage
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if !validSubjectReference(subject) || limit < 1 || limit > 100 || len(options.Cursor) > 2048 {
		return zero, invalidInput()
	}
	projectID, err := uuid(reference.ProjectID)
	if err != nil {
		return zero, err
	}
	body := struct {
		Subject SubjectReference `json:"subject"`
		Limit   int              `json:"limit"`
		Cursor  string           `json:"cursor,omitempty"`
	}{Subject: subject, Limit: limit, Cursor: options.Cursor}
	page, err := serverReadJSON[SubjectBindingPage](
		c, ctx, http.MethodPost, "/v1/projects/"+projectID+"/subject-bindings/search",
		reference.TenantID, body, http.StatusOK,
	)
	if err != nil {
		return zero, err
	}
	if len(page.Items) > 100 || page.NextCursor != nil && (len(*page.NextCursor) < 1 || len(*page.NextCursor) > 2048) {
		return zero, invalidResponse()
	}
	for _, binding := range page.Items {
		if !validSubjectBinding(binding) {
			return zero, invalidResponse()
		}
	}
	return page, nil
}

func (c *ServerClient) StartSubjectLifecycleOperation(
	ctx context.Context,
	reference SubjectProjectReference,
	subject SubjectReference,
	kind string,
	operationID string,
) (SubjectLifecycleOutcome, error) {
	var zero SubjectLifecycleOutcome
	if !validSubjectReference(subject) || kind != "restrict" && kind != "export" && kind != "delete" {
		return zero, invalidInput()
	}
	projectID, err := uuid(reference.ProjectID)
	if err != nil {
		return zero, err
	}
	body := struct {
		Subject SubjectReference `json:"subject"`
		Kind    string           `json:"kind"`
	}{Subject: subject, Kind: kind}
	outcome, err := serverRequestJSON[SubjectLifecycleOutcome](
		c, ctx, http.MethodPost, "/v1/projects/"+projectID+"/subject-lifecycle-operations",
		reference.TenantID, operationID, body, http.StatusCreated, http.StatusAccepted,
	)
	if err != nil {
		return zero, err
	}
	if !validSubjectLifecycleOperation(outcome.Operation) {
		return zero, invalidResponse()
	}
	return outcome, nil
}

func (c *ServerClient) ReadSubjectLifecycleOperation(
	ctx context.Context,
	reference SubjectProjectReference,
	lifecycleOperationID string,
	options SubjectBindingPageOptions,
) (SubjectLifecyclePage, error) {
	var zero SubjectLifecyclePage
	limit := options.Limit
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 || len(options.Cursor) > 2048 {
		return zero, invalidInput()
	}
	projectID, err := uuid(reference.ProjectID)
	if err != nil {
		return zero, err
	}
	lifecycleOperationID, err = uuid(lifecycleOperationID)
	if err != nil {
		return zero, err
	}
	body := struct {
		OperationID string `json:"operation_id"`
		Limit       int    `json:"limit"`
		Cursor      string `json:"cursor,omitempty"`
	}{OperationID: lifecycleOperationID, Limit: limit, Cursor: options.Cursor}
	page, err := serverReadJSON[SubjectLifecyclePage](
		c, ctx, http.MethodPost, "/v1/projects/"+projectID+"/subject-lifecycle-operations/search",
		reference.TenantID, body, http.StatusOK,
	)
	if err != nil {
		return zero, err
	}
	if !validSubjectLifecycleOperation(page.Operation) || len(page.Items) > 100 ||
		page.NextCursor != nil && (len(*page.NextCursor) < 1 || len(*page.NextCursor) > 2048) {
		return zero, invalidResponse()
	}
	for _, item := range page.Items {
		if !validSubjectLifecycleItem(item) {
			return zero, invalidResponse()
		}
	}
	return page, nil
}

func (c *ServerClient) CreateCapabilityDataClient(
	ctx context.Context,
	reference CollectionReference,
	request CreateCapabilitySessionRequest,
	operationID string,
	options CapabilityDataClientOptions,
) (*CapabilityDataClientSession, error) {
	grant, err := c.CreateCapabilitySession(ctx, reference, request, operationID)
	if err != nil {
		return nil, err
	}
	dataClient, err := NewClient(ClientOptions{
		BaseURL: c.baseURL, Capability: grant.Token, Origin: grant.Audience,
		Transport: options.Transport, Timeout: options.Timeout, Retry: options.Retry,
	})
	if err != nil {
		return nil, err
	}
	return &CapabilityDataClientSession{Grant: grant, DataClient: dataClient}, nil
}

func (c *ServerClient) RevokeCapabilitySession(
	ctx context.Context,
	reference CollectionReference,
	sessionID string,
	operationID string,
) (string, error) {
	if _, err := uuid(sessionID); err != nil {
		return "", err
	}
	path, err := managementCollectionPath(reference, "/capability-sessions/"+sessionID)
	if err != nil {
		return "", err
	}
	disposition, err := serverRequestJSON[string](c, ctx, http.MethodDelete, path, reference.TenantID, operationID, nil, http.StatusOK)
	if err != nil {
		return "", err
	}
	if disposition != "applied" && disposition != "exact_replay" {
		return "", invalidResponse()
	}
	return disposition, nil
}

func serverRequestJSON[T any](
	c *ServerClient,
	ctx context.Context,
	method, path, tenantID, operationID string,
	value any,
	expectedStatus ...int,
) (T, error) {
	return serverJSON[T](c, ctx, method, path, tenantID, operationID, true, value, expectedStatus...)
}

func serverReadJSON[T any](
	c *ServerClient,
	ctx context.Context,
	method, path, tenantID string,
	value any,
	expectedStatus ...int,
) (T, error) {
	return serverJSON[T](c, ctx, method, path, tenantID, "", false, value, expectedStatus...)
}

func serverJSON[T any](
	c *ServerClient,
	ctx context.Context,
	method, path, tenantID, operationID string,
	requireOperation bool,
	value any,
	expectedStatus ...int,
) (T, error) {
	var zero T
	if ctx == nil {
		return zero, invalidInput()
	}
	tenantID, err := uuid(tenantID)
	if err != nil {
		return zero, err
	}
	if requireOperation {
		operationID, err = uuid(operationID)
		if err != nil {
			return zero, err
		}
	}
	evidence := c.workloadSession
	if c.workloadSessionProvider != nil {
		evidence, err = c.workloadSessionProvider(ctx)
		if err != nil {
			return zero, clientFailure("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE")
		}
	}
	if len(evidence) < 2 || len(evidence) > 48*1024 || !workloadSessionPattern.MatchString(evidence) {
		return zero, invalidInput()
	}
	var body []byte
	if value != nil {
		body, err = json.Marshal(value)
		if err != nil {
			return zero, invalidInput()
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return zero, invalidInput()
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "MetamorphWorkload "+evidence)
	if requireOperation {
		request.Header.Set("Idempotency-Key", operationID)
	}
	request.Header.Set("X-Almira-Tenant-Id", tenantID)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return zero, clientFailure("ALMIRA_CLIENT_ABORTED")
		}
		return zero, clientFailure("ALMIRA_CLIENT_NETWORK")
	}
	if response == nil || response.Body == nil || response.StatusCode < 100 || response.StatusCode > 599 {
		if response != nil && response.Body != nil {
			response.Body.Close()
		}
		return zero, invalidResponse()
	}
	statusAccepted := false
	for _, status := range expectedStatus {
		statusAccepted = statusAccepted || response.StatusCode == status
	}
	if !statusAccepted {
		return zero, parseAPIError(response)
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		response.Body.Close()
		return zero, invalidResponse()
	}
	raw, err := boundedBody(response, 2*1024*1024)
	if err != nil {
		return zero, err
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return zero, invalidResponse()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	if err := decoder.Decode(&zero); err != nil {
		return zero, invalidResponse()
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return zero, invalidResponse()
	}
	return zero, nil
}

func validSubjectReference(subject SubjectReference) bool {
	return subjectNamespacePattern.MatchString(subject.Namespace) && utf8.ValidString(subject.SubjectID) &&
		validOpaque(subject.SubjectID) && len(subject.SubjectID) <= 255
}

func validSubjectBinding(binding SubjectBinding) bool {
	return uuidV7Pattern.MatchString(binding.BindingID) && validSubjectReference(binding.Subject) &&
		uuidV7Pattern.MatchString(binding.EnvironmentID) && uuidV7Pattern.MatchString(binding.CollectionInstanceID) &&
		uuidV7Pattern.MatchString(binding.EntryID) &&
		(binding.EntryLifecycle == "active" || binding.EntryLifecycle == "restricted" || binding.EntryLifecycle == "deleted") &&
		validTimestamp(binding.CreatedAt)
}

func validSubjectLifecycleOperation(operation SubjectLifecycleOperation) bool {
	return uuidV7Pattern.MatchString(operation.OperationID) && validSubjectReference(operation.Subject) &&
		(operation.Kind == "restrict" || operation.Kind == "export" || operation.Kind == "delete") &&
		(operation.State == "complete" || operation.State == "pending") &&
		operation.CompletedEntries+operation.PendingEntries == operation.MatchedEntries &&
		(operation.State == "complete") == (operation.PendingEntries == 0) &&
		contentSHA256Pattern.MatchString(operation.ManifestDigest) &&
		validTimestamp(operation.CreatedAt) && validTimestamp(operation.UpdatedAt)
}

func validSubjectLifecycleItem(item SubjectLifecycleItem) bool {
	validDisposition := item.Disposition == "export_ready" || item.Disposition == "restricted" ||
		item.Disposition == "already_restricted" || item.Disposition == "already_deleted" ||
		item.Disposition == "deleted_pending_retention" || item.Disposition == "shared_resource_restricted" ||
		item.Disposition == "export_pending_bundle" || item.Disposition == "export_pending_restriction" ||
		item.Disposition == "export_pending_retention"
	validContentPath := item.ContentPath == nil || strings.HasPrefix(*item.ContentPath, "/v1/projects/") && len(*item.ContentPath) <= 512
	return uuidV7Pattern.MatchString(item.BindingID) && uuidV7Pattern.MatchString(item.EnvironmentID) &&
		uuidV7Pattern.MatchString(item.CollectionInstanceID) && uuidV7Pattern.MatchString(item.EntryID) &&
		item.EntryRevision > 0 && validDisposition && (item.Disposition == "export_ready") == (item.ContentPath != nil) &&
		validContentPath && (item.RecycleUntil == nil || validTimestamp(*item.RecycleUntil))
}

func validateCapabilityRequest(request CreateCapabilitySessionRequest) error {
	if !validOpaque(request.Subject.SubjectID) ||
		request.Subject.OrganizationID != nil && !validOpaque(*request.Subject.OrganizationID) ||
		len(request.Subject.Roles) > 16 || len(request.Subject.Attributes) > 16 ||
		!uniqueStrings(request.Subject.Roles) ||
		request.LifetimeSeconds < 60 || request.LifetimeSeconds > 900 {
		return invalidInput()
	}
	for _, role := range request.Subject.Roles {
		if !labelPattern.MatchString(role) {
			return invalidInput()
		}
	}
	for key, value := range request.Subject.Attributes {
		if !labelPattern.MatchString(key) || !validOpaque(value) {
			return invalidInput()
		}
	}
	if !validOperations(request.Operations) || validateCapabilityResource(request.Resource) != nil {
		return invalidInput()
	}
	if _, err := parseEndpoint(request.Audience, true); err != nil {
		return invalidInput()
	}
	return nil
}

func validateCapabilityGrant(grant CapabilitySessionGrant) error {
	if !uuidV7Pattern.MatchString(grant.SessionID) || !validCapability(grant.Token) ||
		!validOperations(grant.Operations) || validateCapabilityResource(grant.Resource) != nil ||
		grant.PolicyRevision < 1 || grant.IssuerEpoch < 1 || !validTimestamp(grant.ExpiresAt) {
		return invalidResponse()
	}
	if _, err := parseEndpoint(grant.Audience, true); err != nil {
		return invalidResponse()
	}
	return nil
}

func validateCreateUploadRequest(request CreateUploadRequest) error {
	if !validLogicalPath(request.Path) || request.ExpectedSizeBytes < 1 || request.ExpectedSizeBytes > 10_737_418_240 ||
		!contentSHA256Pattern.MatchString(request.ContentSHA256) || len(request.DeclaredMediaType) > 127 ||
		!mediaTypePattern.MatchString(request.DeclaredMediaType) {
		return invalidInput()
	}
	if request.BrowserOrigin != nil && !validBrowserOrigin(*request.BrowserOrigin) {
		return invalidInput()
	}
	if request.Protocol != "" && request.Protocol != "auto" && request.Protocol != "single_put" && request.Protocol != "multipart" {
		return invalidInput()
	}
	return nil
}

func validateCreateUploadOutcome(outcome CreateUploadOutcome) error {
	if !uuidV7Pattern.MatchString(outcome.TransferSessionID) || !uuidV7Pattern.MatchString(outcome.EntryID) ||
		!uuidV7Pattern.MatchString(outcome.GenerationID) || !validDirectUploadDescriptor(outcome.Descriptor) {
		return invalidResponse()
	}
	return nil
}

func validDirectUploadDescriptor(descriptor DirectUploadDescriptor) bool {
	if !uuidV7Pattern.MatchString(descriptor.DescriptorID) ||
		descriptor.Protocol != "single_put" && descriptor.Protocol != "multipart" ||
		descriptor.Protocol == "single_put" && (len(descriptor.Requests) != 1 || descriptor.PartSizeBytes != nil || descriptor.PartCount != 1) ||
		descriptor.Protocol == "multipart" && (len(descriptor.Requests) != 0 || descriptor.PartSizeBytes == nil || *descriptor.PartSizeBytes < 1 || descriptor.PartCount < 1 || descriptor.PartCount > 10_000) ||
		descriptor.ExpectedSizeBytes < 1 || descriptor.ExpectedSizeBytes > 10_737_418_240 ||
		!contentSHA256Pattern.MatchString(descriptor.ContentSHA256) || !descriptor.OneUse || !validTimestamp(descriptor.ExpiresAt) {
		return false
	}
	if descriptor.Protocol == "multipart" &&
		(*descriptor.PartSizeBytes*int64(descriptor.PartCount-1) >= descriptor.ExpectedSizeBytes ||
			*descriptor.PartSizeBytes*int64(descriptor.PartCount) < descriptor.ExpectedSizeBytes) {
		return false
	}
	var offset int64
	for index, part := range descriptor.Requests {
		if part.PartNumber != index+1 || part.OffsetBytes != offset || !validDirectUploadPart(part) {
			return false
		}
		if part.LengthBytes > 10_737_418_240-offset {
			return false
		}
		offset += part.LengthBytes
	}
	return descriptor.Protocol == "multipart" || offset == descriptor.ExpectedSizeBytes
}

func validDirectUploadPart(part DirectUploadPart) bool {
	if part.PartNumber < 1 || part.PartNumber > 10_000 || part.OffsetBytes < 0 || part.LengthBytes < 1 ||
		part.LengthBytes > 10_737_418_240 || part.Method != http.MethodPut || !part.OneUse ||
		!validTransferURL(part.URL) || len(part.Headers) > 32 {
		return false
	}
	names := make(map[string]struct{}, len(part.Headers))
	for _, header := range part.Headers {
		if !headerNamePattern.MatchString(header.Name) || header.Value == "" || len(header.Value) > 4096 || hasControls(header.Value) {
			return false
		}
		if _, exists := names[header.Name]; exists {
			return false
		}
		names[header.Name] = struct{}{}
	}
	return true
}

func validateFinalizeUploadRequest(request FinalizeUploadRequest) error {
	if !uuidV7Pattern.MatchString(request.DescriptorID) ||
		request.Protocol != "single_put" && request.Protocol != "multipart" ||
		request.ETag != nil && !validProviderReceipt(*request.ETag) ||
		request.ProviderVersion != nil && !validProviderVersion(*request.ProviderVersion) ||
		request.SizeBytes < 1 || request.SizeBytes > 10_737_418_240 ||
		!contentSHA256Pattern.MatchString(request.ContentSHA256) || !validCompletionParts(request.Protocol, request.Parts) {
		return invalidInput()
	}
	if request.Protocol == "single_put" && (request.ETag == nil || request.Parts[0].ETag != *request.ETag) ||
		request.Protocol == "multipart" && (request.ETag != nil || request.ProviderVersion != nil) {
		return invalidInput()
	}
	return nil
}

func validCompletionParts(protocol string, parts []DirectUploadPartCompletion) bool {
	if protocol == "single_put" && len(parts) != 1 || protocol == "multipart" && (len(parts) < 1 || len(parts) > 10_000) {
		return false
	}
	for index, part := range parts {
		if part.PartNumber != index+1 || !validProviderReceipt(part.ETag) {
			return false
		}
	}
	return true
}

func validProviderReceipt(value string) bool {
	return len(value) >= 1 && len(value) <= 256 && !hasControls(value) && strings.IndexFunc(value, func(r rune) bool { return r < '!' || r > '~' }) == -1
}

func validProviderVersion(value string) bool {
	return validProviderReceipt(value) && !strings.ContainsAny(value, "/?#\\")
}

func validTransferURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Fragment == "" &&
		len(value) <= 8192 && !hasControls(value) && !strings.Contains(value, "\\")
}

func validBrowserOrigin(value string) bool {
	parsed, err := parseEndpoint(value, true)
	if err != nil || parsed.Port() != "" {
		if err != nil {
			return false
		}
		port, portErr := strconv.Atoi(parsed.Port())
		if portErr != nil || port < 1 || port > 65535 {
			return false
		}
	}
	hostname := parsed.Hostname()
	return parsed.Scheme == "https" && browserHostPattern.MatchString(hostname) ||
		parsed.Scheme == "http" && (hostname == "localhost" || hostname == "127.0.0.1")
}

func validFileGeneration(generation FileGeneration) bool {
	return uuidV7Pattern.MatchString(generation.EntryID) && uuidV7Pattern.MatchString(generation.GenerationID) &&
		generation.GenerationNumber >= 1 && generation.ExpectedSizeBytes >= 1 && generation.ExpectedSizeBytes <= 10_737_418_240 &&
		contentSHA256Pattern.MatchString(generation.ContentSHA256) && mediaTypePattern.MatchString(generation.DeclaredMediaType) &&
		(generation.State == "pending_transfer" || generation.State == "aborted" || generation.State == "safety_pending" || generation.State == "available" || generation.State == "unavailable") &&
		(generation.MalwareScanRequirement == "not_required" || generation.MalwareScanRequirement == "required") &&
		(generation.SafetyState == "not_required" || generation.SafetyState == "scan_pending" || generation.SafetyState == "clean" || generation.SafetyState == "blocked") &&
		generation.Revision >= 1 && validTimestamp(generation.CreatedAt)
}

func validateCapabilityResource(resource CapabilityResource) error {
	switch resource.Kind {
	case "collection":
		if resource.PathPrefix != "" || resource.EntryID != "" {
			return invalidInput()
		}
	case "prefix":
		if !validLogicalPath(resource.PathPrefix) || resource.EntryID != "" {
			return invalidInput()
		}
	case "entry":
		if resource.PathPrefix != "" || !uuidV7Pattern.MatchString(resource.EntryID) {
			return invalidInput()
		}
	default:
		return invalidInput()
	}
	return nil
}

func validOperations(operations []string) bool {
	if len(operations) < 1 || len(operations) > 4 || !uniqueStrings(operations) {
		return false
	}
	for _, operation := range operations {
		if operation != "list" && operation != "metadata_read" && operation != "content_read" && operation != "search" {
			return false
		}
	}
	return true
}

func uniqueStrings(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func validOpaque(value string) bool {
	length := utf8.RuneCountInString(value)
	return length >= 1 && length <= 255 && value == strings.TrimSpace(value) && !hasControls(value)
}

func managementCollectionPath(reference CollectionReference, suffix string) (string, error) {
	if _, err := uuid(reference.TenantID); err != nil {
		return "", err
	}
	project, err := uuid(reference.ProjectID)
	if err != nil {
		return "", err
	}
	environment, err := uuid(reference.EnvironmentID)
	if err != nil {
		return "", err
	}
	collection, err := uuid(reference.CollectionInstanceID)
	if err != nil {
		return "", err
	}
	return "/v1/projects/" + project + "/environments/" + environment + "/collections/" + collection + suffix, nil
}
