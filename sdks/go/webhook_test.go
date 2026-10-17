package almira

import (
	"net/http"
	"testing"
	"time"
)

func webhookHeaders() http.Header {
	return http.Header{
		"Metamorph-Webhook-Delivery-Id": {"018f0000-0000-7000-8000-000000000011"},
		"Metamorph-Webhook-Event-Id":    {"018f0000-0000-7000-8000-000000000012"},
		"Metamorph-Webhook-Attempt":     {"2"},
		"Metamorph-Webhook-Timestamp":   {"2026-10-17T12:00:00.000000Z"},
		"Metamorph-Webhook-Signature":   {"v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI"},
	}
}

func TestVerifyWebhookSignatureUsesCommonAPPVector(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 30, 0, time.UTC)
	verified, ok := VerifyWebhookSignature(
		[]byte("topsecret"),
		[]byte(`{"event":"almira.file.available.v1"}`),
		webhookHeaders(),
		WebhookVerificationOptions{Now: now},
	)
	if !ok || verified.Attempt != 2 || verified.DeliveryID != "018f0000-0000-7000-8000-000000000011" {
		t.Fatalf("unexpected verification: %#v %v", verified, ok)
	}
}

func TestVerifyWebhookSignatureFailsClosed(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 30, 0, time.UTC)
	body := []byte(`{"event":"almira.file.available.v1"}`)
	if _, ok := VerifyWebhookSignature([]byte("wrong"), body, webhookHeaders(), WebhookVerificationOptions{Now: now}); ok {
		t.Fatal("wrong secret verified")
	}
	if _, ok := VerifyWebhookSignature([]byte("topsecret"), append(body, ' '), webhookHeaders(), WebhookVerificationOptions{Now: now}); ok {
		t.Fatal("substituted body verified")
	}
	if _, ok := VerifyWebhookSignature([]byte("topsecret"), body, webhookHeaders(), WebhookVerificationOptions{
		Now: time.Date(2026, 10, 17, 12, 5, 1, 0, time.UTC),
	}); ok {
		t.Fatal("stale delivery verified")
	}
	duplicates := webhookHeaders()
	duplicates["metamorph-webhook-attempt"] = []string{"2"}
	if _, ok := VerifyWebhookSignature([]byte("topsecret"), body, duplicates, WebhookVerificationOptions{Now: now}); ok {
		t.Fatal("duplicate header verified")
	}
	nonCanonical := webhookHeaders()
	nonCanonical.Set("Metamorph-Webhook-Signature", "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klJ")
	if _, ok := VerifyWebhookSignature([]byte("topsecret"), body, nonCanonical, WebhookVerificationOptions{Now: now}); ok {
		t.Fatal("non-canonical base64url verified")
	}
}
