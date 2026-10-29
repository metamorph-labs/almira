package almira

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type conformanceRoundTripper func(*http.Request) (*http.Response, error)

func (transport conformanceRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestCommonManagedDevelopmentJourney(t *testing.T) {
	raw, err := os.ReadFile("../../conformance/application-sdk.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var common struct {
		Managed struct {
			BaseURL   string `json:"base_url"`
			Origin    string `json:"origin"`
			Reference struct {
				TenantID             string `json:"tenant_id"`
				ProjectID            string `json:"project_id"`
				EnvironmentID        string `json:"environment_id"`
				CollectionInstanceID string `json:"collection_instance_id"`
				EntryID              string `json:"entry_id"`
			} `json:"reference"`
			Positive struct {
				Capability string          `json:"capability"`
				Response   json.RawMessage `json:"response"`
			} `json:"positive"`
			Refusal struct {
				Credential string `json:"credential"`
				ClientCode string `json:"client_code"`
			} `json:"refusal"`
			Retry struct {
				Capabilities      []string        `json:"capabilities"`
				FirstStatus       int             `json:"first_status"`
				FirstError        json.RawMessage `json:"first_error"`
				RetryAfterSeconds int             `json:"retry_after_seconds"`
				FinalStatus       int             `json:"final_status"`
			} `json:"retry"`
			Cleanup struct {
				Applicable bool   `json:"applicable"`
				Reason     string `json:"reason"`
			} `json:"cleanup"`
		} `json:"managed_development"`
	}
	if err := json.Unmarshal(raw, &common); err != nil {
		t.Fatal(err)
	}
	journey := common.Managed
	reference := FileReference{CollectionReference{
		TenantID: journey.Reference.TenantID, ProjectID: journey.Reference.ProjectID,
		EnvironmentID: journey.Reference.EnvironmentID, CollectionInstanceID: journey.Reference.CollectionInstanceID,
	}, journey.Reference.EntryID}
	jsonResponse := func(status int, body []byte) *http.Response {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(string(body)))}
	}
	var authorities []string
	positive, err := NewClient(ClientOptions{
		BaseURL: journey.BaseURL, Origin: journey.Origin, Capability: journey.Positive.Capability,
		Transport: conformanceRoundTripper(func(request *http.Request) (*http.Response, error) {
			authorities = append(authorities, request.Header.Get("Authorization"))
			return jsonResponse(http.StatusOK, journey.Positive.Response), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, err := positive.GetFileMetadataWithCapability(context.Background(), reference)
	if err != nil || entry.EntryID != journey.Reference.EntryID || authorities[0] != "Bearer "+journey.Positive.Capability {
		t.Fatalf("positive journey failed: %#v %v %#v", entry, err, authorities)
	}

	refusalCalls := 0
	refused, err := NewClient(ClientOptions{
		BaseURL: journey.BaseURL, Capability: journey.Refusal.Credential,
		Transport: conformanceRoundTripper(func(*http.Request) (*http.Response, error) {
			refusalCalls++
			return jsonResponse(http.StatusOK, journey.Positive.Response), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refused.GetFileMetadataWithCapability(context.Background(), reference)
	var clientError *ClientError
	if !errors.As(err, &clientError) || clientError.Code != journey.Refusal.ClientCode || refusalCalls != 0 {
		t.Fatalf("refusal journey failed: %v %d", err, refusalCalls)
	}

	attempt := 0
	authorities = nil
	retrying, err := NewClient(ClientOptions{
		BaseURL:            journey.BaseURL,
		CapabilityProvider: func(context.Context) (string, error) { return journey.Retry.Capabilities[attempt], nil },
		Retry:              &RetryPolicy{MaxAttempts: 2, BaseDelay: 0, MaxDelay: time.Nanosecond},
		Transport: conformanceRoundTripper(func(request *http.Request) (*http.Response, error) {
			authorities = append(authorities, request.Header.Get("Authorization"))
			attempt++
			if attempt == 1 {
				response := jsonResponse(journey.Retry.FirstStatus, journey.Retry.FirstError)
				response.Header.Set("Retry-After", "0")
				return response, nil
			}
			return jsonResponse(journey.Retry.FinalStatus, journey.Positive.Response), nil
		}),
	})
	if err != nil {
		t.Fatal(err)
	}
	entry, err = retrying.GetFileMetadataWithCapability(context.Background(), reference)
	if err != nil || entry.EntryID != journey.Reference.EntryID || len(authorities) != 2 ||
		authorities[0] != "Bearer "+journey.Retry.Capabilities[0] || authorities[1] != "Bearer "+journey.Retry.Capabilities[1] {
		t.Fatalf("retry journey failed: %#v %v %#v", entry, err, authorities)
	}
	if journey.Cleanup.Applicable || journey.Cleanup.Reason != "read_only_journey" {
		t.Fatalf("unexpected cleanup semantics: %#v", journey.Cleanup)
	}
}
