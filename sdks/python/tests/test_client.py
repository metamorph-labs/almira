from __future__ import annotations

import inspect
import io
import json
import pathlib
import re
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from almira import (  # noqa: E402
    AlmiraApiError,
    AlmiraClientError,
    AlmiraDataClient,
    CollectionReference,
    DerivativeReference,
    FileReference,
    HttpResponse,
    ImmutableGenerationReference,
)
from almira import __contract_version__  # noqa: E402

TENANT = "018f0000-0000-7000-8000-000000000002"
PROJECT = "018f0000-0000-7000-8000-000000000003"
ENVIRONMENT = "018f0000-0000-7000-8000-000000000004"
COLLECTION = "018f0000-0000-7000-8000-000000000005"
ENTRY = "018f0000-0000-7000-8000-000000000006"
GENERATION = "018f0000-0000-7000-8000-000000000007"
REQUEST = "018f0000-0000-7000-8000-000000000008"
CAPABILITY = f"alm_cap_v1.{'a' * 43}"
SHARE = f"alm_share_v1.{'b' * 43}"


def response(value: object, status: int = 200, headers: dict[str, str] | None = None) -> HttpResponse:
    raw = value if isinstance(value, bytes) else json.dumps(value).encode()
    return HttpResponse(
        status,
        {"content-type": "application/json", **(headers or {})},
        io.BytesIO(raw),
    )


