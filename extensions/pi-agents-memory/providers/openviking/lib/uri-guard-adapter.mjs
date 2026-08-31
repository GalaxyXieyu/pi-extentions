import { buildGuardMessage, findVikingUri, normalizeToolName } from "../shared/uri-guard.mjs";

const VIKING_URI_TOOL_HINTS = {
  read: {
    tool: "memory_read",
    example: (uri) => `memory_read(uri="${uri}", level="overview")`,
  },
  grep: {
    tool: "memory_search",
    example: (uri, input = {}) => `memory_search(query="${String(input.pattern ?? "").replaceAll('"', '\\"')}", scope="${uri}")`,
  },
  find: {
    tool: "memory_browse",
    example: (uri) => `memory_browse(action="list", uri="${uri}")`,
  },
  ls: {
    tool: "memory_browse",
    example: (uri) => `memory_browse(action="list", uri="${uri}")`,
  },
  bash: {
    tool: "memory_read or memory_search",
    example: (uri) => `memory_read(uri="${uri}", level="overview")`,
  },
};

export function guardVikingUriToolCall(event) {
  const toolName = normalizeToolName(event?.toolName ?? event?.tool_name ?? event?.name);
  const hint = VIKING_URI_TOOL_HINTS[toolName];
  if (!hint) return null;

  const input = event?.input ?? event?.args ?? event?.params ?? {};
  const uri = findVikingUri(input);
  if (!uri) return null;

  return {
    block: true,
    reason: buildGuardMessage(uri, {
      tool: hint.tool,
      example: hint.example(uri, input),
    }),
  };
}
