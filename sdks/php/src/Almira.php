<?php

declare(strict_types=1);

namespace Metamorph\Almira;

const CONTRACT_VERSION = '0.1.0-dev.59';
const UUID_V7 = '/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/D';

final class ClientException extends \RuntimeException
{
    public function __construct(public readonly string $codeName) { parent::__construct($codeName); }
}

final class ApiException extends \RuntimeException
{
    public function __construct(
        public readonly string $codeName,
        public readonly string $requestId,
        public readonly int $status,
        public readonly ?int $retryAfterSeconds,
    ) { parent::__construct($codeName); }
}

final readonly class CollectionReference
{
    public function __construct(public string $tenantId, public string $projectId, public string $environmentId, public string $collectionInstanceId) {}
}
final readonly class FileReference
{
    public function __construct(public string $tenantId, public string $projectId, public string $environmentId, public string $collectionInstanceId, public string $entryId) {}
}
final readonly class GenerationReference
{
    public function __construct(public string $tenantId, public string $projectId, public string $environmentId, public string $collectionInstanceId, public string $entryId, public string $generationId) {}
}
final readonly class DerivativeReference
{
    public function __construct(public string $tenantId, public string $projectId, public string $environmentId, public string $collectionInstanceId, public string $entryId, public string $generationId, public string $variantKey) {}
}
final readonly class ProjectReference
{
    public function __construct(public string $tenantId, public string $projectId) {}
}

final class HttpResponse
{
    /** @param resource $body */
    public function __construct(public readonly int $status, public readonly array $headers, public $body) {}
    public function close(): void { if (is_resource($this->body)) fclose($this->body); }
}

interface Transport
{
    /** @param array<string,string> $headers */
    public function send(string $method, string $url, array $headers, ?string $body): HttpResponse;
}

final class CurlTransport implements Transport
{
    public function __construct(private readonly int $timeoutSeconds = 30) {}

    public function send(string $method, string $url, array $headers, ?string $body): HttpResponse
    {
        $output = fopen('php://temp/maxmemory:1048576', 'w+b');
        if ($output === false) throw new ClientException('ALMIRA_CLIENT_NETWORK');
        $responseHeaders = [];
        $handle = curl_init($url);
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => array_map(static fn(string $name, string $value): string => "$name: $value", array_keys($headers), $headers),
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => $this->timeoutSeconds,
            CURLOPT_TIMEOUT => $this->timeoutSeconds,
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$responseHeaders): int {
                $position = strpos($line, ':');
                if ($position !== false) $responseHeaders[strtolower(trim(substr($line, 0, $position)))] = trim(substr($line, $position + 1));
                return strlen($line);
            },
            CURLOPT_WRITEFUNCTION => static function ($curl, string $chunk) use ($output): int { $written = fwrite($output, $chunk); return $written === false ? 0 : $written; },
        ]);
        if ($body !== null) curl_setopt($handle, CURLOPT_POSTFIELDS, $body);
        try {
            if (!curl_exec($handle)) throw new ClientException('ALMIRA_CLIENT_NETWORK');
            $status = curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
            rewind($output);
            return new HttpResponse($status, $responseHeaders, $output);
        } catch (\Throwable $error) {
            fclose($output);
            if ($error instanceof ClientException) throw $error;
            throw new ClientException('ALMIRA_CLIENT_NETWORK');
        } finally {
            curl_close($handle);
        }
    }
}

final readonly class RetryPolicy
{
    public function __construct(public int $maxAttempts = 1, public float $baseDelaySeconds = 0.1, public float $maximumDelaySeconds = 5.0) {
        if ($maxAttempts < 1 || $maxAttempts > 5 || $baseDelaySeconds < 0 || $maximumDelaySeconds < $baseDelaySeconds || $maximumDelaySeconds > 60) throw input_error();
    }
}

final class AlmiraDataClient
{
    private readonly string $baseUrl;
    /** @var \Closure():string */
    private readonly \Closure $capability;

    /** @param callable():string $capability */
    public function __construct(
        string $baseUrl,
        callable $capability,
        private readonly ?string $origin = null,
        private readonly Transport $transport = new CurlTransport(),
        private readonly RetryPolicy $retry = new RetryPolicy(),
    ) {
        $this->baseUrl = base_url($baseUrl);
        $this->capability = $capability(...);
        if ($origin !== null && (str_ends_with($origin, '/') || base_url($origin) !== $origin)) throw input_error();
    }

