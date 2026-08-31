import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listSessionFiles,
  readTranscript,
  readTranscriptWindow,
  chunkMessages,
  isProcessed,
  markProcessed,
  resumeOffset,
  loadNightlyState,
  saveNightlyState,
  runNightlySweep,
  piSessionsDir,
} from "../nightly.ts";
import { inlineLlmEnabled, llmExtractionEnabled } from "../llm-extractor.ts";
import { requestContext, localIdentity } from "../contracts.ts";

function fixture() {
  const root = join(tmpdir(), `pi-nightly-${Math.random().toString(36).slice(2, 8)}`);
  const workspace = join(root, "--private-tmp-proj--");
  mkdirSync(workspace, { recursive: true });
  const transcript = [
    { type: "session", version: 3, id: "sess-1", timestamp: new Date().toISOString(), cwd: "/private/tmp/proj" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "这套工具链太折腾了，新的一套顺手很多" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "note" }, { type: "text", text: "收到，后面用 pnpm workspace。" }, { type: "toolCall", name: "bash" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "command output noise" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "<memory-context backend=\"x\">\n- 旧记忆\n</memory-context>\n请把测试命令记下来" }] } },
    { type: "model_change", provider: "taqu" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
  const path = join(workspace, "2026-08-31T00-00-00-000Z_sess-1.jsonl");
  writeFileSync(path, transcript);
  return { root, path };
}

test("session-inline LLM is off by default, master switch still on", () => {
  delete process.env.PI_MEMORY_LLM_INLINE;
  delete process.env.PI_MEMORY_LLM_ENABLED;
  assert.equal(inlineLlmEnabled(), false, "no in-session model calls by default");
  assert.equal(llmExtractionEnabled(), true, "nightly sweep keeps the LLM path available");
  process.env.PI_MEMORY_LLM_INLINE = "1";
  assert.equal(inlineLlmEnabled(), true);
  process.env.PI_MEMORY_LLM_ENABLED = "0";
  assert.equal(inlineLlmEnabled(), false);
  assert.equal(llmExtractionEnabled(), false);
  delete process.env.PI_MEMORY_LLM_INLINE;
  delete process.env.PI_MEMORY_LLM_ENABLED;
});

