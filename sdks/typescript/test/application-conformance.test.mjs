import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AlmiraClientError, AlmiraDataClient } from "../dist/index.js";

const common = JSON.parse(await readFile(new URL("../../../conformance/application-sdk.v1.json", import.meta.url)));
const journey = common.managed_development;
const reference = {
  tenantId: journey.reference.tenant_id,
  projectId: journey.reference.project_id,
  environmentId: journey.reference.environment_id,
  collectionInstanceId: journey.reference.collection_instance_id,
  entryId: journey.reference.entry_id,
};

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

test("common managed-development positive, refusal, retry, and cleanup journey", async () => {
  const positive = new AlmiraDataClient({
    baseUrl: journey.base_url,
    origin: journey.origin,
    capability: journey.positive.capability,
    fetch: async (_input, init) => {
      assert.equal(init.headers.get("authorization"), `Bearer ${journey.positive.capability}`);
      return json(journey.positive.response);
    },
  });
  assert.equal((await positive.getFileMetadataWithCapability(reference)).entry_id, reference.entryId);

  let refusalCalls = 0;
  const refused = new AlmiraDataClient({
    baseUrl: journey.base_url,
    capability: journey.refusal.credential,
    fetch: async () => { refusalCalls += 1; return json({}); },
  });
  await assert.rejects(
    refused.getFileMetadataWithCapability(reference),
    (error) => error instanceof AlmiraClientError && error.code === journey.refusal.client_code,
  );
  assert.equal(refusalCalls, 0);

  let attempts = 0;
  const observed = [];
  const retrying = new AlmiraDataClient({
    baseUrl: journey.base_url,
    capability: () => journey.retry.capabilities[attempts],
    retry: { maxAttempts: 2, baseDelayMilliseconds: 0, maximumDelayMilliseconds: 0 },
    fetch: async (_input, init) => {
      observed.push(init.headers.get("authorization"));
      attempts += 1;
      return attempts === 1
        ? json(journey.retry.first_error, journey.retry.first_status, { "retry-after": String(journey.retry.retry_after_seconds) })
        : json(journey.positive.response, journey.retry.final_status);
    },
  });
  assert.equal((await retrying.getFileMetadataWithCapability(reference)).entry_id, reference.entryId);
  assert.deepEqual(observed, journey.retry.capabilities.map((value) => `Bearer ${value}`));
  assert.deepEqual(journey.cleanup, { applicable: false, reason: "read_only_journey" });
});
