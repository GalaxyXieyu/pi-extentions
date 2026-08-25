import { test } from "vitest";
import assert from "node:assert/strict";
import { MemoryPolicyEngine } from "../policy-engine.ts";

const policy = {
  version: 1,
  candidateSchema: {},
  common: {},
  purposes: {
    coding: { priority: ["project", "decision", "experience"], quotas: { project: 1, decision: 1 } },
    chat: { priority: ["profile", "event"], quotas: { profile: 2 } },
  },
  kinds: {},
  codingExtractionPrompt: "coding",
  chatExtractionPrompt: "chat",
};

test("policy engine filters status/confidence/expiry and applies priority quotas", () => {
  const engine = new MemoryPolicyEngine(policy);
  const result = engine.selectRecall([
    { kind: "experience", content: "late", score: 0.99 },
    { kind: "project", content: "project high", score: 0.4 },
    { kind: "project", content: "project second", score: 0.99 },
    { kind: "decision", content: "decision", score: 0.2 },
    { kind: "event", content: "expired", score: 1, metadata: { status: "expired" } },
    { kind: "project", content: "low confidence", score: 1, metadata: { confidence: "low" } },
    { kind: "decision", content: "valid old", score: 1, metadata: { valid_until: "2000-01-01T00:00:00Z" } },
  ], "coding");
  assert.deepEqual(result.items.map((item) => item.content), ["project second", "decision", "late"]);
  assert.equal(result.dropped, 4);
});
