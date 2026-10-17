"""Capability-only application data client for Almira."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from email.message import Message
from http.client import HTTPMessage
from typing import Any, BinaryIO, Callable, Iterable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

UUID_V7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CAPABILITY = re.compile(r"^alm_(?:cap|local)_v1\.[A-Za-z0-9_.-]{20,24576}$")
SHARE_TOKEN = re.compile(r"^alm_share_v1\.[A-Za-z0-9_-]{43}$")
API_ERROR = re.compile(r"^ALMIRA_[A-Z0-9_]{1,120}$")
BYTE_RANGE = re.compile(r"^bytes=[0-9]+-[0-9]*$")
VARIANT = re.compile(r"^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$")


class AlmiraClientError(Exception):
    """A stable local SDK failure that does not disclose response or credential content."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class AlmiraApiError(Exception):
    """A stable error returned by the Almira API."""

    def __init__(
        self,
        code: str,
        request_id: str,
        status: int,
        retry_after_seconds: int | None,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.request_id = request_id
        self.status = status
        self.retry_after_seconds = retry_after_seconds


@dataclass(frozen=True, slots=True)
class CollectionReference:
    tenant_id: str
    project_id: str
    environment_id: str
    collection_instance_id: str


@dataclass(frozen=True, slots=True)
class FileReference(CollectionReference):
    entry_id: str


@dataclass(frozen=True, slots=True)
class ImmutableGenerationReference(FileReference):
    generation_id: str


@dataclass(frozen=True, slots=True)
class DerivativeReference(ImmutableGenerationReference):
    variant_key: str


@dataclass(slots=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: BinaryIO

    def close(self) -> None:
        self.body.close()


@dataclass(slots=True)
class BinaryResponse:
    status: int
    headers: Mapping[str, str]
    body: BinaryIO
    content_length: int | None
    content_range: str | None
    content_type: str | None
    etag: str | None

    def iter_bytes(self, chunk_size: int = 64 * 1024) -> Iterable[bytes]:
        if chunk_size < 1 or chunk_size > 8 * 1024 * 1024:
            raise AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID")
        while True:
            try:
                chunk = self.body.read(chunk_size)
            except Exception as error:
                self.close()
                raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
            if not chunk:
                return
            if not isinstance(chunk, bytes):
                self.close()
                _invalid_response()
            yield chunk

    def close(self) -> None:
        self.body.close()

    def __enter__(self) -> BinaryResponse:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class Transport(Protocol):
    def __call__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> HttpResponse: ...


CapabilityProvider = Callable[[], str]


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_: object, **__: object) -> None:
        return None


class _UrllibTransport:
    def __init__(self, timeout: float) -> None:
        self._timeout = timeout
        self._opener = build_opener(_NoRedirect())

    def __call__(
        self,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: bytes | None,
    ) -> HttpResponse:
        request = Request(url, data=body, headers=dict(headers), method=method)
        try:
            response = self._opener.open(request, timeout=self._timeout)
        except HTTPError as error:
            response = error
        except (OSError, URLError, TimeoutError) as error:
            raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
        return HttpResponse(
            status=response.status,
            headers=_headers(response.headers),
            body=response,
        )


class AlmiraDataClient:
    """Application data-plane client accepting only Almira capability tokens."""

    def __init__(
        self,
        *,
        base_url: str,
        capability: str | CapabilityProvider | None = None,
        origin: str | None = None,
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
        ):
            _invalid_input()
        if origin is not None:
            origin_parts = urlsplit(origin)
            if (
                origin_parts.scheme not in {"http", "https"}
                or not origin_parts.netloc
                or origin_parts.path
                or origin_parts.query
                or origin_parts.fragment
                or origin_parts.username is not None
                or origin_parts.password is not None
                or any(ord(character) <= 32 or ord(character) == 127 for character in origin)
            ):
                _invalid_input()
        if timeout <= 0 or timeout > 300:
            _invalid_input()
        self._base_url = base_url.rstrip("/")
        self._capability = capability
        self._origin = origin
        self._transport = transport or _UrllibTransport(timeout)

    def list_files_with_capability(
        self,
        reference: CollectionReference,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        path_prefix: str | None = None,
    ) -> Any:
        query: list[tuple[str, str]] = []
        if limit is not None:
            if not 1 <= limit <= 100:
                _invalid_input()
            query.append(("limit", str(limit)))
        if cursor is not None:
            if not cursor or len(cursor) > 2048:
                _invalid_input()
            query.append(("cursor", cursor))
        if path_prefix is not None:
            if not path_prefix or len(path_prefix) > 1024:
                _invalid_input()
            query.append(("path_prefix", path_prefix))
        return self._json("GET", _with_query(_data_collection_path(reference, "/files"), query))

    def search_files_with_capability(
        self,
        reference: CollectionReference,
        search: Mapping[str, Any],
    ) -> Any:
        if not isinstance(search, Mapping):
            _invalid_input()
        return self._json("POST", _data_collection_path(reference, "/search"), dict(search))

    def get_file_metadata_with_capability(self, reference: FileReference) -> Any:
        return self._json(
            "GET",
            f"{_data_collection_path(reference, '/files')}/{_uuid(reference.entry_id)}",
        )

    def list_derivatives_with_capability(
        self,
        reference: ImmutableGenerationReference,
    ) -> Any:
        return self._json(
            "GET",
            f"{_data_collection_path(reference, '/files')}/{_uuid(reference.entry_id)}"
            f"/versions/{_uuid(reference.generation_id)}/derivatives",
        )

    def read_immutable_generation(
        self,
        reference: ImmutableGenerationReference,
        *,
        byte_range: str | None = None,
        if_none_match: str | None = None,
    ) -> BinaryResponse:
        path = (
            f"/v1/delivery/{_uuid(reference.tenant_id)}/{_uuid(reference.project_id)}"
            f"/{_uuid(reference.environment_id)}/{_uuid(reference.collection_instance_id)}"
            f"/{_uuid(reference.entry_id)}/{_uuid(reference.generation_id)}"
        )
        return self._binary(path, byte_range, if_none_match, capability_mode="optional")

    def read_derivative(
        self,
        reference: DerivativeReference,
        *,
        byte_range: str | None = None,
        if_none_match: str | None = None,
    ) -> BinaryResponse:
        path = (
            f"/v1/delivery/{_uuid(reference.tenant_id)}/{_uuid(reference.project_id)}"
            f"/{_uuid(reference.environment_id)}/{_uuid(reference.collection_instance_id)}"
            f"/{_uuid(reference.entry_id)}/{_uuid(reference.generation_id)}"
            f"/variants/{_variant(reference.variant_key)}"
        )
        return self._binary(path, byte_range, if_none_match, capability_mode="optional")

    def read_share(
        self,
        share_token: str,
        *,
        byte_range: str | None = None,
        if_none_match: str | None = None,
    ) -> BinaryResponse:
        if not SHARE_TOKEN.fullmatch(share_token):
            _invalid_input()
        return self._binary(
            f"/v1/shares/{share_token}",
            byte_range,
            if_none_match,
            capability_mode="forbidden",
        )

    def _json(self, method: str, path: str, value: Any = None) -> Any:
        headers = {"accept": "application/json"}
        body = None
        if value is not None:
            headers["content-type"] = "application/json"
            try:
                body = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            except (TypeError, ValueError) as error:
                raise AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID") from error
        response = self._request(method, path, headers, body, capability_mode="required")
        if not 200 <= response.status < 300:
            self._raise_api_error(response)
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            response.close()
            _invalid_response()
        raw = _bounded_read(response, 2 * 1024 * 1024)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error

    def _binary(
        self,
        path: str,
        byte_range: str | None,
        if_none_match: str | None,
        *,
        capability_mode: str,
    ) -> BinaryResponse:
        headers = {"accept": "application/octet-stream"}
        if byte_range is not None:
            if len(byte_range) > 64 or not BYTE_RANGE.fullmatch(byte_range):
                _invalid_input()
            headers["range"] = byte_range
        if if_none_match is not None:
            if not if_none_match or len(if_none_match) > 512 or "\r" in if_none_match or "\n" in if_none_match:
                _invalid_input()
            headers["if-none-match"] = if_none_match
        response = self._request("GET", path, headers, None, capability_mode=capability_mode)
        if response.status not in {200, 206, 304}:
            self._raise_api_error(response)
        return BinaryResponse(
            status=response.status,
            headers=response.headers,
            body=response.body,
            content_length=_safe_integer(response.headers.get("content-length")),
            content_range=response.headers.get("content-range"),
            content_type=response.headers.get("content-type"),
            etag=response.headers.get("etag"),
        )

    def _request(
        self,
        method: str,
        path: str,
        headers: dict[str, str],
        body: bytes | None,
        *,
        capability_mode: str,
    ) -> HttpResponse:
        if capability_mode != "forbidden" and self._origin is not None:
            headers["origin"] = self._origin
        if capability_mode != "forbidden" and self._capability is not None:
            try:
                capability = self._capability() if callable(self._capability) else self._capability
            except Exception as error:
                raise AlmiraClientError("ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE") from error
            if not isinstance(capability, str) or not CAPABILITY.fullmatch(capability):
                _invalid_input()
            headers["authorization"] = f"Bearer {capability}"
        elif capability_mode == "required":
            _invalid_input()
        try:
            response = self._transport(method, f"{self._base_url}{path}", headers, body)
        except AlmiraClientError:
            raise
        except Exception as error:
            raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
        if (
            not isinstance(response, HttpResponse)
            or isinstance(response.status, bool)
            or not isinstance(response.status, int)
            or not 100 <= response.status <= 599
            or not callable(getattr(response.body, "read", None))
            or not callable(getattr(response.body, "close", None))
        ):
            _invalid_response()
        try:
            items = response.headers.items()
            headers = {
                key.lower(): value
                for key, value in items
                if isinstance(key, str) and isinstance(value, str)
            }
        except Exception as error:
            response.close()
            raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error
        if len(headers) != len(response.headers):
            response.close()
            _invalid_response()
        response.headers = headers
        return response

    def _raise_api_error(self, response: HttpResponse) -> None:
        raw = _bounded_read(response, 64 * 1024)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID") from error
        if (
            not isinstance(value, dict)
            or set(value) != {"code", "request_id"}
            or not isinstance(value["code"], str)
            or not API_ERROR.fullmatch(value["code"])
            or not isinstance(value["request_id"], str)
            or not UUID_V7.fullmatch(value["request_id"])
        ):
            _invalid_response()
        retry_after = response.headers.get("retry-after")
        retry_seconds = int(retry_after) if retry_after is not None and re.fullmatch(r"[0-9]{1,8}", retry_after) else None
        raise AlmiraApiError(value["code"], value["request_id"], response.status, retry_seconds)


def _data_collection_path(reference: CollectionReference, suffix: str) -> str:
    return (
        f"/v1/data/{_uuid(reference.tenant_id)}/{_uuid(reference.project_id)}"
        f"/{_uuid(reference.environment_id)}/{_uuid(reference.collection_instance_id)}{suffix}"
    )


def _uuid(value: str) -> str:
    if not isinstance(value, str) or not UUID_V7.fullmatch(value):
        _invalid_input()
    return value


def _variant(value: str) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= 160
        or not VARIANT.fullmatch(value)
        or "//" in value
        or any(segment in {".", ".."} for segment in value.split("/"))
    ):
        _invalid_input()
    return "/".join(quote(segment, safe="") for segment in value.split("/"))


def _with_query(path: str, values: list[tuple[str, str]]) -> str:
    return path if not values else f"{path}?{urlencode(values)}"


def _bounded_read(response: HttpResponse, limit: int) -> bytes:
    try:
        raw = response.body.read(limit + 1)
    except Exception as error:
        response.close()
        raise AlmiraClientError("ALMIRA_CLIENT_NETWORK") from error
    response.close()
    if not isinstance(raw, bytes) or not raw or len(raw) > limit:
        _invalid_response()
    return raw


def _safe_integer(value: str | None) -> int | None:
    if value is None or not re.fullmatch(r"0|[1-9][0-9]{0,15}", value):
        return None
    parsed = int(value)
    return parsed if parsed <= 9_007_199_254_740_991 else None


def _headers(value: Message | HTTPMessage) -> Mapping[str, str]:
    return {key.lower(): item for key, item in value.items()}


def _invalid_input() -> None:
    raise AlmiraClientError("ALMIRA_CLIENT_INPUT_INVALID")


def _invalid_response() -> None:
    raise AlmiraClientError("ALMIRA_CLIENT_RESPONSE_INVALID")
