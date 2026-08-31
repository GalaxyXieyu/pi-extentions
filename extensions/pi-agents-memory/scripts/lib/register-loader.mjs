import { register } from "node:module";

/**
 * One hook covers the whole package: it resolves relative `.js` specifiers to
 * sibling `.ts` sources wherever they are imported from, so the sweep does not
 * need per-directory loaders (and does not depend on the test-only ones, which
 * are not shipped in the npm package).
 */
register("./ts-resolver.mjs", import.meta.url);
