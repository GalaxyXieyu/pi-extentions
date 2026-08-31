import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileStatsProvider } from "../observability.ts";

test("audit writes sanitized JSONL when configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-audit-"));
  const file = join(dir, "audit.jsonl");
  const previous = process.env.PI_MEMORY_AUDIT_FILE;
  process.env.PI_MEMORY_AUDIT_FILE = file;
  try {
    const stats = new FileStatsProvider();
    const text = stats.audit("s1", [{ kind: "event", scope: "user", status: "candidate", confidence: "medium", content: "token=abcdefghijklmnop", owner: { tenantId: "local" }, source: { observedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policyVersion: 1 }]);
    assert.doesNotMatch(text, /abcdefghijklmnop/);
    const raw = await readFile(file, "utf8");
    assert.doesNotMatch(raw, /abcdefghijklmnop/);
  } finally {
    if (previous === undefined) delete process.env.PI_MEMORY_AUDIT_FILE;
    else process.env.PI_MEMORY_AUDIT_FILE = previous;
  }
});
