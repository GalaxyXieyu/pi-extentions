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
  const explicitUser = /remember|请记住|confirmed|确认|决定|以后|改用|改成|换成|迁移到|换成了|不要|不对|错了|不是这样|记错了|现在(?:改|用|是)|已经不用|不再是|correction|纠正/i.test(input.text);
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
  const t = text.trim();
  // Questions, greetings, open process narration: never durable facts.
  if (isNoise(t)) return null;
  if (/不要|别用|不用|no,? use|correction|纠正/i.test(t)) return "preference";
  // Experience needs a resolved conclusion — just hitting an error is not enough.
  if (/根因(?:是|为)|原因(?:是|为|找到)|已?修复|修好了|解决了|已解决|fixed|验证通过|测试通过/i.test(t)) return "experience";
  // Decision needs a confirmed choice — plain "架构/考虑" discussion is not.
  if (/(?:已?决定|确定|最终选择|选定|采用)(?:了)?(?:用|使用|采用|选|方案|方式)?|方案(?:是|确定|用)|决定用|决定采用/i.test(t)) return "decision";
  if (/请记住|记住|记得|以后(?:都|一直|就)|偏好|喜欢|prefer|profile|希望(?:以后|每次|以后都)/i.test(t)) return "preference";
  // Event needs a completed milestone — process words alone are not.
  if (/迁移到|重构(?:了|完成)|已完成|完成了|上线了|发布了|提交了|切到|换成了|改用/i.test(t)) return "event";
  if (purpose === "coding" && /package\.json|测试命令|workspace|项目(?:使用|用|采用|里|中|的)|npm (?:install|run|i )|pnpm (?:install|run|i )|docker (?:compose|run|build)/i.test(t)) return "project";
  return null;
}

/** Low-value shapes that should never become memories: questions, greetings, open task narration. */
function isNoise(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/[?？]\s*$/.test(t)) return true;
  if (/^(如何|怎样|怎么|为什么|是吗|是不是|行不行|要不要|能不能|可否|是否|what|how|why|should|does|are|is|can|please)/i.test(t)) return true;
  if (/^(你好|嗨|hello|hi|早上好|晚上好|谢谢|thanks|好的|ok|嗯|行)/i.test(t)) return true;
  if (/^(我先|让我|正在|准备|接下来|先做|试着|尝试|我看|我在看|看下|我看看)/i.test(t)) return true;
  return false;
}

/**
 * Correction/update signals ("不对/改成/换成/迁移到…") must NOT steal the kind —
 * they only raise confidence and mark the fact as an update over an existing one.
 */
export function correctionSignal(text: string): boolean {
  return /改用|改成|换成|迁移到|换成了|不对|错了|不是这样|记错了|已经不用|不再是|现在(?:改|用|是)/i.test(text);
}
