import 'dart:collection';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';

const _contractVersion = '0.1.0-dev.59';
final _uuidV7 = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
final _digest = RegExp(r'^sha256:[0-9a-f]{64}$');
final _keyId = RegExp(r'^[a-z][a-z0-9._-]{0,63}$');
const _checks = [
  'finalization_idempotency',
  'private_read_integrity',
  'cross_scope_refusal',
  'malware_safety'
];

/// Verifies the closed V1 shape, optional exact binding and Ed25519 signature.
Future<bool> verifyVerificationReceipt(
    Map<String, Object?> signed, Map<String, Object?> keySet,
    {Map<String, Object?>? expected}) async {
  try {
    if (!_exactKeys(signed, {'algorithm', 'receipt', 'signature'}) ||
        signed['algorithm'] != 'ed25519' ||
        signed['receipt'] is! Map<String, Object?> ||
        !_validReceipt(signed['receipt'] as Map<String, Object?>) ||
        signed['signature'] is! String ||
        !_exactKeys(keySet, {'format_version', 'keys'}) ||
        keySet['format_version'] != 1 ||
        keySet['keys'] is! List<Object?> ||
        (keySet['keys'] as List<Object?>).isEmpty ||
        (keySet['keys'] as List<Object?>).length > 4) {
      return false;
    }
    final receipt = signed['receipt'] as Map<String, Object?>;
    if (expected != null && !_matches(receipt, expected)) return false;
    final signatureBytes = _decodeBase64Url(signed['signature'], 64);
    if (signatureBytes == null) return false;
    final matching = <String>[];
    for (final value in keySet['keys'] as List<Object?>) {
      if (value is! Map<String, Object?> ||
          !_exactKeys(value, {'algorithm', 'key_id', 'public_key'}) ||
          value['algorithm'] != 'ed25519' ||
          value['key_id'] is! String ||
          !_keyId.hasMatch(value['key_id'] as String) ||
          value['public_key'] is! String) {
        return false;
      }
      if (value['key_id'] == receipt['signing_key_id']) {
        matching.add(value['public_key'] as String);
      }
    }
    if (matching.length != 1) return false;
    final publicKey = _decodeBase64Url(matching.single, 32);
    if (publicKey == null) return false;
    final message = utf8.encode(jsonEncode(_canonical(receipt)));
    return Ed25519().verify(message,
        signature: Signature(signatureBytes,
            publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519)));
  } catch (_) {
    return false;
  }
}

bool _validReceipt(Map<String, Object?> receipt) {
  const fields = {
    'checks',
    'collection_instance_id',
    'content_sha256',
    'contract_version',
    'entry_id',
    'environment_id',
    'expected_size_bytes',
    'generation_id',
    'project_id',
    'realm_id',
    'receipt_version',
    'safety_state',
    'signing_key_id',
    'tenant_id',
    'verification_id'
  };
  final size = receipt['expected_size_bytes'];
  if (!_exactKeys(receipt, fields) ||
      receipt['receipt_version'] != 'almira.verification.v1' ||
      receipt['contract_version'] != _contractVersion ||
      receipt['signing_key_id'] is! String ||
      !_keyId.hasMatch(receipt['signing_key_id'] as String) ||
      receipt['content_sha256'] is! String ||
      !_digest.hasMatch(receipt['content_sha256'] as String) ||
      size is! int ||
      size < 1 ||
      size > 8 * 1024 * 1024 ||
      !{'not_required', 'clean'}.contains(receipt['safety_state'])) {
    return false;
  }
  for (final field in [
    'verification_id',
    'realm_id',
    'tenant_id',
    'project_id',
    'environment_id',
    'collection_instance_id',
    'entry_id',
    'generation_id'
  ]) {
    final value = receipt[field];
    if (value is! String || !_uuidV7.hasMatch(value)) return false;
  }
  final checks = receipt['checks'];
  if (checks is! List<Object?> || checks.length != _checks.length) return false;
  for (var index = 0; index < _checks.length; index++) {
    final check = checks[index];
    if (check is! Map<String, Object?> ||
        !_exactKeys(check, {'name', 'result'}) ||
        check['name'] != _checks[index] ||
        check['result'] != 'passed') {
      return false;
    }
  }
  return true;
}

bool _matches(Map<String, Object?> receipt, Map<String, Object?> expected) {
  for (final field in [
    'tenant_id',
    'project_id',
    'environment_id',
    'collection_instance_id',
    'entry_id',
    'generation_id',
    'expected_size_bytes',
    'content_sha256'
  ]) {
    if (!expected.containsKey(field) || receipt[field] != expected[field]) {
      return false;
    }
  }
  return !expected.containsKey('verification_id') ||
      receipt['verification_id'] == expected['verification_id'];
}

bool _exactKeys(Map<String, Object?> value, Set<String> expected) =>
    value.length == expected.length && value.keys.toSet().containsAll(expected);

Object? _canonical(Object? value) {
  if (value is List<Object?>) return value.map(_canonical).toList();
  if (value is Map<String, Object?>) {
    return SplayTreeMap<String, Object?>()
      ..addEntries(value.entries
          .map((entry) => MapEntry(entry.key, _canonical(entry.value))));
  }
  return value;
}

List<int>? _decodeBase64Url(Object? value, int size) {
  if (value is! String ||
      value.contains('=') ||
      !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(value)) {
    return null;
  }
  try {
    final decoded =
        base64Url.decode(value + '=' * ((4 - value.length % 4) % 4));
    return decoded.length == size &&
            base64Url.encode(decoded).replaceAll('=', '') == value
        ? decoded
        : null;
  } catch (_) {
    return null;
  }
}
