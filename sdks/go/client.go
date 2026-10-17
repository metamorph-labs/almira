package almira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	uuidV7Pattern       = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	capabilityPattern   = regexp.MustCompile(`^alm_(?:cap|local)_v1\.[A-Za-z0-9_.-]{20,}$`)
	sharePattern        = regexp.MustCompile(`^alm_share_v1\.[A-Za-z0-9_-]{43}$`)
	apiErrorPattern     = regexp.MustCompile(`^ALMIRA_[A-Z0-9_]{1,120}$`)
	byteRangePattern    = regexp.MustCompile(`^bytes=[0-9]+-[0-9]*$`)
	variantPattern      = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$`)
	metadataNamePattern = regexp.MustCompile(`^[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])?$`)
	mediaTypePattern    = regexp.MustCompile(`^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$`)
	facetPattern        = regexp.MustCompile(`^(?:tags|verified_media_type|custom\.[a-z](?:[a-z0-9._-]{0,62}[a-z0-9])?)$`)
)

type CapabilityProvider func(context.Context) (string, error)

type ClientOptions struct {
	BaseURL            string
	Capability         string
	CapabilityProvider CapabilityProvider
	Origin             string
	Transport          http.RoundTripper
	Timeout            time.Duration
	Retry              *RetryPolicy
}

type Client struct {
	baseURL            string
	capability         string
	capabilityProvider CapabilityProvider
	origin             string
	http               *http.Client
	retry              RetryPolicy
}

func NewClient(options ClientOptions) (*Client, error) {
	base, err := parseEndpoint(options.BaseURL, false)
	if err != nil {
		return nil, invalidInput()
	}
	if options.Origin != "" {
		if _, err := parseEndpoint(options.Origin, true); err != nil {
			return nil, invalidInput()
		}
	}
	if options.Capability != "" && options.CapabilityProvider != nil {
		return nil, invalidInput()
	}
	timeout := options.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	if timeout < 0 || timeout > 5*time.Minute {
		return nil, invalidInput()
	}
	transport := options.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	retry := RetryPolicy{MaxAttempts: 1, BaseDelay: 100 * time.Millisecond, MaxDelay: 2 * time.Second}
	if options.Retry != nil {
		retry = *options.Retry
		if retry.MaxAttempts < 1 || retry.MaxAttempts > 5 || retry.BaseDelay < 0 ||
			retry.BaseDelay > 10*time.Second || retry.MaxDelay < retry.BaseDelay || retry.MaxDelay > time.Minute {
			return nil, invalidInput()
		}
	}
	return &Client{
		baseURL:            strings.TrimSuffix(base.String(), "/"),
		capability:         options.Capability,
		capabilityProvider: options.CapabilityProvider,
		origin:             options.Origin,
		http: &http.Client{
			Transport: transport,
			Timeout:   timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		retry: retry,
	}, nil
}

func (c *Client) ListFilesWithCapability(
	ctx context.Context,
	reference CollectionReference,
	options ListFilesOptions,
) (FileEntryPage, error) {
	query, err := listQuery(options)
	if err != nil {
		return FileEntryPage{}, err
	}
	path, err := collectionPath(reference, "/files")
	if err != nil {
		return FileEntryPage{}, err
	}
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return requestJSON[FileEntryPage](c, ctx, http.MethodGet, path, nil)
}

func (c *Client) SearchFilesWithCapability(
	ctx context.Context,
	reference CollectionReference,
	input SearchInput,
) (SearchPage, error) {
	if err := validateSearch(input); err != nil {
		return SearchPage{}, err
	}
	path, err := collectionPath(reference, "/search")
	if err != nil {
		return SearchPage{}, err
	}
	return requestJSON[SearchPage](c, ctx, http.MethodPost, path, input)
}

func (c *Client) GetFileMetadataWithCapability(
	ctx context.Context,
	reference FileReference,
) (FileEntry, error) {
	path, err := collectionPath(reference.CollectionReference, "/files")
	if err != nil {
		return FileEntry{}, err
	}
	entryID, err := uuid(reference.EntryID)
	if err != nil {
		return FileEntry{}, err
	}
	return requestJSON[FileEntry](c, ctx, http.MethodGet, path+"/"+entryID, nil)
}

func (c *Client) ListDerivativesWithCapability(
	ctx context.Context,
	reference ImmutableGenerationReference,
) ([]MediaDerivative, error) {
	path, err := generationDataPath(reference)
	if err != nil {
		return nil, err
	}
	return requestJSON[[]MediaDerivative](c, ctx, http.MethodGet, path+"/derivatives", nil)
}

func (c *Client) ReadImmutableGeneration(
	ctx context.Context,
	reference ImmutableGenerationReference,
	options ReadOptions,
) (*BinaryResponse, error) {
	path, err := deliveryPath(reference)
	if err != nil {
		return nil, err
	}
	return c.read(ctx, path, options, capabilityOptional)
}

func (c *Client) ReadDerivative(
	ctx context.Context,
	reference DerivativeReference,
	options ReadOptions,
) (*BinaryResponse, error) {
	path, err := deliveryPath(reference.ImmutableGenerationReference)
	if err != nil {
		return nil, err
	}
	variant, err := variant(reference.VariantKey)
	if err != nil {
		return nil, err
	}
	return c.read(ctx, path+"/variants/"+variant, options, capabilityOptional)
}

func (c *Client) ReadShare(
	ctx context.Context,
	shareToken string,
	options ReadOptions,
) (*BinaryResponse, error) {
	if !sharePattern.MatchString(shareToken) {
		return nil, invalidInput()
	}
	return c.read(ctx, "/v1/shares/"+shareToken, options, capabilityForbidden)
}

type capabilityMode uint8

const (
	capabilityRequired capabilityMode = iota
	capabilityOptional
	capabilityForbidden
)

func requestJSON[T any](
	c *Client,
	ctx context.Context,
	method string,
	path string,
	value any,
) (T, error) {
	var zero T
	var body []byte
	var err error
	if value != nil {
		body, err = json.Marshal(value)
		if err != nil {
			return zero, invalidInput()
		}
	}
	headers := make(http.Header)
	headers.Set("Accept", "application/json")
	if body != nil {
		headers.Set("Content-Type", "application/json")
	}
	response, err := c.do(ctx, method, path, headers, body, capabilityRequired)
	if err != nil {
		return zero, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
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

func (c *Client) read(
	ctx context.Context,
	path string,
	options ReadOptions,
	mode capabilityMode,
) (*BinaryResponse, error) {
	headers := make(http.Header)
	headers.Set("Accept", "application/octet-stream")
	if options.Range != "" {
		if len(options.Range) > 64 || !byteRangePattern.MatchString(options.Range) {
			return nil, invalidInput()
		}
		headers.Set("Range", options.Range)
	}
	if options.IfNoneMatch != "" {
		if len(options.IfNoneMatch) > 512 || strings.ContainsAny(options.IfNoneMatch, "\r\n") {
			return nil, invalidInput()
		}
		headers.Set("If-None-Match", options.IfNoneMatch)
	}
	response, err := c.do(ctx, http.MethodGet, path, headers, nil, mode)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK &&
		response.StatusCode != http.StatusPartialContent &&
		response.StatusCode != http.StatusNotModified {
		return nil, parseAPIError(response)
	}
	return &BinaryResponse{
		StatusCode:    response.StatusCode,
		Header:        response.Header.Clone(),
		Body:          response.Body,
		ContentLength: safeContentLength(response.Header.Get("Content-Length")),
		ContentRange:  response.Header.Get("Content-Range"),
		ContentType:   response.Header.Get("Content-Type"),
		ETag:          response.Header.Get("ETag"),
	}, nil
}

func (c *Client) do(
	ctx context.Context,
	method string,
	path string,
	headers http.Header,
	body []byte,
	mode capabilityMode,
) (*http.Response, error) {
	if ctx == nil {
		return nil, invalidInput()
	}
	for attempt := 1; attempt <= c.retry.MaxAttempts; attempt++ {
		requestHeaders := headers.Clone()
		if mode != capabilityForbidden && c.origin != "" {
			requestHeaders.Set("Origin", c.origin)
		}
		if mode != capabilityForbidden {
			capability := c.capability
			if c.capabilityProvider != nil {
				var err error
				capability, err = c.capabilityProvider(ctx)
				if err != nil {
					return nil, clientFailure("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE")
				}
			}
			if capability != "" {
				if !validCapability(capability) {
					return nil, invalidInput()
				}
				requestHeaders.Set("Authorization", "Bearer "+capability)
			} else if mode == capabilityRequired {
				return nil, invalidInput()
			}
		}
		request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
		if err != nil {
			return nil, invalidInput()
		}
		request.Header = requestHeaders
		response, err := c.http.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return nil, clientFailure("ALMIRA_CLIENT_ABORTED")
			}
			if attempt == c.retry.MaxAttempts {
				return nil, clientFailure("ALMIRA_CLIENT_NETWORK")
			}
			if err := waitForRetry(ctx, retryDelay(c.retry, attempt, "")); err != nil {
				return nil, err
			}
			continue
		}
		if response == nil || response.Body == nil || response.StatusCode < 100 || response.StatusCode > 599 {
			if response != nil && response.Body != nil {
				response.Body.Close()
			}
			return nil, invalidResponse()
		}
		if attempt == c.retry.MaxAttempts || !retryableStatus(response.StatusCode) {
			return response, nil
		}
		response.Body.Close()
		if err := waitForRetry(ctx, retryDelay(c.retry, attempt, response.Header.Get("Retry-After"))); err != nil {
			return nil, err
		}
	}
	return nil, clientFailure("ALMIRA_CLIENT_NETWORK")
}

func retryableStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func retryDelay(policy RetryPolicy, failedAttempt int, retryAfterHeader string) time.Duration {
	if seconds := retryAfter(retryAfterHeader); seconds != nil {
		return min(time.Duration(*seconds)*time.Second, policy.MaxDelay)
	}
	delay := policy.BaseDelay
	for attempt := 1; attempt < failedAttempt && delay < policy.MaxDelay; attempt++ {
		delay = min(delay*2, policy.MaxDelay)
	}
	return delay
}

func waitForRetry(ctx context.Context, delay time.Duration) error {
	if delay == 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return clientFailure("ALMIRA_CLIENT_ABORTED")
	}
}

func parseAPIError(response *http.Response) error {
	raw, err := boundedBody(response, 64*1024)
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 2 {
		return invalidResponse()
	}
	var code, requestID string
	if json.Unmarshal(fields["code"], &code) != nil ||
		json.Unmarshal(fields["request_id"], &requestID) != nil ||
		!apiErrorPattern.MatchString(code) || !uuidV7Pattern.MatchString(requestID) {
		return invalidResponse()
	}
	return &APIError{
		Code:              code,
		RequestID:         requestID,
		StatusCode:        response.StatusCode,
		RetryAfterSeconds: retryAfter(response.Header.Get("Retry-After")),
	}
}

func boundedBody(response *http.Response, limit int64) ([]byte, error) {
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, clientFailure("ALMIRA_CLIENT_NETWORK")
	}
	if len(raw) == 0 || int64(len(raw)) > limit {
		return nil, invalidResponse()
	}
	return raw, nil
}

func listQuery(options ListFilesOptions) (url.Values, error) {
	query := make(url.Values)
	if options.Limit != 0 {
		if options.Limit < 1 || options.Limit > 100 {
			return nil, invalidInput()
		}
		query.Set("limit", strconv.Itoa(options.Limit))
	}
	if options.Cursor != "" {
		if len(options.Cursor) > 2048 {
			return nil, invalidInput()
		}
		query.Set("cursor", options.Cursor)
	}
	if options.PathPrefix != "" {
		if !validLogicalPath(options.PathPrefix) {
			return nil, invalidInput()
		}
		query.Set("path_prefix", options.PathPrefix)
	}
	filter := FileMetadataFilter{
		Tag: options.Tag, MetadataKey: options.MetadataKey, MetadataValue: options.MetadataValue,
		VerifiedMediaType: options.VerifiedMediaType, MinimumSizeBytes: options.MinimumSizeBytes,
		MaximumSizeBytes: options.MaximumSizeBytes, CreatedAfter: options.CreatedAfter,
		CreatedBefore: options.CreatedBefore, ExtractionKind: options.ExtractionKind,
		ExtractionState: options.ExtractionState,
	}
	if err := validateFilter(filter); err != nil {
		return nil, err
	}
	if options.Tag != "" {
		query.Set("tag", options.Tag)
	}
	if options.MetadataKey != "" {
		encoded, _ := json.Marshal(options.MetadataValue)
		query.Set("metadata_key", options.MetadataKey)
		query.Set("metadata_value", string(encoded))
	}
	if options.VerifiedMediaType != "" {
		query.Set("verified_media_type", options.VerifiedMediaType)
	}
	if options.MinimumSizeBytes != 0 {
		query.Set("minimum_size_bytes", strconv.FormatInt(options.MinimumSizeBytes, 10))
	}
	if options.MaximumSizeBytes != 0 {
		query.Set("maximum_size_bytes", strconv.FormatInt(options.MaximumSizeBytes, 10))
	}
	if options.CreatedAfter != "" {
		query.Set("created_after", options.CreatedAfter)
	}
	if options.CreatedBefore != "" {
		query.Set("created_before", options.CreatedBefore)
	}
	if options.ExtractionKind != "" {
		query.Set("extraction_kind", options.ExtractionKind)
		query.Set("extraction_state", options.ExtractionState)
	}
	return query, nil
}

func validateSearch(input SearchInput) error {
	if input.Query == "" || input.Query != strings.TrimSpace(input.Query) ||
		len([]byte(input.Query)) > 1024 || hasControls(input.Query) {
		return invalidInput()
	}
	if input.Mode != "" && input.Mode != "lexical" && input.Mode != "semantic" && input.Mode != "hybrid" {
		return invalidInput()
	}
	if input.PathPrefix != "" && !validLogicalPath(input.PathPrefix) {
		return invalidInput()
	}
	if input.PageSize < 0 || input.PageSize > 50 || input.Cursor != "" && len(input.Cursor) > 8192 {
		return invalidInput()
	}
	seen := make(map[string]struct{}, len(input.Facets))
	if len(input.Facets) > 8 {
		return invalidInput()
	}
	for _, facet := range input.Facets {
		if !facetPattern.MatchString(facet) {
			return invalidInput()
		}
		if _, exists := seen[facet]; exists {
			return invalidInput()
		}
		seen[facet] = struct{}{}
	}
	if input.Filter != nil {
		return validateFilter(*input.Filter)
	}
	return nil
}

func validateFilter(filter FileMetadataFilter) error {
	if filter.Tag != "" && !metadataNamePattern.MatchString(filter.Tag) ||
		filter.MetadataKey != "" && !metadataNamePattern.MatchString(filter.MetadataKey) ||
		(filter.MetadataKey == "") != (filter.MetadataValue == nil) ||
		filter.MetadataValue != nil && !validMetadataValue(filter.MetadataValue) ||
		filter.VerifiedMediaType != "" && !mediaTypePattern.MatchString(filter.VerifiedMediaType) ||
		filter.MinimumSizeBytes < 0 || filter.MaximumSizeBytes < 0 ||
		filter.MinimumSizeBytes > 10_737_418_240 || filter.MaximumSizeBytes > 10_737_418_240 ||
		filter.MinimumSizeBytes != 0 && filter.MaximumSizeBytes != 0 && filter.MinimumSizeBytes > filter.MaximumSizeBytes ||
		filter.CreatedAfter != "" && !validTimestamp(filter.CreatedAfter) ||
		filter.CreatedBefore != "" && !validTimestamp(filter.CreatedBefore) ||
		(filter.ExtractionKind == "") != (filter.ExtractionState == "") {
		return invalidInput()
	}
	if filter.ExtractionKind != "" &&
		filter.ExtractionKind != "technical" && filter.ExtractionKind != "content" &&
		filter.ExtractionKind != "ocr" && filter.ExtractionKind != "transcription" {
		return invalidInput()
	}
	if filter.ExtractionState != "" &&
		filter.ExtractionState != "pending" && filter.ExtractionState != "running" &&
		filter.ExtractionState != "succeeded" && filter.ExtractionState != "failed" &&
		filter.ExtractionState != "unsupported" {
		return invalidInput()
	}
	return nil
}

func validMetadataValue(value any) bool {
	switch typed := value.(type) {
	case bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32:
		return true
	case uint64:
		return typed <= uint64(^uint64(0)>>1)
	case string:
		length := utf8.RuneCountInString(typed)
		return length >= 1 && length <= 512
	default:
		return false
	}
}

func validCapability(value string) bool {
	separator := strings.IndexByte(value, '.')
	return capabilityPattern.MatchString(value) && separator >= 0 && len(value)-separator-1 <= 24_576
}

func parseEndpoint(value string, origin bool) (*url.URL, error) {
	if value == "" || hasControls(value) {
		return nil, errors.New("invalid endpoint")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
		parsed.Opaque != "" || parsed.ForceQuery || parsed.Path != "" && parsed.Path != "/" {
		return nil, errors.New("invalid endpoint")
	}
	if origin && parsed.Path != "" {
		return nil, errors.New("invalid origin")
	}
	return parsed, nil
}

func collectionPath(reference CollectionReference, suffix string) (string, error) {
	tenant, err := uuid(reference.TenantID)
	if err != nil {
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
	return fmt.Sprintf("/v1/data/%s/%s/%s/%s%s", tenant, project, environment, collection, suffix), nil
}

func generationDataPath(reference ImmutableGenerationReference) (string, error) {
	path, err := collectionPath(reference.CollectionReference, "/files")
	if err != nil {
		return "", err
	}
	entry, err := uuid(reference.EntryID)
	if err != nil {
		return "", err
	}
	generation, err := uuid(reference.GenerationID)
	if err != nil {
		return "", err
	}
	return path + "/" + entry + "/versions/" + generation, nil
}

func deliveryPath(reference ImmutableGenerationReference) (string, error) {
	values := []string{reference.TenantID, reference.ProjectID, reference.EnvironmentID,
		reference.CollectionInstanceID, reference.EntryID, reference.GenerationID}
	for index, value := range values {
		parsed, err := uuid(value)
		if err != nil {
			return "", err
		}
		values[index] = parsed
	}
	return "/v1/delivery/" + strings.Join(values, "/"), nil
}

func uuid(value string) (string, error) {
	if !uuidV7Pattern.MatchString(value) {
		return "", invalidInput()
	}
	return value, nil
}

func variant(value string) (string, error) {
	if len(value) == 0 || len(value) > 160 || !variantPattern.MatchString(value) ||
		strings.Contains(value, "//") {
		return "", invalidInput()
	}
	parts := strings.Split(value, "/")
	for index, part := range parts {
		if part == "." || part == ".." {
			return "", invalidInput()
		}
		parts[index] = url.PathEscape(part)
	}
	return strings.Join(parts, "/"), nil
}

func validLogicalPath(value string) bool {
	if value == "" || len(value) > 1024 {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || len(part) > 255 {
			return false
		}
		for _, character := range part {
			if !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' ||
				character >= '0' && character <= '9' || strings.ContainsRune("._~-", character)) {
				return false
			}
		}
	}
	return true
}

func validTimestamp(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func hasControls(value string) bool {
	for _, character := range value {
		if character <= 32 || character == 127 {
			return true
		}
	}
	return false
}

func retryAfter(value string) *int {
	if value == "" || len(value) > 8 {
		return nil
	}
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds < 0 {
		return nil
	}
	return &seconds
}

func safeContentLength(value string) *int64 {
	if value == "" || len(value) > 16 || value[0] == '-' || len(value) > 1 && value[0] == '0' {
		return nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 || parsed > 9_007_199_254_740_991 {
		return nil
	}
	return &parsed
}

func clientFailure(code string) error { return &ClientError{Code: code} }
func invalidInput() error             { return clientFailure("ALMIRA_CLIENT_INPUT_INVALID") }
func invalidResponse() error          { return clientFailure("ALMIRA_CLIENT_RESPONSE_INVALID") }
