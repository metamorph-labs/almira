package almira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	workloadSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	labelPattern           = regexp.MustCompile(`^[a-z][a-z0-9._:-]{0,63}$`)
)

type WorkloadSessionProvider func(context.Context) (string, error)

type BuilderSubject struct {
	SubjectID      string            `json:"subject_id"`
	OrganizationID *string           `json:"organization_id,omitempty"`
	Roles          []string          `json:"roles"`
	Attributes     map[string]string `json:"attributes"`
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

type ServerClient struct {
	baseURL                 string
	workloadSession         string
	workloadSessionProvider WorkloadSessionProvider
	http                    *http.Client
}

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
	expectedStatus int,
) (T, error) {
	var zero T
	if ctx == nil {
		return zero, invalidInput()
	}
	tenantID, err := uuid(tenantID)
	if err != nil {
		return zero, err
	}
	operationID, err = uuid(operationID)
	if err != nil {
		return zero, err
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
	request.Header.Set("Idempotency-Key", operationID)
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
	if response.StatusCode != expectedStatus {
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
