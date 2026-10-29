# frozen_string_literal: true

require "stringio"
require_relative "../lib/almira"

TENANT = "018f0000-0000-7000-8000-000000000002"
PROJECT = "018f0000-0000-7000-8000-000000000003"
ENVIRONMENT = "018f0000-0000-7000-8000-000000000004"
COLLECTION = "018f0000-0000-7000-8000-000000000005"
OPERATION = "018f0000-0000-7000-8000-000000000008"
CAPABILITY = "alm_cap_v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

class MemoryBody < StringIO
  def close! = close
end

class RecordingTransport
  attr_reader :calls
  def initialize = @calls = []
  def send(method, url, headers, body)
    @calls << { method:, url:, headers:, body: }
    share = url.include?("/shares/")
    status = url.include?("/uploads") ? 201 : 200
    Almira::HTTPResponse.new(status, { "content-type" => share ? "application/octet-stream" : "application/json" }, MemoryBody.new(share ? "hello" : "{}"))
  end
end

class UploadTransport
  def put(_part, _source) = { status: 200, headers: { "etag" => '"v1"' } }
end

class JourneyTransport
  attr_reader :calls
  def initialize(responses) = (@responses = responses; @calls = [])
  def send(method, url, headers, body)
    @calls << { method:, url:, headers:, body: }
    response = @responses.shift
    Almira::HTTPResponse.new(
      response.fetch(:status),
      { "content-type" => "application/json" }.merge(response.fetch(:headers, {})),
      MemoryBody.new(JSON.generate(response.fetch(:body)))
    )
  end
end

def expect(value, message)
  raise message unless value
end

begin
  Almira::DataClient.new(base_url: "https://almira.test", capability: -> { CAPABILITY }, origin: "https://app.example/")
  raise "invalid origin accepted"
rescue Almira::ClientError
  nil
end
transport = RecordingTransport.new
reference = Almira::CollectionReference.new(tenant_id: TENANT, project_id: PROJECT, environment_id: ENVIRONMENT, collection_instance_id: COLLECTION)
data = Almira::DataClient.new(base_url: "https://almira.test", capability: -> { CAPABILITY }, origin: "https://app.example", transport:)
data.list_files_with_capability(reference, filters: { limit: 25 })
data.read_share("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb").close
begin
  data.read_share("alm_share_v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", range: "bytes=unsafe")
  raise "invalid range accepted"
rescue Almira::ClientError
  nil
end
expect(transport.calls[0][:headers]["authorization"] == "Bearer #{CAPABILITY}", "capability missing")
expect(!transport.calls[1][:headers].key?("authorization"), "share leaked credential")

