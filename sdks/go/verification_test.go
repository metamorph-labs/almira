package almira

import (
	"encoding/json"
	"os"
	"testing"
)

func TestCommonBehaviorReceiptVector(t *testing.T) {
	raw, err := os.ReadFile("../../conformance/application-sdk.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vector struct {
		BehaviorReceipt struct {
			Signed       SignedVerificationReceipt  `json:"signed"`
			KeySet       VerificationPublicKeySet   `json:"key_set"`
			Expected     map[string]json.RawMessage `json:"expected"`
			Substitution map[string]string          `json:"substitution"`
		} `json:"behavior_receipt"`
	}
	if err := json.Unmarshal(raw, &vector); err != nil {
		t.Fatal(err)
	}
	var expected VerificationReceiptExpectation
	expectationJSON, _ := json.Marshal(vector.BehaviorReceipt.Expected)
	var wire struct {
		VerificationID       string `json:"verification_id"`
		TenantID             string `json:"tenant_id"`
		ProjectID            string `json:"project_id"`
		EnvironmentID        string `json:"environment_id"`
		CollectionInstanceID string `json:"collection_instance_id"`
		EntryID              string `json:"entry_id"`
		GenerationID         string `json:"generation_id"`
		ExpectedSizeBytes    int64  `json:"expected_size_bytes"`
		ContentSHA256        string `json:"content_sha256"`
	}
	if err := json.Unmarshal(expectationJSON, &wire); err != nil {
		t.Fatal(err)
	}
	expected = VerificationReceiptExpectation(wire)
	if !VerifyVerificationReceipt(vector.BehaviorReceipt.Signed, vector.BehaviorReceipt.KeySet, &expected) {
		t.Fatal("valid common receipt vector was rejected")
	}
	expected.GenerationID = vector.BehaviorReceipt.Substitution["generation_id"]
	if VerifyVerificationReceipt(vector.BehaviorReceipt.Signed, vector.BehaviorReceipt.KeySet, &expected) {
		t.Fatal("resource substitution was accepted")
	}
	tampered := vector.BehaviorReceipt.Signed
	tampered.Receipt.GenerationID = expected.GenerationID
	if VerifyVerificationReceipt(tampered, vector.BehaviorReceipt.KeySet, nil) {
		t.Fatal("tampered signed payload was accepted")
	}
}
