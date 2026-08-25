import { test } from "vitest";
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