server = Almira::ServerClient.new(base_url: "https://almira.test", workload_session: -> { "workload_evidence" }, transport:)
server.create_upload(reference, { "path" => "avatar.png" }, operation_id: OPERATION)
expect(transport.calls[2][:headers]["authorization"] == "MetamorphWorkload workload_evidence", "workload evidence missing")
expect(Almira::CONTRACT_VERSION == "0.1.0-dev.59", "contract drift")
source = StringIO.new("hello")
finalize = Almira.upload_direct(
  descriptor: {
    "descriptor_id" => OPERATION, "protocol" => "single_put", "expected_size_bytes" => 5,
    "content_sha256" => "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "one_use" => true, "expires_at" => "2099-01-01T00:00:00.000000Z", "part_size_bytes" => nil,
    "part_count" => 1, "requests" => [{ "part_number" => 1, "offset_bytes" => 0, "length_bytes" => 5, "method" => "PUT", "url" => "https://storage.test/secret", "headers" => [], "one_use" => true }]
  }, source:, transport: UploadTransport.new
)
expect(finalize["etag"] == '"v1"' && !finalize.to_s.include?("storage.test"), "unsafe transfer result")
webhook_headers = {
  "metamorph-webhook-delivery-id" => "018f0000-0000-7000-8000-000000000011",
  "metamorph-webhook-event-id" => "018f0000-0000-7000-8000-000000000012",
  "metamorph-webhook-attempt" => "2",
  "metamorph-webhook-timestamp" => "2026-10-17T12:00:00.000000Z",
  "metamorph-webhook-signature" => "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI"
}
verified = Almira.verify_webhook_signature(secret: "topsecret", body: '{"event":"almira.file.available.v1"}', headers: webhook_headers, now: Time.iso8601("2026-10-17T12:00:30Z"))
expect(verified&.attempt == 2, "webhook vector rejected")
webhook_headers["metamorph-webhook-signature"] = "v1=AHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI"
expect(Almira.verify_webhook_signature(secret: "topsecret", body: '{"event":"almira.file.available.v1"}', headers: webhook_headers, now: Time.iso8601("2026-10-17T12:00:30Z")).nil?, "tampered webhook accepted")
common = JSON.parse(File.read(File.expand_path("../../../conformance/application-sdk.v1.json", __dir__)))
receipt_vector = common["behavior_receipt"]
expect(Almira.verify_verification_receipt(signed: receipt_vector["signed"], key_set: receipt_vector["key_set"], expected: receipt_vector["expected"]), "valid behavior receipt rejected")
substituted = receipt_vector["expected"].merge("generation_id" => receipt_vector["substitution"]["generation_id"])
expect(!Almira.verify_verification_receipt(signed: receipt_vector["signed"], key_set: receipt_vector["key_set"], expected: substituted), "resource substitution accepted")
tampered_receipt = Marshal.load(Marshal.dump(receipt_vector["signed"]))
tampered_receipt["receipt"]["generation_id"] = substituted["generation_id"]
expect(!Almira.verify_verification_receipt(signed: tampered_receipt, key_set: receipt_vector["key_set"]), "tampered behavior receipt accepted")
journey = common["managed_development"]
ids = journey["reference"]
file = Almira::FileReference.new(
  tenant_id: ids["tenant_id"], project_id: ids["project_id"], environment_id: ids["environment_id"],
  collection_instance_id: ids["collection_instance_id"], entry_id: ids["entry_id"]
)
positive_transport = JourneyTransport.new([{ status: 200, body: journey["positive"]["response"] }])
positive = Almira::DataClient.new(
  base_url: journey["base_url"], capability: -> { journey["positive"]["capability"] },
  origin: journey["origin"], transport: positive_transport
)
expect(positive.get_file_metadata_with_capability(file)["entry_id"] == ids["entry_id"], "managed-development positive journey failed")
expect(positive_transport.calls[0][:headers]["authorization"] == "Bearer #{journey["positive"]["capability"]}", "local capability not sent")
refusal_transport = JourneyTransport.new([{ status: 200, body: journey["positive"]["response"] }])
begin
  Almira::DataClient.new(base_url: journey["base_url"], capability: -> { journey["refusal"]["credential"] }, transport: refusal_transport)
    .get_file_metadata_with_capability(file)
  raise "management credential accepted"
rescue Almira::ClientError => error
  expect(error.code == journey["refusal"]["client_code"] && refusal_transport.calls.empty?, "management credential refusal journey failed")
end
retry_transport = JourneyTransport.new([
  { status: journey["retry"]["first_status"], body: journey["retry"]["first_error"], headers: { "retry-after" => "0" } },
  { status: journey["retry"]["final_status"], body: journey["positive"]["response"] }
])
credential_attempt = 0
retrying = Almira::DataClient.new(
  base_url: journey["base_url"], capability: -> { value = journey["retry"]["capabilities"][credential_attempt]; credential_attempt += 1; value },
  transport: retry_transport, retry_policy: Almira::RetryPolicy.new(max_attempts: 2, base_delay_seconds: 0, maximum_delay_seconds: 0)
)
expect(retrying.get_file_metadata_with_capability(file)["entry_id"] == ids["entry_id"], "managed-development retry journey failed")
expect(retry_transport.calls.map { |call| call[:headers]["authorization"] } == journey["retry"]["capabilities"].map { |value| "Bearer #{value}" }, "retry did not refresh authority")
expect(journey["cleanup"] == { "applicable" => false, "reason" => "read_only_journey" }, "read-only cleanup semantics drifted")
puts "Ruby SDK tests passed"