def camel_to_snake(value: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()


class RecordingTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

    def __call__(self, method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
        self.calls.append((method, url, dict(headers), body))
        if "/delivery/" in url or "/shares/" in url:
            return response(b"hello", headers={"content-type": "text/plain", "content-length": "5", "etag": '"v1"'})
        if url.endswith("/derivatives"):
            return response([])
        if url.endswith("/search"):
            return response({"entries": [], "facets": [], "next_cursor": None})
        if url.endswith(f"/files/{ENTRY}"):
            return response({"entry_id": ENTRY})
        return response({"entries": [], "next_cursor": None})


class AlmiraPythonSdkTest(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport()
        self.client = AlmiraDataClient(
            base_url="https://almira.test/",
            capability=CAPABILITY,
            origin="https://app.example",
            transport=self.transport,
        )
        self.collection = CollectionReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION)
        self.file = FileReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION, ENTRY)
        self.generation = ImmutableGenerationReference(
            TENANT, PROJECT, ENVIRONMENT, COLLECTION, ENTRY, GENERATION
        )

    def test_version_and_methods_cover_data_contract_exactly(self) -> None:
        contract = json.loads((ROOT / "contracts" / "data-openapi.v1.json").read_text())
        operations = {
            camel_to_snake(operation["operationId"])
            for path in contract["paths"].values()
            for operation in path.values()
            if isinstance(operation, dict) and "operationId" in operation
        }
        methods = {
            name
            for name, value in inspect.getmembers(AlmiraDataClient, inspect.isfunction)
            if not name.startswith("_")
        }
        self.assertEqual(__contract_version__, contract["info"]["version"])
        self.assertEqual(methods, operations)

    def test_json_operations_use_exact_capability_scope(self) -> None:
        self.client.list_files_with_capability(
            self.collection, limit=25, cursor="next page", path_prefix="avatars"
        )
        self.client.get_file_metadata_with_capability(self.file)
        self.client.search_files_with_capability(
            self.collection, {"query": "portrait", "mode": "hybrid", "limit": 10}
        )
        self.client.list_derivatives_with_capability(self.generation)

        base = f"https://almira.test/v1/data/{TENANT}/{PROJECT}/{ENVIRONMENT}/{COLLECTION}"
        self.assertEqual(
            [(method, url) for method, url, _, _ in self.transport.calls],
            [
                ("GET", f"{base}/files?limit=25&cursor=next+page&path_prefix=avatars"),
                ("GET", f"{base}/files/{ENTRY}"),
                ("POST", f"{base}/search"),
                ("GET", f"{base}/files/{ENTRY}/versions/{GENERATION}/derivatives"),
            ],
        )
        for _, _, headers, _ in self.transport.calls:
            self.assertEqual(headers["authorization"], f"Bearer {CAPABILITY}")
            self.assertEqual(headers["origin"], "https://app.example")
        self.assertEqual(
            json.loads(self.transport.calls[2][3] or b"{}"),
            {"query": "portrait", "mode": "hybrid", "limit": 10},
        )

    def test_delivery_streams_and_share_never_forwards_capability(self) -> None:
        with self.client.read_immutable_generation(
            self.generation, byte_range="bytes=0-4", if_none_match='"old"'
        ) as result:
            self.assertEqual(result.status, 200)
            self.assertEqual(list(result.iter_bytes(2)), [b"he", b"ll", b"o"])
        derivative = DerivativeReference(
            TENANT, PROJECT, ENVIRONMENT, COLLECTION, ENTRY, GENERATION, "hls/720p/segment-1.m4s"
        )
        self.client.read_derivative(derivative).close()
        self.client.read_share(SHARE).close()

        self.assertEqual(
            self.transport.calls[0][1],
            f"https://almira.test/v1/delivery/{TENANT}/{PROJECT}/{ENVIRONMENT}/{COLLECTION}/{ENTRY}/{GENERATION}",
        )
        self.assertEqual(self.transport.calls[0][2]["range"], "bytes=0-4")
        self.assertTrue(self.transport.calls[1][1].endswith("/variants/hls/720p/segment-1.m4s"))
        share_headers = self.transport.calls[2][2]
        self.assertNotIn("authorization", share_headers)
        self.assertNotIn("origin", share_headers)

    def test_invalid_inputs_fail_before_transport(self) -> None:
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_INPUT_INVALID"):
            self.client.list_files_with_capability(self.collection, limit=101)
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_INPUT_INVALID"):
            self.client.read_immutable_generation(self.generation, byte_range="bytes=-5")
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_INPUT_INVALID"):
            self.client.read_derivative(
                DerivativeReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION, ENTRY, GENERATION, "../secret")
            )
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_INPUT_INVALID"):
            AlmiraDataClient(base_url="https://almira.test", origin="https://app.example\nforwarded: bad")
        self.assertEqual(self.transport.calls, [])

    def test_api_errors_are_bounded_and_typed(self) -> None:
        def refusing(*_: object) -> HttpResponse:
            return response(
                {"code": "ALMIRA_CAPABILITY_REFUSED", "request_id": REQUEST},
                403,
                {"retry-after": "7"},
            )

        client = AlmiraDataClient(
            base_url="https://almira.test",
            capability=CAPABILITY,
            transport=refusing,
        )
        with self.assertRaises(AlmiraApiError) as caught:
            client.get_file_metadata_with_capability(self.file)
        self.assertEqual(caught.exception.code, "ALMIRA_CAPABILITY_REFUSED")
        self.assertEqual(caught.exception.request_id, REQUEST)
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.retry_after_seconds, 7)

    def test_credential_provider_failures_are_redacted(self) -> None:
        def credential() -> str:
            raise RuntimeError("secret detail")

        client = AlmiraDataClient(
            base_url="https://almira.test",
            capability=credential,
            transport=self.transport,
        )
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE") as caught:
            client.get_file_metadata_with_capability(self.file)
        self.assertNotIn("secret detail", str(caught.exception))
        self.assertEqual(self.transport.calls, [])

    def test_malformed_transport_response_is_stable_and_closed(self) -> None:
        body = io.StringIO("not bytes")

        def malformed(*_: object) -> HttpResponse:
            return HttpResponse(200, {"content-type": "application/json"}, body)  # type: ignore[arg-type]

        client = AlmiraDataClient(
            base_url="https://almira.test",
            capability=CAPABILITY,
            transport=malformed,
        )
        with self.assertRaisesRegex(AlmiraClientError, "ALMIRA_CLIENT_RESPONSE_INVALID"):
            client.get_file_metadata_with_capability(self.file)
        self.assertTrue(body.closed)


if __name__ == "__main__":
    unittest.main()
