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


@dataclass(frozen=True, slots=True)
class BuilderSubject:
    subject_id: str
    organization_id: str | None = None
    roles: tuple[str, ...] = ()
    attributes: Mapping[str, str] = field(default_factory=dict)


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
    token: str
    operations: tuple[str, ...]
    resource: CapabilityResource
    audience: str
    policy_revision: int
    issuer_epoch: int
    expires_at: str


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
        operation_id: str,
        value: object | None,
        expected_status: int,
    ) -> Any:
        operation_id = _uuid(operation_id)
        tenant_id = _uuid(tenant_id)
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
            "idempotency-key": operation_id,
            "x-almira-tenant-id": tenant_id,
        }
        if body is not None:
            headers["content-type"] = "application/json"
        try:
            response = self._transport(method, f"{self._base_url}{path}", headers, body)
        except AlmiraClientError:
            raise
        except Exception as error:
            raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
        _validate_response(response)
        if response.status != expected_status:
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
