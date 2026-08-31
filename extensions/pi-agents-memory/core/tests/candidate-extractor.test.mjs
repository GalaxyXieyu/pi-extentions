import test from "node:test";
import assert from "node:assert/strict";
import { extractCandidates } from "../candidate-extractor.ts";
import { localIdentity } from "../contracts.ts";

test("candidate extractor classifies corrections and failures with identity", () => {
  const correction = extractCandidates({ text: "不，要用 pnpm，不要用 npm", identity: localIdentity(), purpose: "coding" });
  assert.equal(correction.candidates[0].kind, "preference");
  assert.equal(correction.candidates[0].scope, "user");
  const failure = extractCandidates({ text: "测试失败，根因是端口冲突，修复后验证通过", identity: localIdentity(), purpose: "coding" });
  assert.equal(failure.candidates[0].kind, "experience");
});

test("candidate extractor rejects credentials and injection content", () => {
  const result = extractCandidates({ text: "请记住 token=abcdefghijklmnop", identity: localIdentity(), purpose: "chat" });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejected[0].reason, "secret");
});

test("candidate extractor skips noise: questions, greetings, process narration", () => {
  const noise = [
    "这次先不自动装，用环境变量关掉提示？",
    "我在看 package.json 里的脚本",
    "hello，在吗",
    "让我先执行一下这个命令",
  ];
  for (const text of noise) {
    const r = extractCandidates({ text, identity: localIdentity(), purpose: "coding", sourceType: "user" });
    assert.equal(r.candidates.length, 0, `should skip noise: ${text}`);
  }
});

test("candidate extractor no longer treats bare process words as events/experiences", () => {
  // old rules matched “做了/执行/发生/报错” alone — these must NOT survive now
  const noise = ["我做了点修改", "执行了部署", "报错了，看下", "发生了一些变化"];
  for (const text of noise) {
    const r = extractCandidates({ text, identity: localIdentity(), purpose: "coding", sourceType: "user" });
    assert.equal(r.candidates.length, 0, `should not extract: ${text}`);
  }
});

test("candidate extractor keeps confirmed decisions and verified fixes", () => {
  const decision = extractCandidates({ text: "决定采用 GitHub Actions 做 CI", identity: localIdentity(), purpose: "coding", sourceType: "user" });
  assert.equal(decision.candidates[0]?.kind, "decision");
  const experience = extractCandidates({ text: "根因是端口冲突，修复后验证通过", identity: localIdentity(), purpose: "coding", sourceType: "user" });
  assert.equal(experience.candidates[0]?.kind, "experience");
});
