import { llmExtractionEnabled, type LlmCompleteFn } from "./llm-extractor.js";

/**
 * Host-piloted LLM completion: inherits pi's active provider, model, and
 * credentials via `ctx.modelRegistry.complete()`. When `PI_MEMORY_LLM_MODEL`
 * names a configured pi model (`provider/model`), that model is used instead
 * of the session model — still with pi's own auth.
 *
 * No `PI_MEMORY_LLM_URL` / standalone endpoint needed on this path.
 */

export function resolvePilotModel(ctx: any): any {
  const spec = String(process.env.PI_MEMORY_LLM_MODEL || "").trim();
  if (spec) {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const provider = spec.slice(0, slash).trim();
      const modelId = spec.slice(slash + 1).split(":")[0]?.trim();
      if (provider && modelId && typeof ctx?.modelRegistry?.find === "function") {
        const found = ctx.modelRegistry.find(provider, modelId);
        if (found) return found;
      }
      throw new Error(`PI_MEMORY_LLM_MODEL "${spec}" is not a configured pi model`);
    }
  }
  return ctx?.model;
}

/** Build the completion hook from a ctx getter, or null when LLM path is off. */
export function makePilotComplete(getCtx: () => any): LlmCompleteFn | null {
  if (!llmExtractionEnabled()) return null;
  return async (messages) => {
    const ctx = getCtx();
    const registry = ctx?.modelRegistry;
    const model = resolvePilotModel(ctx);
    if (!registry || typeof registry.complete !== "function" || !model) {
      throw new Error("pi model registry unavailable for memory curation");
    }
    const assistant = await registry.complete(model, {
      systemPrompt: messages.find((m) => m.role === "system")?.content ?? undefined,
      messages: [
        {
          role: "user",
          content: messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
          timestamp: Date.now(),
        },
      ],
    });
    const text = (assistant?.content || [])
      .filter((block: any) => block?.type === "text")
      .map((block: any) => String(block.text || ""))
      .join("");
    if (!text) throw new Error("pilot completion returned no text");
    return text;
  };
}