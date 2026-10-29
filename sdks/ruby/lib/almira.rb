# frozen_string_literal: true

require "base64"
require "digest"
require "json"
require "net/http"
require "openssl"
require "set"
require "tempfile"
require "time"
require "uri"

module Almira
  CONTRACT_VERSION = "0.1.0-dev.59"
  UUID_V7 = /\A[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/

  class ClientError < StandardError
    attr_reader :code
    def initialize(code) = (@code = code; super(code))
  end

  class APIError < StandardError
    attr_reader :code, :request_id, :status, :retry_after_seconds
    def initialize(code, request_id, status, retry_after_seconds)
      @code = code; @request_id = request_id; @status = status; @retry_after_seconds = retry_after_seconds
      super(code)
    end
  end

  CollectionReference = Data.define(:tenant_id, :project_id, :environment_id, :collection_instance_id)
  FileReference = Data.define(:tenant_id, :project_id, :environment_id, :collection_instance_id, :entry_id)
  GenerationReference = Data.define(:tenant_id, :project_id, :environment_id, :collection_instance_id, :entry_id, :generation_id)
  DerivativeReference = Data.define(:tenant_id, :project_id, :environment_id, :collection_instance_id, :entry_id, :generation_id, :variant_key)
  ProjectReference = Data.define(:tenant_id, :project_id)
  VerifiedWebhook = Data.define(:delivery_id, :event_id, :attempt, :timestamp)

  class HTTPResponse
    attr_reader :status, :headers, :body
    def initialize(status, headers, body)
      @status = status; @headers = headers.transform_keys(&:downcase).freeze; @body = body
    end
    def close = @body.close!
  end

  class NetHTTPTransport
    def initialize(timeout: 30) = @timeout = timeout
    def send(method, url, headers, body)
      uri = URI(url)
      request = Net::HTTP.const_get(method.capitalize).new(uri)
      headers.each { |name, value| request[name] = value }
      request.body = body if body
      output = Tempfile.new("almira-response", binmode: true)
      Net::HTTP.start(uri.host, uri.port, use_ssl: uri.scheme == "https", open_timeout: @timeout, read_timeout: @timeout) do |http|
        http.request(request) do |response|
          response.read_body { |chunk| output.write(chunk) }
          output.rewind
          return HTTPResponse.new(response.code.to_i, response.each_header.to_h, output)
        end
      end
    rescue ClientError
      output&.close!
      raise
    rescue StandardError
      output&.close!
      raise ClientError, "ALMIRA_CLIENT_NETWORK"
    end
  end

  RetryPolicy = Data.define(:max_attempts, :base_delay_seconds, :maximum_delay_seconds) do
    def initialize(max_attempts: 1, base_delay_seconds: 0.1, maximum_delay_seconds: 5.0)
      raise Almira.input_error unless (1..5).cover?(max_attempts) && base_delay_seconds >= 0 && maximum_delay_seconds >= base_delay_seconds && maximum_delay_seconds <= 60
      super(max_attempts:, base_delay_seconds:, maximum_delay_seconds:)
    end
  end

  class DataClient
    def initialize(base_url:, capability:, origin: nil, transport: NetHTTPTransport.new, retry_policy: RetryPolicy.new)
      @base_url = Almira.base_url(base_url); @capability = capability; @origin = origin; @transport = transport; @retry = retry_policy
      raise Almira.input_error if origin && (origin.end_with?("/") || Almira.base_url(origin) != origin)
    end

    def list_files_with_capability(reference, filters: {})
      json("GET", Almira.data_collection_path(reference, "/files") + Almira.query(filters), nil)
    end
    def search_files_with_capability(reference, request)
      raise Almira.input_error unless request.is_a?(Hash)
      json("POST", Almira.data_collection_path(reference, "/search"), request)
    end
    def get_file_metadata_with_capability(reference)
      json("GET", Almira.data_collection_path(reference, "/files/#{Almira.uuid(reference.entry_id)}"), nil)
    end
    def list_derivatives_with_capability(reference)
      json("GET", Almira.data_collection_path(reference, "/files/#{Almira.uuid(reference.entry_id)}/versions/#{Almira.uuid(reference.generation_id)}/derivatives"), nil)
    end
    def read_immutable_generation(reference, range: nil, if_none_match: nil)
      binary("/v1/delivery/#{Almira.scope(reference)}/#{Almira.uuid(reference.entry_id)}/#{Almira.uuid(reference.generation_id)}", range, if_none_match, false)
    end
    def read_derivative(reference, range: nil, if_none_match: nil)
      binary("/v1/delivery/#{Almira.scope(reference)}/#{Almira.uuid(reference.entry_id)}/#{Almira.uuid(reference.generation_id)}/variants/#{Almira.variant(reference.variant_key)}", range, if_none_match, false)
    end
    def read_share(share_token, range: nil, if_none_match: nil)
      raise Almira.input_error unless share_token.match?(/\Aalm_share_v1\.[A-Za-z0-9_-]{43,4096}\z/)
      binary("/v1/shares/#{URI.encode_uri_component(share_token)}", range, if_none_match, true)
    end

    private

    def json(method, path, value)
      response = send_request(method, path, value, false, nil, nil)
      raise Almira.api_error(response) unless (200...300).cover?(response.status)
      raise Almira.response_error unless response.headers.fetch("content-type", "").split(";").first == "application/json"
      decoded = JSON.parse(Almira.bounded_read(response.body, 2 * 1024 * 1024))
      raise Almira.response_error unless decoded.is_a?(Hash) || decoded.is_a?(Array)
      decoded
    rescue JSON::ParserError
      raise Almira.response_error
    ensure
      response&.close
    end

    def binary(path, range, if_none_match, share)
      raise Almira.input_error if range && (range.length > 64 || !range.match?(/\Abytes=[0-9]+-[0-9]*\z/))
      raise Almira.input_error if if_none_match && (if_none_match.empty? || if_none_match.length > 512 || if_none_match.include?("\r") || if_none_match.include?("\n"))
      response = send_request("GET", path, nil, share, range, if_none_match)
      unless [200, 206, 304].include?(response.status)
        error = Almira.api_error(response); response.close; raise error
      end
      response
    end

    def send_request(method, path, value, share, range, if_none_match)
      (1..@retry.max_attempts).each do |attempt|
        headers = { "accept" => value ? "application/json" : "*/*" }
        unless share
          begin
            token = @capability.call
          rescue StandardError
            raise ClientError, "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"
          end
          raise Almira.input_error unless token.is_a?(String) && token.match?(/\A(?:alm_cap_v1|alm_local_v1)\.[A-Za-z0-9_-]{43,4096}\z/)
          headers["authorization"] = "Bearer #{token}"; headers["origin"] = @origin if @origin
        end
        headers["range"] = range if range; headers["if-none-match"] = if_none_match if if_none_match
        body = value && JSON.generate(value); headers["content-type"] = "application/json" if body
        begin
          response = @transport.send(method, @base_url + path, headers, body)
        rescue ClientError
          raise
        rescue StandardError
          raise ClientError, "ALMIRA_CLIENT_NETWORK"
        end
        return response unless [429, 502, 503, 504].include?(response.status) && attempt < @retry.max_attempts
        retry_after = response.headers["retry-after"]&.match?(/\A[0-9]{1,8}\z/) ? response.headers["retry-after"].to_f : nil
        response.close
        sleep([retry_after || @retry.base_delay_seconds * (2**(attempt - 1)), @retry.maximum_delay_seconds].min)
      end
    end
  end

  class ServerClient
    def initialize(base_url:, workload_session:, transport: NetHTTPTransport.new)
      @base_url = Almira.base_url(base_url); @workload_session = workload_session; @transport = transport
    end
    def create_capability_session(reference, request, operation_id:) = call("POST", collection(reference, "/capability-sessions"), reference.tenant_id, operation_id, request, [201])
    def create_upload(reference, request, operation_id:) = call("POST", collection(reference, "/uploads"), reference.tenant_id, operation_id, request, [201])
    def create_upload_part(reference, transfer_session_id, request, operation_id:) = call("POST", collection(reference, "/uploads/#{Almira.uuid(transfer_session_id)}/parts"), reference.tenant_id, operation_id, request, [201])
    def finalize_upload(reference, transfer_session_id, request, operation_id:) = call("POST", collection(reference, "/uploads/#{Almira.uuid(transfer_session_id)}/finalize"), reference.tenant_id, operation_id, request, [200])
    def bind_subject(reference, entry_id, subject, operation_id:) = call("POST", collection(reference, "/files/#{Almira.uuid(entry_id)}/subject-bindings"), reference.tenant_id, operation_id, subject, [201])
    def list_subject_bindings(reference, request) = call("POST", "/v1/projects/#{Almira.uuid(reference.project_id)}/subject-bindings/search", reference.tenant_id, nil, request, [200])
    def start_subject_lifecycle_operation(reference, request, operation_id:) = call("POST", "/v1/projects/#{Almira.uuid(reference.project_id)}/subject-lifecycle-operations", reference.tenant_id, operation_id, request, [201, 202])
    def read_subject_lifecycle_operation(reference, request) = call("POST", "/v1/projects/#{Almira.uuid(reference.project_id)}/subject-lifecycle-operations/search", reference.tenant_id, nil, request, [200])
    def create_subject_export_download(reference, lifecycle_operation_id, request, operation_id:) = call("POST", "/v1/projects/#{Almira.uuid(reference.project_id)}/subject-lifecycle-operations/#{Almira.uuid(lifecycle_operation_id)}/download", reference.tenant_id, operation_id, request, [201])
    def revoke_capability_session(reference, session_id, operation_id:)
      value = call("DELETE", collection(reference, "/capability-sessions/#{Almira.uuid(session_id)}"), reference.tenant_id, operation_id, nil, [200])
      raise Almira.response_error unless ["applied", "exact_replay"].include?(value)
      value
    end

    private

    def call(method, path, tenant_id, operation_id, value, statuses)
      tenant_id = Almira.uuid(tenant_id); operation_id = Almira.uuid(operation_id) if operation_id
      begin
        evidence = @workload_session.call
      rescue StandardError
        raise ClientError, "ALMIRA_CLIENT_CREDENTIAL_UNAVAILABLE"
      end
      raise Almira.input_error unless evidence.is_a?(String) && (2..49_152).cover?(evidence.length) && evidence.match?(/\A[A-Za-z0-9_-]+\z/)
      headers = { "accept" => "application/json", "authorization" => "MetamorphWorkload #{evidence}", "x-almira-tenant-id" => tenant_id }
      headers["idempotency-key"] = operation_id if operation_id
      body = value && JSON.generate(value); headers["content-type"] = "application/json" if body
      begin
        response = @transport.send(method, @base_url + path, headers, body)
      rescue ClientError
        raise
      rescue StandardError
        raise ClientError, "ALMIRA_CLIENT_NETWORK"
      end
      raise Almira.api_error(response) unless statuses.include?(response.status)
      raise Almira.response_error unless response.headers.fetch("content-type", "").split(";").first == "application/json"
      JSON.parse(Almira.bounded_read(response.body, 2 * 1024 * 1024))
    rescue JSON::ParserError
      raise Almira.response_error
    ensure
      response&.close
    end

    def collection(reference, suffix)
      "/v1/projects/#{Almira.uuid(reference.project_id)}/environments/#{Almira.uuid(reference.environment_id)}/collections/#{Almira.uuid(reference.collection_instance_id)}#{suffix}"
    end
  end

  class TransferError < StandardError
    attr_reader :code, :part_number, :status
    def initialize(code, part_number = nil, status = nil) = (@code = code; @part_number = part_number; @status = status; super(code))
  end

  class DirectUploadTransport
    def put(part, source)
      uri = URI(part.fetch("url"))
      raise TransferError, "ALMIRA_TRANSFER_DESCRIPTOR_INVALID" unless uri.scheme == "https" && uri.host && !uri.userinfo && !uri.fragment
      source.seek(part.fetch("offset_bytes"))
      body = SegmentIO.new(source, part.fetch("length_bytes"))
      request = Net::HTTP::Put.new(uri)
      part.fetch("headers").each { |header| request[header.fetch("name")] = header.fetch("value") }
      request.content_length = part.fetch("length_bytes")
      request.body_stream = body
      Net::HTTP.start(uri.host, uri.port, use_ssl: true, open_timeout: 30, read_timeout: 30) do |http|
        response = http.request(request)
        raise TransferError.new("ALMIRA_TRANSFER_OUTCOME_UNKNOWN", part.fetch("part_number")) unless body.remaining.zero?
        return { status: response.code.to_i, headers: response.each_header.to_h }
      end
    end
  end

  class SegmentIO
    attr_reader :remaining
    def initialize(source, remaining) = (@source = source; @remaining = remaining)
    def read(length = nil, output = nil)
      return nil if @remaining.zero?
      count = [length || @remaining, @remaining].min
      value = @source.read(count)
      return nil if value.nil? || value.empty?
      @remaining -= value.bytesize
      output&.replace(value) || value
    end
  end

  module_function

  def upload_direct(descriptor:, source:, grant_part: nil, transport: DirectUploadTransport.new, now: nil)
    invalid = -> { TransferError.new("ALMIRA_TRANSFER_DESCRIPTOR_INVALID") }
    raise invalid.call unless source.respond_to?(:seek) && source.respond_to?(:read)
    descriptor_id = uuid(descriptor.fetch("descriptor_id")); protocol = descriptor.fetch("protocol")
    raise invalid.call unless ["single_put", "multipart"].include?(protocol) && descriptor["one_use"] == true
    expected_size = descriptor.fetch("expected_size_bytes"); digest = descriptor.fetch("content_sha256")
    current = source.pos; source.seek(0, IO::SEEK_END); actual_size = source.pos; source.seek(current)
    raise invalid.call unless expected_size.is_a?(Integer) && (1..10_737_418_240).cover?(expected_size) && actual_size == expected_size && digest.match?(/\Asha256:[0-9a-f]{64}\z/)
    expires_at = Time.iso8601(descriptor.fetch("expires_at")); raise TransferError, "ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED" unless expires_at > (now || Time.now.utc)
    requests = descriptor.fetch("requests"); part_count = descriptor.fetch("part_count")
    raise invalid.call unless requests.is_a?(Array) && part_count.is_a?(Integer) && (1..10_000).cover?(part_count)
    if protocol == "single_put"
      raise invalid.call unless requests.length == 1 && descriptor.key?("part_size_bytes") && descriptor["part_size_bytes"].nil? && part_count == 1
      part_size = expected_size
    else
      part_size = descriptor["part_size_bytes"]
      raise invalid.call unless requests.empty? && part_size.is_a?(Integer) && (1..10_737_418_240).cover?(part_size) && part_size * (part_count - 1) < expected_size && part_size * part_count >= expected_size
    end
    completions = []; object_etag = nil; provider_version = nil
    (1..part_count).each do |number|
      offset = (number - 1) * part_size; length = [part_size, expected_size - offset].min; raise invalid.call unless length.positive?
      part = if protocol == "single_put"
               requests.first
             else
               raise invalid.call unless grant_part
               source.seek(offset); hash = Digest::SHA256.new; remaining = length
               until remaining.zero?
                 chunk = source.read([65_536, remaining].min); raise invalid.call unless chunk && !chunk.empty?
                 hash.update(chunk); remaining -= chunk.bytesize
               end
               grant_part.call("part_number" => number, "content_sha256" => "sha256:#{hash.hexdigest}")
             end
      raise invalid.call unless part.is_a?(Hash) && part["part_number"] == number && part["offset_bytes"] == offset && part["length_bytes"] == length && part["method"] == "PUT" && part["one_use"] == true && valid_transfer_url(part["url"]) && valid_transfer_headers(part["headers"])
      raise TransferError, "ALMIRA_TRANSFER_DESCRIPTOR_EXPIRED" unless expires_at > (now || Time.now.utc)
      response = transport.put(part, source)
      raise TransferError.new("ALMIRA_TRANSFER_RESPONSE_INVALID", number) unless response.is_a?(Hash) && response[:status].is_a?(Integer) && (100..599).cover?(response[:status]) && response[:headers].is_a?(Hash)
      raise TransferError.new("ALMIRA_TRANSFER_PART_REFUSED", number, response[:status]) unless (200...300).cover?(response[:status])
      headers = {}
      response[:headers].each do |name, value|
        normalized = name.to_s.downcase
        raise TransferError.new("ALMIRA_TRANSFER_RESPONSE_INVALID", number) unless value.is_a?(String) && !headers.key?(normalized)
        headers[normalized] = value
      end
      etag = headers["etag"]
      raise TransferError.new("ALMIRA_TRANSFER_RESPONSE_INVALID", number) unless etag&.match?(/\A[!-~]{1,256}\z/)
      completions << { "part_number" => number, "etag" => etag }
      next unless protocol == "single_put"
      object_etag = etag
      %w[x-amz-version-id x-goog-generation x-ms-version-id].each do |name|
        version = headers[name]; next unless version
        raise TransferError.new("ALMIRA_TRANSFER_RESPONSE_INVALID", number) unless version.match?(/\A[!-~]{1,256}\z/) && !version.match?(%r{[/\\?#]}) && (provider_version.nil? || provider_version == version)
        provider_version = version
      end
    end
    { "descriptor_id" => descriptor_id, "protocol" => protocol, "etag" => object_etag, "provider_version" => provider_version, "parts" => completions, "size_bytes" => expected_size, "content_sha256" => digest }
  rescue TransferError
    raise
  rescue StandardError
    raise invalid.call
  end

  def valid_transfer_url(value)
    return false unless value.is_a?(String) && value.bytesize <= 8192 && value.bytes.none? { |byte| byte <= 32 || byte == 127 || byte == 92 }
    uri = URI(value)
    uri.scheme == "https" && uri.host && !uri.userinfo && !uri.fragment
  rescue URI::InvalidURIError
    false
  end

  def valid_transfer_headers(headers)
    return false unless headers.is_a?(Array) && headers.length <= 32
    names = Set.new
    headers.all? do |header|
      header.is_a?(Hash) &&
        header["name"].is_a?(String) && header["name"].match?(/\A[A-Za-z0-9_-]{1,128}\z/) &&
        header["value"].is_a?(String) && (1..4096).cover?(header["value"].bytesize) &&
        header["value"].bytes.none? { |byte| byte < 32 || byte == 127 } && names.add?(header["name"])
    end
  end

  def verify_webhook_signature(secret:, body:, headers:, now: Time.now.utc, tolerance_seconds: 300)
    return nil if secret.empty? || body.bytesize > 272 * 1024 || tolerance_seconds.negative?
    header = lambda do |name|
      values = headers.filter_map { |key, value| value if key.downcase == name }
      values.length == 1 && !values.first.include?(",") ? values.first : nil
    end
    delivery = header.call("metamorph-webhook-delivery-id"); event = header.call("metamorph-webhook-event-id"); attempt_value = header.call("metamorph-webhook-attempt"); timestamp = header.call("metamorph-webhook-timestamp"); signature = header.call("metamorph-webhook-signature")
    return nil unless delivery&.match?(UUID_V7) && event&.match?(UUID_V7) && attempt_value&.match?(/\A[1-8]\z/) && timestamp&.match?(/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\z/) && signature&.match?(/\Av1=([A-Za-z0-9_-]{43})\z/)
    occurred = Time.iso8601(timestamp).utc
    return nil if (now - occurred).abs > tolerance_seconds
    transcript = ["metamorph-webhook-v1", delivery, event, attempt_value, timestamp, "sha256:#{Digest::SHA256.hexdigest(body)}"].join("\n")
    expected = Base64.urlsafe_encode64(OpenSSL::HMAC.digest("SHA256", secret, transcript), padding: false)
    actual = signature.delete_prefix("v1=")
    return nil unless expected.bytesize == actual.bytesize && OpenSSL.fixed_length_secure_compare(expected, actual)
    VerifiedWebhook.new(delivery_id: delivery, event_id: event, attempt: attempt_value.to_i, timestamp: timestamp)
  rescue ArgumentError
    nil
  end

  # Verifies the closed V1 shape, exact expected binding and Ed25519 receipt signature.
  def verify_verification_receipt(signed:, key_set:, expected: nil)
    return false unless exact_keys?(signed, %w[algorithm receipt signature]) && signed["algorithm"] == "ed25519"
    receipt = signed["receipt"]
    return false unless valid_verification_receipt?(receipt) && signed["signature"].is_a?(String)
    signature = decode_base64url(signed["signature"], 64)
    return false unless signature && exact_keys?(key_set, %w[format_version keys]) && key_set["format_version"] == 1
    keys = key_set["keys"]
    return false unless keys.is_a?(Array) && (1..4).cover?(keys.length)
    return false if expected && !matches_verification_expectation?(receipt, expected)
    matching = keys.filter_map do |key|
      return false unless exact_keys?(key, %w[algorithm key_id public_key]) && key["algorithm"] == "ed25519" &&
        key["key_id"].is_a?(String) && key["key_id"].match?(/\A[a-z][a-z0-9._-]{0,63}\z/) && key["public_key"].is_a?(String)
      key["public_key"] if key["key_id"] == receipt["signing_key_id"]
    end
    return false unless matching.length == 1 && (raw_key = decode_base64url(matching.first, 32))
    der = ["302a300506032b6570032100"].pack("H*") + raw_key
    OpenSSL::PKey.read(der).verify(nil, signature, JSON.generate(canonical_json(receipt)))
  rescue ArgumentError, OpenSSL::PKey::PKeyError
    false
  end

  def valid_verification_receipt?(receipt)
    fields = %w[checks collection_instance_id content_sha256 contract_version entry_id environment_id
                expected_size_bytes generation_id project_id realm_id receipt_version safety_state
                signing_key_id tenant_id verification_id]
    return false unless exact_keys?(receipt, fields) && receipt["receipt_version"] == "almira.verification.v1" &&
      receipt["contract_version"] == CONTRACT_VERSION && receipt["signing_key_id"].is_a?(String) &&
      receipt["signing_key_id"].match?(/\A[a-z][a-z0-9._-]{0,63}\z/) && receipt["content_sha256"].is_a?(String) &&
      receipt["content_sha256"].match?(/\Asha256:[0-9a-f]{64}\z/) && receipt["expected_size_bytes"].is_a?(Integer) &&
      (1..8 * 1024 * 1024).cover?(receipt["expected_size_bytes"]) && %w[not_required clean].include?(receipt["safety_state"])
    return false unless %w[verification_id realm_id tenant_id project_id environment_id collection_instance_id entry_id generation_id]
      .all? { |field| receipt[field].is_a?(String) && receipt[field].match?(UUID_V7) }
    names = %w[finalization_idempotency private_read_integrity cross_scope_refusal malware_safety]
    receipt["checks"].is_a?(Array) && receipt["checks"].length == names.length && names.each_with_index.all? do |name, index|
      check = receipt["checks"][index]
      exact_keys?(check, %w[name result]) && check["name"] == name && check["result"] == "passed"
    end
  end

  def matches_verification_expectation?(receipt, expected)
    required = %w[tenant_id project_id environment_id collection_instance_id entry_id generation_id expected_size_bytes content_sha256]
    required.all? { |field| expected.key?(field) && receipt[field] == expected[field] } &&
      (!expected.key?("verification_id") || receipt["verification_id"] == expected["verification_id"])
  end

  def exact_keys?(value, expected) = value.is_a?(Hash) && value.keys.sort == expected.sort

  def canonical_json(value)
    return value.map { |child| canonical_json(child) } if value.is_a?(Array)
    return value.keys.sort.to_h { |key| [key, canonical_json(value[key])] } if value.is_a?(Hash)
    value
  end

  def decode_base64url(value, size)
    return nil unless value.is_a?(String) && value.match?(/\A[A-Za-z0-9_-]+\z/) && !value.include?("=")
    decoded = Base64.urlsafe_decode64(value + "=" * ((4 - value.length % 4) % 4))
    decoded.bytesize == size && Base64.urlsafe_encode64(decoded, padding: false) == value ? decoded : nil
  rescue ArgumentError
    nil
  end

  def input_error = ClientError.new("ALMIRA_CLIENT_INPUT_INVALID")
  def response_error = ClientError.new("ALMIRA_CLIENT_RESPONSE_INVALID")
  def uuid(value) = value.is_a?(String) && value.match?(UUID_V7) ? value : raise(input_error)
  def base_url(value)
    uri = URI(value)
    raise input_error unless ["http", "https"].include?(uri.scheme) && uri.host && !uri.userinfo && !uri.query && !uri.fragment && ["", "/"].include?(uri.path)
    value.delete_suffix("/")
  rescue URI::InvalidURIError
    raise input_error
  end
  def scope(reference) = [reference.tenant_id, reference.project_id, reference.environment_id, reference.collection_instance_id].map { |value| uuid(value) }.join("/")
  def data_collection_path(reference, suffix) = "/v1/data/#{scope(reference)}#{suffix}"
  def variant(value)
    segments = value.split("/", -1)
    raise input_error unless (1..160).cover?(value.length) && segments.all? { |part| !["", ".", ".."].include?(part) && part.match?(/\A[A-Za-z0-9._~-]+\z/) }
    segments.map { |part| URI.encode_uri_component(part) }.join("/")
  end
  def query(values) = values.compact.empty? ? "" : "?#{URI.encode_www_form(values.compact)}"
  def bounded_read(stream, limit)
    value = stream.read(limit + 1)
    raise response_error if value.nil? || value.bytesize > limit
    value
  end
  def api_error(response)
    value = JSON.parse(bounded_read(response.body, 64 * 1024)); code = value["code"]; request_id = value["request_id"]
    raise response_error unless code.is_a?(String) && code.match?(/\AALMIRA_[A-Z0-9_]{1,127}\z/) && request_id.is_a?(String) && request_id.match?(UUID_V7)
    retry_after = response.headers["retry-after"]&.match?(/\A[0-9]{1,8}\z/) ? response.headers["retry-after"].to_i : nil
    APIError.new(code, request_id, response.status, retry_after)
  rescue JSON::ParserError
    raise response_error
  end
end
