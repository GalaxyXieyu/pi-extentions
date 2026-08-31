import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, join } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("node:") || !specifier.endsWith(".js")) return nextResolve(specifier, context);
  try {
    const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
    const candidate = join(parent, specifier);
    const ts = candidate.slice(0, -3) + ".ts";
    await access(ts);
    return { url: pathToFileURL(ts).href, shortCircuit: true };
  } catch {
    return nextResolve(specifier, context);
  }
}
