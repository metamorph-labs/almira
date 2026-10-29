<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/Almira.php';

use Metamorph\Almira\AlmiraDataClient;
use Metamorph\Almira\AlmiraServerClient;
use Metamorph\Almira\CollectionReference;
use Metamorph\Almira\HttpResponse;
use Metamorph\Almira\Transport;
use Metamorph\Almira\DirectUploadTransport;
use Metamorph\Almira\FileReference;

const TENANT = '018f0000-0000-7000-8000-000000000002';
const PROJECT = '018f0000-0000-7000-8000-000000000003';
const ENVIRONMENT = '018f0000-0000-7000-8000-000000000004';
const COLLECTION = '018f0000-0000-7000-8000-000000000005';
const OPERATION = '018f0000-0000-7000-8000-000000000008';
const CAPABILITY = 'alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

final class RecordingTransport implements Transport
{
    public array $calls = [];
    public function send(string $method, string $url, array $headers, ?string $body): HttpResponse
    {
        $this->calls[] = compact('method', 'url', 'headers', 'body');
        $stream = fopen('php://temp', 'w+b'); fwrite($stream, str_contains($url, '/shares/') ? 'hello' : '{}'); rewind($stream);
        return new HttpResponse(str_contains($url, '/uploads') ? 201 : 200, ['content-type' => str_contains($url, '/shares/') ? 'application/octet-stream' : 'application/json'], $stream);
    }
}

final class UploadTransport implements DirectUploadTransport
{
    public function put(array $part, $source): array { return ['status' => 200, 'headers' => ['etag' => '"v1"']]; }
}

