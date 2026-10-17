import assert from "node:assert/strict";
import test from "node:test";

import { verifyWebhookSignature } from "../dist/index.js";

const body = '{"event":"almira.file.available.v1"}';
const headers = {
  "Metamorph-Webhook-Delivery-Id": "018f0000-0000-7000-8000-000000000011",
  "Metamorph-Webhook-Event-Id": "018f0000-0000-7000-8000-000000000012",
  "Metamorph-Webhook-Attempt": "2",
  "Metamorph-Webhook-Timestamp": "2026-10-17T12:00:00.000000Z",
  "Metamorph-Webhook-Signature": "v1=PHaG4k_rjkr4itoseS10o0_znK6FR9aoArs7pPV2klI",
};
const now = new Date("2026-10-17T12:00:30.000Z");

test("verifies the common APP-01 webhook vector over raw bytes", async () => {
  assert.deepEqual(await verifyWebhookSignature("topsecret", body, headers, { now }), {
    deliveryId: headers["Metamorph-Webhook-Delivery-Id"],
    eventId: headers["Metamorph-Webhook-Event-Id"],
    attempt: 2,
    timestamp: headers["Metamorph-Webhook-Timestamp"],
  });
});

test("fails closed on substitution, replay-age, and coalesced headers", async () => {
  assert.equal(await verifyWebhookSignature("topsecret", `${body} `, headers, { now }), null);
  assert.equal(await verifyWebhookSignature("wrong", body, headers, { now }), null);
  assert.equal(await verifyWebhookSignature("topsecret", body, headers, {
    now: new Date("2026-10-17T12:05:00.001Z"),
  }), null);
  assert.equal(await verifyWebhookSignature("topsecret", body, {
    ...headers,
    "metamorph-webhook-attempt": "2",
  }, { now }), null);
  assert.equal(await verifyWebhookSignature("topsecret", body, {
    ...headers,
    "Metamorph-Webhook-Attempt": "2, 2",
  }, { now }), null);
  assert.equal(await verifyWebhookSignature("topsecret", body, {
    ...headers,
    "Metamorph-Webhook-Timestamp": "2026-02-30T12:00:00.000000Z",
  }, { now }), null);
});
