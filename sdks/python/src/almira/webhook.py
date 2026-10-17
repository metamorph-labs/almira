"""Verification for APP-01 signed webhook requests."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Mapping

_MAX_BODY_BYTES = 272 * 1024
_DEFAULT_TOLERANCE_SECONDS = 300
_UUID_V7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$")
_SIGNATURE = re.compile(r"^v1=([A-Za-z0-9_-]{43})$")


@dataclass(frozen=True, slots=True)
class VerifiedWebhook:
    """Authenticated APP-01 delivery metadata, not application authorization."""

    delivery_id: str
    event_id: str
    attempt: int
    timestamp: str


def _header(headers: Mapping[str, str], name: str) -> str | None:
    matches = [value for key, value in headers.items() if key.lower() == name]
    if len(matches) != 1 or "," in matches[0]:
        return None
    return matches[0]


def verify_webhook_signature(
    secret: bytes | str,
    body: bytes,
    headers: Mapping[str, str],
    *,
    now: datetime | None = None,
    tolerance_seconds: int = _DEFAULT_TOLERANCE_SECONDS,
) -> VerifiedWebhook | None:
    """Verify an APP-01 signature over the exact raw HTTP request body.

    Parse and authorize the payload only after this function succeeds. Callers
    remain responsible for durable delivery-id/attempt replay tracking.
    """

    secret_bytes = secret.encode() if isinstance(secret, str) else secret
    if not secret_bytes or len(body) > _MAX_BODY_BYTES or tolerance_seconds < 0:
        return None
    delivery_id = _header(headers, "metamorph-webhook-delivery-id")
    event_id = _header(headers, "metamorph-webhook-event-id")
    attempt_value = _header(headers, "metamorph-webhook-attempt")
    timestamp = _header(headers, "metamorph-webhook-timestamp")
    signature = _header(headers, "metamorph-webhook-signature")
    if (
        delivery_id is None
        or _UUID_V7.fullmatch(delivery_id) is None
        or event_id is None
        or _UUID_V7.fullmatch(event_id) is None
        or attempt_value is None
        or attempt_value not in set("12345678")
        or timestamp is None
        or _TIMESTAMP.fullmatch(timestamp) is None
        or signature is None
        or (signature_match := _SIGNATURE.fullmatch(signature)) is None
    ):
        return None
    try:
        occurred_at = datetime.strptime(timestamp, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None
    sampled_at = now or datetime.now(timezone.utc)
    if sampled_at.tzinfo is None or abs((sampled_at - occurred_at).total_seconds()) > tolerance_seconds:
        return None

    body_digest = f"sha256:{hashlib.sha256(body).hexdigest()}"
    transcript = "\n".join(
        (
            "metamorph-webhook-v1",
            delivery_id,
            event_id,
            attempt_value,
            timestamp,
            body_digest,
        )
    ).encode()
    expected = base64.urlsafe_b64encode(
        hmac.new(secret_bytes, transcript, hashlib.sha256).digest()
    ).rstrip(b"=").decode()
    if not hmac.compare_digest(expected, signature_match.group(1)):
        return None
    return VerifiedWebhook(delivery_id, event_id, int(attempt_value), timestamp)