    /** @return array<string,mixed> */
    public function listFilesWithCapability(CollectionReference $reference, array $filters = []): array
    {
        return $this->json('GET', data_collection_path($reference, '/files') . query($filters), null);
    }
    /** @param array<string,mixed> $request @return array<string,mixed> */
    public function searchFilesWithCapability(CollectionReference $reference, array $request): array
    {
        return $this->json('POST', data_collection_path($reference, '/search'), $request);
    }
    /** @return array<string,mixed> */
    public function getFileMetadataWithCapability(FileReference $reference): array
    {
        return $this->json('GET', data_collection_path($reference, '/files/' . uuid($reference->entryId)), null);
    }
    /** @return array<string,mixed> */
    public function listDerivativesWithCapability(GenerationReference $reference): array
    {
        return $this->json('GET', data_collection_path($reference, '/files/' . uuid($reference->entryId) . '/versions/' . uuid($reference->generationId) . '/derivatives'), null);
    }
    public function readImmutableGeneration(GenerationReference $reference, ?string $range = null, ?string $ifNoneMatch = null): HttpResponse
    {
        return $this->binary('/v1/delivery/' . scope($reference) . '/' . uuid($reference->entryId) . '/' . uuid($reference->generationId), $range, $ifNoneMatch, false);
    }
    public function readDerivative(DerivativeReference $reference, ?string $range = null, ?string $ifNoneMatch = null): HttpResponse
    {
        return $this->binary('/v1/delivery/' . scope($reference) . '/' . uuid($reference->entryId) . '/' . uuid($reference->generationId) . '/variants/' . variant($reference->variantKey), $range, $ifNoneMatch, false);
    }
    public function readShare(string $shareToken, ?string $range = null, ?string $ifNoneMatch = null): HttpResponse
    {
        if (!preg_match('/^alm_share_v1\.[A-Za-z0-9_-]{43,4096}$/D', $shareToken)) throw input_error();
        return $this->binary('/v1/shares/' . rawurlencode($shareToken), $range, $ifNoneMatch, true);
    }

    /** @param ?array<string,mixed> $body @return array<string,mixed> */
    private function json(string $method, string $path, ?array $body): array
    {
        $response = $this->send($method, $path, $body, false, null, null);
        try {
            if ($response->status < 200 || $response->status >= 300) throw api_error($response);
            if (explode(';', $response->headers['content-type'] ?? '')[0] !== 'application/json') throw response_error();
            $raw = bounded_read($response->body, 2 * 1024 * 1024);
            $value = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
            if (!is_array($value)) throw response_error();
            return $value;
        } catch (\JsonException) { throw response_error(); }
        finally { $response->close(); }
    }

    private function binary(string $path, ?string $range, ?string $ifNoneMatch, bool $share): HttpResponse
    {
        if ($range !== null && (strlen($range) > 64 || !preg_match('/^bytes=[0-9]+-[0-9]*$/D', $range))) throw input_error();
        if ($ifNoneMatch !== null && ($ifNoneMatch === '' || strlen($ifNoneMatch) > 512 || str_contains($ifNoneMatch, "\r") || str_contains($ifNoneMatch, "\n"))) throw input_error();
        $response = $this->send('GET', $path, null, $share, $range, $ifNoneMatch);
        if (!in_array($response->status, [200, 206, 304], true)) {
            try { throw api_error($response); } finally { $response->close(); }
        }
        return $response;
    }

