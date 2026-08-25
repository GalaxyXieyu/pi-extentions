import type { MemoryCandidate, MemoryIdentity, MemoryKind, MemorySourceType } from "./contracts.js";
import { scanMemoryContent } from "./content-scanner.js";
import { MemoryPolicyEngine } from "./policy-engine.js";

export interface CandidateInput {
  text: string;
  identity: MemoryIdentity;
  sessionId?: string;
  purpose: "chat" | "coding";
  sourceType?: MemorySourceType;
  source?: { files?: string[]; commands?: string[] };
  policyVersion?: number;
}

export interface CandidateExtractionResult {
  candidates: MemoryCandidate[];
  rejected: Array<{ reason: string; findings: string[] }>;
}

export function extractCandidates(input: CandidateInput): CandidateExtractionResult {
  const scan = scanMemoryContent(input.text);
  if (scan.action === "reject" || scan.action === "threat" || scan.findings.some((finding) => finding.id === "secret-assignment")) {
    return { candidates: [], rejected: [{ reason: scan.action === "redact" ? "secret" : scan.action, findings: scan.findings.map((item) => item.id) }] };
  }
  const policy = new MemoryPolicyEngine();
  const kind = classify(input.text, input.purpose);
  const writeWhen = Array.isArray((policy.policy.common as any).writeWhen) ? (policy.policy.common as any).writeWhen : [];
  if (!kind || writeWhen.length === 0) return { candidates: [], rejected: [] };
  const now = new Date().toISOString();
  const sourceType: MemorySourceType = input.sourceType || (input.text ? "user" : "agent");
  // Source credibility: agent inference carries less weight than an explicit
  // user statement; system events are treated as observations. Correction
  // signals ("不对/错了/现在改成 X") count as high-confidence explicit user
  // content regardless of the message role.
  const explicitUser = /remember|请记住|confirmed|确认|决定|以后|改用|不要|不对|错了|不是这样|记错了|现在(?:改|用|是)|已经不用|不再是|correction|纠正/i.test(input.text);
  const confidence = explicitUser || sourceType === "user" ? "high" : "medium";
  return {
    candidates: [{
      kind,
      scope: kind === "profile" || kind === "preference" ? "user" : "workspace",
      status: kind === "decision" ? "needs-confirmation" : "candidate",
      confidence,
      summary: scan.text.trim().slice(0, 1200),
      content: scan.text.trim(),
      owner: { tenantId: input.identity.tenantId, userId: input.identity.userId, agentId: input.identity.agentId, workspaceId: input.identity.workspaceId },
      source: { sessionId: input.sessionId, files: input.source?.files, commands: input.source?.commands, observedAt: now, sourceType },
      createdAt: now,
      updatedAt: now,
      policyVersion: input.policyVersion || 1,
      security: { verdict: scan.action, findings: scan.findings.map((item) => item.id) },
    }],
    rejected: [],
  };
}

export function classify(text: string, purpose: "chat" | "coding"): MemoryKind | null {
  if (/不要|别用|改用|改成|换成|迁移到|换成了|no,? use|correction|纠正|不对|错了|不是这样|记错了|已经不用|不再是|现在(?:改|用|是)/i.test(text)) return "preference";
  if (/根因|修复|failed|failure|错误|报错|验证通过|fixed/i.test(text)) return "experience";
  if (/架构|决定|decision|选择.*方案|采用/i.test(text)) return "decision";
  if (/请记住|记住|记得|remember|偏好|喜欢|prefer|profile/i.test(text)) return "profile";
  if (/完成|开始|发生|在.*进行了|做了|执行|重构|迁移|上线|提交了/i.test(text)) return "event";
  if (purpose === "coding" && /package\.json|测试命令|目录|workspace|项目|project|npm |pnpm |docker/i.test(text)) return "project";
  return null;
}
