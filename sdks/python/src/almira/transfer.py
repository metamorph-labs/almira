"""Credential-isolated direct upload execution for Almira one-use descriptors."""

from __future__ import annotations

import http.client
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import BinaryIO, Callable, Mapping, Protocol
from urllib.parse import urlsplit

from .server import (
    DirectUploadDescriptor,
    DirectUploadPart,
    DirectUploadPartCompletion,
    FinalizeUploadRequest,
    _upload_descriptor,
)


class AlmiraTransferError(Exception):
    """Stable transfer failure that never contains provider URLs, headers, or bodies."""

    def __init__(self, code: str, part_number: int | None = None, status: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.part_number = part_number
        self.status = status


@dataclass(frozen=True, slots=True)
class DirectUploadResponse:
    status: int
    headers: Mapping[str, str]


class DirectUploadTransport(Protocol):
    def __call__(self, part: DirectUploadPart, body: BinaryIO) -> DirectUploadResponse: ...


class _BoundedReader:
    def __init__(self, source: BinaryIO, remaining: int) -> None:
        self._source = source
        self._remaining = remaining

    @property
    def remaining(self) -> int:
        return self._remaining

    def read(self, size: int = -1) -> bytes:
        if self._remaining == 0:
            return b""
        size = self._remaining if size < 0 else min(size, self._remaining)
        value = self._source.read(size)
        if not isinstance(value, bytes):
            raise OSError("source did not return bytes")
        self._remaining -= len(value)
        return value


def upload_direct(
    descriptor: DirectUploadDescriptor,
    body: BinaryIO,
    *,
    size_bytes: int,
    transport: DirectUploadTransport | None = None,
    now: Callable[[], datetime] | None = None,
) -> FinalizeUploadRequest:
    """Streams exact descriptor slices and returns the evidence accepted by `finalize_upload`."""

    admitted = _admit_descriptor(descriptor)
    if isinstance(size_bytes, bool) or size_bytes != admitted.expected_size_bytes:
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID")
    if not callable(getattr(body, "read", None)) or not callable(getattr(body, "seek", None)):
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID")
    clock = now or (lambda: datetime.now(timezone.utc))
    execute = transport or _put_https
    completions: list[DirectUploadPartCompletion] = []
    object_etag: str | None = None
    provider_version: str | None = None
    for part in admitted.requests:
        _require_unexpired(admitted, clock())
        try:
            body.seek(part.offset_bytes)
            bounded = _BoundedReader(body, part.length_bytes)
            response = execute(part, bounded)
        except AlmiraTransferError:
            raise
        except Exception:
            raise AlmiraTransferError("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", part.part_number) from None
        if bounded.remaining != 0:
            raise AlmiraTransferError("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", part.part_number)
        if not isinstance(response, DirectUploadResponse) or isinstance(response.status, bool) or not 100 <= response.status <= 599:
            raise AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", part.part_number)
        try:
            headers = {name.lower(): value for name, value in response.headers.items() if isinstance(name, str) and isinstance(value, str)}
        except Exception:
            raise AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", part.part_number) from None
        if len(headers) != len(response.headers):
            raise AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", part.part_number)
        if not 200 <= response.status < 300:
            raise AlmiraTransferError("ALMIRA_TRANSFER_PART_REFUSED", part.part_number, response.status)
        etag = headers.get("etag")
        if etag is None or not _provider_receipt(etag):
            raise AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", part.part_number)
        if admitted.protocol == "single_put":
            versions = [headers[name] for name in ("x-amz-version-id", "x-goog-generation", "x-ms-version-id") if name in headers]
            if any(not _provider_version(value) for value in versions) or len(set(versions)) > 1:
                raise AlmiraTransferError("ALMIRA_TRANSFER_RESPONSE_INVALID", part.part_number)
            object_etag = etag
            provider_version = versions[0] if versions else None
        completions.append(DirectUploadPartCompletion(part.part_number, etag))
    return FinalizeUploadRequest(
        descriptor_id=admitted.descriptor_id,
        protocol=admitted.protocol,
        etag=object_etag,
        provider_version=provider_version if admitted.protocol == "single_put" else None,
        parts=tuple(completions),
        size_bytes=size_bytes,
        content_sha256=admitted.content_sha256,
    )


def _put_https(part: DirectUploadPart, body: BinaryIO) -> DirectUploadResponse:
    parsed = urlsplit(part.url)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=30)
    headers = {header.name: header.value for header in part.headers}
    headers.setdefault("content-length", str(part.length_bytes))
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    try:
        connection.request("PUT", target, body=body, headers=headers, encode_chunked=False)
        response = connection.getresponse()
        result = DirectUploadResponse(response.status, {name.lower(): value for name, value in response.getheaders()})
        response.close()
        return result
    finally:
        connection.close()


def _admit_descriptor(descriptor: DirectUploadDescriptor) -> DirectUploadDescriptor:
    if not isinstance(descriptor, DirectUploadDescriptor):
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID")
    try:
        return _upload_descriptor({
            "descriptor_id": descriptor.descriptor_id,
            "protocol": descriptor.protocol,
            "requests": [{
                "part_number": part.part_number,
                "offset_bytes": part.offset_bytes,
                "length_bytes": part.length_bytes,
                "method": part.method,
                "url": part.url,
                "headers": [{"name": header.name, "value": header.value} for header in part.headers],
                "one_use": part.one_use,
            } for part in descriptor.requests],
            "expected_size_bytes": descriptor.expected_size_bytes,
            "content_sha256": descriptor.content_sha256,
            "one_use": descriptor.one_use,
            "expires_at": descriptor.expires_at,
        })
    except Exception:
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID") from None


def _require_unexpired(descriptor: DirectUploadDescriptor, now: datetime) -> None:
    if not isinstance(now, datetime) or now.tzinfo is None:
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_INVALID")
    expires_at = datetime.fromisoformat(descriptor.expires_at.replace("Z", "+00:00"))
    if expires_at <= now:
        raise AlmiraTransferError("ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED")


def _provider_receipt(value: str) -> bool:
    return 1 <= len(value) <= 256 and all("!" <= character <= "~" for character in value)


def _provider_version(value: str) -> bool:
    return _provider_receipt(value) and not any(character in "/?#\\" for character in value)