    /** @param ?array<string,mixed> $body */
    private function send(string $method, string $path, ?array $body, bool $share, ?string $range, ?string $ifNoneMatch): HttpResponse
    {
        for ($attempt = 1; $attempt <= $this->retry->maxAttempts; $attempt++) {
            $headers = ['accept' => $body === null ? '*/*' : 'application/json'];
            if (!$share) {
                try { $token = ($this->capability)(); } catch (\Throwable) { throw new ClientException('ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE'); }
                if (!preg_match('/^(?:alm_cap_v1|alm_local_v1)\.[A-Za-z0-9_-]{43,4096}$/D', $token)) throw input_error();
                $headers['authorization'] = "Bearer $token";
                if ($this->origin !== null) $headers['origin'] = $this->origin;
            }
            if ($range !== null) $headers['range'] = $range;
            if ($ifNoneMatch !== null) $headers['if-none-match'] = $ifNoneMatch;
            $encoded = $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
            if ($encoded !== null) $headers['content-type'] = 'application/json';
            $response = $this->transport->send($method, $this->baseUrl . $path, $headers, $encoded);
            if (!in_array($response->status, [429, 502, 503, 504], true) || $attempt === $this->retry->maxAttempts) return $response;
            $response->close();
            $retryAfter = isset($response->headers['retry-after']) && preg_match('/^[0-9]{1,8}$/D', $response->headers['retry-after']) ? (float)$response->headers['retry-after'] : null;
            usleep((int)(min($retryAfter ?? $this->retry->baseDelaySeconds * 2 ** ($attempt - 1), $this->retry->maximumDelaySeconds) * 1_000_000));
        }
        throw new ClientException('ALMIRA_CLIENT_NETWORK');
    }
}

final class AlmiraServerClient
{
    private readonly string $baseUrl;
    /** @var \Closure():string */
    private readonly \Closure $workloadSession;
    /** @param callable():string $workloadSession */
    public function __construct(string $baseUrl, callable $workloadSession, private readonly Transport $transport = new CurlTransport()) {
        $this->baseUrl = base_url($baseUrl); $this->workloadSession = $workloadSession(...);
    }
    public function createCapabilitySession(CollectionReference $reference, array $request, string $operationId): array { return $this->request('POST', management_collection_path($reference, '/capability-sessions'), $reference->tenantId, $operationId, $request, [201]); }
    public function createUpload(CollectionReference $reference, array $request, string $operationId): array { return $this->request('POST', management_collection_path($reference, '/uploads'), $reference->tenantId, $operationId, $request, [201]); }
    public function createUploadPart(CollectionReference $reference, string $transferSessionId, array $request, string $operationId): array { return $this->request('POST', management_collection_path($reference, '/uploads/' . uuid($transferSessionId) . '/parts'), $reference->tenantId, $operationId, $request, [201]); }
    public function finalizeUpload(CollectionReference $reference, string $transferSessionId, array $request, string $operationId): array { return $this->request('POST', management_collection_path($reference, '/uploads/' . uuid($transferSessionId) . '/finalize'), $reference->tenantId, $operationId, $request, [200]); }
    public function bindSubject(CollectionReference $reference, string $entryId, array $subject, string $operationId): array { return $this->request('POST', management_collection_path($reference, '/files/' . uuid($entryId) . '/subject-bindings'), $reference->tenantId, $operationId, $subject, [201]); }
    public function listSubjectBindings(ProjectReference $reference, array $request): array { return $this->request('POST', '/v1/projects/' . uuid($reference->projectId) . '/subject-bindings/search', $reference->tenantId, null, $request, [200]); }
    public function startSubjectLifecycleOperation(ProjectReference $reference, array $request, string $operationId): array { return $this->request('POST', '/v1/projects/' . uuid($reference->projectId) . '/subject-lifecycle-operations', $reference->tenantId, $operationId, $request, [201, 202]); }
    public function readSubjectLifecycleOperation(ProjectReference $reference, array $request): array { return $this->request('POST', '/v1/projects/' . uuid($reference->projectId) . '/subject-lifecycle-operations/search', $reference->tenantId, null, $request, [200]); }
    public function createSubjectExportDownload(ProjectReference $reference, string $lifecycleOperationId, array $request, string $operationId): array { return $this->request('POST', '/v1/projects/' . uuid($reference->projectId) . '/subject-lifecycle-operations/' . uuid($lifecycleOperationId) . '/download', $reference->tenantId, $operationId, $request, [201]); }
    public function revokeCapabilitySession(CollectionReference $reference, string $sessionId, string $operationId): string {
        $value = $this->request('DELETE', management_collection_path($reference, '/capability-sessions/' . uuid($sessionId)), $reference->tenantId, $operationId, null, [200]);
        $result = $value['value'] ?? null;
        if (!in_array($result, ['applied', 'exact_replay'], true)) throw response_error();
        return $result;
    }

