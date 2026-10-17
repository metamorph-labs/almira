from __future__ import annotations

import pathlib
import sys
import unittest
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from almira import VerifiedWebhook, verify_webhook_signature  # noqa: E402

BODY = b'{"event":"almira.file.available.v1"}'
HEADERS = {
    "Metamorph-Webhook-Delivery-Id": "018f0000-0000-7000-8000-000000000011",
    "Metamorph-Webhook-Event-Id": "018f0000-0000-7000-8000-000000000012",
    "Metamorph-Webhook-Attempt": "2",
    "Metamorph-Webhook-Timestamp": "2026-10-17T12:00:00.000000Z",
    "Metamorph-Webhook-Signature": "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI",
}
NOW = datetime(2026, 10, 17, 12, 0, 30, tzinfo=timezone.utc)


class AlmiraWebhookTest(unittest.TestCase):
    def test_common_app_vector_verifies_raw_bytes(self) -> None:
        self.assertEqual(
            verify_webhook_signature("topsecret", BODY, HEADERS, now=NOW),
            VerifiedWebhook(
                HEADERS["Metamorph-Webhook-Delivery-Id"],
                HEADERS["Metamorph-Webhook-Event-Id"],
                2,
                HEADERS["Metamorph-Webhook-Timestamp"],
            ),
        )

    def test_substitution_age_and_duplicate_headers_fail_closed(self) -> None:
        self.assertIsNone(verify_webhook_signature("topsecret", BODY + b" ", HEADERS, now=NOW))
        self.assertIsNone(verify_webhook_signature("wrong", BODY, HEADERS, now=NOW))
        self.assertIsNone(
            verify_webhook_signature(
                "topsecret",
                BODY,
                HEADERS,
                now=datetime(2026, 10, 17, 12, 5, 1, tzinfo=timezone.utc),
            )
        )
        self.assertIsNone(
            verify_webhook_signature(
                "topsecret",
                BODY,
                {**HEADERS, "metamorph-webhook-attempt": "2"},
                now=NOW,
            )
        )


if __name__ == "__main__":
    unittest.main()
