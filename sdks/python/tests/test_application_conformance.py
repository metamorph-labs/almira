from __future__ import annotations

import io
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from almira import (  # noqa: E402
    AlmiraClientError,
    AlmiraDataClient,
    FileReference,
    HttpResponse,
    RetryPolicy,
)


class ApplicationConformanceTest(unittest.TestCase):
    def test_common_managed_development_journey(self) -> None:
        common = json.loads((ROOT / "conformance" / "application-sdk.v1.json").read_text())
        journey = common["managed_development"]
        ids = journey["reference"]
        reference = FileReference(
            ids["tenant_id"], ids["project_id"], ids["environment_id"],
            ids["collection_instance_id"], ids["entry_id"],
        )

        def wire(value: object, status: int = 200, headers: dict[str, str] | None = None) -> HttpResponse:
            return HttpResponse(status, {"content-type": "application/json", **(headers or {})}, io.BytesIO(json.dumps(value).encode()))

        observed: list[str] = []

        def positive(_method: str, _url: str, headers: dict[str, str], _body: bytes | None) -> HttpResponse:
            observed.append(headers["authorization"])
            return wire(journey["positive"]["response"])

        client = AlmiraDataClient(
            base_url=journey["base_url"], capability=journey["positive"]["capability"],
            origin=journey["origin"], transport=positive,
        )
        self.assertEqual(client.get_file_metadata_with_capability(reference)["entry_id"], ids["entry_id"])
        self.assertEqual(observed, [f"Bearer {journey['positive']['capability']}"])

        refusal_calls = 0

        def should_not_call(*_: object) -> HttpResponse:
            nonlocal refusal_calls
            refusal_calls += 1
            return wire({})

        refused = AlmiraDataClient(base_url=journey["base_url"], capability=journey["refusal"]["credential"], transport=should_not_call)
        with self.assertRaises(AlmiraClientError) as caught:
            refused.get_file_metadata_with_capability(reference)
        self.assertEqual(caught.exception.code, journey["refusal"]["client_code"])
        self.assertEqual(refusal_calls, 0)

        attempt = 0
        authorities: list[str] = []

        def capability() -> str:
            return journey["retry"]["capabilities"][attempt]

        def transient(_method: str, _url: str, headers: dict[str, str], _body: bytes | None) -> HttpResponse:
            nonlocal attempt
            authorities.append(headers["authorization"])
            attempt += 1
            if attempt == 1:
                return wire(journey["retry"]["first_error"], journey["retry"]["first_status"], {"retry-after": str(journey["retry"]["retry_after_seconds"])})
            return wire(journey["positive"]["response"], journey["retry"]["final_status"])

        retrying = AlmiraDataClient(
            base_url=journey["base_url"], capability=capability, transport=transient,
            retry=RetryPolicy(max_attempts=2, base_delay_seconds=0, maximum_delay_seconds=0),
        )
        self.assertEqual(retrying.get_file_metadata_with_capability(reference)["entry_id"], ids["entry_id"])
        self.assertEqual(authorities, [f"Bearer {value}" for value in journey["retry"]["capabilities"]])
        self.assertEqual(journey["cleanup"], {"applicable": False, "reason": "read_only_journey"})


if __name__ == "__main__":
    unittest.main()