test("listSessionFiles finds top-level transcripts with their real cwd", () => {
  const { root } = fixture();
  const files = listSessionFiles({ root, cutoffMs: 0 });
  assert.equal(files.length, 1);
  assert.equal(files[0].cwd, "/private/tmp/proj");
  assert.equal(files[0].sessionId, "2026-08-31T00-00-00-000Z_sess-1");
  assert.equal(listSessionFiles({ root: join(root, "missing"), cutoffMs: 0 }).length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("cutoff filters old transcripts", () => {
  const { root } = fixture();
  assert.equal(listSessionFiles({ root, cutoffMs: Date.now() + 10_000 }).length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("readTranscript keeps user/assistant text only and strips recall blocks", () => {
  const { path } = fixture();
  const messages = readTranscript(path);
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.ok(!messages.some((m) => m.content.includes("command output noise")));
  assert.ok(!messages.some((m) => m.content.includes("memory-context")));
  assert.ok(messages[2].content.startsWith("请把测试命令记下来"));
  assert.equal(readTranscript(path, { assistant: false }).map((m) => m.role).join(","), "user,user");
  rmSync(join(path, "..", ".."), { recursive: true, force: true });
});

test("chunkMessages respects the character budget", () => {
  const messages = Array.from({ length: 6 }, (_, i) => ({ role: "user", content: "x".repeat(100) + i }));
  const batches = chunkMessages(messages, 250);
  assert.ok(batches.length >= 3);
  for (const batch of batches) assert.ok(batch.reduce((n, m) => n + m.content.length, 0) <= 250);
  assert.equal(chunkMessages([], 100).length, 0);
});

test("watermark skips files already processed at the same size/mtime", () => {
  const { root, path } = fixture();
  const file = listSessionFiles({ root, cutoffMs: 0 })[0];
  const state = loadNightlyState(join(root, "state.json"));
  assert.equal(isProcessed(state, file), false);
  markProcessed(state, file, 2);
  assert.equal(isProcessed(state, file), true);
  saveNightlyState(state, join(root, "state.json"));
  assert.equal(isProcessed(loadNightlyState(join(root, "state.json")), file), true);
  assert.equal(isProcessed(loadNightlyState(join(root, "state.json")), { ...file, size: file.size + 1 }), false);
  void path;
  rmSync(root, { recursive: true, force: true });
});

test("runNightlySweep curates once and skips on the second pass", async () => {
  const { root } = fixture();
  const stateFile = join(root, "state.json");
  const identity = localIdentity({ userId: "u1", workspaceId: "ws-proj" });
  const context = requestContext(identity);
  const calls = [];
  const options = {
    root,
    stateFile,
    contextFor: () => context,
    curate: async (batch, sessionId) => { calls.push({ size: batch.length, sessionId }); return { handled: true, count: 1, rejected: 0 }; },
  };
  const first = await runNightlySweep(options);
  assert.equal(first.scanned, 1);
  assert.equal(first.processed, 1);
  assert.equal(first.memories, 1);
  assert.equal(first.workspaces.includes("ws-proj"), true);
  assert.ok(calls[0].sessionId.startsWith("nightly_"));

  const second = await runNightlySweep(options);
  assert.equal(second.skipped, 1);
  assert.equal(second.batches, 0);
  assert.equal(calls.length, 1, "already-curated transcript is not re-sent");
  rmSync(root, { recursive: true, force: true });
});

test("runNightlySweep leaves the watermark alone when the model is unavailable", async () => {
  const { root } = fixture();
  const stateFile = join(root, "state.json");
  const context = requestContext(localIdentity({ userId: "u1", workspaceId: "ws-proj" }));
  const sweep = () => runNightlySweep({
    root, stateFile, contextFor: () => context,
    curate: async () => ({ handled: false, count: 0, rejected: 0 }),
  });
  const first = await sweep();
  assert.equal(first.errors.length, 1);
  assert.equal(Object.keys(loadNightlyState(stateFile).files).length, 0, "failed batch is retried, not marked done");
  const retry = await sweep();
  assert.equal(retry.batches >= 1, true, "retry happens on the next run");
  rmSync(root, { recursive: true, force: true });
});

test("dry run reports without touching the watermark", async () => {
  const { root } = fixture();
  const stateFile = join(root, "state.json");
  const context = requestContext(localIdentity({ userId: "u1", workspaceId: "ws-proj" }));
  const report = await runNightlySweep({
    root, stateFile, dryRun: true, contextFor: () => context,
    curate: async () => ({ handled: true, count: 5, rejected: 0 }),
  });
  assert.equal(report.processed, 1);
  assert.equal(existsSync(stateFile), false, "dry run never writes the watermark");
  rmSync(root, { recursive: true, force: true });
});

test("piSessionsDir honours PI_MEMORY_SESSIONS_DIR", () => {
  process.env.PI_MEMORY_SESSIONS_DIR = "/tmp/custom-sessions";
  assert.equal(piSessionsDir(), "/tmp/custom-sessions");
  delete process.env.PI_MEMORY_SESSIONS_DIR;
  assert.ok(piSessionsDir({ HOME: "/Users/x" }).endsWith(join(".pi", "agent", "sessions")));
});

// ---------------------------------------------------------------- streaming

/** A long session: many turns interleaved with fat tool results. */
function longFixture(turns = 40) {
  const root = join(tmpdir(), `pi-nightly-long-${Math.random().toString(36).slice(2, 8)}`);
  const workspace = join(root, "--private-tmp-long--");
  mkdirSync(workspace, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id: "sess-long", timestamp: new Date().toISOString(), cwd: "/private/tmp/long" })];
  for (let i = 0; i < turns; i++) {
    lines.push(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `第 ${i} 轮：这条需求要求一个可跨夜续跑的分窗读取器` }] } }));
    lines.push(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "text", text: `处理完毕 ${i}，已写入布局说明` }] } }));
    lines.push(JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(20000) }] } }));
  }
  const path = join(workspace, "2026-08-31T00-00-00-000Z_sess-long.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return { root, path };
}

test("readTranscriptWindow streams windows from a byte offset without losing or repeating lines", () => {
  const { root, path } = longFixture(30);
  const first = readTranscriptWindow(path, { maxChars: 200 });
  assert.equal(first.done, false);
  assert.ok(first.nextOffset < first.size);
  assert.ok(first.messages.length > 0);
  const second = readTranscriptWindow(path, { maxChars: 200, offset: first.nextOffset });
  assert.equal(second.done, false, "the middle of the session is still ahead");
  const streamed = [...first.messages, ...second.messages];
  let offset = second.nextOffset;
  while (true) {
    const window = readTranscriptWindow(path, { maxChars: 200, offset });
    streamed.push(...window.messages);
    offset = window.nextOffset;
    if (window.done) break;
  }
  const whole = readTranscript(path);
  assert.equal(streamed.length, whole.length, "windows tile the transcript exactly");
  assert.equal(offset, whole.length ? statSize(join(root, "--private-tmp-long--", "2026-08-31T00-00-00-000Z_sess-long.jsonl")) : offset);
  assert.equal(streamed.map((m) => m.content).join("|"), whole.map((m) => m.content).join("|"));
  rmSync(root, { recursive: true, force: true });
});

function statSize(path) {
  return statSync(path).size;
}

