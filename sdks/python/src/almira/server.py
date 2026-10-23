"""Builder-backend capability-session exchange for the Almira application SDK."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from .client import (
    API_ERROR,
    CAPABILITY,
    UUID_V7,
    AlmiraApiError,
    AlmiraClientError,
    AlmiraDataClient,
    CollectionReference,
    HttpResponse,
    RetryPolicy,
    Transport,
    _UrllibTransport,
    _bounded_read,
    _invalid_input,
    _invalid_response,
)

WorkloadSessionProvider = Callable[[], str]
READ_OPERATIONS = frozenset({"list", "metadata_read", "content_read", "search"})
LABEL = re.compile(r"^[a-z][a-z0-9._:-]{0,63}$")
CONTENT_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
MEDIA_TYPE = re.compile(r"^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")
HEADER_NAME = re.compile(r"^[a-z0-9-]{1,128}$")
PROVIDER_RECEIPT = re.compile(r"^[!-~]{1,256}$")
PROVIDER_VERSION = re.compile(r"^(?!.*[/?#])(?!.*\\)[!-~]{1,256}$")
SUBJECT_NAMESPACE = re.compile(r"^[a-z][a-z0-9._:-]{0,127}$")


@dataclass(frozen=True, slots=True)
class BuilderSubject:
    subject_id: str
    organization_id: str | None = None
    roles: tuple[str, ...] = ()
    attributes: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SubjectProjectReference:
    tenant_id: str
    project_id: str


@dataclass(frozen=True, slots=True)
class SubjectReference:
    namespace: str
    subject_id: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class SubjectBinding:
    binding_id: str
    subject: SubjectReference = field(repr=False)
    environment_id: str
    collection_instance_id: str
    entry_id: str
    entry_lifecycle: str
    created_at: str


@dataclass(frozen=True, slots=True)
class SubjectBindingOutcome:
    disposition: str
    binding: SubjectBinding


@dataclass(frozen=True, slots=True)
class SubjectBindingPage:
    items: tuple[SubjectBinding, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class SubjectLifecycleOperation:
    operation_id: str
    kind: str
    state: str
    subject: SubjectReference = field(repr=False)
    matched_entries: int
    completed_entries: int
    pending_entries: int
    manifest_digest: str
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class SubjectLifecycleOutcome:
    operation: SubjectLifecycleOperation


@dataclass(frozen=True, slots=True)
class SubjectLifecycleItem:
    binding_id: str
    environment_id: str
    collection_instance_id: str
    entry_id: str
    entry_revision: int
    disposition: str
    content_path: str | None
    recycle_until: str | None


@dataclass(frozen=True, slots=True)
class SubjectLifecyclePage:
    operation: SubjectLifecycleOperation
    items: tuple[SubjectLifecycleItem, ...]
    next_cursor: str | None


@dataclass(frozen=True, slots=True)
class CapabilityResource:
    kind: str
    path_prefix: str | None = None
    entry_id: str | None = None


@dataclass(frozen=True, slots=True)
class CreateCapabilitySessionRequest:
    subject: BuilderSubject
    operations: tuple[str, ...]
    resource: CapabilityResource
    audience: str
    lifetime_seconds: int


@dataclass(frozen=True, slots=True)
class CapabilitySessionGrant:
    session_id: str
    token: str = field(repr=False)
    operations: tuple[str, ...]
    resource: CapabilityResource
    audience: str
    policy_revision: int
    issuer_epoch: int
    expires_at: str


@dataclass(frozen=True, slots=True)
class CreateUploadRequest:
    path: str
    expected_size_bytes: int
    content_sha256: str
    declared_media_type: str
    browser_origin: str | None = None
    protocol: str | None = None


@dataclass(frozen=True, slots=True)
class CreateMultipartPartGrantRequest:
    part_number: int
    content_sha256: str


@dataclass(frozen=True, slots=True)
class DirectUploadHeader:
    name: str
    value: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class DirectUploadPart:
    part_number: int
    offset_bytes: int
    length_bytes: int
    method: str
    url: str = field(repr=False)
    headers: tuple[DirectUploadHeader, ...] = field(repr=False)
    one_use: bool = True


@dataclass(frozen=True, slots=True)
class DirectUploadDescriptor:
    descriptor_id: str
    protocol: str
    requests: tuple[DirectUploadPart, ...] = field(repr=False)
    expected_size_bytes: int = 0
    content_sha256: str = ""
    one_use: bool = True
    expires_at: str = ""
    part_size_bytes: int | None = None
    part_count: int = 1


@dataclass(frozen=True, slots=True)
class CreateUploadOutcome:
    transfer_session_id: str
    entry_id: str
    generation_id: str
    descriptor: DirectUploadDescriptor


@dataclass(frozen=True, slots=True)
class DirectUploadPartCompletion:
    part_number: int
    etag: str


@dataclass(frozen=True, slots=True)
class FinalizeUploadRequest:
    descriptor_id: str
    protocol: str
    etag: str | None
    provider_version: str | None
    parts: tuple[DirectUploadPartCompletion, ...]
    size_bytes: int
    content_sha256: str


@dataclass(frozen=True, slots=True)
class FileGeneration:
    entry_id: str
    generation_id: str
    generation_number: int
    state: str
    expected_size_bytes: int
    content_sha256: str
    declared_media_type: str
    malware_scan_requirement: str
    safety_state: str
    revision: int
    created_at: str


@dataclass(frozen=True, slots=True)
class CapabilityDataClientSession:
    grant: CapabilitySessionGrant
    data_client: AlmiraDataClient


class AlmiraServerClient:
    """Minimal server-side client for exchanging workload evidence for capabilities."""

    def __init__(
        self,
        *,
        base_url: str,
        workload_session: str | WorkloadSessionProvider,
        transport: Transport | None = None,
        timeout: float = 30.0,
    ) -> None:
        parsed = urlsplit(base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.query
            or parsed.fragment
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or any(ord(character) <= 32 or ord(character) == 127 for character in base_url)
            or timeout <= 0
            or timeout > 300
            or not isinstance(workload_session, str)
            and not callable(workload_session)
        ):
            _invalid_input()
        self._base_url = base_url.rstrip("/")
        self._workload_session = workload_session
        self._transport = transport or _UrllibTransport(timeout)

    def create_capability_session(
        self,
        reference: CollectionReference,
        request: CreateCapabilitySessionRequest,
        *,
        operation_id: str,
    ) -> CapabilitySessionGrant:
        payload = _request_payload(request)
        value = self._json(
            "POST",
            _collection_path(reference, "/capability-sessions"),
            reference.tenant_id,
            operation_id,
            payload,
            201,
        )
        return _grant(value)

    def create_upload(
        self,
        reference: CollectionReference,
        request: CreateUploadRequest,
        *,
        operation_id: str,
    ) -> CreateUploadOutcome:
        value = self._json(
            "POST",
            _collection_path(reference, "/uploads"),
            reference.tenant_id,
            operation_id,
            _upload_request_payload(request),
            201,
        )
        return _upload_outcome(value)

    def finalize_upload(
        self,
        reference: CollectionReference,
        transfer_session_id: str,
        request: FinalizeUploadRequest,
        *,
        operation_id: str,
    ) -> FileGeneration:
        transfer_session_id = _uuid(transfer_session_id)
        value = self._json(
            "POST",
            _collection_path(reference, f"/uploads/{transfer_session_id}/finalize"),
            reference.tenant_id,
            operation_id,
            _finalize_request_payload(request),
            200,
        )
        return _file_generation(value)

    def create_upload_part(
        self,
        reference: CollectionReference,
        transfer_session_id: str,
        request: CreateMultipartPartGrantRequest,
        *,
        operation_id: str,
    ) -> DirectUploadPart:
        transfer_session_id = _uuid(transfer_session_id)
        payload = _multipart_part_request_payload(request)
        value = self._json(
            "POST",
            _collection_path(reference, f"/uploads/{transfer_session_id}/parts"),
            reference.tenant_id,
            operation_id,
            payload,
            201,
        )
        part = _upload_part(value)
        if part.part_number != request.part_number:
            _invalid_response()
        return part

    def bind_subject(
        self,
        reference: CollectionReference,
        entry_id: str,
        subject: SubjectReference,
        *,
        operation_id: str,
    ) -> SubjectBindingOutcome:
        entry_id = _uuid(entry_id)
        value = self._json(
            "POST",
            _collection_path(reference, f"/files/{entry_id}/subject-bindings"),
            reference.tenant_id,
            operation_id,
            _subject_payload(subject),
            201,
        )
        return _subject_binding_outcome(value)

    def list_subject_bindings(
        self,
        reference: SubjectProjectReference,
        subject: SubjectReference,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> SubjectBindingPage:
        if (
            not isinstance(reference, SubjectProjectReference)
            or isinstance(limit, bool)
            or not 1 <= limit <= 100
            or cursor is not None
            and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048)
        ):
            _invalid_input()
        value = self._json(
            "POST",
            f"/v1/projects/{_uuid(reference.project_id)}/subject-bindings/search",
            reference.tenant_id,
            None,
            {
                "subject": _subject_payload(subject),
                "limit": limit,
                **({} if cursor is None else {"cursor": cursor}),
            },
            200,
        )
        return _subject_binding_page(value)

    def start_subject_lifecycle_operation(
        self,
        reference: SubjectProjectReference,
        subject: SubjectReference,
        kind: str,
        *,
        operation_id: str,
    ) -> SubjectLifecycleOutcome:
        if not isinstance(reference, SubjectProjectReference) or kind not in {"restrict", "export", "delete"}:
            _invalid_input()
        value = self._json(
            "POST",
            f"/v1/projects/{_uuid(reference.project_id)}/subject-lifecycle-operations",
            reference.tenant_id,
            operation_id,
            {"subject": _subject_payload(subject), "kind": kind},
            (201, 202),
        )
        return _subject_lifecycle_outcome(value)

    def read_subject_lifecycle_operation(
        self,
        reference: SubjectProjectReference,
        lifecycle_operation_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
    ) -> SubjectLifecyclePage:
        if (
            not isinstance(reference, SubjectProjectReference)
            or isinstance(limit, bool)
            or not 1 <= limit <= 100
            or cursor is not None
            and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048)
        ):
            _invalid_input()
        value = self._json(
            "POST",
            f"/v1/projects/{_uuid(reference.project_id)}/subject-lifecycle-operations/search",
            reference.tenant_id,
            None,
            {
                "operation_id": _uuid(lifecycle_operation_id),
                "limit": limit,
                **({} if cursor is None else {"cursor": cursor}),
            },
            200,
        )
        return _subject_lifecycle_page(value)

    def create_capability_data_client(
        self,
        reference: CollectionReference,
        request: CreateCapabilitySessionRequest,
        *,
        operation_id: str,
        data_transport: Transport | None = None,
        data_timeout: float = 30.0,
        retry: RetryPolicy | None = None,
    ) -> CapabilityDataClientSession:
        grant = self.create_capability_session(reference, request, operation_id=operation_id)
        return CapabilityDataClientSession(
            grant=grant,
            data_client=AlmiraDataClient(
                base_url=self._base_url,
                capability=grant.token,
                origin=grant.audience,
                transport=data_transport,
                timeout=data_timeout,
                retry=retry,
            ),
        )

    def revoke_capability_session(
        self,
        reference: CollectionReference,
        session_id: str,
        *,
        operation_id: str,
    ) -> str:
        session_id = _uuid(session_id)
        value = self._json(
            "DELETE",
            _collection_path(reference, f"/capability-sessions/{session_id}"),
            reference.tenant_id,
            operation_id,
            None,
            200,
        )
        if value not in {"applied", "exact_replay"}:
            _invalid_response()
        return value

    def _json(
        self,
        method: str,
        path: str,
        tenant_id: str,
        operation_id: str | None,
        value: object | None,
        expected_status: int | tuple[int, ...],
    ) -> Any:
        tenant_id = _uuid(tenant_id)
        if operation_id is not None:
            operation_id = _uuid(operation_id)
        try:
            evidence = self._workload_session() if callable(self._workload_session) else self._workload_session
        except Exception as error:
            raise AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE") from error
        if not isinstance(evidence, str) or not 2 <= len(evidence) <= 48 * 1024 or re.fullmatch(r"[A-Za-z0-9_-]+", evidence) is None:
            _invalid_input()
        body = None if value is None else json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        headers = {
            "accept": "application/json",
            "authorization": f"MetamorphWorkload {evidence}",
            "x-almira-tenant-id": tenant_id,
        }
        if operation_id is not None:
            headers["idempotency-key"] = operation_id
        if body is not None:
            headers["content-type"] = "application/json"
        try:
            response = self._transport(method, f"{self._base_url}{path}", headers, body)
        except AlmiraClientError:
            raise
        except Exception as error:
            raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
        _validate_response(response)
        expected_statuses = (expected_status,) if isinstance(expected_status, int) else expected_status
        if response.status not in expected_statuses:
            _raise_api_error(response)
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip()
        if content_type != "application/json":
            response.close()
            _invalid_response()
        raw = _bounded_read(response, 2 * 1024 * 1024)
        try:
            decoded = json.loads(raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error
        if decoded is None:
            _invalid_response()
        return decoded


def _request_payload(request: CreateCapabilitySessionRequest) -> dict[str, object]:
    if not isinstance(request, CreateCapabilitySessionRequest):
        _invalid_input()
    subject = request.subject
    if (
        not isinstance(subject, BuilderSubject)
        or not _opaque(subject.subject_id)
        or subject.organization_id is not None and not _opaque(subject.organization_id)
        or len(subject.roles) > 16
        or len(set(subject.roles)) != len(subject.roles)
        or any(LABEL.fullmatch(role) is None for role in subject.roles)
        or len(subject.attributes) > 16
        or any(LABEL.fullmatch(key) is None or not _opaque(value) for key, value in subject.attributes.items())
    ):
        _invalid_input()
    if not 1 <= len(request.operations) <= 4 or len(set(request.operations)) != len(request.operations) or any(operation not in READ_OPERATIONS for operation in request.operations):
        _invalid_input()
    resource = _resource(request.resource, input_value=True)
    if not _origin(request.audience) or isinstance(request.lifetime_seconds, bool) or not 60 <= request.lifetime_seconds <= 900:
        _invalid_input()
    subject_value: dict[str, object] = {
        "subject_id": subject.subject_id,
        "roles": list(subject.roles),
        "attributes": dict(subject.attributes),
    }
    if subject.organization_id is not None:
        subject_value["organization_id"] = subject.organization_id
    return {
        "subject": subject_value,
        "operations": list(request.operations),
        "resource": resource,
        "audience": request.audience,
        "lifetime_seconds": request.lifetime_seconds,
    }


def _upload_request_payload(request: CreateUploadRequest) -> dict[str, object]:
    if (
        not isinstance(request, CreateUploadRequest)
        or not _logical_prefix(request.path)
        or isinstance(request.expected_size_bytes, bool)
        or not 1 <= request.expected_size_bytes <= 10_737_418_240
        or CONTENT_SHA256.fullmatch(request.content_sha256) is None
        or not 3 <= len(request.declared_media_type) <= 127
        or MEDIA_TYPE.fullmatch(request.declared_media_type) is None
        or request.browser_origin is not None
        and not _browser_origin(request.browser_origin)
    ):
        _invalid_input()
    value: dict[str, object] = {
        "path": request.path,
        "expected_size_bytes": request.expected_size_bytes,
        "content_sha256": request.content_sha256,
        "declared_media_type": request.declared_media_type,
    }
    if request.browser_origin is not None:
        value["browser_origin"] = request.browser_origin
    if request.protocol is not None:
        if request.protocol not in {"auto", "single_put", "multipart"}:
            _invalid_input()
        value["protocol"] = request.protocol
    return value


def _multipart_part_request_payload(request: CreateMultipartPartGrantRequest) -> dict[str, object]:
    if (
        not isinstance(request, CreateMultipartPartGrantRequest)
        or isinstance(request.part_number, bool)
        or not isinstance(request.part_number, int)
        or not 1 <= request.part_number <= 10_000
        or CONTENT_SHA256.fullmatch(request.content_sha256) is None
    ):
        _invalid_input()
    return {"part_number": request.part_number, "content_sha256": request.content_sha256}


def _finalize_request_payload(request: FinalizeUploadRequest) -> dict[str, object]:
    if (
        not isinstance(request, FinalizeUploadRequest)
        or UUID_V7.fullmatch(request.descriptor_id) is None
        or request.protocol not in {"single_put", "multipart"}
        or request.etag is not None
        and PROVIDER_RECEIPT.fullmatch(request.etag) is None
        or request.provider_version is not None
        and PROVIDER_VERSION.fullmatch(request.provider_version) is None
        or isinstance(request.size_bytes, bool)
        or not 1 <= request.size_bytes <= 10_737_418_240
        or CONTENT_SHA256.fullmatch(request.content_sha256) is None
        or not _completion_parts(request.protocol, request.parts)
        or request.protocol == "single_put"
        and (request.etag is None or request.parts[0].etag != request.etag)
        or request.protocol == "multipart"
        and (request.etag is not None or request.provider_version is not None)
    ):
        _invalid_input()
    return {
        "descriptor_id": request.descriptor_id,
        "protocol": request.protocol,
        "etag": request.etag,
        "provider_version": request.provider_version,
        "parts": [
            {"part_number": part.part_number, "etag": part.etag}
            for part in request.parts
        ],
        "size_bytes": request.size_bytes,
        "content_sha256": request.content_sha256,
    }


def _subject_payload(subject: SubjectReference) -> dict[str, str]:
    if (
        not isinstance(subject, SubjectReference)
        or SUBJECT_NAMESPACE.fullmatch(subject.namespace) is None
        or not _opaque(subject.subject_id)
        or len(subject.subject_id.encode("utf-8")) > 255
    ):
        _invalid_input()
    return {"namespace": subject.namespace, "subject_id": subject.subject_id}


def _subject_binding(value: object) -> SubjectBinding:
    expected = {
        "binding_id",
        "subject",
        "environment_id",
        "collection_instance_id",
        "entry_id",
        "entry_lifecycle",
        "created_at",
    }
    if not isinstance(value, dict) or set(value) != expected:
        _invalid_response()
    raw_subject = value["subject"]
    if (
        any(
            not isinstance(value[key], str) or UUID_V7.fullmatch(value[key]) is None
            for key in ("binding_id", "environment_id", "collection_instance_id", "entry_id")
        )
        or not isinstance(raw_subject, dict)
        or set(raw_subject) != {"namespace", "subject_id"}
        or not isinstance(raw_subject["namespace"], str)
        or SUBJECT_NAMESPACE.fullmatch(raw_subject["namespace"]) is None
        or not _opaque(raw_subject["subject_id"])
        or len(raw_subject["subject_id"].encode("utf-8")) > 255
        or value["entry_lifecycle"] not in {"active", "restricted", "deleted"}
        or not isinstance(value["created_at"], str)
        or not _timestamp(value["created_at"])
    ):
        _invalid_response()
    return SubjectBinding(
        binding_id=value["binding_id"],
        subject=SubjectReference(raw_subject["namespace"], raw_subject["subject_id"]),
        environment_id=value["environment_id"],
        collection_instance_id=value["collection_instance_id"],
        entry_id=value["entry_id"],
        entry_lifecycle=value["entry_lifecycle"],
        created_at=value["created_at"],
    )


def _subject_binding_outcome(value: object) -> SubjectBindingOutcome:
    if (
        not isinstance(value, dict)
        or set(value) != {"disposition", "binding"}
        or value["disposition"] not in {"applied", "already_bound", "exact_replay"}
    ):
        _invalid_response()
    return SubjectBindingOutcome(value["disposition"], _subject_binding(value["binding"]))


def _subject_binding_page(value: object) -> SubjectBindingPage:
    if not isinstance(value, dict) or set(value) != {"items", "next_cursor"}:
        _invalid_response()
    items = value["items"]
    cursor = value["next_cursor"]
    if (
        not isinstance(items, list)
        or len(items) > 100
        or cursor is not None
        and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048)
    ):
        _invalid_response()
    return SubjectBindingPage(tuple(_subject_binding(item) for item in items), cursor)


def _subject_lifecycle_operation(value: object) -> SubjectLifecycleOperation:
    expected = {
        "operation_id", "kind", "state", "subject", "matched_entries",
        "completed_entries", "pending_entries", "manifest_digest", "created_at", "updated_at",
    }
    if not isinstance(value, dict) or set(value) != expected:
        _invalid_response()
    raw_subject = value["subject"]
    counts = (value["matched_entries"], value["completed_entries"], value["pending_entries"])
    if (
        not isinstance(value["operation_id"], str)
        or UUID_V7.fullmatch(value["operation_id"]) is None
        or value["kind"] not in {"restrict", "export", "delete"}
        or value["state"] not in {"complete", "pending"}
        or not isinstance(raw_subject, dict)
        or set(raw_subject) != {"namespace", "subject_id"}
        or not isinstance(raw_subject["namespace"], str)
        or SUBJECT_NAMESPACE.fullmatch(raw_subject["namespace"]) is None
        or not _opaque(raw_subject["subject_id"])
        or any(isinstance(count, bool) or not isinstance(count, int) or count < 0 for count in counts)
        or counts[1] + counts[2] != counts[0]
        or (value["state"] == "complete") != (counts[2] == 0)
        or not isinstance(value["manifest_digest"], str)
        or CONTENT_SHA256.fullmatch(value["manifest_digest"]) is None
        or not isinstance(value["created_at"], str)
        or not _timestamp(value["created_at"])
        or not isinstance(value["updated_at"], str)
        or not _timestamp(value["updated_at"])
    ):
        _invalid_response()
    return SubjectLifecycleOperation(
        value["operation_id"],
        value["kind"],
        value["state"],
        SubjectReference(raw_subject["namespace"], raw_subject["subject_id"]),
        counts[0],
        counts[1],
        counts[2],
        value["manifest_digest"],
        value["created_at"],
        value["updated_at"],
    )


def _subject_lifecycle_outcome(value: object) -> SubjectLifecycleOutcome:
    if not isinstance(value, dict) or set(value) != {"operation"}:
        _invalid_response()
    return SubjectLifecycleOutcome(_subject_lifecycle_operation(value["operation"]))


def _subject_lifecycle_item(value: object) -> SubjectLifecycleItem:
    expected = {
        "binding_id", "environment_id", "collection_instance_id", "entry_id", "entry_revision",
        "disposition", "content_path", "recycle_until",
    }
    dispositions = {
        "export_ready", "restricted", "already_restricted", "already_deleted",
        "deleted_pending_retention", "shared_resource_restricted",
        "export_pending_bundle", "export_pending_restriction", "export_pending_retention",
    }
    if not isinstance(value, dict) or set(value) != expected:
        _invalid_response()
    content_path = value["content_path"]
    recycle_until = value["recycle_until"]
    if (
        any(
            not isinstance(value[key], str) or UUID_V7.fullmatch(value[key]) is None
            for key in ("binding_id", "environment_id", "collection_instance_id", "entry_id")
        )
        or isinstance(value["entry_revision"], bool)
        or not isinstance(value["entry_revision"], int)
        or value["entry_revision"] < 1
        or value["disposition"] not in dispositions
        or (value["disposition"] == "export_ready") != isinstance(content_path, str)
        or isinstance(content_path, str)
        and (not content_path.startswith("/v1/projects/") or len(content_path) > 512)
        or recycle_until is not None
        and (not isinstance(recycle_until, str) or not _timestamp(recycle_until))
    ):
        _invalid_response()
    return SubjectLifecycleItem(
        value["binding_id"], value["environment_id"], value["collection_instance_id"],
        value["entry_id"], value["entry_revision"], value["disposition"],
        content_path, recycle_until,
    )


def _subject_lifecycle_page(value: object) -> SubjectLifecyclePage:
    if not isinstance(value, dict) or set(value) != {"operation", "items", "next_cursor"}:
        _invalid_response()
    items = value["items"]
    cursor = value["next_cursor"]
    if (
        not isinstance(items, list)
        or len(items) > 100
        or cursor is not None
        and (not isinstance(cursor, str) or not 1 <= len(cursor) <= 2048)
    ):
        _invalid_response()
    return SubjectLifecyclePage(
        _subject_lifecycle_operation(value["operation"]),
        tuple(_subject_lifecycle_item(item) for item in items),
        cursor,
    )


def _grant(value: object) -> CapabilitySessionGrant:
    expected = {"session_id", "token", "operations", "resource", "audience", "policy_revision", "issuer_epoch", "expires_at"}
    if not isinstance(value, dict) or set(value) != expected:
        _invalid_response()
    operations = value["operations"]
    if not isinstance(operations, list) or not 1 <= len(operations) <= 4 or len(set(operations)) != len(operations) or any(operation not in READ_OPERATIONS for operation in operations):
        _invalid_response()
    if (
        not isinstance(value["session_id"], str)
        or UUID_V7.fullmatch(value["session_id"]) is None
        or not isinstance(value["token"], str)
        or not value["token"].startswith("alm_cap_v1.")
        or CAPABILITY.fullmatch(value["token"]) is None
        or not isinstance(value["audience"], str)
        or not _origin(value["audience"])
        or isinstance(value["policy_revision"], bool)
        or not isinstance(value["policy_revision"], int)
        or value["policy_revision"] < 1
        or isinstance(value["issuer_epoch"], bool)
        or not isinstance(value["issuer_epoch"], int)
        or value["issuer_epoch"] < 1
        or not isinstance(value["expires_at"], str)
        or not _timestamp(value["expires_at"])
    ):
        _invalid_response()
    resource_value = _resource(value["resource"], input_value=False)
    return CapabilitySessionGrant(
        session_id=value["session_id"],
        token=value["token"],
        operations=tuple(operations),
        resource=CapabilityResource(**resource_value),
        audience=value["audience"],
        policy_revision=value["policy_revision"],
        issuer_epoch=value["issuer_epoch"],
        expires_at=value["expires_at"],
    )


def _upload_outcome(value: object) -> CreateUploadOutcome:
    if not isinstance(value, dict) or set(value) != {"transfer_session_id", "entry_id", "generation_id", "descriptor"}:
        _invalid_response()
    if any(not isinstance(value[key], str) or UUID_V7.fullmatch(value[key]) is None for key in ("transfer_session_id", "entry_id", "generation_id")):
        _invalid_response()
    descriptor = _upload_descriptor(value["descriptor"])
    return CreateUploadOutcome(
        transfer_session_id=value["transfer_session_id"],
        entry_id=value["entry_id"],
        generation_id=value["generation_id"],
        descriptor=descriptor,
    )


def _upload_descriptor(value: object) -> DirectUploadDescriptor:
    expected = {"descriptor_id", "protocol", "requests", "expected_size_bytes", "content_sha256", "one_use", "expires_at", "part_size_bytes", "part_count"}
    if not isinstance(value, dict) or set(value) != expected:
        _invalid_response()
    raw_requests = value["requests"]
    if (
        not isinstance(value["descriptor_id"], str)
        or UUID_V7.fullmatch(value["descriptor_id"]) is None
        or value["protocol"] not in {"single_put", "multipart"}
        or not isinstance(raw_requests, list)
        or value["protocol"] == "single_put"
        and (len(raw_requests) != 1 or value["part_size_bytes"] is not None or value["part_count"] != 1)
        or value["protocol"] == "multipart"
        and (
            len(raw_requests) != 0
            or isinstance(value["part_size_bytes"], bool)
            or not isinstance(value["part_size_bytes"], int)
            or not 1 <= value["part_size_bytes"] <= 10_737_418_240
            or isinstance(value["part_count"], bool)
            or not isinstance(value["part_count"], int)
            or not 1 <= value["part_count"] <= 10_000
        )
        or isinstance(value["expected_size_bytes"], bool)
        or not isinstance(value["expected_size_bytes"], int)
        or not 1 <= value["expected_size_bytes"] <= 10_737_418_240
        or not isinstance(value["content_sha256"], str)
        or CONTENT_SHA256.fullmatch(value["content_sha256"]) is None
        or value["one_use"] is not True
        or not isinstance(value["expires_at"], str)
        or not _timestamp(value["expires_at"])
    ):
        _invalid_response()
    if value["protocol"] == "multipart" and (
        value["part_size_bytes"] * (value["part_count"] - 1) >= value["expected_size_bytes"]
        or value["part_size_bytes"] * value["part_count"] < value["expected_size_bytes"]
    ):
        _invalid_response()
    parts: list[DirectUploadPart] = []
    offset = 0
    for index, raw in enumerate(raw_requests, 1):
        part = _upload_part(raw)
        if part.part_number != index or part.offset_bytes != offset:
            _invalid_response()
        parts.append(part)
        offset += part.length_bytes
    if value["protocol"] == "single_put" and offset != value["expected_size_bytes"]:
        _invalid_response()
    return DirectUploadDescriptor(
        value["descriptor_id"],
        value["protocol"],
        tuple(parts),
        value["expected_size_bytes"],
        value["content_sha256"],
        True,
        value["expires_at"],
        value["part_size_bytes"],
        value["part_count"],
    )


def _upload_part(raw: object) -> DirectUploadPart:
    if not isinstance(raw, dict) or set(raw) != {"part_number", "offset_bytes", "length_bytes", "method", "url", "headers", "one_use"}:
        _invalid_response()
    raw_headers = raw["headers"]
    if (
        isinstance(raw["part_number"], bool)
        or not isinstance(raw["part_number"], int)
        or not 1 <= raw["part_number"] <= 10_000
        or isinstance(raw["offset_bytes"], bool)
        or not isinstance(raw["offset_bytes"], int)
        or raw["offset_bytes"] < 0
        or isinstance(raw["length_bytes"], bool)
        or not isinstance(raw["length_bytes"], int)
        or not 1 <= raw["length_bytes"] <= 10_737_418_240
        or raw["method"] != "PUT"
        or not isinstance(raw["url"], str)
        or not _transfer_url(raw["url"])
        or not isinstance(raw_headers, list)
        or len(raw_headers) > 32
        or raw["one_use"] is not True
    ):
        _invalid_response()
    headers: list[DirectUploadHeader] = []
    names: set[str] = set()
    for header in raw_headers:
        if (
            not isinstance(header, dict)
            or set(header) != {"name", "value"}
            or not isinstance(header["name"], str)
            or HEADER_NAME.fullmatch(header["name"]) is None
            or header["name"] in names
            or not isinstance(header["value"], str)
            or not 1 <= len(header["value"]) <= 4096
            or any(ord(character) < 32 or ord(character) == 127 for character in header["value"])
        ):
            _invalid_response()
        names.add(header["name"])
        headers.append(DirectUploadHeader(header["name"], header["value"]))
    return DirectUploadPart(raw["part_number"], raw["offset_bytes"], raw["length_bytes"], "PUT", raw["url"], tuple(headers))


def _completion_parts(protocol: str, parts: tuple[DirectUploadPartCompletion, ...]) -> bool:
    expected_count = len(parts) == 1 if protocol == "single_put" else 1 <= len(parts) <= 10_000
    return expected_count and all(
        isinstance(part, DirectUploadPartCompletion)
        and part.part_number == index
        and PROVIDER_RECEIPT.fullmatch(part.etag) is not None
        for index, part in enumerate(parts, 1)
    )


def _file_generation(value: object) -> FileGeneration:
    expected = {"entry_id", "generation_id", "generation_number", "state", "expected_size_bytes", "content_sha256", "declared_media_type", "malware_scan_requirement", "safety_state", "revision", "created_at"}
    if not isinstance(value, dict) or not (
        set(value) == expected
        and all(isinstance(value[key], str) and UUID_V7.fullmatch(value[key]) is not None for key in ("entry_id", "generation_id"))
        and all(isinstance(value[key], int) and not isinstance(value[key], bool) and value[key] >= 1 for key in ("generation_number", "expected_size_bytes", "revision"))
        and value["state"] in {"pending_transfer", "aborted", "safety_pending", "available", "unavailable"}
        and isinstance(value["content_sha256"], str)
        and CONTENT_SHA256.fullmatch(value["content_sha256"]) is not None
        and isinstance(value["declared_media_type"], str)
        and MEDIA_TYPE.fullmatch(value["declared_media_type"]) is not None
        and value["malware_scan_requirement"] in {"not_required", "required"}
        and value["safety_state"] in {"not_required", "scan_pending", "clean", "blocked"}
        and isinstance(value["created_at"], str)
        and _timestamp(value["created_at"])
    ):
        _invalid_response()
    return FileGeneration(**value)


def _resource(value: object, *, input_value: bool) -> dict[str, str]:
    failure = _invalid_input if input_value else _invalid_response
    if isinstance(value, CapabilityResource):
        raw = {"kind": value.kind}
        if value.path_prefix is not None:
            raw["path_prefix"] = value.path_prefix
        if value.entry_id is not None:
            raw["entry_id"] = value.entry_id
    elif isinstance(value, dict):
        raw = value
    else:
        failure()
    kind = raw.get("kind")
    if kind == "collection" and set(raw) == {"kind"}:
        return {"kind": "collection"}
    if kind == "prefix" and set(raw) == {"kind", "path_prefix"} and isinstance(raw.get("path_prefix"), str) and _logical_prefix(raw["path_prefix"]):
        return {"kind": "prefix", "path_prefix": raw["path_prefix"]}
    if kind == "entry" and set(raw) == {"kind", "entry_id"} and isinstance(raw.get("entry_id"), str) and UUID_V7.fullmatch(raw["entry_id"]):
        return {"kind": "entry", "entry_id": raw["entry_id"]}
    failure()
    raise AssertionError("unreachable")


def _collection_path(reference: CollectionReference, suffix: str) -> str:
    return f"/v1/projects/{_uuid(reference.project_id)}/environments/{_uuid(reference.environment_id)}/collections/{_uuid(reference.collection_instance_id)}{suffix}"


def _uuid(value: str) -> str:
    if not isinstance(value, str) or UUID_V7.fullmatch(value) is None:
        _invalid_input()
    return value


def _opaque(value: object) -> bool:
    return isinstance(value, str) and 1 <= len(value) <= 255 and value == value.strip() and not any(ord(character) < 32 or ord(character) == 127 for character in value)


def _logical_prefix(value: str) -> bool:
    return 1 <= len(value) <= 1024 and all(segment not in {"", ".", ".."} and len(segment) <= 255 and re.fullmatch(r"[A-Za-z0-9._~-]+", segment) is not None for segment in value.split("/"))


def _origin(value: str) -> bool:
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc) and not parsed.path and not parsed.query and not parsed.fragment and parsed.username is None and parsed.password is None


def _browser_origin(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    if parsed.path or parsed.query or parsed.fragment or parsed.username is not None or parsed.password is not None or port is not None and not 1 <= port <= 65535:
        return False
    hostname = parsed.hostname or ""
    return (
        parsed.scheme == "https"
        and re.fullmatch(r"[a-z0-9][a-z0-9.-]*", hostname) is not None
        or parsed.scheme == "http"
        and hostname in {"localhost", "127.0.0.1"}
    )


def _transfer_url(value: str) -> bool:
    if len(value) > 8192 or any(ord(character) <= 32 or ord(character) == 127 or character == "\\" for character in value):
        return False
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.hostname) and parsed.username is None and parsed.password is None and not parsed.fragment


def _timestamp(value: str) -> bool:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is not None
    except ValueError:
        return False


def _validate_response(response: HttpResponse) -> None:
    if not isinstance(response, HttpResponse) or isinstance(response.status, bool) or not 100 <= response.status <= 599 or not callable(getattr(response.body, "read", None)) or not callable(getattr(response.body, "close", None)):
        _invalid_response()
    try:
        headers = {key.lower(): item for key, item in response.headers.items() if isinstance(key, str) and isinstance(item, str)}
    except Exception as error:
        response.close()
        raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error
    if len(headers) != len(response.headers):
        response.close()
        _invalid_response()
    response.headers = headers


def _raise_api_error(response: HttpResponse) -> None:
    raw = _bounded_read(response, 64 * 1024)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error
    if not isinstance(value, dict) or set(value) != {"code", "request_id"} or not isinstance(value["code"], str) or API_ERROR.fullmatch(value["code"]) is None or not isinstance(value["request_id"], str) or UUID_V7.fullmatch(value["request_id"]) is None:
        _invalid_response()
    retry_after = response.headers.get("retry-after")
    retry_seconds = int(retry_after) if retry_after is not None and re.fullmatch(r"[0-9]{1,8}", retry_after) else None
    raise AlmiraApiError(value["code"], value["request_id"], response.status, retry_seconds)