    private function request(string $method, string $path, string $tenantId, ?string $operationId, ?array $body, array $statuses): array
    {
        $tenantId = uuid($tenantId); if ($operationId !== null) $operationId = uuid($operationId);
        try { $evidence = ($this->workloadSession)(); } catch (\Throwable) { throw new ClientException('ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE'); }
        if (strlen($evidence) < 2 || strlen($evidence) > 49152 || !preg_match('/^[A-Za-z0-9_-]+$/D', $evidence)) throw input_error();
        $headers = ['accept' => 'application/json', 'authorization' => "MetamorphWorkload $evidence", 'x-almira-tenant-id' => $tenantId];
        if ($operationId !== null) $headers['idempotency-key'] = $operationId;
        $encoded = $body === null ? null : json_encode($body, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        if ($encoded !== null) $headers['content-type'] = 'application/json';
        $response = $this->transport->send($method, $this->baseUrl . $path, $headers, $encoded);
        try {
            if (!in_array($response->status, $statuses, true)) throw api_error($response);
            if (explode(';', $response->headers['content-type'] ?? '')[0] !== 'application/json') throw response_error();
            $value = json_decode(bounded_read($response->body, 2 * 1024 * 1024), true, flags: JSON_THROW_ON_ERROR);
            return is_array($value) ? $value : ['value' => $value];
        } catch (\JsonException) { throw response_error(); }
        finally { $response->close(); }
    }
}

final class TransferException extends \RuntimeException
{
    public function __construct(public readonly string $codeName, public readonly ?int $partNumber = null, public readonly ?int $status = null) { parent::__construct($codeName); }
}

interface DirectUploadTransport
{
    /** @param array<string,mixed> $part @param resource $source @return array{status:int,headers:array<string,string>} */
    public function put(array $part, $source): array;
}

final class CurlDirectUploadTransport implements DirectUploadTransport
{
    public function put(array $part, $source): array
    {
        $url = parse_url((string)($part['url'] ?? ''));
        if ($url === false || ($url['scheme'] ?? '') !== 'https' || !isset($url['host']) || isset($url['user']) || isset($url['pass']) || isset($url['fragment'])) throw new TransferException('ALMIRA_TRANSFER_DESCRIPTOR_INVALID');
        $offset = $part['offset_bytes']; $length = $part['length_bytes'];
        if (fseek($source, $offset) !== 0) throw new TransferException('ALMIRA_TRANSFER_DESCRIPTOR_INVALID');
        $remaining = $length; $headers = []; $requestHeaders = ['content-length' => (string)$length];
        foreach ($part['headers'] as $header) $requestHeaders[$header['name']] = $header['value'];
        $handle = curl_init($part['url']);
        curl_setopt_array($handle, [
            CURLOPT_CUSTOMREQUEST => 'PUT', CURLOPT_UPLOAD => true, CURLOPT_INFILESIZE => $length,
            CURLOPT_HTTPHEADER => array_map(static fn(string $name, string $value): string => "$name: $value", array_keys($requestHeaders), $requestHeaders),
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_READFUNCTION => static function ($curl, $file, int $maximum) use ($source, &$remaining): string {
                if ($remaining === 0) return '';
                $value = fread($source, min($maximum, $remaining));
                if ($value === false) return '';
                $remaining -= strlen($value); return $value;
            },
            CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
                $position = strpos($line, ':'); if ($position !== false) $headers[strtolower(trim(substr($line, 0, $position)))] = trim(substr($line, $position + 1)); return strlen($line);
            },
        ]);
        try {
            if (curl_exec($handle) === false || $remaining !== 0) throw new TransferException('ALMIRA_TRANSFER_OUTCOME_UNKNOWN', $part['part_number']);
            return ['status' => curl_getinfo($handle, CURLINFO_RESPONSE_CODE), 'headers' => $headers];
        } finally { curl_close($handle); }
    }
}

/**
 * @param array<string,mixed> $descriptor
 * @param resource $source
 * @param null|callable(array{part_number:int,content_sha256:string}):array<string,mixed> $grantPart
 * @return array<string,mixed>
 */
