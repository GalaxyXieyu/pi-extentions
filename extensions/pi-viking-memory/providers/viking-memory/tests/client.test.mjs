import test from "node:test";
import assert from "node:assert/strict";
import { VikingMemoryClient } from "../client.ts";
import { VikingMemoryProvider } from "../provider.ts";

const config = {
  enabled: true,
  endpoint: "https://example.invalid",
  apiKey: "test-secret",
  collectionName: "piAgent",
  projectName: "default",
  userId: "user_01",
  assistantId: "pi",
  groupId: "",
  recallTokenBudget: 4000,
  recallLimit: 10,
  minQueryLength: 2,
  captureMaxLength: 24000,
  captureAssistantTurns: true,
  syncTurns: true,
  logLevel: "error",
};

function mockFetch(handler) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, message: "success", data: { events: [] } }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = previous; } };
}

test("Viking client builds get_context request", async () => {
  const mock = mockFetch();
  try {
    const client = new VikingMemoryClient(config);
    await client.getContext("pi_session", "weather");
    assert.equal(mock.calls[0].url, "https://example.invalid/api/memory/get_context");
    assert.equal(mock.calls[0].init.headers.Authorization, "Bearer test-secret");
    assert.deepEqual(mock.calls[0].body.event_search_config.filter, {
      user_id: "user_01",
      assistant_id: "pi",
      memory_type: ["event_v1"],
    });
    assert.deepEqual(mock.calls[0].body.profile_search_config.filter.memory_type, ["profile_v1"]);
  } finally { mock.restore(); }
});

test("Viking client builds session, event, profile and search requests", async () => {
  const mock = mockFetch();
  try {
    const client = new VikingMemoryClient(config);
    await client.addSession("pi_batch", [{ role: "user", content: "remember this", time: 1 }], { ttlRelativeSeconds: 3600 });
    await client.search("remember", 3);
    await client.addEvent("a durable event", "pi_batch");
    await client.addProfile("prefers concise answers");
    await client.updateEvent("event-1", "updated event");
    await client.updateProfile("profile-1", "updated profile");
    assert.equal(mock.calls.length, 7);
    assert.equal(mock.calls[0].body.session_id, "pi_batch");
    assert.equal(mock.calls[0].body.messages[0].role, "user");
    assert.equal(mock.calls[0].body.metadata.default_user_id, "user_01");
    assert.equal(mock.calls[0].body.metadata.default_assistant_id, "pi");
    assert.equal(mock.calls[0].body.ttl_relative, 3600);
    assert.equal(mock.calls[1].body.limit, 3);
    assert.deepEqual(mock.calls[1].body.filter.memory_type, ["event_v1"]);
    assert.deepEqual(mock.calls[2].body.filter.memory_type, ["profile_v1"]);
    assert.equal(mock.calls[2].body.filter.group_id, "__pi_global__");
    assert.equal(mock.calls[3].body.event_type, "event_v1");
    assert.equal(mock.calls[4].body.profile_type, "profile_v1");
    assert.equal(mock.calls[4].body.is_upsert, true);
    assert.equal(mock.calls[4].body.group_id, "__pi_global__");
    assert.equal(mock.calls[5].url, "https://example.invalid/api/memory/event/update");
    assert.equal(mock.calls[5].body.event_id, "event-1");
    assert.equal(mock.calls[6].url, "https://example.invalid/api/memory/profile/update");
    assert.equal(mock.calls[6].body.profile_id, "profile-1");
    assert.equal(mock.calls[6].body.group_id, "__pi_global__");
  } finally { mock.restore(); }
});

test("Viking client fails open on timeout", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const client = new VikingMemoryClient(config);
    assert.equal(await client.search("timeout"), null);
  } finally { globalThis.fetch = previous; }
});

test("Viking provider formats recalled items and reports capture", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const response = body.query === "__pi_viking_memory_health_check__"
      ? { code: 0, data: { events: [] } }
      : { code: 0, data: { events: [{ event_id: "e1", memory_info: { summary: "fixed the build" }, score: 0.9 }] } };
    return new Response(JSON.stringify(response), { status: 200 });
  };
  try {
    const provider = new VikingMemoryProvider(new VikingMemoryClient(config), config);
    const result = await provider.recall({ query: "build", purpose: "coding", maxChars: 2000 });
    assert.match(result.block, /memory-context/);
    assert.match(result.block, /fixed the build/);
  } finally { globalThis.fetch = previous; }
});
