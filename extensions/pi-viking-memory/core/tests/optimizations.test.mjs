import test from "node:test";
import assert from "node:assert/strict";
import { rerankRecall } from "../recall-rerank.ts";
import { diceSimilarity, consolidateLocal } from "../consolidation.ts";
import { localIdentity } from "../contracts.ts";
import { getLifecycleStore, lifecycleFingerprint } from "../lifecycle-store.ts";
import { CurationQueue } from "../curation-queue.ts";
import { extractCandidates } from "../candidate-extractor.ts";

test("rerankRecall boosts recent items for current-time queries", () => {
  const items = [
    { id: "old", kind: "project", content: "项目使用 npm", score: 0.9, timestamp: "2024-01-05T00:00:00Z", metadata: {} },
    { id: "new", kind: "project", content: "项目使用 pnpm", score: 0.9, timestamp: "2026-08-01T00:00:00Z", metadata: {} },
  ];
  const nowQ = rerankRecall(structuredClone(items), "项目现在用的什么包管理器");
  assert.equal(nowQ[0].id, "new");
  const pastQ = rerankRecall(structuredClone(items), "项目当时用的什么包管理器");
  assert.equal(pastQ[0].id, "old");
});

test("rerankRecall without temporal intent keeps order", () => {
  const items = [
    { id: "a", kind: "project", content: "x", score: 0.8, timestamp: "2020-01-01T00:00:00Z", metadata: {} },
    { id: "b", kind: "project", content: "y", score: 0.5, timestamp: "2026-01-01T00:00:00Z", metadata: {} },
  ];
  assert.deepEqual(rerankRecall(items, "重构计划是什么"), items);
});

test("correction signals classify as high-confidence preference", () => {
  const result = extractCandidates({
    text: "不对，项目现在不用 npm 了，改成 pnpm",
    identity: localIdentity({ userId: "u1", workspaceId: "ws" }),
    purpose: "coding",
    sourceType: "user",
    sessionId: "s1",
    policyVersion: 1,
  });
  assert.equal(result.candidates[0]?.kind, "preference");
  assert.equal(result.candidates[0]?.confidence, "high");
});

test("implicit preference phrasing is a rule miss (long tail for LLM)", () => {
  const result = extractCandidates({
    text: "这套工具链太折腾了，新的一套顺手很多",
    identity: localIdentity({ userId: "u1", workspaceId: "ws" }),
    purpose: "coding",
    sourceType: "user",
    sessionId: "s1",
    policyVersion: 1,
  });
  assert.equal(result.candidates.length, 0);
});

test("agent-inferred content gets medium confidence without explicit markers", () => {
  const agent = extractCandidates({
    text: "架构上这块采用事件溯源模式", identity: localIdentity({ userId: "u1" }), purpose: "coding",
    sourceType: "agent", sessionId: "s", policyVersion: 1,
  });
  assert.equal(agent.candidates[0]?.kind, "decision");
  assert.equal(agent.candidates[0]?.confidence, "medium");
  const user = extractCandidates({
    text: "架构上这块采用事件溯源模式", identity: localIdentity({ userId: "u1" }), purpose: "coding",
    sourceType: "user", sessionId: "s", policyVersion: 1,
  });
  assert.equal(user.candidates[0]?.confidence, "high");
});

test("diceSimilarity measures near-duplicate facts", () => {
  assert.ok(diceSimilarity("项目使用 pnpm 作为包管理器", "项目使用 pnpm 管理依赖") > 0.5);
  assert.ok(diceSimilarity("今天下雨", "今天不下雨") < 0.5 || diceSimilarity("今天下雨", "部署到生产环境") < 0.1);
  assert.equal(diceSimilarity("a", "aa"), 0);
});

test("consolidation promotes near-duplicate active records to pending_review", () => {
  const store = getLifecycleStore();
  const now = new Date().toISOString();
  const mk = (content) => ({
    kind: "project", scope: "workspace", status: "active", confidence: "medium", content,
    owner: { tenantId: "local", userId: "u1", workspaceId: "ws" },
    source: { observedAt: now }, createdAt: now, updatedAt: now, policyVersion: 1,
  });
  const r1 = mk("项目使用 pnpm 作为包管理器");
  const r2 = mk("项目使用 pnpm 管理依赖，通过 lockfile 锁定");
  store.upsert(lifecycleFingerprint(r1), r1, "remote-a", "remote-create");
  store.upsert(lifecycleFingerprint(r2), r2, "remote-b", "remote-create");

  const findings = consolidateLocal(localIdentity({ userId: "u1", workspaceId: "ws" }), 0.4);
  assert.ok(findings.length >= 1);
  assert.equal(findings[0].suggestion, "conflict");
  assert.equal(findings[0].promoted, true);
  const pending = store.all().filter((e) => e.record.status === "pending_review");
  assert.ok(pending.length >= 1);
});

