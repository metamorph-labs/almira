package almira

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	tenantID      = "018f0000-0000-7000-8000-000000000002"
	projectID     = "018f0000-0000-7000-8000-000000000003"
	environmentID = "018f0000-0000-7000-8000-000000000004"
	collectionID  = "018f0000-0000-7000-8000-000000000005"
	entryID       = "018f0000-0000-7000-8000-000000000006"
	generationID  = "018f0000-0000-7000-8000-000000000007"
	requestID     = "018f0000-0000-7000-8000-000000000008"
	capability    = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
)

var (
	collection = CollectionReference{tenantID, projectID, environmentID, collectionID}
	file       = FileReference{collection, entryID}
	generation = ImmutableGenerationReference{file, generationID}
)

type recordedCall struct {
	method string
	path   string
	query  map[string][]string
	header http.Header
	body   string
}

func TestMethodsAndVersionCoverPromotedContractExactly(t *testing.T) {
	raw, err := os.ReadFile("../../contracts/data-openapi.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Info struct {
			Version string `json:"version"`
		} `json:"info"`
		Paths map[string]map[string]struct {
			OperationID string `json:"operationId"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatal(err)
	}
	var operations []string
	for _, path := range contract.Paths {
		for _, operation := range path {
			if operation.OperationID != "" {
				operations = append(operations, strings.ToUpper(operation.OperationID[:1])+operation.OperationID[1:])
			}
		}
	}
	typeOfClient := reflect.TypeOf((*Client)(nil))
	methods := make([]string, 0, typeOfClient.NumMethod())
	for index := 0; index < typeOfClient.NumMethod(); index++ {
		methods = append(methods, typeOfClient.Method(index).Name)
	}
	sort.Strings(operations)
	sort.Strings(methods)
	if ContractVersion != contract.Info.Version {
		t.Fatalf("version %q != %q", ContractVersion, contract.Info.Version)
	}
	if !reflect.DeepEqual(methods, operations) {
		t.Fatalf("methods %v != operations %v", methods, operations)
	}
}

func TestExactRoutesFiltersStreamingAndCredentialFreeShare(t *testing.T) {
	var mutex sync.Mutex
	var calls []recordedCall
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		mutex.Lock()
		calls = append(calls, recordedCall{request.Method, request.URL.Path, request.URL.Query(), request.Header.Clone(), string(raw)})
		mutex.Unlock()
		if strings.Contains(request.URL.Path, "/delivery/") || strings.Contains(request.URL.Path, "/shares/") {
			response.Header().Set("Content-Type", "text/plain")
			response.Header().Set("Content-Length", "5")
			response.Header().Set("ETag", `"v1"`)
			response.WriteHeader(http.StatusPartialContent)
			_, _ = response.Write([]byte("hello"))
			return
		}
		response.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(request.URL.Path, "/search"):
			_, _ = response.Write([]byte(`{"items":[],"facets":[],"next_cursor":null,"facet_coverage":"returned_page","consistency":"eventual_projection_authoritative_recheck"}`))
		case strings.HasSuffix(request.URL.Path, "/derivatives"):
			_, _ = response.Write([]byte(`[]`))
		case strings.HasSuffix(request.URL.Path, "/files/"+entryID):
			_, _ = response.Write([]byte(`{}`))
		default:
			_, _ = response.Write([]byte(`{"entries":[],"next_cursor":null}`))
		}
	}))
	defer server.Close()

	client, err := NewClient(ClientOptions{BaseURL: server.URL, Capability: capability, Origin: "https://app.example"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListFilesWithCapability(context.Background(), collection, ListFilesOptions{
		Limit: 25, Cursor: "next page", PathPrefix: "avatars", Tag: "profile.photo",
		MetadataKey: "account.tier", MetadataValue: "pro", VerifiedMediaType: "image/jpeg",
		MinimumSizeBytes: 10, MaximumSizeBytes: 5000,
		CreatedAfter: "2026-01-01T00:00:00Z", CreatedBefore: "2026-02-01T00:00:00Z",
		ExtractionKind: "technical", ExtractionState: "succeeded",
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetFileMetadataWithCapability(context.Background(), file)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.SearchFilesWithCapability(context.Background(), collection, SearchInput{Query: "portrait", Mode: "hybrid"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListDerivativesWithCapability(context.Background(), generation)
	if err != nil {
		t.Fatal(err)
	}
	stream, err := client.ReadImmutableGeneration(context.Background(), generation, ReadOptions{Range: "bytes=0-4", IfNoneMatch: `"old"`})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(stream.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = stream.Body.Close()
	if string(raw) != "hello" || stream.ContentLength == nil || *stream.ContentLength != 5 {
		t.Fatalf("unexpected stream: %q %#v", raw, stream.ContentLength)
	}
	derivative := DerivativeReference{generation, "hls/720p/segment-1.m4s"}
	derived, err := client.ReadDerivative(context.Background(), derivative, ReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_ = derived.Body.Close()
	share, err := client.ReadShare(context.Background(), "alm_share_v1."+strings.Repeat("b", 43), ReadOptions{})
	if err != nil {
		t.Fatal(err)
	}
	_ = share.Body.Close()

	base := "/v1/data/" + tenantID + "/" + projectID + "/" + environmentID + "/" + collectionID
	if calls[0].method != http.MethodGet || calls[0].path != base+"/files" {
		t.Fatalf("list route: %#v", calls[0])
	}
	wantQuery := map[string][]string{
		"limit": {"25"}, "cursor": {"next page"}, "path_prefix": {"avatars"}, "tag": {"profile.photo"},
		"metadata_key": {"account.tier"}, "metadata_value": {`"pro"`}, "verified_media_type": {"image/jpeg"},
		"minimum_size_bytes": {"10"}, "maximum_size_bytes": {"5000"},
		"created_after": {"2026-01-01T00:00:00Z"}, "created_before": {"2026-02-01T00:00:00Z"},
		"extraction_kind": {"technical"}, "extraction_state": {"succeeded"},
	}
	if !reflect.DeepEqual(calls[0].query, wantQuery) {
		t.Fatalf("query: %#v", calls[0].query)
	}
	if calls[1].path != base+"/files/"+entryID || calls[2].path != base+"/search" ||
		calls[3].path != base+"/files/"+entryID+"/versions/"+generationID+"/derivatives" {
		t.Fatalf("data routes: %#v", calls[:4])
	}
	if calls[4].header.Get("Range") != "bytes=0-4" || !strings.HasSuffix(calls[5].path, "/variants/hls/720p/segment-1.m4s") {
		t.Fatalf("delivery calls: %#v", calls[4:6])
	}
	for _, call := range calls[:6] {
		if call.header.Get("Authorization") != "Bearer "+capability || call.header.Get("Origin") != "https://app.example" {
			t.Fatalf("missing capability scope: %#v", call.header)
		}
	}
	if calls[6].header.Get("Authorization") != "" || calls[6].header.Get("Origin") != "" {
		t.Fatalf("share leaked credentials: %#v", calls[6].header)
	}
}

func TestInvalidInputFailsBeforeTransport(t *testing.T) {
	transport := roundTripperFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("transport must not be called")
		return nil, nil
	})
	client, err := NewClient(ClientOptions{BaseURL: "https://almira.test", Capability: capability, Transport: transport})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.ListFilesWithCapability(context.Background(), collection, ListFilesOptions{MetadataKey: "tier"})
	assertClientCode(t, err, "ALMIRA_CLIENT_INPUT_INVALID")
	_, err = client.ReadDerivative(context.Background(), DerivativeReference{generation, "../secret"}, ReadOptions{})
	assertClientCode(t, err, "ALMIRA_CLIENT_INPUT_INVALID")
	if _, err := NewClient(ClientOptions{BaseURL: "https://almira.test", Origin: "https://app.example\nforwarded: bad"}); err == nil {
		t.Fatal("origin injection was accepted")
	}
}

func TestAPIErrorsAndTransportFailuresAreTypedAndRedacted(t *testing.T) {
	apiTransport := roundTripperFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: 403,
			Header:     http.Header{"Retry-After": {"7"}},
			Body:       io.NopCloser(strings.NewReader(`{"code":"ALMIRA_CAPABILITY_REFUSED","request_id":"` + requestID + `"}`)),
		}, nil
	})
	client, err := NewClient(ClientOptions{BaseURL: "https://almira.test", Capability: capability, Transport: apiTransport})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetFileMetadataWithCapability(context.Background(), file)
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Code != "ALMIRA_CAPABILITY_REFUSED" ||
		apiError.RequestID != requestID || apiError.RetryAfterSeconds == nil || *apiError.RetryAfterSeconds != 7 {
		t.Fatalf("unexpected API error: %#v", err)
	}

	secret := errors.New("signed URL and secret details")
	failing, err := NewClient(ClientOptions{
		BaseURL: "https://almira.test", Capability: capability,
		Transport: roundTripperFunc(func(*http.Request) (*http.Response, error) { return nil, secret }),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = failing.GetFileMetadataWithCapability(context.Background(), file)
	assertClientCode(t, err, "ALMIRA_CLIENT_NETWORK")
	if strings.Contains(err.Error(), secret.Error()) {
		t.Fatal("transport detail leaked")
	}
}

func TestCredentialProviderFailureIsRedacted(t *testing.T) {
	client, err := NewClient(ClientOptions{
		BaseURL:            "https://almira.test",
		CapabilityProvider: func(context.Context) (string, error) { return "", errors.New("secret detail") },
		Transport:          roundTripperFunc(func(*http.Request) (*http.Response, error) { t.Fatal("transport called"); return nil, nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.GetFileMetadataWithCapability(context.Background(), file)
	assertClientCode(t, err, "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE")
	if strings.Contains(err.Error(), "secret detail") {
		t.Fatal("credential detail leaked")
	}
}

func TestOptInRetryReResolvesCapabilityAndReplaysSafeRequest(t *testing.T) {
	credentialCalls := 0
	transportCalls := 0
	var authorizations []string
	client, err := NewClient(ClientOptions{
		BaseURL: "https://almira.test",
		CapabilityProvider: func(context.Context) (string, error) {
			credentialCalls++
			return "alm_cap_v1." + strings.Repeat("a", 42) + strconv.Itoa(credentialCalls), nil
		},
		Retry: &RetryPolicy{MaxAttempts: 3, BaseDelay: 0, MaxDelay: 0},
		Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			transportCalls++
			authorizations = append(authorizations, request.Header.Get("Authorization"))
			status := http.StatusOK
			body := `{}`
			if transportCalls == 1 {
				status = http.StatusServiceUnavailable
				body = `{"code":"ALMIRA_TEMPORARILY_UNAVAILABLE","request_id":"` + requestID + `"}`
			}
			return &http.Response{
				StatusCode: status,
				Header: http.Header{
					"Content-Type": {"application/json"},
					"Retry-After":  {"0"},
				},
				Body: io.NopCloser(strings.NewReader(body)),
			}, nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetFileMetadataWithCapability(context.Background(), file); err != nil {
		t.Fatal(err)
	}
	if credentialCalls != 2 || transportCalls != 2 || len(authorizations) != 2 ||
		authorizations[0] == authorizations[1] {
		t.Fatalf("retry did not refresh exact request authority: %d %d %#v", credentialCalls, transportCalls, authorizations)
	}
}

func TestWorkloadExchangeReturnsCapabilityOnlyClientAndRevokesExactly(t *testing.T) {
	var calls []recordedCall
	transport := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(request.Body)
		calls = append(calls, recordedCall{
			method: request.Method, path: request.URL.Path, header: request.Header.Clone(), body: string(raw),
		})
		status := http.StatusOK
		body := `{}`
		switch {
		case request.Method == http.MethodPost:
			status = http.StatusCreated
			body = `{"session_id":"` + requestID + `","token":"` + capability + `","operations":["metadata_read"],"resource":{"kind":"collection"},"audience":"https://app.example","policy_revision":1,"issuer_epoch":1,"expires_at":"2026-10-17T12:00:00Z"}`
		case request.Method == http.MethodDelete:
			body = `"applied"`
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	server, err := NewServerClient(ServerClientOptions{
		BaseURL: "https://almira.test", WorkloadSession: "workload_session_evidence", Transport: transport,
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := server.CreateCapabilityDataClient(
		context.Background(),
		collection,
		CreateCapabilitySessionRequest{
			Subject:    BuilderSubject{SubjectID: "user_42", Roles: []string{}, Attributes: map[string]string{}},
			Operations: []string{"metadata_read"}, Resource: CapabilityResource{Kind: "collection"},
			Audience: "https://app.example", LifetimeSeconds: 300,
		},
		generationID,
		CapabilityDataClientOptions{Transport: transport},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.DataClient.GetFileMetadataWithCapability(context.Background(), file); err != nil {
		t.Fatal(err)
	}
	if disposition, err := server.RevokeCapabilitySession(context.Background(), collection, requestID, generationID); err != nil || disposition != "applied" {
		t.Fatalf("revoke = %q, %v", disposition, err)
	}
	if len(calls) != 3 {
		t.Fatalf("calls = %#v", calls)
	}
	if strings.Contains(fmt.Sprintf("%#v", session), capability) || strings.Contains(fmt.Sprintf("%#v", session.Grant), capability) {
		t.Fatal("capability grant leaked through formatting")
	}
	if calls[0].header.Get("Authorization") != "MetamorphWorkload workload_session_evidence" ||
		calls[0].header.Get("X-Almira-Tenant-Id") != tenantID {
		t.Fatalf("wrong exchange authority: %#v", calls[0].header)
	}
	if calls[1].header.Get("Authorization") != "Bearer "+capability ||
		calls[1].header.Get("Origin") != "https://app.example" ||
		calls[1].header.Get("X-Almira-Tenant-Id") != "" {
		t.Fatalf("credential crossover: %#v", calls[1].header)
	}
	if calls[2].method != http.MethodDelete || calls[2].header.Get("Authorization") != "MetamorphWorkload workload_session_evidence" {
		t.Fatalf("wrong revoke request: %#v", calls[2])
	}
}

func TestServerUploadCreateAndFinalizePreserveDescriptorEvidence(t *testing.T) {
	descriptorID := "018f0000-0000-7000-8000-000000000011"
	contentSHA256 := "sha256:" + strings.Repeat("a", 64)
	var calls []recordedCall
	transport := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(request.Body)
		calls = append(calls, recordedCall{method: request.Method, path: request.URL.Path, header: request.Header.Clone(), body: string(raw)})
		status := http.StatusOK
		body := `{"entry_id":"` + entryID + `","generation_id":"` + generationID + `","generation_number":1,"state":"available","expected_size_bytes":5,"content_sha256":"` + contentSHA256 + `","declared_media_type":"text/plain","malware_scan_requirement":"required","safety_state":"clean","revision":1,"created_at":"2026-10-17T12:00:00Z"}`
		if strings.HasSuffix(request.URL.Path, "/uploads") {
			status = http.StatusCreated
			body = `{"transfer_session_id":"` + requestID + `","entry_id":"` + entryID + `","generation_id":"` + generationID + `","descriptor":{"descriptor_id":"` + descriptorID + `","protocol":"single_put","requests":[{"part_number":1,"offset_bytes":0,"length_bytes":5,"method":"PUT","url":"https://objects.example/one-use-secret","headers":[{"name":"content-type","value":"text/plain"}],"one_use":true}],"expected_size_bytes":5,"content_sha256":"` + contentSHA256 + `","one_use":true,"expires_at":"2026-10-17T12:00:00Z"}}`
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	server, err := NewServerClient(ServerClientOptions{
		BaseURL: "https://almira.test", WorkloadSession: "workload_session_evidence", Transport: transport,
	})
	if err != nil {
		t.Fatal(err)
	}
	created, err := server.CreateUpload(context.Background(), collection, CreateUploadRequest{
		Path: "avatars/me.txt", ExpectedSizeBytes: 5, ContentSHA256: contentSHA256, DeclaredMediaType: "text/plain",
	}, generationID)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fmt.Sprintf("%#v", created), "one-use-secret") || strings.Contains(fmt.Sprintf("%#v", created.Descriptor), "one-use-secret") {
		t.Fatal("descriptor bearer leaked through formatting")
	}
	etag := `"etag-one"`
	providerVersion := "provider-v1"
	finalized, err := server.FinalizeUpload(context.Background(), collection, created.TransferSessionID, FinalizeUploadRequest{
		DescriptorID: descriptorID, Protocol: "single_put", ETag: &etag, ProviderVersion: &providerVersion,
		Parts: []DirectUploadPartCompletion{{PartNumber: 1, ETag: etag}}, SizeBytes: 5, ContentSHA256: contentSHA256,
	}, generationID)
	if err != nil {
		t.Fatal(err)
	}
	if finalized.State != "available" || len(calls) != 2 || !strings.HasSuffix(calls[0].path, "/uploads") ||
		!strings.HasSuffix(calls[1].path, "/uploads/"+requestID+"/finalize") {
		t.Fatalf("unexpected upload flow: %#v %#v", finalized, calls)
	}
	var completion map[string]any
	if err := json.Unmarshal([]byte(calls[1].body), &completion); err != nil {
		t.Fatal(err)
	}
	if completion["descriptor_id"] != descriptorID || completion["etag"] != etag || completion["provider_version"] != providerVersion {
		t.Fatalf("completion evidence drifted: %#v", completion)
	}
}

func TestWorkloadSubjectBindingsAreNamespacedAndOperationScoped(t *testing.T) {
	subject := SubjectReference{Namespace: "auth0:primary", SubjectID: "opaque|user-42"}
	binding := fmt.Sprintf(
		`{"binding_id":"%s","subject":{"namespace":"auth0:primary","subject_id":"opaque|user-42"},"environment_id":"%s","collection_instance_id":"%s","entry_id":"%s","entry_lifecycle":"active","created_at":"2026-10-17T12:00:00Z"}`,
		requestID, environmentID, collectionID, entryID,
	)
	var calls []recordedCall
	transport := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(request.Body)
		calls = append(calls, recordedCall{
			method: request.Method, path: request.URL.Path, header: request.Header.Clone(), body: string(raw),
		})
		status := http.StatusOK
		body := `{"items":[` + binding + `],"next_cursor":null}`
		if strings.HasSuffix(request.URL.Path, "/files/"+entryID+"/subject-bindings") {
			status = http.StatusCreated
			body = `{"disposition":"applied","binding":` + binding + `}`
		}
		return &http.Response{
			StatusCode: status,
			Header:     http.Header{"Content-Type": {"application/json"}},
			Body:       io.NopCloser(strings.NewReader(body)),
		}, nil
	})
	server, err := NewServerClient(ServerClientOptions{
		BaseURL: "https://almira.test", WorkloadSession: "workload_session", Transport: transport,
	})
	if err != nil {
		t.Fatal(err)
	}
	collection := CollectionReference{TenantID: tenantID, ProjectID: projectID, EnvironmentID: environmentID, CollectionInstanceID: collectionID}
	outcome, err := server.BindSubject(
		context.Background(), FileReference{CollectionReference: collection, EntryID: entryID}, subject, requestID,
	)
	if err != nil {
		t.Fatal(err)
	}
	page, err := server.ListSubjectBindings(
		context.Background(), SubjectProjectReference{TenantID: tenantID, ProjectID: projectID}, subject,
		SubjectBindingPageOptions{Limit: 25, Cursor: "next"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Binding.EntryID != entryID || len(page.Items) != 1 || strings.Contains(fmt.Sprintf("%#v", subject), subject.SubjectID) {
		t.Fatalf("subject binding response or redaction drifted: %#v %#v", outcome, page)
	}
	if len(calls) != 2 || calls[0].header.Get("Idempotency-Key") != requestID ||
		calls[1].header.Get("Idempotency-Key") != "" ||
		calls[0].header.Get("Authorization") != "MetamorphWorkload workload_session" ||
		calls[1].path != "/v1/projects/"+projectID+"/subject-bindings/search" {
		t.Fatalf("subject binding request drifted: %#v", calls)
	}
}

func TestDirectUploadStreamsExactPartsWithoutAlmiraCredentials(t *testing.T) {
	contentSHA256 := "sha256:" + strings.Repeat("a", 64)
	descriptor := DirectUploadDescriptor{
		DescriptorID: "018f0000-0000-7000-8000-000000000011",
		Protocol:     "multipart",
		Requests: []DirectUploadPart{
			{PartNumber: 1, OffsetBytes: 0, LengthBytes: 2, Method: "PUT", URL: "https://objects.example/secret-one", Headers: []DirectUploadHeader{{Name: "content-type", Value: "text/plain"}}, OneUse: true},
			{PartNumber: 2, OffsetBytes: 2, LengthBytes: 3, Method: "PUT", URL: "https://objects.example/secret-two", Headers: []DirectUploadHeader{{Name: "content-type", Value: "text/plain"}}, OneUse: true},
		},
		ExpectedSizeBytes: 5, ContentSHA256: contentSHA256, OneUse: true, ExpiresAt: "2026-10-17T12:00:00Z",
	}
	var transferred [][]byte
	transport := roundTripperFunc(func(request *http.Request) (*http.Response, error) {
		raw, _ := io.ReadAll(request.Body)
		if request.Header.Get("Authorization") != "" || request.ContentLength != int64(len(raw)) {
			t.Fatalf("credential crossover or length drift: %#v", request.Header)
		}
		transferred = append(transferred, raw)
		headers := make(http.Header)
		headers.Set("ETag", fmt.Sprintf(`"part-%d"`, len(transferred)))
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     headers,
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	})
	completion, err := UploadDirect(
		context.Background(), descriptor, bytes.NewReader([]byte("hello")), 5,
		DirectUploadOptions{Transport: transport, Now: func() time.Time {
			return time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(transferred) != 2 || string(transferred[0]) != "he" || string(transferred[1]) != "llo" ||
		completion.ETag != nil || completion.ProviderVersion != nil || len(completion.Parts) != 2 {
		t.Fatalf("direct transfer drifted: %#v %#v", transferred, completion)
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (function roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func assertClientCode(t *testing.T, err error, code string) {
	t.Helper()
	var clientError *ClientError
	if !errors.As(err, &clientError) || clientError.Code != code {
		t.Fatalf("error %#v does not have code %s", err, code)
	}
}
