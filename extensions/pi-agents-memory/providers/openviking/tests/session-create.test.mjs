import test from "node:test";
import assert from "node:assert/strict";
import { SyncManager } from "../sync.ts";

const config = { commitTokenThreshold: 20000, commitKeepRecentCount: 10, captureAssistantTurns: true, captureToolMaxChars: 2000, captureMaxLength: 24000, takeoverEnabled: true };

test("ensureSession creates the remote OpenViking session before capture", async () => {
  const calls = [];
  const client = {
    createSession: async (id) => { calls.push(id); return true; },
    addMessagePayload: async () => true,
    commitSessionResponse: async () => ({ result: {} }),
    fetchJSON: async () => ({ ok: true, result: {} }),
  };
  const provider = {
    id: "openviking",
    capabilities: {},
    health: async () => true,
    recall: async () => ({ backend: "openviking", items: [], block: null }),
    capture: async () => ({ accepted: true, count: 1, backend: "openviking", delivered: true }),
    commit: async () => ({ accepted: true, count: 0, backend: "openviking" }),
    search: async () => [],
    remember: async () => ({ accepted: true, count: 1, backend: "openviking" }),
    updateProfile: async () => ({ accepted: false, count: 0, backend: "openviking" }),
    unsupported: () => { throw new Error("unsupported"); },
  };
  const sync = new SyncManager(client, config, provider);
  assert.equal(await sync.ensureSession("pi-session"), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^pi-/);
});
