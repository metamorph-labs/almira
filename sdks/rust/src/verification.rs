//! Closed-shape Ed25519 verification for Almira V1 behavior receipts.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::CONTRACT_VERSION;

const CHECKS: [&str; 4] = [
    "finalization_idempotency",
    "private_read_integrity",
    "cross_scope_refusal",
    "malware_safety",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationCheck {
    pub name: String,
    pub result: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationReceipt {
    pub receipt_version: String,
    pub contract_version: String,
    pub verification_id: String,
    pub realm_id: String,
    pub tenant_id: String,
    pub project_id: String,
    pub environment_id: String,
    pub collection_instance_id: String,
    pub entry_id: String,
    pub generation_id: String,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
    pub safety_state: String,
    pub checks: Vec<VerificationCheck>,
    pub signing_key_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SignedVerificationReceipt {
    pub receipt: VerificationReceipt,
    pub algorithm: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationPublicKey {
    pub key_id: String,
    pub algorithm: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationPublicKeySet {
    pub format_version: u8,
    pub keys: Vec<VerificationPublicKey>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationReceiptExpectation {
    pub verification_id: Option<String>,
    pub tenant_id: String,
    pub project_id: String,
    pub environment_id: String,
    pub collection_instance_id: String,
    pub entry_id: String,
    pub generation_id: String,
    pub expected_size_bytes: u64,
    pub content_sha256: String,
}

/// Verifies the closed receipt shape, exact expected binding and Ed25519 signature.
#[must_use]
pub fn verify_verification_receipt(
    signed: &SignedVerificationReceipt,
    key_set: &VerificationPublicKeySet,
    expected: Option<&VerificationReceiptExpectation>,
) -> bool {
    if signed.algorithm != "ed25519"
        || !valid_receipt(&signed.receipt)
        || key_set.format_version != 1
        || !(1..=4).contains(&key_set.keys.len())
        || expected.is_some_and(|value| !matches_expectation(&signed.receipt, value))
    {
        return false;
    }
    let Some(signature) = decode_base64url::<64>(&signed.signature) else {
        return false;
    };
    let mut matching = key_set
        .keys
        .iter()
        .filter(|key| key.key_id == signed.receipt.signing_key_id);
    if key_set
        .keys
        .iter()
        .any(|key| key.algorithm != "ed25519" || !valid_key_id(&key.key_id))
    {
        return false;
    }
    let Some(key) = matching.next() else {
        return false;
    };
    if matching.next().is_some() {
        return false;
    }
    let Some(public_key) = decode_base64url::<32>(&key.public_key) else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&public_key) else {
        return false;
    };
    let Ok(value) = serde_json::to_value(&signed.receipt) else {
        return false;
    };
    let Ok(message) = serde_json::to_vec(&value) else {
        return false;
    };
    verifying_key
        .verify(&message, &Signature::from_bytes(&signature))
        .is_ok()
}

fn valid_receipt(receipt: &VerificationReceipt) -> bool {
    receipt.receipt_version == "almira.verification.v1"
        && receipt.contract_version == CONTRACT_VERSION
        && valid_key_id(&receipt.signing_key_id)
        && receipt.content_sha256.len() == 71
        && receipt.content_sha256.starts_with("sha256:")
        && receipt.content_sha256[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && (1..=8 * 1024 * 1024).contains(&receipt.expected_size_bytes)
        && matches!(receipt.safety_state.as_str(), "not_required" | "clean")
        && [
            &receipt.verification_id,
            &receipt.realm_id,
            &receipt.tenant_id,
            &receipt.project_id,
            &receipt.environment_id,
            &receipt.collection_instance_id,
            &receipt.entry_id,
            &receipt.generation_id,
        ]
        .into_iter()
        .all(|value| valid_uuid_v7(value))
        && receipt.checks.len() == CHECKS.len()
        && CHECKS
            .iter()
            .zip(&receipt.checks)
            .all(|(name, check)| check.name == *name && check.result == "passed")
}

fn matches_expectation(
    receipt: &VerificationReceipt,
    expected: &VerificationReceiptExpectation,
) -> bool {
    expected
        .verification_id
        .as_ref()
        .is_none_or(|value| receipt.verification_id == *value)
        && receipt.tenant_id == expected.tenant_id
        && receipt.project_id == expected.project_id
        && receipt.environment_id == expected.environment_id
        && receipt.collection_instance_id == expected.collection_instance_id
        && receipt.entry_id == expected.entry_id
        && receipt.generation_id == expected.generation_id
        && receipt.expected_size_bytes == expected.expected_size_bytes
        && receipt.content_sha256 == expected.content_sha256
}

fn decode_base64url<const SIZE: usize>(value: &str) -> Option<[u8; SIZE]> {
    if value.contains('=') {
        return None;
    }
    let decoded = URL_SAFE_NO_PAD.decode(value).ok()?;
    if decoded.len() != SIZE || URL_SAFE_NO_PAD.encode(&decoded) != value {
        return None;
    }
    decoded.try_into().ok()
}

fn valid_key_id(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z'))
        && value.len() <= 64
        && bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn valid_uuid_v7(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes[8] == b'-'
        && bytes[13] == b'-'
        && bytes[18] == b'-'
        && bytes[23] == b'-'
        && bytes[14] == b'7'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
        && bytes.iter().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                || byte.is_ascii_digit()
                || (b'a'..=b'f').contains(byte)
        })
}
