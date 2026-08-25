import { test } from "vitest";
import assert from "node:assert/strict";
import { formatRecall, injectRecall, stripMemoryContext } from "../format.ts";

const result = {
  backend: "viking-memory",
  items: [
    { kind: "project", content: "Use npm test", source: "file:README.md", score: 0.9, scope: "project" },
    { kind: "project", content: "Use npm test", source: "file:README.md", score: 0.9, scope: "project" },
  ],
};

test("formatRecall adds provenance, budget and deduplicates", () => {
  const block = formatRecall({ ...result, maxChars: 1000 });
  assert.match(block, /backend="viking-memory"/);
  assert.match(block, /kind=project/);
  assert.match(block, /source=file:README.md/);
  assert.equal((block.match(/Use npm test/g) || []).length, 1);
});

test("injectRecall adds one block and does not duplicate", () => {
  const block = formatRecall(result);
  const messages = [{ role: "user", content: "run tests" }];
  injectRecall(messages, block);
  injectRecall(messages, block);
  assert.equal((messages[0].content.match(/<memory-context/g) || []).length, 1);
});

test("stripMemoryContext prevents recall pollution", () => {
  assert.equal(stripMemoryContext('<memory-context>secret context</memory-context>hello'), "hello");
  assert.equal(stripMemoryContext('<viking-memory-context>old</viking-memory-context>next'), "next");
});
