import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryCardRenderer, normalizeMemoryCardView } from "../tui/output-view.ts";

test("normalizeMemoryCardView adapts a memory search result array", () => {
  const view = normalizeMemoryCardView({
    content: [{ type: "text", text: "[]" }],
    details: {
      results: [
        { kind: "event", content: "项目使用 pnpm", score: 0.9 },
        { kind: "profile", content: "喜欢简洁回答", score: 0.6 },
      ],
    },
  });
  assert.equal(view.status, "success");
  assert.match(view.summary, /Found 2 memories/);
  assert.match(view.expandedText, /项目使用 pnpm/);
});

test("normalizeMemoryCardView flags failures and falls back to reason", () => {
  const failure = normalizeMemoryCardView({ content: [{ type: "text", text: "oops" }], isError: true, details: { error: "backend down" } });
  assert.equal(failure.status, "failure");
  assert.equal(failure.summary, "backend down");
  const empty = normalizeMemoryCardView({ content: [{ type: "text", text: "No results found." }] });
  assert.equal(empty.status, "success"); // successful but empty text => success summary
});

test("renderer produces a renderable, expandable component", () => {
  const render = createMemoryCardRenderer();
  const component = render(
    { content: [{ type: "text", text: JSON.stringify([{ kind: "event", content: "x", score: 0.5 }], null, 2) }], details: { results: [{ kind: "event", content: "x", score: 0.5 }] } },
    { expanded: false },
    {},
    {},
  );
  assert.equal(typeof component.render, "function");
  const lines = component.render(100);
  assert.ok(lines.length >= 1);
  assert.match(lines[0], /Found 1 memory/);

  // expanded path returns a Text component with a render method
  const expanded = render({}, { expanded: true }, {}, {});
  assert.equal(typeof expanded.render, "function");
});