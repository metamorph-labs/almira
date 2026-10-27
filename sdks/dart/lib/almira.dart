library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';

const contractVersion = '0.1.0-dev.59';
final _uuidV7 = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
final _capability =
    RegExp(r'^(?:alm_cap_v1|alm_local_v1)\.[A-Za-z0-9_-]{43,4096}$');
final _share = RegExp(r'^alm_share_v1\.[A-Za-z0-9_-]{43,4096}$');

class AlmiraClientException implements Exception {
  const AlmiraClientException(this.code);
  final String code;
  @override
  String toString() => code;
}

class AlmiraApiException implements Exception {
  const AlmiraApiException(
      this.code, this.requestId, this.status, this.retryAfterSeconds);
  final String code;
  final String requestId;
  final int status;
  final int? retryAfterSeconds;
  @override
  String toString() => code;
}

class CollectionReference {
  const CollectionReference(
      {required this.tenantId,
      required this.projectId,
      required this.environmentId,
      required this.collectionInstanceId});
  final String tenantId;
  final String projectId;
  final String environmentId;
  final String collectionInstanceId;
}

class FileReference extends CollectionReference {
  const FileReference(
      {required super.tenantId,
      required super.projectId,
      required super.environmentId,
      required super.collectionInstanceId,
      required this.entryId});
  final String entryId;
}

class GenerationReference extends FileReference {
  const GenerationReference(
      {required super.tenantId,
      required super.projectId,
      required super.environmentId,
      required super.collectionInstanceId,
      required super.entryId,
      required this.generationId});
  final String generationId;
}

class DerivativeReference extends GenerationReference {
  const DerivativeReference(
      {required super.tenantId,
      required super.projectId,
      required super.environmentId,
      required super.collectionInstanceId,
      required super.entryId,
      required super.generationId,
      required this.variantKey});
  final String variantKey;
}

class ProjectReference {
  const ProjectReference({required this.tenantId, required this.projectId});
  final String tenantId;
  final String projectId;
}

class WireResponse {
  const WireResponse(
      {required this.status, required this.headers, required this.body});
  final int status;
  final Map<String, String> headers;
  final Stream<List<int>> body;
}

abstract interface class AlmiraTransport {
  Future<WireResponse> send(
      String method, Uri url, Map<String, String> headers, Uint8List? body);
}

class IoTransport implements AlmiraTransport {
  IoTransport({HttpClient? client, this.timeout = const Duration(seconds: 30)})
      : _client = client ?? HttpClient();
  final HttpClient _client;
  final Duration timeout;
  @override
  Future<WireResponse> send(String method, Uri url, Map<String, String> headers,
      Uint8List? body) async {
    try {
      final request = await _client.openUrl(method, url).timeout(timeout);
      request.followRedirects = false;
      headers.forEach(request.headers.set);
      if (body != null) request.add(body);
      final response = await request.close().timeout(timeout);
      final resultHeaders = <String, String>{};
      response.headers.forEach((name, values) {
        if (values.length == 1) {
          resultHeaders[name.toLowerCase()] = values.single;
        }
      });
      return WireResponse(
          status: response.statusCode, headers: resultHeaders, body: response);
    } on AlmiraClientException {
      rethrow;
    } catch (_) {
      throw const AlmiraClientException('ALMIRA_CLIENT_NETWORK');
    }
  }
}

class BinaryResponse {
  const BinaryResponse(
      {required this.status, required this.headers, required this.body});
  final int status;
  final Map<String, String> headers;
  final Stream<List<int>> body;
}

class RetryPolicy {
  const RetryPolicy(
      {this.maxAttempts = 1,
      this.baseDelay = const Duration(milliseconds: 100),
      this.maximumDelay = const Duration(seconds: 5)});
  final int maxAttempts;
  final Duration baseDelay;
  final Duration maximumDelay;
}

typedef CapabilityProvider = FutureOr<String> Function();

