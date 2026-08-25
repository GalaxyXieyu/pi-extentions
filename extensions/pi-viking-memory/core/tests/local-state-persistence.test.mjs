import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LifecycleStore } from "../lifecycle-store.ts";
import { FileStatsProvider } from "../observability.ts";

function record() { return { kind: "event", scope: "user", status: "active", confidence: "medium", content: "completed integration", owner: { tenantId: "local", userId: "alice" }, source: { observedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policyVersion: 1 }; }

test("lifecycle and stats default persistence survive reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-state-"));
  const ledgerPath = join(dir, "lifecycle.json");
  const statsPath = join(dir, "events.jsonl");
  const store = new LifecycleStore(ledgerPath);
  store.upsert("local|alice|workspace|event|user|completed integration", record(), "remote-1", "created");
  const stats = new FileStatsProvider(statsPath);
  stats.record({ type: "write", backend: "runtime", operation: "test" });
  const reloaded = new LifecycleStore(ledgerPath);
  assert.equal(reloaded.find("local|alice|workspace|event|user|completed integration")?.remoteId, "remote-1");
  const rawStats = await readFile(statsPath, "utf8");
  assert.match(rawStats, /"type":"write"/);
});
