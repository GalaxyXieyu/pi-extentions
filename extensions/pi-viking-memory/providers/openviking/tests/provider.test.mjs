import { test } from "vitest";
import assert from "node:assert/strict";
import { OVClient } from "../client.ts";
import { OpenVikingProvider } from "../provider.ts";

const config = {
  enabled: true,
  endpoint: "https://example.invalid",
  apiKey: "test-secret",
  account: "",
  user: "",
  peerId: "",
  userAgent: "test",
  recallLimit: 10,
  recallMaxContentChars: 500,
  commitKeepRecentCount: 10,
  takeoverEnabled: true,
  captureToolResults: false,
  captureMode: "semantic",
  captureMaxLength: 24000,
  captureToolMaxChars: 100000,
  captureAssistantTurns: true,
  bypassPatterns: [],
  logLevel: "error",
};

function mockFetch() {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, init, body });
    const result = url.endsWith("/search/search")
      ? { memories: [{ uri: "viking://~/memories/project.md", context_type: "memory", score: 0.91, abstract: "Project uses TypeScript", level: 0, category: "project", match_reason: "semantic" }], resources: [], skills: [], total: 1 }
      : url.includes("/content/write")
        ? { uri: "viking://~/memories/project.md", root_uri: "viking://~/memories" }
        : url.includes("/commit")
        ? { task_id: "task-1", archive_uri: "viking://~/sessions/pi/history/archive_1" }
        : {};
    return new Response(JSON.stringify({ status: "ok", result }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

test("OpenViking provider exposes native capability matrix", () => {
  const provider = new OpenVikingProvider(new OVClient(config), config);
  assert.equal(provider.id, "openviking");
  assert.equal(provider.capabilities.uriRead, false);
  assert.equal(provider.capabilities.resourceIngest, false);
  assert.equal(provider.capabilities.contextTakeover, false);
  assert.equal(provider.nativeCapabilities.uriRead, true);
  assert.equal(provider.nativeCapabilities.contextTakeover, true);
  assert.equal(provider.capabilities.profileWrite, false);
});

test("OpenViking provider uses real search, message, and commit HTTP contracts", async () => {
  const mock = mockFetch();
  try {
    const provider = new OpenVikingProvider(new OVClient(config), config);
    const items = await provider.search("typescript", { limit: 5 });
    assert.equal(items[0].source, "viking://~/memories/project.md");
    const capture = await provider.capture("pi_session", [{ role: "user", content: "hello" }]);
    assert.equal(capture.accepted, true);
    const committed = await provider.commit("pi_session");
    assert.equal(committed.accepted, true);
    const remembered = await provider.remember("remember this decision", { sessionId: "pi_session" });
    const write = await new OVClient(config).writeContent("viking://~/memories/project.md", "updated", { mode: "replace", wait: true });
    assert.equal(write?.uri, "viking://~/memories/project.md");
    assert.equal(remembered.accepted, true);
    assert.equal(mock.calls[0].url, "https://example.invalid/api/v1/search/search");
    assert.deepEqual(mock.calls[0].body, { query: "typescript", mode: "context", max_tokens: 1600, purpose: "coding", limit: 5 });
    assert.equal(mock.calls[1].url, "https://example.invalid/api/v1/sessions/pi_session/messages");
    assert.deepEqual(mock.calls[1].body, { role: "user", content: "hello" });
    assert.equal(mock.calls[2].url, "https://example.invalid/api/v1/sessions/pi_session/commit");
    assert.deepEqual(mock.calls[2].body, { keep_recent_count: 10 });
    assert.equal(mock.calls[3].url, "https://example.invalid/api/v1/sessions/pi_session/messages");
    assert.deepEqual(mock.calls[3].body, { role: "user", content: "[Remember] remember this decision" });
    assert.equal(mock.calls[4].url, "https://example.invalid/api/v1/content/write");
    assert.deepEqual(mock.calls[4].body, { uri: "viking://~/memories/project.md", content: "updated", mode: "replace", wait: true });
  } finally { mock.restore(); }
});

test("OpenViking provider does not silently fake profile writes", async () => {
  const provider = new OpenVikingProvider(new OVClient(config), config);
  await assert.rejects(() => provider.updateProfile("profile"), /does not support/);
});
