use std::fs;
use std::path::PathBuf;

use metamorph_almira::{
    SignedVerificationReceipt, VerificationPublicKeySet, VerificationReceiptExpectation,
    verify_verification_receipt,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct CommonVector {
    behavior_receipt: BehaviorReceiptVector,
}

#[derive(Deserialize)]
struct BehaviorReceiptVector {
    signed: SignedVerificationReceipt,
    key_set: VerificationPublicKeySet,
    expected: VerificationReceiptExpectation,
    substitution: Substitution,
}

#[derive(Deserialize)]
struct Substitution {
    generation_id: String,
}

#[test]
fn verifies_common_behavior_receipt_and_rejects_substitution() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../conformance/application-sdk.v1.json");
    let common: CommonVector = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let vector = common.behavior_receipt;
    assert!(verify_verification_receipt(
        &vector.signed,
        &vector.key_set,
        Some(&vector.expected),
    ));
    let mut substituted = vector.expected;
    substituted.generation_id = vector.substitution.generation_id;
    assert!(!verify_verification_receipt(
        &vector.signed,
        &vector.key_set,
        Some(&substituted),
    ));
    let mut tampered = vector.signed;
    tampered.receipt.generation_id = substituted.generation_id;
    assert!(!verify_verification_receipt(
        &tampered,
        &vector.key_set,
        None
    ));
}
