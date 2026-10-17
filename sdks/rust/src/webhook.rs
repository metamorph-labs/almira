//! Verification for APP-01 signed webhook requests.

use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const MAX_BODY_BYTES: usize = 272 * 1024;
const DEFAULT_TOLERANCE: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WebhookHeaders<'a> {
    pub delivery_id: &'a str,
    pub event_id: &'a str,
    pub attempt: &'a str,
    pub timestamp: &'a str,
    pub signature: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedWebhook {
    pub delivery_id: String,
    pub event_id: String,
    pub attempt: u8,
    pub timestamp: String,
}

#[derive(Clone, Copy, Debug)]
pub struct WebhookVerificationOptions {
    pub now: OffsetDateTime,
    pub tolerance: Duration,
}

impl Default for WebhookVerificationOptions {
    fn default() -> Self {
        Self {
            now: OffsetDateTime::now_utc(),
            tolerance: DEFAULT_TOLERANCE,
        }
    }
}

fn is_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
}

fn parse_timestamp(value: &str) -> Option<OffsetDateTime> {
    let bytes = value.as_bytes();
    if bytes.len() != 27
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[26] != b'Z'
        || bytes[20..26].iter().any(|byte| !byte.is_ascii_digit())
    {
        return None;
    }
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

/// Verifies an APP-01 signature over the exact raw HTTP request body.
///
/// A successful result authenticates delivery by APP-01 only. The caller must
/// still validate the payload and durably reject replayed delivery attempts.
#[must_use]
pub fn verify_webhook_signature(
    secret: &[u8],
    body: &[u8],
    headers: WebhookHeaders<'_>,
    options: WebhookVerificationOptions,
) -> Option<VerifiedWebhook> {
    if secret.is_empty()
        || body.len() > MAX_BODY_BYTES
        || !is_uuid_v7(headers.delivery_id)
        || !is_uuid_v7(headers.event_id)
        || headers.attempt.len() != 1
        || !(b'1'..=b'8').contains(headers.attempt.as_bytes().first()?)
        || !headers.signature.starts_with("v1=")
        || headers.signature.len() != 46
    {
        return None;
    }
    let timestamp = parse_timestamp(headers.timestamp)?;
    let difference = options.now - timestamp;
    if difference.whole_milliseconds().unsigned_abs() > options.tolerance.as_millis() {
        return None;
    }

    let body_digest = Sha256::digest(body);
    let transcript = format!(
        "metamorph-webhook-v1\n{}\n{}\n{}\n{}\nsha256:{body_digest:x}",
        headers.delivery_id, headers.event_id, headers.attempt, headers.timestamp
    );
    let encoded_signature = headers.signature.strip_prefix("v1=")?;
    let supplied = URL_SAFE_NO_PAD.decode(encoded_signature).ok()?;
    if URL_SAFE_NO_PAD.encode(&supplied) != encoded_signature {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).ok()?;
    mac.update(transcript.as_bytes());
    mac.verify_slice(&supplied).ok()?;
    Some(VerifiedWebhook {
        delivery_id: headers.delivery_id.to_owned(),
        event_id: headers.event_id.to_owned(),
        attempt: headers.attempt.parse().ok()?,
        timestamp: headers.timestamp.to_owned(),
    })
}
