import test from "node:test";
import assert from "node:assert/strict";
import { OVClient } from "../client.ts";

const config = { endpoint: "https://example.invalid", apiKey: "test-secret", account: "", user: "", peerId: "", userAgent: "test" };

test("OV client classifies timeout and redacts HTTP errors", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error("Bearer abcdefghijklmnop"), { name: "AbortError" }); };
  try {
    const result = await new OVClient(config).fetchJSON("/health", undefined, 1);
    assert.equal(result.error.code, "timeout");
    assert.doesNotMatch(result.error.message, /abcdefghijklmnop/);
  } finally { globalThis.fetch = previous; }
});