class AlmiraDataClient {
  AlmiraDataClient(
      {required String baseUrl,
      required CapabilityProvider capability,
      String? origin,
      AlmiraTransport? transport,
      RetryPolicy retry = const RetryPolicy()})
      : _baseUrl = _baseUri(baseUrl),
        _capabilityProvider = capability,
        _origin = origin,
        _transport = transport ?? IoTransport(),
        _retry = retry {
    if (origin != null &&
        (origin.endsWith('/') || _baseUri(origin).origin != origin)) {
      throw _input;
    }
    if (retry.maxAttempts < 1 ||
        retry.maxAttempts > 5 ||
        retry.baseDelay.isNegative ||
        retry.maximumDelay < retry.baseDelay ||
        retry.maximumDelay > const Duration(minutes: 1)) {
      throw _input;
    }
  }
  final Uri _baseUrl;
  final CapabilityProvider _capabilityProvider;
  final String? _origin;
  final AlmiraTransport _transport;
  final RetryPolicy _retry;

  Future<Object?> listFilesWithCapability(CollectionReference reference,
          {Map<String, Object?> filters = const {}}) =>
      _json('GET', _dataCollection(reference, '/files', filters), null);
  Future<Object?> searchFilesWithCapability(
          CollectionReference reference, Map<String, Object?> request) =>
      _json('POST', _dataCollection(reference, '/search'), request);
  Future<Object?> getFileMetadataWithCapability(FileReference reference) =>
      _json(
          'GET',
          _dataCollection(reference, '/files/${_uuid(reference.entryId)}'),
          null);
  Future<Object?> listDerivativesWithCapability(
          GenerationReference reference) =>
      _json(
          'GET',
          _dataCollection(reference,
              '/files/${_uuid(reference.entryId)}/versions/${_uuid(reference.generationId)}/derivatives'),
          null);
  Future<BinaryResponse> readImmutableGeneration(GenerationReference reference,
          {String? range, String? ifNoneMatch}) =>
      _binary(
          '/v1/delivery/${_scope(reference)}/${_uuid(reference.entryId)}/${_uuid(reference.generationId)}',
          range,
          ifNoneMatch,
          false);
  Future<BinaryResponse> readDerivative(DerivativeReference reference,
          {String? range, String? ifNoneMatch}) =>
      _binary(
          '/v1/delivery/${_scope(reference)}/${_uuid(reference.entryId)}/${_uuid(reference.generationId)}/variants/${_variant(reference.variantKey)}',
          range,
          ifNoneMatch,
          false);
  Future<BinaryResponse> readShare(String shareToken,
      {String? range, String? ifNoneMatch}) {
    if (!_share.hasMatch(shareToken)) throw _input;
    return _binary('/v1/shares/${Uri.encodeComponent(shareToken)}', range,
        ifNoneMatch, true);
  }

  Future<Object?> _json(
      String method, String path, Map<String, Object?>? body) async {
    final response = await _send(method, path, body, false, null, null);
    if (response.status < 200 || response.status >= 300) {
      throw await apiError(response);
    }
    if ((response.headers['content-type'] ?? '').split(';').first.trim() !=
        'application/json') {
      throw _response;
    }
    try {
      return jsonDecode(
          utf8.decode(await collect(response.body, 2 * 1024 * 1024)));
    } catch (_) {
      throw _response;
    }
  }

  Future<BinaryResponse> _binary(
      String path, String? range, String? ifNoneMatch, bool share) async {
    if (range != null &&
        (range.length > 64 ||
            !RegExp(r'^bytes=[0-9]+-[0-9]*$').hasMatch(range))) {
      throw _input;
    }
    if (ifNoneMatch != null &&
        (ifNoneMatch.isEmpty ||
            ifNoneMatch.length > 512 ||
            ifNoneMatch.contains('\r') ||
            ifNoneMatch.contains('\n'))) {
      throw _input;
    }
    final response = await _send('GET', path, null, share, range, ifNoneMatch);
    if (![200, 206, 304].contains(response.status)) {
      throw await apiError(response);
    }
    return BinaryResponse(
        status: response.status,
        headers: response.headers,
        body: response.body);
  }

