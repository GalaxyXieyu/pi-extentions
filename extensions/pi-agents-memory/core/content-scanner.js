const RULES = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/i, severity: "high", action: "reject" },
  { id: "credential-file", pattern: /(?:^|[\s/])(?:\.env(?:\.[\w.-]+)?|credentials\.json|id_rsa|.*\.pem|.*\.key)(?:$|[\s/])/i, severity: "high", action: "reject" },
  { id: "prompt-injection", pattern: /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|system|memory)\s+instructions/i, severity: "high", action: "threat" },
  { id: "auth-header", pattern: /authorization\s*:\s*(?:bearer|basic)\s+\S+/i, severity: "high", action: "reject" },
  { id: "secret-assignment", pattern: /(?:api[_ -]?key|token|password|secret[_ -]?key)\s*[:=]\s*\S+/i, severity: "medium", action: "redact" },
];

export function scanMemoryContent(value) {
  const text = String(value ?? "");
  const findings = RULES.filter((rule) => rule.pattern.test(text)).map(({ id, severity, action }) => ({ id, severity, action }));
  if (findings.some((item) => item.action === "threat")) return { action: "threat", text: "", findings };
  if (findings.some((item) => item.action === "reject")) return { action: "reject", text: "", findings };
  if (findings.length) return { action: "redact", text: text.replace(/\b(?:api[_ -]?key|token|password|secret[_ -]?key)\s*[:=]\s*\S+/gi, "[REDACTED_SECRET]"), findings };
  return { action: "allow", text, findings: [] };
}
