"""Closed-shape Ed25519 verification for Almira V1 behavior receipts."""

from __future__ import annotations

import base64
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Mapping


_UUID_V7 = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_KEY_ID = re.compile(r"^[a-z][a-z0-9._-]{0,63}$")
_CHECKS = (
    "finalization_idempotency",
    "private_read_integrity",
    "cross_scope_refusal",
    "malware_safety",
)


@dataclass(frozen=True)
class VerificationReceiptExpectation:
    tenant_id: str
    project_id: str
    environment_id: str
    collection_instance_id: str
    entry_id: str
    generation_id: str
    expected_size_bytes: int
    content_sha256: str
    verification_id: str | None = None


def verify_verification_receipt(
    signed: Mapping[str, object],
    key_set: Mapping[str, object],
    expected: VerificationReceiptExpectation | Mapping[str, object] | None = None,
) -> bool:
    """Verify a receipt against a trusted key set and optional exact resource binding."""

    try:
        if set(signed) != {"algorithm", "receipt", "signature"} or signed["algorithm"] != "ed25519":
            return False
        receipt = signed["receipt"]
        if not isinstance(receipt, dict) or not _valid_receipt(receipt):
            return False
        signature = _decode_base64url(signed["signature"], 64)
        if signature is None or set(key_set) != {"format_version", "keys"} or key_set["format_version"] != 1:
            return False
        keys = key_set["keys"]
        if not isinstance(keys, list) or not 1 <= len(keys) <= 4:
            return False
        if expected is not None and not _matches(receipt, expected):
            return False
        matching: list[object] = []
        for key in keys:
            if not isinstance(key, dict) or set(key) != {"algorithm", "key_id", "public_key"}:
                return False
            key_id = key["key_id"]
            if key["algorithm"] != "ed25519" or not isinstance(key_id, str) or _KEY_ID.fullmatch(key_id) is None:
                return False
            if key_id == receipt["signing_key_id"]:
                matching.append(key["public_key"])
        if len(matching) != 1:
            return False
        public_key = _decode_base64url(matching[0], 32)
        if public_key is None:
            return False
        message = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode("utf-8")
        return _verify_ed25519(public_key, signature, message)
    except (KeyError, TypeError, ValueError, OverflowError):
        return False


def _valid_receipt(receipt: Mapping[str, object]) -> bool:
    fields = {
        "checks", "collection_instance_id", "content_sha256", "contract_version", "entry_id",
        "environment_id", "expected_size_bytes", "generation_id", "project_id", "realm_id",
        "receipt_version", "safety_state", "signing_key_id", "tenant_id", "verification_id",
    }
    size = receipt.get("expected_size_bytes")
    if (
        set(receipt) != fields
        or receipt.get("receipt_version") != "almira.verification.v1"
        or receipt.get("contract_version") != "0.1.0-dev.59"
        or not isinstance(receipt.get("signing_key_id"), str)
        or _KEY_ID.fullmatch(str(receipt["signing_key_id"])) is None
        or not isinstance(receipt.get("content_sha256"), str)
        or _DIGEST.fullmatch(str(receipt["content_sha256"])) is None
        or type(size) is not int
        or not 1 <= size <= 8 * 1024 * 1024
        or receipt.get("safety_state") not in {"not_required", "clean"}
    ):
        return False
    for field in (
        "verification_id", "realm_id", "tenant_id", "project_id", "environment_id",
        "collection_instance_id", "entry_id", "generation_id",
    ):
        value = receipt.get(field)
        if not isinstance(value, str) or _UUID_V7.fullmatch(value) is None:
            return False
    checks = receipt.get("checks")
    return isinstance(checks, list) and len(checks) == len(_CHECKS) and all(
        isinstance(check, dict)
        and set(check) == {"name", "result"}
        and check["name"] == name
        and check["result"] == "passed"
        for name, check in zip(_CHECKS, checks, strict=True)
    )


def _matches(
    receipt: Mapping[str, object],
    expected: VerificationReceiptExpectation | Mapping[str, object],
) -> bool:
    values: Mapping[str, object]
    if isinstance(expected, VerificationReceiptExpectation):
        values = expected.__dict__
    else:
        values = expected
    fields = (
        "tenant_id", "project_id", "environment_id", "collection_instance_id", "entry_id",
        "generation_id", "expected_size_bytes", "content_sha256",
    )
    return all(field in values and receipt[field] == values[field] for field in fields) and (
        values.get("verification_id") is None or receipt["verification_id"] == values["verification_id"]
    )