final class JourneyTransport implements Transport
{
    public array $calls = [];
    public function __construct(private array $responses) {}
    public function send(string $method, string $url, array $headers, ?string $body): HttpResponse
    {
        $this->calls[] = compact('method', 'url', 'headers', 'body');
        $response = array_shift($this->responses);
        $stream = fopen('php://temp', 'w+b');
        fwrite($stream, json_encode($response['body'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES)); rewind($stream);
        return new HttpResponse($response['status'], ['content-type' => 'application/json', ...($response['headers'] ?? [])], $stream);
    }
}

function expect(bool $value, string $message): void { if (!$value) throw new RuntimeException($message); }

$invalidOriginRejected = false;
try { new AlmiraDataClient('https://almira.test', fn(): string => CAPABILITY, 'https://app.example/'); } catch (\Metamorph\Almira\ClientException) { $invalidOriginRejected = true; }
expect($invalidOriginRejected, 'invalid origin accepted');
$transport = new RecordingTransport();
$reference = new CollectionReference(TENANT, PROJECT, ENVIRONMENT, COLLECTION);
$data = new AlmiraDataClient('https://almira.test', fn(): string => CAPABILITY, 'https://app.example', $transport);
$data->listFilesWithCapability($reference, ['limit' => 25]);
$share = $data->readShare('alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'); $share->close();
$invalidRangeRejected = false;
try { $data->readShare('alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'bytes=unsafe'); } catch (\Metamorph\Almira\ClientException) { $invalidRangeRejected = true; }
expect($invalidRangeRejected, 'invalid range accepted');
expect($transport->calls[0]['headers']['authorization'] === 'Bearer ' . CAPABILITY, 'capability missing');
expect(!isset($transport->calls[1]['headers']['authorization']), 'share leaked credential');

$server = new AlmiraServerClient('https://almira.test', fn(): string => 'workload_evidence', $transport);
$server->createUpload($reference, ['path' => 'avatar.png'], OPERATION);
expect($transport->calls[2]['headers']['authorization'] === 'MetamorphWorkload workload_evidence', 'workload evidence missing');
expect($transport->calls[2]['headers']['x-almira-tenant-id'] === TENANT, 'tenant scope missing');
expect(\Metamorph\Almira\CONTRACT_VERSION === '0.1.0-dev.59', 'contract drift');
$source = fopen('php://temp', 'w+b'); fwrite($source, 'hello'); rewind($source);
$finalize = \Metamorph\Almira\uploadDirect([
    'descriptor_id' => OPERATION, 'protocol' => 'single_put', 'expected_size_bytes' => 5,
    'content_sha256' => 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    'one_use' => true, 'expires_at' => '2099-01-01T00:00:00.000000Z', 'part_size_bytes' => null,
    'part_count' => 1, 'requests' => [[
        'part_number' => 1, 'offset_bytes' => 0, 'length_bytes' => 5, 'method' => 'PUT',
        'url' => 'https://storage.test/secret', 'headers' => [], 'one_use' => true,
    ]],
], $source, transport: new UploadTransport());
expect($finalize['etag'] === '"v1"' && !str_contains(json_encode($finalize), 'storage.test'), 'unsafe transfer result');
fclose($source);
$webhookHeaders = [
    'metamorph-webhook-delivery-id' => '018f0000-0000-7000-8000-000000000011',
    'metamorph-webhook-event-id' => '018f0000-0000-7000-8000-000000000012',
    'metamorph-webhook-attempt' => '2',
    'metamorph-webhook-timestamp' => '2026-10-17T12:00:00.000000Z',
    'metamorph-webhook-signature' => 'v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI',
];
$verified = \Metamorph\Almira\verifyWebhookSignature('topsecret', '{"event":"almira.file.available.v1"}', $webhookHeaders, new DateTimeImmutable('2026-10-17T12:00:30Z'));
expect($verified?->attempt === 2, 'webhook vector rejected');
$webhookHeaders['metamorph-webhook-signature'] = 'v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI';
expect(\Metamorph\Almira\verifyWebhookSignature('topsecret', '{"event":"almira.file.available.v1"}', $webhookHeaders, new DateTimeImmutable('2026-10-17T12:00:30Z')) === null, 'tampered webhook accepted');
$common = json_decode(file_get_contents(__DIR__ . '/../../../conformance/application-sdk.v1.json'), true, flags: JSON_THROW_ON_ERROR);
$receiptVector = $common['behavior_receipt'];
expect(\Metamorph\Almira\verifyVerificationReceipt($receiptVector['signed'], $receiptVector['key_set'], $receiptVector['expected']), 'valid behavior receipt rejected');
$substituted = $receiptVector['expected'];
$substituted['generation_id'] = $receiptVector['substitution']['generation_id'];
expect(!\Metamorph\Almira\verifyVerificationReceipt($receiptVector['signed'], $receiptVector['key_set'], $substituted), 'resource substitution accepted');
$tamperedReceipt = $receiptVector['signed'];
$tamperedReceipt['receipt']['generation_id'] = $substituted['generation_id'];
expect(!\Metamorph\Almira\verifyVerificationReceipt($tamperedReceipt, $receiptVector['key_set']), 'tampered behavior receipt accepted');
$journey = $common['managed_development']; $ids = $journey['reference'];
$file = new FileReference($ids['tenant_id'], $ids['project_id'], $ids['environment_id'], $ids['collection_instance_id'], $ids['entry_id']);
$positiveTransport = new JourneyTransport([['status' => 200, 'body' => $journey['positive']['response']]]);
$positiveClient = new AlmiraDataClient($journey['base_url'], fn(): string => $journey['positive']['capability'], $journey['origin'], $positiveTransport);
expect($positiveClient->getFileMetadataWithCapability($file)['entry_id'] === $ids['entry_id'], 'managed-development positive journey failed');
expect($positiveTransport->calls[0]['headers']['authorization'] === 'Bearer ' . $journey['positive']['capability'], 'local capability not sent');
$refusalTransport = new JourneyTransport([['status' => 200, 'body' => $journey['positive']['response']]]);
$refusal = null;
try { (new AlmiraDataClient($journey['base_url'], fn(): string => $journey['refusal']['credential'], transport: $refusalTransport))->getFileMetadataWithCapability($file); }
catch (\Metamorph\Almira\ClientException $error) { $refusal = $error->codeName; }
expect($refusal === $journey['refusal']['client_code'] && $refusalTransport->calls === [], 'management credential refusal journey failed');
$retryTransport = new JourneyTransport([
    ['status' => $journey['retry']['first_status'], 'body' => $journey['retry']['first_error'], 'headers' => ['retry-after' => '0']],
    ['status' => $journey['retry']['final_status'], 'body' => $journey['positive']['response']],
]);
$credentialAttempt = 0;
$retryClient = new AlmiraDataClient(
    $journey['base_url'],
    function () use (&$credentialAttempt, $journey): string { return $journey['retry']['capabilities'][$credentialAttempt++]; },
    transport: $retryTransport,
    retry: new \Metamorph\Almira\RetryPolicy(2, 0, 0),
);
expect($retryClient->getFileMetadataWithCapability($file)['entry_id'] === $ids['entry_id'], 'managed-development retry journey failed');
expect(array_column(array_column($retryTransport->calls, 'headers'), 'authorization') === array_map(fn(string $value): string => 'Bearer ' . $value, $journey['retry']['capabilities']), 'retry did not refresh authority');
expect($journey['cleanup'] === ['applicable' => false, 'reason' => 'read_only_journey'], 'read-only cleanup semantics drifted');
fwrite(STDOUT, "PHP SDK tests passed\n");
