import { loadConfig } from "../extensions/pi-agents-memory/providers/openviking/config.ts";
import { OVClient } from "../extensions/pi-agents-memory/providers/openviking/client.ts";

const config = loadConfig("../extensions/pi-agents-memory/providers/openviking");
if (!config.apiKey && !process.env.OPENVIKING_URL) {
  console.log(JSON.stringify({ operation: "search_context", readOnly: true, status: "skipped", reason: "OPENVIKING credentials not configured" }));
  process.exit(0);
}
const client = new OVClient(config);
const ok = await client.health();
if (!ok) {
  console.log(JSON.stringify({ operation: "search_context", readOnly: true, status: "failed", reason: "health failed" }));
  process.exit(1);
}
const result = await client.searchContext("coding agent memory architecture", { purpose: "coding", maxTokens: 800, limit: 3 });
console.log(JSON.stringify({ operation: "search_context", readOnly: true, status: result ? "passed" : "failed", hasRendered: Boolean(result?.rendered), hasBuckets: Boolean(result?.memories || result?.resources || result?.skills) }));
process.exit(result ? 0 : 1);
