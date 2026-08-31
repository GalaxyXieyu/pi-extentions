import test from "node:test";
import assert from "node:assert/strict";
import { OVClient } from "../client.ts";
import { OpenVikingProvider } from "../provider.ts";

const config = { endpoint: "https://example.invalid", apiKey: "test-secret", account: "", user: "", peerId: "", userAgent: "test", recallLimit: 10, recallMaxContentChars: 500, commitKeepRecentCount: 10 };

test("OpenViking capability probe returns verified structured support", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "ok", result: {} }), { status: 200 });
  try {
    const result = await new OpenVikingProvider(new OVClient(config), config).probeCapabilities();
    assert.equal(result.verified, true);
    assert.equal(result.backend, "openviking");
    assert.deepEqual(result.unsupported, ["profileWrite"]);
  } finally { globalThis.fetch = previous; }
});
