import test from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, REASON_CODES } from "../web/voice-status.js";

test("the local server not answering is its own reason", () => {
  assert.equal(classifyFailure({ fetchFailed: true, offline: false }).code, "local_server");
});

test("a browser that is offline explains a network failure", () => {
  const result = classifyFailure({ status: 502, body: { code: "network", detail: "x" }, offline: true });
  assert.equal(result.code, "offline");
});

test("server reasons are passed through with their detail", () => {
  const result = classifyFailure({ status: 502, body: { code: "rejected", status: 403, detail: "403 Invalid response status" }, offline: false });
  assert.equal(result.code, "rejected");
  assert.match(result.detail, /403/);
});

test("unknown shapes never throw and fall back to 'other'", () => {
  assert.equal(classifyFailure({ status: 500, body: null, offline: false }).code, "other");
  assert.equal(classifyFailure({ status: 502, body: { code: "weird" }, offline: false }).code, "other");
  assert.ok(REASON_CODES.includes("not_installed"));
});
