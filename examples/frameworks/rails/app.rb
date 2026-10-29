# frozen_string_literal: true

require "rails"
require "action_controller/railtie"
require "almira"

def required(name)
  ENV.fetch(name) { raise "#{name} is required" }
end

class AlmiraExample < Rails::Application
  config.eager_load = false
  config.logger = Logger.new($stdout)
  config.secret_key_base = "development-only-not-an-almira-credential"
  config.hosts.clear
end

class FilesController < ActionController::API
  def show
    return render(json: { code: "ALMIRA_EXAMPLE_FORBIDDEN" }, status: :forbidden) unless request.headers["X-App-User"].present?

    client = Almira::DataClient.new(
      base_url: required("ALMIRA_BASE_URL"),
      capability: -> { required("ALMIRA_CAPABILITY") },
      retry_policy: Almira::RetryPolicy.new(max_attempts: 3, base_delay_seconds: 0.1, maximum_delay_seconds: 2)
    )
    entry = client.get_file_metadata_with_capability(Almira::FileReference.new(
      tenant_id: required("ALMIRA_TENANT_ID"), project_id: required("ALMIRA_PROJECT_ID"),
      environment_id: required("ALMIRA_ENVIRONMENT_ID"), collection_instance_id: required("ALMIRA_COLLECTION_ID"),
      entry_id: params.fetch(:entry_id)
    ))
    render json: entry
  end
end

AlmiraExample.routes.draw { get "/files/:entry_id", to: "files#show" }
