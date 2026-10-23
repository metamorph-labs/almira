from __future__ import annotations

import inspect
import hashlib
import io
import json
import pathlib
import re
import sys
import unittest
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "sdks" / "python" / "src"))

from almira import (  # noqa: E402
    AlmiraApiError,
    AlmiraClientError,
    AlmiraDataClient,
    AlmiraServerClient,
    BuilderSubject,
    CapabilityResource,
    CollectionReference,
    CreateCapabilitySessionRequest,
    CreateMultipartPartGrantRequest,
    CreateUploadRequest,
    DirectUploadDescriptor,
    DirectUploadHeader,
    DirectUploadPart,
    DirectUploadPartCompletion,
    DirectUploadResponse,
    DerivativeReference,
    FileReference,
    HttpResponse,
    ImmutableGenerationReference,
    FinalizeUploadRequest,
    RetryPolicy,
    SubjectProjectReference,
    SubjectReference,
    upload_direct,
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
            self.collection,
            limit=25,
            cursor="next page",
            path_prefix="avatars",
            tag="profile.photo",
            metadata_key="account.tier",
            metadata_value="pro",
            verified_media_type="image/jpeg",
            minimum_size_bytes=10,
            maximum_size_bytes=5000,
            created_after="2026-01-01T00:00:00Z",
            created_before="2026-02-01T00:00:00Z",
            extraction_kind="technical",
            extraction_state="succeeded",
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
                (
                    "GET",
                    f"{base}/files?limit=25&cursor=next+page&path_prefix=avatars"
                    "&tag=profile.photo&metadata_key=account.tier&metadata_value=%22pro%22"
                    "&verified_media_type=image%2Fjpeg&minimum_size_bytes=10&maximum_size_bytes=5000"
                    "&created_after=2026-01-01T00%3A00%3A00Z"
                    "&created_before=2026-02-01T00%3A00%3A00Z"
                    "&extraction_kind=technical&extraction_state=succeeded",
                ),
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
            self.client.list_files_with_capability(self.collection, path_prefix="../secret")
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

    def test_opt_in_retry_re_resolves_capability_and_replays_safe_request(self) -> None:
        calls: list[str] = []
        credential_calls = 0

        def capability() -> str:
            nonlocal credential_calls
            credential_calls += 1
            return f"alm_cap_v1.{'a' * 42}{credential_calls}"

        def transient(
            _method: str,
            _url: str,
            headers: dict[str, str],
            _body: bytes | None,
        ) -> HttpResponse:
            calls.append(headers["authorization"])
            if len(calls) == 1:
                return response(
                    {"code": "ALMIRA_TEMPORARILY_UNAVAILABLE", "request_id": REQUEST},
                    503,
                    {"retry-after": "0"},
                )
            return response({"entry_id": ENTRY})

        client = AlmiraDataClient(
            base_url="https://almira.test",
            capability=capability,
            transport=transient,
            retry=RetryPolicy(max_attempts=3, base_delay_seconds=0, maximum_delay_seconds=0),
        )
        self.assertEqual(client.get_file_metadata_with_capability(self.file), {"entry_id": ENTRY})
        self.assertEqual(credential_calls, 2)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0], calls[1])

    def test_workload_exchange_returns_capability_only_client_and_revokes_exactly(self) -> None:
        calls: list[tuple[str, str, dict[str, str], bytes | None]] = []

        def exchange(
            method: str,
            url: str,
            headers: dict[str, str],
            body: bytes | None,
        ) -> HttpResponse:
            calls.append((method, url, dict(headers), body))
            if method == "POST":
                return response(
                    {
                        "session_id": REQUEST,
                        "token": CAPABILITY,
                        "operations": ["metadata_read"],
                        "resource": {"kind": "collection"},
                        "audience": "https://app.example",
                        "policy_revision": 1,
                        "issuer_epoch": 1,
                        "expires_at": "2026-10-17T12:00:00Z",
                    },
                    201,
                )
            if method == "DELETE":
                return response("applied")
            return response({"entry_id": ENTRY})

        server = AlmiraServerClient(
            base_url="https://almira.test",
            workload_session="workload_session_evidence",
            transport=exchange,
        )
        session = server.create_capability_data_client(
            self.collection,
            CreateCapabilitySessionRequest(
                subject=BuilderSubject("user_42"),
                operations=("metadata_read",),
                resource=CapabilityResource("collection"),
                audience="https://app.example",
                lifetime_seconds=300,
            ),
            operation_id=GENERATION,
            data_transport=exchange,
        )
        self.assertEqual(session.grant.token, CAPABILITY)
        self.assertNotIn(CAPABILITY, repr(session.grant))
        session.data_client.get_file_metadata_with_capability(self.file)
        self.assertEqual(server.revoke_capability_session(self.collection, REQUEST, operation_id=GENERATION), "applied")
        self.assertEqual(calls[0][2]["authorization"], "MetamorphWorkload workload_session_evidence")
        self.assertEqual(calls[0][2]["x-almira-tenant-id"], TENANT)
        self.assertEqual(calls[1][2]["authorization"], f"Bearer {CAPABILITY}")
        self.assertEqual(calls[1][2]["origin"], "https://app.example")
        self.assertNotIn("x-almira-tenant-id", calls[1][2])
        self.assertEqual(calls[2][2]["authorization"], "MetamorphWorkload workload_session_evidence")
        self.assertEqual(calls[2][0], "DELETE")

    def test_server_upload_create_and_finalize_preserve_descriptor_evidence(self) -> None:
        calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        descriptor_id = "018f0000-0000-7000-8000-000000000011"
        content_sha256 = f"sha256:{'a' * 64}"

        def upload_api(
            method: str,
            url: str,
            headers: dict[str, str],
            body: bytes | None,
        ) -> HttpResponse:
            calls.append((method, url, dict(headers), body))
            if url.endswith("/uploads"):
                return response(
                    {
                        "transfer_session_id": REQUEST,
                        "entry_id": ENTRY,
                        "generation_id": GENERATION,
                        "descriptor": {
                            "descriptor_id": descriptor_id,
                            "protocol": "single_put",
                            "requests": [{
                                "part_number": 1,
                                "offset_bytes": 0,
                                "length_bytes": 5,
                                "method": "PUT",
                                "url": "https://objects.example/one-use-secret",
                                "headers": [{"name": "content-type", "value": "text/plain"}],
                                "one_use": True,
                            }],
                            "expected_size_bytes": 5,
                            "content_sha256": content_sha256,
                            "one_use": True,
                            "expires_at": "2026-10-17T12:00:00Z",
                            "part_size_bytes": None,
                            "part_count": 1,
                        },
                    },
                    201,
                )
            return response({
                "entry_id": ENTRY,
                "generation_id": GENERATION,
                "generation_number": 1,
                "state": "available",
                "expected_size_bytes": 5,
                "content_sha256": content_sha256,
                "declared_media_type": "text/plain",
                "malware_scan_requirement": "required",
                "safety_state": "clean",
                "revision": 1,
                "created_at": "2026-10-17T12:00:00Z",
            })

        server = AlmiraServerClient(
            base_url="https://almira.test",
            workload_session="workload_session_evidence",
            transport=upload_api,
        )
        created = server.create_upload(
            self.collection,
            CreateUploadRequest("avatars/me.txt", 5, content_sha256, "text/plain"),
            operation_id=GENERATION,
        )
        self.assertNotIn("one-use-secret", repr(created))
        finalized = server.finalize_upload(
            self.collection,
            created.transfer_session_id,
            FinalizeUploadRequest(
                created.descriptor.descriptor_id,
                "single_put",
                '"etag-one"',
                "provider-v1",
                (DirectUploadPartCompletion(1, '"etag-one"'),),
                5,
                content_sha256,
            ),
            operation_id=GENERATION,
        )
        self.assertEqual(finalized.state, "available")
        self.assertTrue(calls[0][1].endswith(f"/collections/{COLLECTION}/uploads"))
        self.assertTrue(calls[1][1].endswith(f"/uploads/{REQUEST}/finalize"))
        self.assertEqual(json.loads(calls[1][3] or b"{}"), {
            "descriptor_id": descriptor_id,
            "protocol": "single_put",
            "etag": '"etag-one"',
            "provider_version": "provider-v1",
            "parts": [{"part_number": 1, "etag": '"etag-one"'}],
            "size_bytes": 5,
            "content_sha256": content_sha256,
        })

    def test_workload_subject_bindings_are_namespaced_and_operation_scoped(self) -> None:
        calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        subject = SubjectReference("auth0:primary", "opaque|user-42")
        binding = {
            "binding_id": REQUEST,
            "subject": {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
            "environment_id": ENVIRONMENT,
            "collection_instance_id": COLLECTION,
            "entry_id": ENTRY,
            "entry_lifecycle": "active",
            "created_at": "2026-10-17T12:00:00Z",
        }

        def transport(method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
            calls.append((method, url, dict(headers), body))
            if url.endswith("/subject-bindings"):
                return response({"disposition": "applied", "binding": binding}, 201)
            lifecycle = {
                "operation_id": REQUEST,
                "kind": "delete",
                "state": "pending",
                "subject": {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
                "matched_entries": 1,
                "completed_entries": 0,
                "pending_entries": 1,
                "manifest_digest": f"sha256:{'a' * 64}",
                "created_at": "2026-10-17T12:00:00Z",
                "updated_at": "2026-10-17T12:00:00Z",
            }
            if url.endswith("/subject-lifecycle-operations"):
                return response({"operation": lifecycle}, 202)
            if url.endswith("/subject-lifecycle-operations/search"):
                return response({"operation": lifecycle, "items": [], "next_cursor": None})
            return response({"items": [binding], "next_cursor": None})

        server = AlmiraServerClient(
            base_url="https://almira.test",
            workload_session="workload_session",
            transport=transport,
        )

        collection = CollectionReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION)
        outcome = server.bind_subject(collection, ENTRY, subject, operation_id=REQUEST)
        page = server.list_subject_bindings(
            SubjectProjectReference(TENANT, PROJECT),
            subject,
            limit=25,
            cursor="next",
        )
        lifecycle = server.start_subject_lifecycle_operation(
            SubjectProjectReference(TENANT, PROJECT),
            subject,
            "delete",
            operation_id=REQUEST,
        )
        manifest = server.read_subject_lifecycle_operation(
            SubjectProjectReference(TENANT, PROJECT),
            REQUEST,
            limit=25,
            cursor="manifest-next",
        )
        self.assertEqual(outcome.binding.entry_id, ENTRY)
        self.assertEqual(len(page.items), 1)
        self.assertEqual(lifecycle.operation.state, "pending")
        self.assertEqual(manifest.operation.operation_id, REQUEST)
        self.assertNotIn("opaque|user-42", repr(subject))
        self.assertEqual(calls[0][2]["idempotency-key"], REQUEST)
        self.assertNotIn("idempotency-key", calls[1][2])
        self.assertEqual(calls[2][2]["idempotency-key"], REQUEST)
        self.assertNotIn("idempotency-key", calls[3][2])
        self.assertEqual(
            [json.loads(call[3] or b"{}") for call in calls],
            [
                {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
                {
                    "subject": {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
                    "limit": 25,
                    "cursor": "next",
                },
                {
                    "subject": {"namespace": "auth0:primary", "subject_id": "opaque|user-42"},
                    "kind": "delete",
                },
                {
                    "operation_id": REQUEST,
                    "limit": 25,
                    "cursor": "manifest-next",
                },
            ],
        )

    def test_server_multipart_part_grant_binds_transfer_checksum_and_operation(self) -> None:
        calls: list[tuple[str, str, dict[str, str], bytes | None]] = []
        content_sha256 = f"sha256:{'d' * 64}"

        def part_api(method: str, url: str, headers: dict[str, str], body: bytes | None) -> HttpResponse:
            calls.append((method, url, dict(headers), body))
            return response({
                "part_number": 2,
                "offset_bytes": 67_108_864,
                "length_bytes": 1024,
                "method": "PUT",
                "url": "https://objects.example/one-use-part",
                "headers": [{"name": "x-upload-token", "value": "secret"}],
                "one_use": True,
            }, 201)

        server = AlmiraServerClient(
            base_url="https://almira.test",
            workload_session="workload_session_evidence",
            transport=part_api,
        )
        part = server.create_upload_part(
            self.collection,
            REQUEST,
            CreateMultipartPartGrantRequest(2, content_sha256),
            operation_id=GENERATION,
        )
        self.assertEqual(part.part_number, 2)
        self.assertTrue(calls[0][1].endswith(f"/uploads/{REQUEST}/parts"))
        self.assertEqual(calls[0][2]["idempotency-key"], GENERATION)
        self.assertEqual(json.loads(calls[0][3] or b"{}"), {
            "part_number": 2,
            "content_sha256": content_sha256,
        })

    def test_direct_upload_streams_exact_parts_without_almira_credentials(self) -> None:
        content_sha256 = f"sha256:{'a' * 64}"
        descriptor = DirectUploadDescriptor(
            "018f0000-0000-7000-8000-000000000011",
            "multipart",
            (),
            5,
            content_sha256,
            True,
            "2026-10-17T12:00:00Z",
            2,
            3,
        )
        transferred: list[tuple[int, bytes, tuple[str, ...]]] = []
        grants: list[CreateMultipartPartGrantRequest] = []

        def grant(request: CreateMultipartPartGrantRequest) -> DirectUploadPart:
            grants.append(request)
            offset = (request.part_number - 1) * 2
            return DirectUploadPart(
                request.part_number,
                offset,
                min(2, 5 - offset),
                "PUT",
                f"https://objects.example/secret-{request.part_number}",
                (DirectUploadHeader("content-type", "text/plain"),),
            )

        def transfer(part: DirectUploadPart, stream: io.BytesIO) -> DirectUploadResponse:
            transferred.append((part.part_number, stream.read(), tuple(header.name for header in part.headers)))
            return DirectUploadResponse(200, {"etag": f'"part-{part.part_number}"'})

        completion = upload_direct(
            descriptor,
            io.BytesIO(b"hello"),
            size_bytes=5,
            transport=transfer,
            grant_part=grant,
            now=lambda: datetime(2026, 10, 17, 10, tzinfo=timezone.utc),
        )
        self.assertEqual(transferred, [(1, b"he", ("content-type",)), (2, b"ll", ("content-type",)), (3, b"o", ("content-type",))])
        self.assertEqual(
            [(request.part_number, request.content_sha256) for request in grants],
            [
                (1, f"sha256:{hashlib.sha256(b'he').hexdigest()}"),
                (2, f"sha256:{hashlib.sha256(b'll').hexdigest()}"),
                (3, f"sha256:{hashlib.sha256(b'o').hexdigest()}"),
            ],
        )
        self.assertEqual(completion.protocol, "multipart")
        self.assertIsNone(completion.etag)
        self.assertIsNone(completion.provider_version)
        self.assertEqual([part.etag for part in completion.parts], ['"part-1"', '"part-2"', '"part-3"'])

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
