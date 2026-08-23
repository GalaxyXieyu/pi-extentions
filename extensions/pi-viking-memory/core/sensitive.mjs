const SECRET_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_ -]?key|access[_ -]?key|secret[_ -]?key|token|password|passwd|client_secret|authorization)\b\s*[:=]\s*['"`]?(?:Bearer\s+)?[A-Za-z0-9_./+=:-]{4,}/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\b(?:OPENAI|ANTHROPIC|GEMINI|AWS|AZURE|VIKING|MEMORY)_[A-Z0-9_]*KEY\b\s*=\s*[^\s]+/gi,
];

export function sanitizeSensitiveText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

export function sanitizeSensitiveValue(value) {
  if (typeof value === "string") return sanitizeSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeSensitiveValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      const sensitiveKey = /(?:api[_ -]?key|access[_ -]?key|secret[_ -]?key|token|password|passwd|client_secret|authorization)/i.test(key);
      return [key, sensitiveKey ? "[REDACTED_SECRET]" : sanitizeSensitiveValue(item)];
    }));
  }
  return value;
}
