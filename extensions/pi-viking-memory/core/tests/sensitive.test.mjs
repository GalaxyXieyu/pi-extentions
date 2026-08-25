import { test } from "vitest";
import assert from "node:assert/strict";
import { sanitizeSensitiveText, sanitizeSensitiveValue } from "../sensitive.mjs";

test("sensitive sanitizer redacts common credentials", () => {
  const text = "Authorization: Bearer abcdefghijklmnop api_key=secret-value password: hunter2 OPENAI_API_KEY=sk-real-value";
  const safe = sanitizeSensitiveText(text);
  assert.doesNotMatch(safe, /abcdefghijklmnop|secret-value|hunter2|sk-real-value/);
  assert.match(safe, /REDACTED_SECRET/);
});

test("sensitive sanitizer handles structured tool parts", () => {
  const safe = sanitizeSensitiveValue({ input: { token: "abcdefghijklmnop" }, output: "ok" });
  assert.equal(safe.output, "ok");
  assert.doesNotMatch(JSON.stringify(safe), /abcdefghijklmnop/);
});
