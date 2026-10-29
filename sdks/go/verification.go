package almira

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"regexp"
)

var (
	verificationDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	verificationKeyIDPattern  = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,63}$`)
)

var verificationChecks = [...]string{
	"finalization_idempotency",
	"private_read_integrity",
	"cross_scope_refusal",
	"malware_safety",
}

// VerificationCheck is one server-exercised behavior in a signed verification receipt.
type VerificationCheck struct {
	Name   string `json:"name"`
	Result string `json:"result"`
}

// VerificationReceipt is the exact V1 receipt payload signed by Almira.
type VerificationReceipt struct {
	ReceiptVersion       string              `json:"receipt_version"`
	ContractVersion      string              `json:"contract_version"`
	VerificationID       string              `json:"verification_id"`
	RealmID              string              `json:"realm_id"`
	TenantID             string              `json:"tenant_id"`
	ProjectID            string              `json:"project_id"`
	EnvironmentID        string              `json:"environment_id"`
	CollectionInstanceID string              `json:"collection_instance_id"`
	EntryID              string              `json:"entry_id"`
	GenerationID         string              `json:"generation_id"`
	ExpectedSizeBytes    int64               `json:"expected_size_bytes"`
	ContentSHA256        string              `json:"content_sha256"`
	SafetyState          string              `json:"safety_state"`
	Checks               []VerificationCheck `json:"checks"`
	SigningKeyID         string              `json:"signing_key_id"`
}

// SignedVerificationReceipt contains a receipt and its unpadded base64url Ed25519 signature.
type SignedVerificationReceipt struct {
	Receipt   VerificationReceipt `json:"receipt"`
	Algorithm string              `json:"algorithm"`
	Signature string              `json:"signature"`
}

// VerificationPublicKey is one trusted public key projected by Almira's origin.
type VerificationPublicKey struct {
	KeyID     string `json:"key_id"`
	Algorithm string `json:"algorithm"`
	PublicKey string `json:"public_key"`
}

// VerificationPublicKeySet is the bounded public receipt-verification key set.
type VerificationPublicKeySet struct {
	FormatVersion int                     `json:"format_version"`
	Keys          []VerificationPublicKey `json:"keys"`
}

// VerificationReceiptExpectation binds a valid signature to the exact resource the caller tested.
type VerificationReceiptExpectation struct {
	VerificationID       string
	TenantID             string
	ProjectID            string
	EnvironmentID        string
	CollectionInstanceID string
	EntryID              string
	GenerationID         string
	ExpectedSizeBytes    int64
	ContentSHA256        string
}

// VerifyVerificationReceipt validates the closed receipt shape, exact binding and Ed25519 signature.
func VerifyVerificationReceipt(
	signed SignedVerificationReceipt,
	keySet VerificationPublicKeySet,
	expected *VerificationReceiptExpectation,
) bool {
	if signed.Algorithm != "ed25519" || !validVerificationReceipt(signed.Receipt) ||
		keySet.FormatVersion != 1 || len(keySet.Keys) < 1 || len(keySet.Keys) > 4 ||
		(expected != nil && !matchesVerificationExpectation(signed.Receipt, *expected)) {
		return false
	}
	signature, ok := decodeCanonicalBase64URL(signed.Signature, ed25519.SignatureSize)
	if !ok {
		return false
	}
	var matching []VerificationPublicKey
	for _, key := range keySet.Keys {
		if !verificationKeyIDPattern.MatchString(key.KeyID) || key.Algorithm != "ed25519" {
			return false
		}
		if key.KeyID == signed.Receipt.SigningKeyID {
			matching = append(matching, key)
		}
	}
	if len(matching) != 1 {
		return false
	}
	publicKey, ok := decodeCanonicalBase64URL(matching[0].PublicKey, ed25519.PublicKeySize)
	if !ok {
		return false
	}
	message, ok := canonicalReceiptJSON(signed.Receipt)
	return ok && ed25519.Verify(ed25519.PublicKey(publicKey), message, signature)
}

func validVerificationReceipt(receipt VerificationReceipt) bool {
	if receipt.ReceiptVersion != "almira.verification.v1" || receipt.ContractVersion != ContractVersion ||
		!verificationKeyIDPattern.MatchString(receipt.SigningKeyID) ||
		!verificationDigestPattern.MatchString(receipt.ContentSHA256) ||
		receipt.ExpectedSizeBytes < 1 || receipt.ExpectedSizeBytes > 8*1024*1024 ||
		(receipt.SafetyState != "not_required" && receipt.SafetyState != "clean") ||
		len(receipt.Checks) != len(verificationChecks) {
		return false
	}
	for _, value := range []string{
		receipt.VerificationID, receipt.RealmID, receipt.TenantID, receipt.ProjectID,
		receipt.EnvironmentID, receipt.CollectionInstanceID, receipt.EntryID, receipt.GenerationID,
	} {
		if !uuidV7Pattern.MatchString(value) {
			return false
		}
	}
	for index, name := range verificationChecks {
		if receipt.Checks[index].Name != name || receipt.Checks[index].Result != "passed" {
			return false
		}
	}
	return true
}

func matchesVerificationExpectation(receipt VerificationReceipt, expected VerificationReceiptExpectation) bool {
	return (expected.VerificationID == "" || receipt.VerificationID == expected.VerificationID) &&
		receipt.TenantID == expected.TenantID && receipt.ProjectID == expected.ProjectID &&
		receipt.EnvironmentID == expected.EnvironmentID &&
		receipt.CollectionInstanceID == expected.CollectionInstanceID &&
		receipt.EntryID == expected.EntryID && receipt.GenerationID == expected.GenerationID &&
		receipt.ExpectedSizeBytes == expected.ExpectedSizeBytes &&
		receipt.ContentSHA256 == expected.ContentSHA256
}

func canonicalReceiptJSON(receipt VerificationReceipt) ([]byte, bool) {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return nil, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	canonical, err := json.Marshal(value)
	return canonical, err == nil
}

func decodeCanonicalBase64URL(value string, size int) ([]byte, bool) {
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return decoded, err == nil && len(decoded) == size && base64.RawURLEncoding.EncodeToString(decoded) == value
}