function uploadDirect(array $descriptor, $source, ?callable $grantPart = null, ?DirectUploadTransport $transport = null, ?\DateTimeImmutable $now = null): array
{
    $invalid = static fn(): TransferException => new TransferException('ALMIRA_TRANSFER_DESCRIPTOR_INVALID');
    try {
        if (!is_resource($source) || !($metadata = stream_get_meta_data($source))['seekable']) throw $invalid();
        $descriptorId = uuid($descriptor['descriptor_id'] ?? ''); $protocol = $descriptor['protocol'] ?? null;
        if (!in_array($protocol, ['single_put', 'multipart'], true) || ($descriptor['one_use'] ?? false) !== true) throw $invalid();
        $statistics = fstat($source); $expectedSize = $descriptor['expected_size_bytes'] ?? null; $digest = $descriptor['content_sha256'] ?? null;
        if (!is_int($expectedSize) || $expectedSize < 1 || $expectedSize > 10_737_418_240 || ($statistics['size'] ?? -1) !== $expectedSize || !is_string($digest) || !preg_match('/^sha256:[0-9a-f]{64}$/D', $digest)) throw $invalid();
        $expiresAt = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s.u\Z', $descriptor['expires_at'] ?? '', new \DateTimeZone('UTC')) ?: new \DateTimeImmutable($descriptor['expires_at'] ?? 'invalid');
        $clockNow = $now ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC'));
        if ($expiresAt <= $clockNow) throw new TransferException('ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED');
        $requests = $descriptor['requests'] ?? null; $partCount = $descriptor['part_count'] ?? null;
        if (!is_array($requests) || !is_int($partCount) || $partCount < 1 || $partCount > 10_000) throw $invalid();
        if ($protocol === 'single_put') {
            if (count($requests) !== 1 || !array_key_exists('part_size_bytes', $descriptor) || $descriptor['part_size_bytes'] !== null || $partCount !== 1) throw $invalid();
            $partSize = $expectedSize;
        } else {
            $partSize = $descriptor['part_size_bytes'] ?? null;
            if (count($requests) !== 0 || !is_int($partSize) || $partSize < 1 || $partSize > 10_737_418_240 || $partSize * ($partCount - 1) >= $expectedSize || $partSize * $partCount < $expectedSize) throw $invalid();
        }
        $execute = $transport ?? new CurlDirectUploadTransport(); $parts = []; $objectEtag = null; $providerVersion = null;
        for ($number = 1; $number <= $partCount; $number++) {
            $offset = ($number - 1) * $partSize; $length = min($partSize, $expectedSize - $offset); if ($length <= 0) throw $invalid();
            if ($protocol === 'single_put') {
                $part = $requests[0];
            } else {
                if ($grantPart === null || fseek($source, $offset) !== 0) throw $invalid();
                $hash = hash_init('sha256'); $remaining = $length;
                while ($remaining > 0) { $chunk = fread($source, min(65536, $remaining)); if ($chunk === false || $chunk === '') throw $invalid(); hash_update($hash, $chunk); $remaining -= strlen($chunk); }
                $part = $grantPart(['part_number' => $number, 'content_sha256' => 'sha256:' . hash_final($hash)]);
            }
            if (!is_array($part) || ($part['part_number'] ?? null) !== $number || ($part['offset_bytes'] ?? null) !== $offset || ($part['length_bytes'] ?? null) !== $length || ($part['method'] ?? null) !== 'PUT' || ($part['one_use'] ?? false) !== true || !valid_transfer_url($part['url'] ?? null) || !valid_transfer_headers($part['headers'] ?? null)) throw $invalid();
            if ($expiresAt <= ($now ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC')))) throw new TransferException('ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED');
            try { $response = $execute->put($part, $source); } catch (TransferException $error) { throw $error; } catch (\Throwable) { throw new TransferException('ALMIRA_TRANSFER_OUTCOME_UNKNOWN', $number); }
            if (!is_int($response['status'] ?? null) || $response['status'] < 100 || $response['status'] > 599 || !is_array($response['headers'] ?? null)) throw new TransferException('ALMIRA_TRANSFER_RESPONSE_INVALID', $number);
            if ($response['status'] < 200 || $response['status'] >= 300) throw new TransferException('ALMIRA_TRANSFER_PART_REFUSED', $number, $response['status']);
            $headers = [];
            foreach ($response['headers'] as $name => $value) { $normalized = strtolower((string)$name); if (!is_string($value) || array_key_exists($normalized, $headers)) throw new TransferException('ALMIRA_TRANSFER_RESPONSE_INVALID', $number); $headers[$normalized] = $value; }
            $etag = $headers['etag'] ?? null;
            if (!is_string($etag) || !preg_match('/^[!-~]{1,256}$/D', $etag)) throw new TransferException('ALMIRA_TRANSFER_RESPONSE_INVALID', $number);
            $parts[] = ['part_number' => $number, 'etag' => $etag];
            if ($protocol === 'single_put') {
                $objectEtag = $etag;
                foreach (['x-amz-version-id', 'x-goog-generation', 'x-ms-version-id'] as $name) if (isset($headers[$name])) { $value = $headers[$name]; if (!preg_match('/^[!-~]{1,256}$/D', $value) || preg_match('/[\/?#\\\\]/', $value) || $providerVersion !== null && $providerVersion !== $value) throw new TransferException('ALMIRA_TRANSFER_RESPONSE_INVALID', $number); $providerVersion = $value; }
            }
        }
        return ['descriptor_id' => $descriptorId, 'protocol' => $protocol, 'etag' => $objectEtag, 'provider_version' => $providerVersion, 'parts' => $parts, 'size_bytes' => $expectedSize, 'content_sha256' => $digest];
    } catch (TransferException $error) { throw $error; } catch (\Throwable) { throw $invalid(); }
}

function valid_transfer_url(mixed $value): bool
{
    if (!is_string($value) || strlen($value) > 8192 || preg_match('/[\\x00-\\x20\\x7f\\\\]/', $value)) return false;
    $url = parse_url($value);
    return $url !== false && ($url['scheme'] ?? '') === 'https' && isset($url['host']) && !isset($url['user']) && !isset($url['pass']) && !isset($url['fragment']);
}

function valid_transfer_headers(mixed $headers): bool
{
    if (!is_array($headers) || count($headers) > 32) return false;
    $names = [];
    foreach ($headers as $header) {
        if (!is_array($header) || !is_string($header['name'] ?? null) || !is_string($header['value'] ?? null)) return false;
        $name = $header['name']; $value = $header['value'];
        if (!preg_match('/^[A-Za-z0-9_-]{1,128}$/D', $name) || strlen($value) < 1 || strlen($value) > 4096 || preg_match('/[\\x00-\\x1f\\x7f]/', $value) || isset($names[$name])) return false;
        $names[$name] = true;
    }
    return true;
}

final readonly class VerifiedWebhook
{
    public function __construct(public string $deliveryId, public string $eventId, public int $attempt, public string $timestamp) {}
}

/** @param array<string,string> $headers */
function verifyWebhookSignature(string $secret, string $body, array $headers, ?\DateTimeImmutable $now = null, int $toleranceSeconds = 300): ?VerifiedWebhook
{
    if ($secret === '' || strlen($body) > 272 * 1024 || $toleranceSeconds < 0) return null;
    $header = static function (string $name) use ($headers): ?string {
        $values = array_values(array_filter($headers, static fn(string $value, string $key): bool => strtolower($key) === $name, ARRAY_FILTER_USE_BOTH));
        return count($values) === 1 && !str_contains($values[0], ',') ? $values[0] : null;
    };
    $delivery = $header('metamorph-webhook-delivery-id'); $event = $header('metamorph-webhook-event-id'); $attemptValue = $header('metamorph-webhook-attempt'); $timestamp = $header('metamorph-webhook-timestamp'); $signature = $header('metamorph-webhook-signature');
    if ($delivery === null || !preg_match(UUID_V7, $delivery) || $event === null || !preg_match(UUID_V7, $event) || $attemptValue === null || !preg_match('/^[1-8]$/D', $attemptValue) || $timestamp === null || $signature === null || !preg_match('/^v1=([A-Za-z0-9_-]{43})$/D', $signature, $matches)) return null;
    $occurred = \DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s.u\Z', $timestamp, new \DateTimeZone('UTC'));
    if ($occurred === false || abs(($now ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC')))->getTimestamp() - $occurred->getTimestamp()) > $toleranceSeconds) return null;
    $transcript = implode("\n", ['metamorph-webhook-v1', $delivery, $event, $attemptValue, $timestamp, 'sha256:' . hash('sha256', $body)]);
    $expected = rtrim(strtr(base64_encode(hash_hmac('sha256', $transcript, $secret, true)), '+/', '-_'), '=');
    return hash_equals($expected, $matches[1]) ? new VerifiedWebhook($delivery, $event, (int)$attemptValue, $timestamp) : null;
}

/**
 * Verifies the closed V1 receipt shape, optional exact resource binding and Ed25519 signature.
 *
 * @param array<string,mixed> $signed
 * @param array<string,mixed> $keySet
 * @param array<string,mixed>|null $expected
 */
function verifyVerificationReceipt(array $signed, array $keySet, ?array $expected = null): bool
{
    try {
        if (!exact_keys($signed, ['algorithm', 'receipt', 'signature']) || $signed['algorithm'] !== 'ed25519'
            || !is_array($signed['receipt']) || !valid_verification_receipt($signed['receipt'])
            || !is_string($signed['signature']) || ($signature = decode_base64url($signed['signature'], 64)) === null
            || !exact_keys($keySet, ['format_version', 'keys']) || $keySet['format_version'] !== 1
            || !is_array($keySet['keys']) || count($keySet['keys']) < 1 || count($keySet['keys']) > 4
            || $expected !== null && !matches_verification_expectation($signed['receipt'], $expected)) return false;
        $matching = [];
        foreach ($keySet['keys'] as $key) {
            if (!is_array($key) || !exact_keys($key, ['algorithm', 'key_id', 'public_key'])
                || $key['algorithm'] !== 'ed25519' || !is_string($key['key_id'])
                || !preg_match('/^[a-z][a-z0-9._-]{0,63}$/D', $key['key_id']) || !is_string($key['public_key'])) return false;
            if ($key['key_id'] === $signed['receipt']['signing_key_id']) $matching[] = $key['public_key'];
        }
        if (count($matching) !== 1 || ($publicKey = decode_base64url($matching[0], 32)) === null) return false;
        $message = json_encode(canonical_json($signed['receipt']), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        return sodium_crypto_sign_verify_detached($signature, $message, $publicKey);
    } catch (\Throwable) {
        return false;
    }
}

/** @param array<string,mixed> $receipt */
function valid_verification_receipt(array $receipt): bool
{
    $fields = ['checks', 'collection_instance_id', 'content_sha256', 'contract_version', 'entry_id',
        'environment_id', 'expected_size_bytes', 'generation_id', 'project_id', 'realm_id',
        'receipt_version', 'safety_state', 'signing_key_id', 'tenant_id', 'verification_id'];
    if (!exact_keys($receipt, $fields) || $receipt['receipt_version'] !== 'almira.verification.v1'
        || $receipt['contract_version'] !== CONTRACT_VERSION || !is_string($receipt['signing_key_id'])
        || !preg_match('/^[a-z][a-z0-9._-]{0,63}$/D', $receipt['signing_key_id'])
        || !is_string($receipt['content_sha256']) || !preg_match('/^sha256:[0-9a-f]{64}$/D', $receipt['content_sha256'])
        || !is_int($receipt['expected_size_bytes']) || $receipt['expected_size_bytes'] < 1
        || $receipt['expected_size_bytes'] > 8 * 1024 * 1024
        || !in_array($receipt['safety_state'], ['not_required', 'clean'], true)) return false;
    foreach (['verification_id', 'realm_id', 'tenant_id', 'project_id', 'environment_id',
        'collection_instance_id', 'entry_id', 'generation_id'] as $field) {
        if (!is_string($receipt[$field]) || !preg_match(UUID_V7, $receipt[$field])) return false;
    }
    $checks = ['finalization_idempotency', 'private_read_integrity', 'cross_scope_refusal', 'malware_safety'];
    if (!is_array($receipt['checks']) || count($receipt['checks']) !== count($checks)) return false;
    foreach ($checks as $index => $name) {
        $check = $receipt['checks'][$index] ?? null;
        if (!is_array($check) || !exact_keys($check, ['name', 'result'])
            || $check['name'] !== $name || $check['result'] !== 'passed') return false;
    }
    return true;
}

/** @param array<string,mixed> $receipt @param array<string,mixed> $expected */
function matches_verification_expectation(array $receipt, array $expected): bool
{
    $required = ['tenant_id', 'project_id', 'environment_id', 'collection_instance_id', 'entry_id',
        'generation_id', 'expected_size_bytes', 'content_sha256'];
    foreach ($required as $field) if (!array_key_exists($field, $expected) || $receipt[$field] !== $expected[$field]) return false;
    return !array_key_exists('verification_id', $expected) || $receipt['verification_id'] === $expected['verification_id'];
}

/** @param array<mixed> $value @param list<string> $expected */
function exact_keys(array $value, array $expected): bool
{
    $actual = array_keys($value); sort($actual); sort($expected); return $actual === $expected;
}

function canonical_json(mixed $value): mixed
{
    if (!is_array($value)) return $value;
    if (array_is_list($value)) return array_map(__NAMESPACE__ . '\\canonical_json', $value);
    ksort($value, SORT_STRING);
    foreach ($value as $key => $child) $value[$key] = canonical_json($child);
    return $value;
}

function decode_base64url(string $value, int $size): ?string
{
    if (str_contains($value, '=') || !preg_match('/^[A-Za-z0-9_-]+$/D', $value)) return null;
    $decoded = base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4), true);
    return is_string($decoded) && strlen($decoded) === $size
        && rtrim(strtr(base64_encode($decoded), '+/', '-_'), '=') === $value ? $decoded : null;
}

function input_error(): ClientException { return new ClientException('ALMIRA_CLIENT_INPUT_INVALID'); }
function response_error(): ClientException { return new ClientException('ALMIRA_CLIENT_RESPONSE_INVALID'); }
function uuid(string $value): string { if (!preg_match(UUID_V7, $value)) throw input_error(); return $value; }
function base_url(string $value): string { $parts = parse_url($value); if ($parts === false || !in_array($parts['scheme'] ?? '', ['http', 'https'], true) || !isset($parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true)) throw input_error(); return rtrim($value, '/'); }
function scope(object $reference): string { return uuid($reference->tenantId) . '/' . uuid($reference->projectId) . '/' . uuid($reference->environmentId) . '/' . uuid($reference->collectionInstanceId); }
function data_collection_path(object $reference, string $suffix): string { return '/v1/data/' . scope($reference) . $suffix; }
function management_collection_path(CollectionReference $reference, string $suffix): string { return '/v1/projects/' . uuid($reference->projectId) . '/environments/' . uuid($reference->environmentId) . '/collections/' . uuid($reference->collectionInstanceId) . $suffix; }
function variant(string $value): string { $segments = explode('/', $value); if ($value === '' || strlen($value) > 160 || array_filter($segments, static fn(string $part): bool => $part === '' || $part === '.' || $part === '..' || !preg_match('/^[A-Za-z0-9._~-]+$/D', $part))) throw input_error(); return implode('/', array_map('rawurlencode', $segments)); }
function query(array $values): string { $values = array_filter($values, static fn(mixed $value): bool => $value !== null); return $values === [] ? '' : '?' . http_build_query($values, '', '&', PHP_QUERY_RFC3986); }
function bounded_read($stream, int $limit): string { $value = stream_get_contents($stream, $limit + 1); if ($value === false || strlen($value) > $limit) throw response_error(); return $value; }
function api_error(HttpResponse $response): ApiException { try { $value = json_decode(bounded_read($response->body, 64 * 1024), true, flags: JSON_THROW_ON_ERROR); } catch (\Throwable) { throw response_error(); } $code = $value['code'] ?? null; $request = $value['request_id'] ?? null; if (!is_string($code) || !preg_match('/^ALMIRA_[A-Z0-9_]{1,127}$/D', $code) || !is_string($request) || !preg_match(UUID_V7, $request)) throw response_error(); $retry = isset($response->headers['retry-after']) && preg_match('/^[0-9]{1,8}$/D', $response->headers['retry-after']) ? (int)$response->headers['retry-after'] : null; return new ApiException($code, $request, $response->status, $retry); }