  Future<WireResponse> _send(
      String method,
      String path,
      Map<String, Object?>? body,
      bool share,
      String? range,
      String? ifNoneMatch) async {
    for (var attempt = 1; attempt <= _retry.maxAttempts; attempt++) {
      final headers = <String, String>{
        'accept': body == null ? '*/*' : 'application/json'
      };
      if (!share) {
        String token;
        try {
          token = await _capabilityProvider();
        } catch (_) {
          throw const AlmiraClientException(
              'ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE');
        }
        if (!_capability.hasMatch(token)) throw _input;
        headers['authorization'] = 'Bearer $token';
        if (_origin != null) headers['origin'] = _origin;
      }
      if (range != null) headers['range'] = range;
      if (ifNoneMatch != null) headers['if-none-match'] = ifNoneMatch;
      final encoded = body == null
          ? null
          : Uint8List.fromList(utf8.encode(jsonEncode(body)));
      if (encoded != null) headers['content-type'] = 'application/json';
      try {
        final response = await _transport.send(
            method,
            _baseUrl.resolve(path.replaceFirst(RegExp(r'^/'), '')),
            headers,
            encoded);
        if (![429, 502, 503, 504].contains(response.status) ||
            attempt == _retry.maxAttempts) {
          return response;
        }
        await response.body.drain<void>();
      } catch (_) {
        if (attempt == _retry.maxAttempts) {
          throw const AlmiraClientException('ALMIRA_CLIENT_NETWORK');
        }
      }
      final multiplier = 1 << (attempt - 1);
      final delay =
          Duration(microseconds: _retry.baseDelay.inMicroseconds * multiplier);
      await Future<void>.delayed(
          delay > _retry.maximumDelay ? _retry.maximumDelay : delay);
    }
    throw const AlmiraClientException('ALMIRA_CLIENT_NETWORK');
  }
}

final _input = const AlmiraClientException('ALMIRA_CLIENT_INPUT_INVALID');
final _response = const AlmiraClientException('ALMIRA_CLIENT_RESPONSE_INVALID');
String _uuid(String value) {
  if (!_uuidV7.hasMatch(value)) throw _input;
  return value;
}

Uri _baseUri(String value) {
  final uri = Uri.tryParse(value);
  if (uri == null ||
      !['http', 'https'].contains(uri.scheme) ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      !(uri.path.isEmpty || uri.path == '/')) {
    throw _input;
  }
  return Uri.parse('${value.replaceFirst(RegExp(r'/$'), '')}/');
}

String _scope(CollectionReference reference) =>
    '${_uuid(reference.tenantId)}/${_uuid(reference.projectId)}/${_uuid(reference.environmentId)}/${_uuid(reference.collectionInstanceId)}';
String _dataCollection(CollectionReference reference, String suffix,
    [Map<String, Object?> values = const {}]) {
  final filtered = <String, dynamic>{};
  values.forEach((key, value) {
    if (value != null) {
      filtered[key] = value is Iterable
          ? value.map((item) => item.toString()).toList()
          : value.toString();
    }
  });
  return '/v1/data/${_scope(reference)}$suffix${filtered.isEmpty ? '' : '?${Uri(queryParameters: filtered).query}'}';
}

String _variant(String value) {
  final segments = value.split('/');
  if (value.isEmpty ||
      value.length > 160 ||
      segments.any((part) =>
          part.isEmpty ||
          part == '.' ||
          part == '..' ||
          !RegExp(r'^[A-Za-z0-9._~-]+$').hasMatch(part))) {
    throw _input;
  }
  return segments.map(Uri.encodeComponent).join('/');
}

Future<Uint8List> collect(Stream<List<int>> stream, int limit) async {
  final builder = BytesBuilder(copy: false);
  var size = 0;
  await for (final chunk in stream) {
    size += chunk.length;
    if (size > limit) throw _response;
    builder.add(chunk);
  }
  return builder.takeBytes();
}

Future<AlmiraApiException> apiError(WireResponse response) async {
  try {
    final value =
        jsonDecode(utf8.decode(await collect(response.body, 64 * 1024)));
    if (value is! Map<String, dynamic>) throw _response;
    final code = value['code'];
    final requestId = value['request_id'];
    if (code is! String ||
        !RegExp(r'^ALMIRA_[A-Z0-9_]{1,127}$').hasMatch(code) ||
        requestId is! String ||
        !_uuidV7.hasMatch(requestId)) {
      throw _response;
    }
    final retry = int.tryParse(response.headers['retry-after'] ?? '');
    return AlmiraApiException(code, requestId, response.status, retry);
  } on AlmiraApiException {
    rethrow;
  } catch (_) {
    throw _response;
  }
}

