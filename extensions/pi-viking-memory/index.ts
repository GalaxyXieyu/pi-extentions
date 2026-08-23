import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSelected } from "./core/selection.js";
import { loadConfig as loadVikingConfig } from "./providers/viking-memory/config.js";
import { VikingMemoryClient } from "./providers/viking-memory/client.js";
import { VikingMemoryProvider } from "./providers/viking-memory/provider.js";
import { loadConfigFromModuleUrl as loadOVConfig } from "./providers/openviking/config.js";
import { OVClient } from "./providers/openviking/client.js";
import { OpenVikingProvider } from "./providers/openviking/provider.js";

export default async function (pi: ExtensionAPI) {
  if (isSelected("viking-memory")) return import("./providers/viking-memory/index.js").then((module) => module.default(pi));
  if (isSelected("openviking")) return import("./providers/openviking/index.js").then((module) => module.default(pi));
  return;
}

export function selectedProviderId(): "viking-memory" | "openviking" | null {
  if (isSelected("viking-memory")) return "viking-memory";
  if (isSelected("openviking")) return "openviking";
  return null;
}
