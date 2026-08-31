import test from "node:test";
import assert from "node:assert/strict";
import { OVClient } from "../client.ts";

const config = { endpoint: "https://example.invalid", apiKey: "test", account: "", user: "", peerId: "", userAgent: "test" };

test("context search falls back to recall endpoint", async () => {
  const previous = globalThis.fetch;
  const paths = [];
  globalThis.fetch = async (url, init) => {
    paths.push(url);
    if (url.endsWith("/search/search")) return new Response(JSON.stringify({ status: "error", error: { message: "unsupported" } }), { status: 400 });
    return new Response(JSON.stringify({ status: "ok", result: { memories: [{ uri: "viking://~/memories/fallback" }] } }), { status: 200 });
  };
  try {
    const result = await new OVClient(config).searchContext("fallback", { purpose: "coding" });
    assert.equal(result.memories[0].uri, "viking://~/memories/fallback");
    assert.deepEqual(paths, ["https://example.invalid/api/v1/search/search", "https://example.invalid/api/v1/search/recall"]);
  } finally { globalThis.fetch = previous; }
});