class AlmiraTransferException implements Exception {
  const AlmiraTransferException(this.code, {this.partNumber, this.status});
  final String code;
  final int? partNumber;
  final int? status;
  @override
  String toString() => code;
}

class UploadResponse {
  const UploadResponse(this.status, this.headers);
  final int status;
  final Map<String, String> headers;
}

abstract interface class DirectUploadTransport {
  Future<UploadResponse> put(Map<String, Object?> part, File source);
}

class IoDirectUploadTransport implements DirectUploadTransport {
  IoDirectUploadTransport({HttpClient? client})
      : _client = client ?? HttpClient();
  final HttpClient _client;
  @override
  Future<UploadResponse> put(Map<String, Object?> part, File source) async {
    final uri = Uri.tryParse(part['url'] as String? ?? '');
    if (uri == null ||
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment) {
      throw const AlmiraTransferException('ALMIRA_TRANSFER_DESCRIPTOR_INVALID');
    }
    final offset = part['offset_bytes'] as int;
    final length = part['length_bytes'] as int;
    final request = await _client.putUrl(uri);
    request.followRedirects = false;
    request.contentLength = length;
    for (final header in part['headers'] as List<Object?>) {
      final value = header! as Map<String, Object?>;
      request.headers.set(value['name']! as String, value['value']! as String);
    }
    await request.addStream(source.openRead(offset, offset + length));
    final response = await request.close();
    final headers = <String, String>{};
    response.headers.forEach((name, values) {
      if (values.length == 1) headers[name.toLowerCase()] = values.single;
    });
    await response.drain<void>();
    return UploadResponse(response.statusCode, headers);
  }
}

typedef MultipartPartGrant = FutureOr<Map<String, Object?>> Function(
    Map<String, Object?> request);

