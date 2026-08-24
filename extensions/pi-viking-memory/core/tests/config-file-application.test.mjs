import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCanonicalConfig } from "../config-protocol.ts";

test("versioned config file applies nested settings and revision", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-config-file-"));
  const path = join(dir, "memory.json");
  await writeFile(path, JSON.stringify({
    schemaVersion: 1,
    revision: "config-v7",
    backend: "viking-memory",
    source: "file",
    identity: { tenantId: "tenant-a", userId: "alice", workspaceId: "workspace-a", agentId: "coding-agent", source: "local" },
    retrieval: { purpose: "chat", limit: 7, maxChars: 9000, minQueryLength: 4, scoreThreshold: 0.7, queryExpansion: false },
    capture: { enabled: false, assistantTurns: false, toolResults: true, maxLength: 900 },
    lifecycle: { expiryEnabled: false, consolidationEnabled: true, conflictPolicy: "auto-merge" },
    ui: { cards: { enabled: false, hint: false, partialPrefix: "Working", maxSummary: 72 } },
  }));
  try {
    const result = loadCanonicalConfig({ MEMORY_CONFIG_FILE: path });
    assert.equal(result.valid, true);
    assert.equal(result.config.source, "file");
    assert.equal(result.config.revision, "config-v7");
    assert.equal(result.config.identity.userId, "alice");
    assert.equal(result.config.retrieval.limit, 7);
    assert.equal(result.config.retrieval.purpose, "chat");
    assert.equal(result.config.capture.enabled, false);
    assert.equal(result.config.lifecycle.conflictPolicy, "auto-merge");
    assert.equal(result.config.ui.cards.enabled, false);
    assert.equal(result.config.ui.cards.hint, false);
    assert.equal(result.config.ui.cards.partialPrefix, "Working");
    assert.equal(result.config.ui.cards.maxSummary, 72);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
