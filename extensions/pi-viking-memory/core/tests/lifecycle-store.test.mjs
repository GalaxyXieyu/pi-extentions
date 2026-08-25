import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LifecycleStore, lifecycleFingerprint } from "../lifecycle-store.ts";

function record(overrides = {}) { return { kind: "project", scope: "workspace", status: "active", confidence: "high", content: "use pnpm", owner: { tenantId: "local", userId: "alice", workspaceId: "p" }, source: { observedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policyVersion: 1, ...overrides }; }

test("lifecycle store persists supersede and expiry metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-lifecycle-"));
  const path = join(dir, "ledger.json");
  const store = new LifecycleStore(path);
  const first = record();
  const key = lifecycleFingerprint(first);
  store.upsert(key, first, "remote-old", "created");
  store.transition(key, "superseded", "new record", "remote-new");
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.entries[0].record.status, "superseded");
  assert.equal(raw.entries[0].history[1].targetId, "remote-new");
});
