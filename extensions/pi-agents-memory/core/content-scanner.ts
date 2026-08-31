import { sanitizeSensitiveText } from "./sensitive.mjs";

export type ScanAction = "allow" | "redact" | "reject" | "threat";

export interface ScanFinding {
  id: string;
  severity: "low" | "medium" | "high";
  action: ScanAction;
}

export interface ScanResult {
  action: ScanAction;
  text: string;
  findings: ScanFinding[];
}

const RULES: Array<{ id: string; pattern: RegExp; severity: ScanFinding["severity"]; action: ScanAction }> = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/i, severity: "high", action: "reject" },
  { id: "credential-file", pattern: /(?:^|[\s/])(?:\.env(?:\.[\w.-]+)?|credentials\.json|id_rsa|.*\.pem|.*\.key)(?:$|[\s/])/i, severity: "high", action: "reject" },
  { id: "prompt-injection", pattern: /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|system|memory)\s+instructions/i, severity: "high", action: "threat" },
  { id: "auth-header", pattern: /authorization\s*:\s*(?:bearer|basic)\s+\S+/i, severity: "high", action: "reject" },
  { id: "secret-assignment", pattern: /(?:api[_ -]?key|token|password|secret[_ -]?key)\s*[:=]\s*\S+/i, severity: "medium", action: "redact" },
];

export function scanMemoryContent(value: unknown): ScanResult {
  const raw = String(value ?? "");
  const findings = RULES.filter((rule) => rule.pattern.test(raw)).map(({ id, severity, action }) => ({ id, severity, action }));
  if (findings.some((finding) => finding.action === "threat")) return { action: "threat", text: "", findings };
  if (findings.some((finding) => finding.action === "reject")) return { action: "reject", text: "", findings };
  if (findings.some((finding) => finding.action === "redact")) return { action: "redact", text: sanitizeSensitiveText(raw), findings };
  return { action: "allow", text: raw, findings: [] };
}