Future<Map<String, Object?>> uploadDirect(
  Map<String, Object?> descriptor,
  File source, {
  MultipartPartGrant? grantPart,
  DirectUploadTransport? transport,
  DateTime Function()? now,
}) async {
  const invalid = AlmiraTransferException('ALMIRA_TRANSFER_DESCRIPTOR_INVALID');
  try {
    final descriptorId = _uuid(descriptor['descriptor_id']! as String);
    final protocol = descriptor['protocol'];
    if (!['single_put', 'multipart'].contains(protocol) ||
        descriptor['one_use'] != true) {
      throw invalid;
    }
    final expectedSize = descriptor['expected_size_bytes'];
    final contentSha256 = descriptor['content_sha256'];
    if (expectedSize is! int ||
        expectedSize < 1 ||
        expectedSize > 10737418240 ||
        await source.length() != expectedSize ||
        contentSha256 is! String ||
        !RegExp(r'^sha256:[0-9a-f]{64}$').hasMatch(contentSha256)) {
      throw invalid;
    }
    final expiresAt =
        DateTime.tryParse(descriptor['expires_at'] as String? ?? '');
    if (expiresAt == null) throw invalid;
    if (!expiresAt.isAfter((now ?? DateTime.now)().toUtc())) {
      throw const AlmiraTransferException('ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED');
    }
    final requests = descriptor['requests'];
    final partCount = descriptor['part_count'];
    if (requests is! List<Object?> ||
        partCount is! int ||
        partCount < 1 ||
        partCount > 10000) {
      throw invalid;
    }
    final int partSize;
    if (protocol == 'single_put') {
      if (requests.length != 1 ||
          !descriptor.containsKey('part_size_bytes') ||
          descriptor['part_size_bytes'] != null ||
          partCount != 1) {
        throw invalid;
      }
      partSize = expectedSize;
    } else {
      final value = descriptor['part_size_bytes'];
      if (requests.isNotEmpty ||
          value is! int ||
          value < 1 ||
          value > 10737418240 ||
          value * (partCount - 1) >= expectedSize ||
          value * partCount < expectedSize) {
        throw invalid;
      }
      partSize = value;
    }
    final completions = <Map<String, Object?>>[];
    String? objectEtag;
    String? providerVersion;
    final execute = transport ?? IoDirectUploadTransport();
    for (var number = 1; number <= partCount; number++) {
      final offset = (number - 1) * partSize;
      final length =
          (expectedSize - offset) < partSize ? expectedSize - offset : partSize;
      if (length <= 0) throw invalid;
      Map<String, Object?> part;
      if (protocol == 'single_put') {
        if (requests.single is! Map<String, Object?>) {
          throw invalid;
        }
        part = requests.single! as Map<String, Object?>;
      } else {
        if (grantPart == null) throw invalid;
        final digest =
            await sha256.bind(source.openRead(offset, offset + length)).first;
        part = await grantPart(
            {'part_number': number, 'content_sha256': 'sha256:$digest'});
      }
      if (part['part_number'] != number ||
          part['offset_bytes'] != offset ||
          part['length_bytes'] != length ||
          part['method'] != 'PUT' ||
          part['one_use'] != true ||
          !_validTransferUrl(part['url']) ||
          !_validTransferHeaders(part['headers'])) {
        throw invalid;
      }
      if (!expiresAt.isAfter((now ?? DateTime.now)().toUtc())) {
        throw const AlmiraTransferException(
            'ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED');
      }
      UploadResponse response;
      try {
        response = await execute.put(part, source);
      } on AlmiraTransferException {
        rethrow;
      } catch (_) {
        throw AlmiraTransferException('ALMIRA_TRANSFER_OUTCOME_UNKNOWN',
            partNumber: number);
      }
      if (response.status < 100 || response.status > 599) {
        throw AlmiraTransferException('ALMIRA_TRANSFER_RESPONSE_INVALID',
            partNumber: number);
      }
      if (response.status < 200 || response.status >= 300) {
        throw AlmiraTransferException('ALMIRA_TRANSFER_PART_REFUSED',
            partNumber: number, status: response.status);
      }
      final headers = <String, String>{};
      for (final entry in response.headers.entries) {
        final name = entry.key.toLowerCase();
        if (headers.containsKey(name)) {
          throw AlmiraTransferException('ALMIRA_TRANSFER_RESPONSE_INVALID',
              partNumber: number);
        }
        headers[name] = entry.value;
      }
      final etag = headers['etag'];
      if (etag == null || !RegExp(r'^[!-~]{1,256}$').hasMatch(etag)) {
        throw AlmiraTransferException('ALMIRA_TRANSFER_RESPONSE_INVALID',
            partNumber: number);
      }
      completions.add({'part_number': number, 'etag': etag});
      if (protocol == 'single_put') {
        objectEtag = etag;
        for (final name in [
          'x-amz-version-id',
          'x-goog-generation',
          'x-ms-version-id'
        ]) {
          final version = headers[name];
          if (version == null) continue;
          if (!RegExp(r'^[!-~]{1,256}$').hasMatch(version) ||
              RegExp(r'[/\\?#]').hasMatch(version) ||
              providerVersion != null && providerVersion != version) {
            throw AlmiraTransferException('ALMIRA_TRANSFER_RESPONSE_INVALID',
                partNumber: number);
          }
          providerVersion = version;
        }
      }
    }
    return {
      'descriptor_id': descriptorId,
      'protocol': protocol,
      'etag': objectEtag,
      'provider_version': providerVersion,
      'parts': completions,
      'size_bytes': expectedSize,
      'content_sha256': contentSha256
    };
  } on AlmiraTransferException {
    rethrow;
  } catch (_) {
    throw invalid;
  }
}

bool _validTransferUrl(Object? value) {
  if (value is! String ||
      value.length > 8192 ||
      value.codeUnits.any((unit) => unit <= 32 || unit == 127 || unit == 92)) {
    return false;
  }
  final uri = Uri.tryParse(value);
  return uri != null &&
      uri.scheme == 'https' &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty &&
      !uri.hasFragment;
}

bool _validTransferHeaders(Object? value) {
  if (value is! List<Object?> || value.length > 32) return false;
  final names = <String>{};
  for (final item in value) {
    if (item is! Map<String, Object?>) return false;
    final name = item['name'];
    final headerValue = item['value'];
    if (name is! String ||
        headerValue is! String ||
        !RegExp(r'^[A-Za-z0-9_-]{1,128}$').hasMatch(name) ||
        headerValue.isEmpty ||
        headerValue.length > 4096 ||
        headerValue.codeUnits.any((unit) => unit < 32 || unit == 127) ||
        !names.add(name)) {
      return false;
    }
  }
  return true;
}
