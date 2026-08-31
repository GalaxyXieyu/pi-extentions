import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enqueue, listPending } from "../shared/pending-queue.mjs";

test("pending queue redacts payloads and uses owner-only permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ov-pending-security-"));
  const previous = process.env.OPENVIKING_PENDING_DIR;
  process.env.OPENVIKING_PENDING_DIR = dir;
  try {
    await enqueue("addMessage", "session-secret", { role: "user", content: "token=abcdefghijklmnop password=hunter2" });
    const entries = await listPending();
    assert.equal(entries.length, 1);
    assert.doesNotMatch(JSON.stringify(entries[0].entry), /abcdefghijklmnop|hunter2/);
    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const fileStat = await stat(join(dir, files[0]));
    assert.equal(fileStat.mode & 0o077, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = previous;
  }
});
