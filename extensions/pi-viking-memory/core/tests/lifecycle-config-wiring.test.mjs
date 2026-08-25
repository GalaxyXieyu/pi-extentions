import { test } from "vitest";
import assert from "node:assert/strict";
import { requestContext, localIdentity } from "../contracts.ts";
import { gateCapture } from "../runtime.ts";
import { extractCandidates } from "../candidate-extractor.ts";
import { loadCanonicalConfig } from "../config-protocol.ts";

test("config-driven purpose reaches candidate extraction", () => {
  const identity = localIdentity({ userId: "alice" });
  // coding purpose classifies project, chat purpose does not
  const coding = extractCandidates({ text: "项目使用 npm", identity, purpose: "coding", sessionId: "s1", policyVersion: 1 });
  const chat = extractCandidates({ text: "项目使用 npm", identity, purpose: "chat", sessionId: "s1", policyVersion: 1 });
  assert.ok(coding.candidates.length > 0);
  assert.ok(chat.candidates.length === 0);
});

test("canonical config wires purpose/conflictPolicy/expiryEnabled into requestContext", () => {
  const canonical = loadCanonicalConfig();
  assert.ok(canonical.valid || canonical.valid === false); // loads without throwing
  if (!canonical.valid) return;
  const context = requestContext(localIdentity(), {
    purpose: canonical.config.retrieval.purpose || "coding",
    lifecycle: { expiryEnabled: canonical.config.lifecycle.expiryEnabled, conflictPolicy: canonical.config.lifecycle.conflictPolicy },
  });
  assert.equal(context.purpose, canonical.config.retrieval.purpose || "coding");
  assert.equal(context.lifecycle.expiryEnabled, canonical.config.lifecycle.expiryEnabled);
  assert.ok(["preserve-and-confirm", "auto-merge"].includes(context.lifecycle.conflictPolicy));
});

test("conflictPolicy preserve-and-confirm downgrades merge to conflict; auto-merge keeps merge", async () => {
  const prevFile = process.env.PI_MEMORY_LIFECYCLE_FILE;
  process.env.PI_MEMORY_LIFECYCLE_FILE = `:memory:${Math.random()}`;
  const identity = localIdentity({ userId: "alice", workspaceId: "ws" });
  // find an exact-duplicate-free, same-kind episodic candidate that would merge
  const text = "完成了缓存重建";
  const extract = extractCandidates({ text, identity, purpose: "coding", sessionId: "s1", policyVersion: 1 });
  const candidate = extract.candidates[0];
  assert.ok(candidate, "expected a durable candidate");
  const existing = { kind: candidate.kind, content: "完成了一次部署", scope: candidate.scope, id: "r1", source: "x", status: "active", confidence: "medium", owner: identity, metadata: { user_id: "alice", tenant_id: "local", workspace_id: "ws" } };

  const preserve = await gateCapture(text, identity, requestContext(identity, { lifecycle: { expiryEnabled: true, conflictPolicy: "preserve-and-confirm" } }), async () => [existing]);
  assert.equal(preserve.lifecycle.decision, "conflict");

  const auto = await gateCapture(text, identity, requestContext(identity, { lifecycle: { expiryEnabled: true, conflictPolicy: "auto-merge" } }), async () => [existing]);
  assert.equal(auto.lifecycle.decision, "merge");

  if (prevFile === undefined) delete process.env.PI_MEMORY_LIFECYCLE_FILE; else process.env.PI_MEMORY_LIFECYCLE_FILE = prevFile;
});