test("curation queue enqueues, thresholds on count, and requeues bounded", () => {
  process.env.PI_MEMORY_LLM_BATCH_COUNT = "2";
  const q = new CurationQueue();
  q.enqueue({ role: "user", content: "a" });
  assert.equal(q.shouldFlush(), false);
  q.enqueue({ role: "user", content: "b" });
  assert.equal(q.shouldFlush(), true);
  const batch = q.takeBatch();
  assert.equal(batch.length, 2);
  assert.equal(q.size, 0);
  q.requeue(batch, 3);
  assert.equal(q.size, 0); // max attempts reached
  delete process.env.PI_MEMORY_LLM_BATCH_COUNT;
});
test("llm-extractor uses pilot complete hook instead of fetch", async () => {
  process.env.PI_MEMORY_LLM_ENABLED = "1";
  delete process.env.PI_MEMORY_LLM_URL;
  const { extractMemories } = await import("../llm-extractor.ts");
  let called = 0;
  const result = await extractMemories({
    endpoint: "http://127.0.0.1:1/v1", // must not be hit
    model: "unused",
    newBatch: [{ role: "user", content: "这套工具链太折腾了，新的顺手很多" }],
    existingMemories: [],
    complete: async (messages) => {
      called++;
      const system = messages.find((m) => m.role === "system")?.content || "";
      const user = messages.find((m) => m.role === "user")?.content || "";
      assert.ok(system.includes("memory curator"));
      assert.ok(user.includes("这套工具链"));
      return JSON.stringify({ memories: [{ action: "add", text: "偏好轻量工具链", kind: "preference", scope: "user", confidence: 0.8 }] });
    },
  });
  assert.equal(called, 1);
  assert.equal(result.ok, true);
  assert.equal(result.memories[0].text, "偏好轻量工具链");
  assert.equal(result.memories[0].kind, "preference");
  delete process.env.PI_MEMORY_LLM_ENABLED;
});

test("llm funnel enabled without endpoint/pilot falls back to rules", async () => {
  process.env.PI_MEMORY_LLM_ENABLED = "1";
  delete process.env.PI_MEMORY_LLM_URL;
  const { curateWithLlm } = await import("../runtime.ts");
  const { localIdentity, requestContext } = await import("../contracts.ts");
  const identity = localIdentity({ userId: "u1" });
  const result = await curateWithLlm(
    [{ role: "user", content: "测试" }],
    identity,
    requestContext(identity),
    async () => [],
    undefined,
  );
  assert.equal(result.handled, false);
  delete process.env.PI_MEMORY_LLM_ENABLED;
});

test("conflict arbiter parses LLM relations and falls back to null", async () => {
  const { parseArbitration, makeConflictArbiter } = await import("../conflict-arbiter.ts");
  const ok = parseArbitration('{"relation":"supersede","confidence":0.9,"reason":"x","target_id":"m1"}');
  assert.equal(ok?.relation, "supersede");
  assert.equal(ok?.confidence, 0.9);
  assert.equal(parseArbitration('not-json'), null);
  assert.equal(parseArbitration('{"relation":"maybe"}'), null);

  const noLlm = makeConflictArbiter(null);
  assert.equal(await noLlm("x", []), null);
  const failing = makeConflictArbiter(async () => { throw new Error("boom"); });
  assert.equal(await failing("x", []) , null);
});

test("conflict arbiter parses LLM relations and falls back safely", async () => {
  const { parseArbitration, makeConflictArbiter } = await import("../conflict-arbiter.ts");
  assert.deepEqual(parseArbitration('{"relation":"supersede","confidence":0.9,"target_id":"m1"}').relation, "supersede");
  assert.equal(parseArbitration('```json\n{"relation":"duplicate","confidence":0.8}\n```').relation, "duplicate");
  assert.equal(parseArbitration("not json"), null);
  assert.equal(parseArbitration('{"relation":"maybe","confidence":0.9}'), null);

  const nullArbiter = makeConflictArbiter(null);
  assert.equal(await nullArbiter("x", []), null);
  const failingArbiter = makeConflictArbiter(async () => { throw new Error("boom"); });
  assert.equal(await failingArbiter("x", []), null);
});


test("arbitration is triggered after rules flag a conflict", async () => {
  process.env.PI_MEMORY_LIFECYCLE_FILE = ":memory:" + Math.random();
  const { gateCapture } = await import("../runtime.ts");
  const { localIdentity, requestContext } = await import("../contracts.ts");
  const identity = localIdentity({ userId: "u1", workspaceId: "ws" });
  const ctx = requestContext(identity);
  // existing 与候选同 kind=preference、同 scope=user，内容不同 -> 规则层 high+active -> supersede -> preserve-and-confirm -> conflict
  const existing = [{ id: "m1", kind: "decision", scope: "workspace", content: "我们决定包管理用 npm", metadata: { user_id: "u1", tenant_id: "local", workspace_id: "ws", status: "active" } }];
  const run = (relation, conf = 0.9) => gateCapture(
    "我们决定包管理用 pnpm", identity, ctx, async () => existing, "user",
    async () => ({ relation, confidence: conf }),
  );
  assert.equal((await run("supplement")).lifecycle?.decision, "merge");
  assert.equal((await run("duplicate")).lifecycle?.decision, "skip");
  assert.equal((await run("unrelated")).lifecycle?.decision, "create");
  assert.equal((await run("supersede", 0.8)).lifecycle?.decision, "supersede");
  assert.equal((await run("supersede", 0.3)).lifecycle?.decision, "conflict");
  assert.equal((await run("conflict")).lifecycle?.decision, "conflict");
  // 返回 null 的 arbiter 回退规则
  assert.equal((await gateCapture("我们决定包管理用 pnpm", identity, ctx, async () => existing, "user", async () => null)).lifecycle?.decision, "conflict");
  delete process.env.PI_MEMORY_LIFECYCLE_FILE;
});
