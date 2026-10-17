package almira

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	maxWebhookBodyBytes        = 272 * 1024
	defaultWebhookClockSkew    = 5 * time.Minute
	webhookTimestampWireFormat = "2006-01-02T15:04:05.000000Z"
)

var (
	webhookUUIDV7Pattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	webhookTimestampPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$`)
	webhookSignaturePattern = regexp.MustCompile(`^v1=([A-Za-z0-9_-]{43})$`)
)

// VerifiedWebhook is authenticated APP-01 delivery metadata, not application authorization.
type VerifiedWebhook struct {
	DeliveryID string
	EventID    string
	Attempt    int
	Timestamp  string
}

type WebhookVerificationOptions struct {
	Now       time.Time
	Tolerance time.Duration
}

func oneHeader(headers http.Header, name string) (string, bool) {
	var matches []string
	for key, values := range headers {
		if strings.EqualFold(key, name) {
			matches = append(matches, values...)
		}
	}
	if len(matches) != 1 || strings.Contains(matches[0], ",") {
		return "", false
	}
	return matches[0], true
}

// VerifyWebhookSignature verifies the exact raw request body using APP-01's common protocol.
// The caller remains responsible for durable delivery-id/attempt replay tracking.
func VerifyWebhookSignature(secret, body []byte, headers http.Header, options WebhookVerificationOptions) (VerifiedWebhook, bool) {
	if len(secret) == 0 || len(body) > maxWebhookBodyBytes {
		return VerifiedWebhook{}, false
	}
	deliveryID, deliveryOK := oneHeader(headers, "Metamorph-Webhook-Delivery-Id")
	eventID, eventOK := oneHeader(headers, "Metamorph-Webhook-Event-Id")
	attemptValue, attemptOK := oneHeader(headers, "Metamorph-Webhook-Attempt")
	timestamp, timestampOK := oneHeader(headers, "Metamorph-Webhook-Timestamp")
	signature, signatureOK := oneHeader(headers, "Metamorph-Webhook-Signature")
	attempt, attemptError := strconv.Atoi(attemptValue)
	if !deliveryOK || !webhookUUIDV7Pattern.MatchString(deliveryID) ||
		!eventOK || !webhookUUIDV7Pattern.MatchString(eventID) ||
		!attemptOK || attemptError != nil || attempt < 1 || attempt > 8 || strconv.Itoa(attempt) != attemptValue ||
		!timestampOK || !webhookTimestampPattern.MatchString(timestamp) ||
		!signatureOK || !webhookSignaturePattern.MatchString(signature) {
		return VerifiedWebhook{}, false
	}
	occurredAt, err := time.Parse(webhookTimestampWireFormat, timestamp)
	if err != nil {
		return VerifiedWebhook{}, false
	}
	now := options.Now
	if now.IsZero() {
		now = time.Now()
	}
	tolerance := options.Tolerance
	if tolerance == 0 {
		tolerance = defaultWebhookClockSkew
	}
	if tolerance < 0 {
		return VerifiedWebhook{}, false
	}
	delta := now.Sub(occurredAt)
	if delta < 0 {
		delta = -delta
	}
	if delta > tolerance {
		return VerifiedWebhook{}, false
	}

	bodyHash := sha256.Sum256(body)
	transcript := strings.Join([]string{
		"metamorph-webhook-v1",
		deliveryID,
		eventID,
		attemptValue,
		timestamp,
		"sha256:" + hex.EncodeToString(bodyHash[:]),
	}, "\n")
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(transcript))
	expected := mac.Sum(nil)
	supplied, err := base64.RawURLEncoding.Strict().DecodeString(strings.TrimPrefix(signature, "v1="))
	if err != nil || !hmac.Equal(expected, supplied) {
		return VerifiedWebhook{}, false
	}
	return VerifiedWebhook{deliveryID, eventID, attempt, timestamp}, true
}