def _decode_base64url(value: object, size: int) -> bytes | None:
    if not isinstance(value, str) or "=" in value or re.fullmatch(r"[A-Za-z0-9_-]+", value) is None:
        return None
    try:
        decoded = base64.urlsafe_b64decode(value + "=" * ((4 - len(value) % 4) % 4))
    except ValueError:
        return None
    return decoded if len(decoded) == size and base64.urlsafe_b64encode(decoded).rstrip(b"=").decode() == value else None


# Verification uses only public inputs. The complete extended-coordinate implementation keeps the
# dependency-free SDK portable while enforcing canonical encodings and prime-order points.
_FIELD = 2**255 - 19
_ORDER = 2**252 + 27742317777372353535851937790883648493
_D = (-121665 * pow(121666, _FIELD - 2, _FIELD)) % _FIELD
_SQRT_M1 = pow(2, (_FIELD - 1) // 4, _FIELD)
_IDENTITY = (0, 1, 1, 0)


def _recover_x(y: int, sign: int) -> int | None:
    xx = (y * y - 1) * pow(_D * y * y + 1, _FIELD - 2, _FIELD) % _FIELD
    x = pow(xx, (_FIELD + 3) // 8, _FIELD)
    if (x * x - xx) % _FIELD != 0:
        x = x * _SQRT_M1 % _FIELD
    if (x * x - xx) % _FIELD != 0:
        return None
    if x & 1 != sign:
        x = _FIELD - x
    return x


def _decode_point(encoded: bytes) -> tuple[int, int, int, int] | None:
    value = int.from_bytes(encoded, "little")
    sign = value >> 255
    y = value & ((1 << 255) - 1)
    if y >= _FIELD:
        return None
    x = _recover_x(y, sign)
    if x is None or (x == 0 and sign == 1):
        return None
    return (x, y, 1, x * y % _FIELD)


def _add(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x1, y1, z1, t1 = left
    x2, y2, z2, t2 = right
    a = (y1 - x1) * (y2 - x2) % _FIELD
    b = (y1 + x1) * (y2 + x2) % _FIELD
    c = 2 * _D * t1 * t2 % _FIELD
    d = 2 * z1 * z2 % _FIELD
    e, f, g, h = b - a, d - c, d + c, b + a
    return (e * f % _FIELD, g * h % _FIELD, f * g % _FIELD, e * h % _FIELD)


def _scalar_multiply(point: tuple[int, int, int, int], scalar: int) -> tuple[int, int, int, int]:
    result = _IDENTITY
    addend = point
    while scalar:
        if scalar & 1:
            result = _add(result, addend)
        addend = _add(addend, addend)
        scalar >>= 1
    return result


def _equal(left: tuple[int, int, int, int], right: tuple[int, int, int, int]) -> bool:
    return (left[0] * right[2] - right[0] * left[2]) % _FIELD == 0 and (
        left[1] * right[2] - right[1] * left[2]
    ) % _FIELD == 0


_BASE_Y = 4 * pow(5, _FIELD - 2, _FIELD) % _FIELD
_BASE_X = _recover_x(_BASE_Y, 0)
assert _BASE_X is not None
_BASE = (_BASE_X, _BASE_Y, 1, _BASE_X * _BASE_Y % _FIELD)


def _verify_ed25519(public_key: bytes, signature: bytes, message: bytes) -> bool:
    public_point = _decode_point(public_key)
    r_point = _decode_point(signature[:32])
    scalar = int.from_bytes(signature[32:], "little")
    if public_point is None or r_point is None or scalar >= _ORDER:
        return False
    if _equal(public_point, _IDENTITY) or not _equal(_scalar_multiply(public_point, _ORDER), _IDENTITY):
        return False
    if not _equal(_scalar_multiply(r_point, _ORDER), _IDENTITY):
        return False
    challenge = int.from_bytes(hashlib.sha512(signature[:32] + public_key + message).digest(), "little") % _ORDER
    return _equal(_scalar_multiply(_BASE, scalar), _add(r_point, _scalar_multiply(public_point, challenge)))
