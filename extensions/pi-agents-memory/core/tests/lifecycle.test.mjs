import test from "node:test";
import assert from "node:assert/strict";
import { decideMerge, isExpired, transition } from "../lifecycle.ts";

function record(overrides = {}) {
  return { kind: "decision", scope: "workspace", status: "active", confidence: "high", content: "use pnpm", owner: { tenantId: "local", workspaceId: "x" }, source: { observedAt: new Date().toISOString() }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), policyVersion: 1, ...overrides };
}

test("lifecycle transitions preserve audit metadata", () => {
  const next = transition(record(), "superseded", "new decision", "user");
  assert.equal(next.status, "superseded");
  assert.equal(next.metadata.transitionActor, "user");
});

test("merge policy distinguishes duplicate, supersede, conflict and episodic merge", () => {
  const base = record();
  assert.equal(decideMerge(base, base).decision, "skip");
  assert.equal(decideMerge(record({ content: "use npm" }), base).decision, "supersede");
  assert.equal(decideMerge(record({ confidence: "medium", content: "use bun" }), base).decision, "conflict");
  assert.equal(decideMerge(record({ kind: "event", content: "same event" }), record({ kind: "event", content: "old event" })).decision, "merge");
});

test("expiry is a soft lifecycle predicate", () => {
  assert.equal(isExpired(record({ validUntil: "2000-01-01T00:00:00Z" })), true);
  assert.equal(isExpired(record({ validUntil: null })), false);
});