test("readTranscriptWindow skips tool results on the raw bytes and caps oversized lines", () => {
  const { root, path } = longFixture(3);
  const window = readTranscriptWindow(path, { maxChars: 100000 });
  assert.equal(window.messages.length, 6, "only user/assistant text survives");
  assert.ok(!window.messages.some((m) => m.content.startsWith("yyy")), "tool result payloads never reach the curator");

  // One giant assistant line (base64 blob, huge diff) is counted, not parsed.
  const fat = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "z".repeat(50000) }] } });
  writeFileSync(path, `${readFileSync(path, "utf8").trimEnd()}\n${fat}\n`);
  const capped = readTranscriptWindow(path, { maxChars: 100000, maxLineBytes: 1024 });
  assert.equal(capped.oversize, 1, "oversized line is skipped by byte budget");
  assert.equal(capped.messages.length, 6);
  assert.ok(capped.messages.every((m) => m.content.length <= 2400));
  rmSync(root, { recursive: true, force: true });
});

test("the sweep resumes a long session from its cursor instead of restarting", async () => {
  const { root, path } = longFixture(8);
  const stateFile = join(root, "state.json");
  const context = requestContext(localIdentity({ userId: "u1", workspaceId: "ws-long" }));
  const seen = [];
  const options = {
    root,
    stateFile,
    windowChars: 120,
    maxWindowsPerFile: 1,
    contextFor: () => context,
    curate: async (batch) => { seen.push(...batch); return { handled: true, count: 1, rejected: 0 }; },
  };

  const first = await runNightlySweep(options);
  assert.equal(first.processed, 0, "window budget hit: the file is not finished");
  assert.equal(first.windows, 1);
  const afterFirst = loadNightlyState(stateFile);
  const entry = Object.values(afterFirst.files)[0];
  assert.ok(entry.offset > 0 && entry.offset < entry.size, "cursor saved mid-file");
  const file = listSessionFiles({ root, cutoffMs: 0 })[0];
  assert.equal(isProcessed(afterFirst, file), false);
  assert.equal(resumeOffset(afterFirst, file), entry.offset);

  let runs = 1;
  let report = first;
  while (!report.processed && runs < 20) { report = await runNightlySweep(options); runs++; }
  assert.equal(report.processed, 1, "the cursor converges to EOF");
  assert.ok(runs >= 3, `跨 ${runs} 次运行才跑完`);
  assert.equal(report.resumed, 1, "每一轮都是从游标接着读，不是重来");

  const expected = readTranscript(path);
  assert.equal(seen.length, expected.length, "every message curated exactly once across the runs");
  assert.equal(seen.map((m) => m.content).join("|"), expected.map((m) => m.content).join("|"));
  rmSync(root, { recursive: true, force: true });
});

test("a session that keeps growing only pays for its new tail", async () => {
  const { root, path } = longFixture(4);
  const stateFile = join(root, "state.json");
  const context = requestContext(localIdentity({ userId: "u1", workspaceId: "ws-long" }));
  const firstPass = [];
  const first = await runNightlySweep({
    root, stateFile, contextFor: () => context,
    curate: async (batch) => { firstPass.push(...batch); return { handled: true, count: 0, rejected: 0 }; },
  });
  assert.equal(first.processed, 1);
  assert.ok(firstPass.length >= 6, `首轮读到全部 ${firstPass.length} 条`);

  // Same file, more turns appended.
  const lines = readFileSync(path, "utf8").trimEnd();
  const appended = [400, 401].map((i) => JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: `补充决定 ${i}：以后都用 pnpm workspace 布局` }] } }));
  writeFileSync(path, `${lines}\n${appended.join("\n")}\n`);

  const secondPass = [];
  const second = await runNightlySweep({
    root, stateFile, contextFor: () => context,
    curate: async (batch) => { secondPass.push(...batch); return { handled: true, count: 0, rejected: 0 }; },
  });
  assert.equal(second.resumed, 1);
  assert.equal(second.skipped, 0, "grown file is re-read, not skipped");
  assert.equal(secondPass.length, 2, `只送新增的尾巴（实际 ${secondPass.length} 条）`);
  assert.ok(secondPass.every((m) => m.content.includes("补充决定")));
  rmSync(root, { recursive: true, force: true });
});

test("failed window keeps the cursor so the next run retries it", async () => {
  const { root } = longFixture(20);
  const stateFile = join(root, "state.json");
  const context = requestContext(localIdentity({ userId: "u1", workspaceId: "ws-long" }));
  const options = {
    root, stateFile, windowChars: 120, maxWindowsPerFile: 1, contextFor: () => context,
    curate: async () => ({ handled: false, count: 0, rejected: 0 }),
  };
  const first = await runNightlySweep(options);
  assert.equal(first.errors.length, 1);
  assert.equal(Object.keys(loadNightlyState(stateFile).files).length, 0, "失败的那扇窗口不写游标");
  const retry = await runNightlySweep({ ...options, curate: async () => ({ handled: true, count: 1, rejected: 0 }) });
  assert.equal(retry.resumed, 0, "游标还在 0，所以是从头重试而不是跳过");
  assert.ok(retry.memories >= 1);
  rmSync(root, { recursive: true, force: true });
});

