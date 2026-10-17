use std::time::Duration;

use metamorph_almira::{WebhookHeaders, WebhookVerificationOptions, verify_webhook_signature};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const BODY: &[u8] = br#"{"event":"almira.file.available.v1"}"#;

fn headers() -> WebhookHeaders<'static> {
    WebhookHeaders {
        delivery_id: "018f0000-0000-7000-8000-000000000011",
        event_id: "018f0000-0000-7000-8000-000000000012",
        attempt: "2",
        timestamp: "2026-10-17T12:00:00.000000Z",
        signature: "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI",
    }
}

fn options(value: &str) -> WebhookVerificationOptions {
    WebhookVerificationOptions {
        now: OffsetDateTime::parse(value, &Rfc3339).unwrap(),
        tolerance: Duration::from_secs(300),
    }
}

#[test]
fn verifies_the_common_app_vector_over_raw_bytes() {
    let verified = verify_webhook_signature(
        b"topsecret",
        BODY,
        headers(),
        options("2026-10-17T12:00:30Z"),
    )
    .unwrap();
    assert_eq!(verified.attempt, 2);
    assert_eq!(verified.delivery_id, headers().delivery_id);
}

#[test]
fn fails_closed_on_substitution_age_and_malformed_headers() {
    assert!(
        verify_webhook_signature(b"wrong", BODY, headers(), options("2026-10-17T12:00:30Z"))
            .is_none()
    );
    assert!(
        verify_webhook_signature(
            b"topsecret",
            br#"{"event":"almira.file.available.v1"} "#,
            headers(),
            options("2026-10-17T12:00:30Z")
        )
        .is_none()
    );
    assert!(
        verify_webhook_signature(
            b"topsecret",
            BODY,
            headers(),
            options("2026-10-17T12:05:00.001Z")
        )
        .is_none()
    );
    assert!(
        verify_webhook_signature(
            b"topsecret",
            BODY,
            WebhookHeaders {
                attempt: "02",
                ..headers()
            },
            options("2026-10-17T12:00:30Z")
        )
        .is_none()
    );
    assert!(
        verify_webhook_signature(
            b"topsecret",
            BODY,
            WebhookHeaders {
                signature: "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klJ",
                ..headers()
            },
            options("2026-10-17T12:00:30Z")
        )
        .is_none()
    );
}
