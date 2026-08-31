import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";

/**
 * Resolve hook: map a relative `./thing.js` specifier onto the sibling
 * `thing.ts` source, so plain `node --experimental-strip-types` can import the
 * plugin's TypeScript without a build step.
 *
 * This lives under `scripts/lib/` (not `tests/`) because the published package
 * excludes tests, and the nightly sweep must work from an npm install.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("node:") || !specifier.endsWith(".js")) return nextResolve(specifier, context);
  try {
    const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidate = join(parent, specifier);
    const ts = candidate.slice(0, -extname(candidate).length) + ".ts";
    await access(ts);
    return { url: pathToFileURL(ts).href, shortCircuit: true };
  } catch {
    return nextResolve(specifier, context);
  }
}
