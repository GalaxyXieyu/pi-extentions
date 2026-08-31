import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { MemoryMessage } from "./provider.js";
import { localIdentity, requestContext, type MemoryRequestContext } from "./contracts.js";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";
import { stripMemoryContext } from "./format.js";
import { localMemoryStatePath } from "./local-paths.js";

/**
 * Nightly transcript curation (offline LLM stage).
 *
 * Normal conversation capture is rule/keyword-only and must never wait on a
 * model. Everything that needs an LLM happens here instead: once a day the
 * sweep reads pi's own session transcripts from disk, groups them per
 * workspace, and pushes them through the same batch curator + lifecycle gates
 * the inline funnel used to use.
 *
 * Discovery, parsing, and the processed-file watermark are pure filesystem
 * logic so they stay testable; the model call and the remote write are
 * injected by the caller (`scripts/nightly-sweep.mjs`).
 *
 * Long sessions are streamed, never slurped: a busy pi session keeps every
 * tool result in one append-only JSONL file and regularly reaches hundreds of
 * megabytes, while the actual user/assistant text is a few dozen kilobytes.
 * `readTranscriptWindow` walks the file from a byte offset, rejects non-text
 * lines on the raw bytes, and returns the offset to resume from, so the sweep
 * memory stays flat and an interrupted file continues where it stopped.
 */

export interface SessionFile {
  path: string;
  /** pi session id = file stem, used as the provenance sessionId. */
  sessionId: string;
  cwd: string;
  mtimeMs: number;
  size: number;
}

export interface NightlyStateFile {
  version: 1;
  files: Record<string, { mtimeMs: number; size: number; processedAt: string; memories: number; /** Byte offset already curated; equals size when finished. */ offset: number }>;
}

export interface NightlyReport {
  scanned: number;
  skipped: number;
  processed: number;
  /** Files whose curation resumed from a stored cursor (unfinished last run). */
  resumed: number;
  windows: number;
  batches: number;
  memories: number;
  rejected: number;
  /** Transcript lines skipped for being larger than the line budget. */
  oversize: number;
  workspaces: string[];
  errors: string[];
}

export function piSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.PI_MEMORY_SESSIONS_DIR || join(homedir(), ".pi", "agent", "sessions"));
}

export function nightlyStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.PI_MEMORY_NIGHTLY_STATE || localMemoryStatePath("nightly-state.json"));
}

/**
 * List top-level pi session files modified after `cutoffMs`.
 *
 * Layout is `<sessionsRoot>/<cwd-slug>/<timestamp>_<uuid>.jsonl`; nested
 * directories under the slug hold subagent/workflow transcripts and are
 * skipped unless `includeSubagents` is set.
 */
export function listSessionFiles(options: { root?: string; cutoffMs: number; includeSubagents?: boolean; limit?: number } = { cutoffMs: 0 }): SessionFile[] {
  const root = resolve(options.root || piSessionsDir());
  const found: SessionFile[] = [];
  if (!existsSync(root)) return found;
  for (const entry of safeReadDir(root)) {
    const workspaceDir = join(root, entry);
    let stat;
    try { stat = statSync(workspaceDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of safeReadDir(workspaceDir)) {
      if (file.endsWith(".jsonl")) {
        const push = collectSession(join(workspaceDir, file), options.cutoffMs);
        if (push) found.push(push);
      } else if (options.includeSubagents) {
        const nested = join(workspaceDir, file);
        let nestedStat;
        try { nestedStat = statSync(nested); } catch { continue; }
        if (!nestedStat.isDirectory()) continue;
        for (const inner of walkJsonl(nested, 3)) {
          const push = collectSession(inner, options.cutoffMs);
          if (push) found.push(push);
        }
      }
    }
  }
  found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return options.limit && options.limit > 0 ? found.slice(-options.limit) : found;
}

function walkJsonl(dir: string, depth: number): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];
  for (const entry of safeReadDir(dir)) {
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) out.push(...walkJsonl(full, depth - 1));
    else if (entry.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function collectSession(path: string, cutoffMs: number): SessionFile | null {
  let stat;
  try { stat = statSync(path); } catch { return null; }
  if (stat.size === 0 || stat.mtimeMs < cutoffMs) return null;  const cwd = readSessionCwd(path);
  if (!cwd) return null;
  return { path, sessionId: basename(path).replace(/\.jsonl$/, ""), cwd, mtimeMs: stat.mtimeMs, size: stat.size };
}

/** The first JSONL line is the session header and carries the real cwd. */
export function readSessionCwd(path: string): string {
  try {
    return parseSessionHeader(readHead(path));
  } catch { /* unreadable transcript */ }
  return "";
}

/** Read only the head of the file — a session record can be hundreds of MB. */
function readHead(path: string, bytes = 8192): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally { closeSync(fd); }
}

function parseSessionHeader(head: string): string {
  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (parsed?.type === "session" && typeof parsed.cwd === "string") return parsed.cwd;
    if (parsed?.type === "session") return "";
    if (!line.startsWith("{")) continue;
  }
  return "";
}

export interface TranscriptOptions {
  /** Include assistant turns (default true). */
  assistant?: boolean;
  /** Per-message character cap. */
  maxLength?: number;
  /** Character budget for this read window (not for the whole transcript). */
  maxChars?: number;
  /** Byte offset to start from; reads always resume on a line boundary. */
  offset?: number;
  /** Skip lines larger than this (base64 blobs, giant tool payloads). */
  maxLineBytes?: number;
}

export interface TranscriptWindow {
  messages: MemoryMessage[];
  /** Byte offset to resume from; equals file size when `done`. */
  nextOffset: number;
  size: number;
  /** True when the reader reached the end of the file. */
  done: boolean;
  /** Lines skipped because they exceeded `maxLineBytes`. */
  oversize: number;
}

/**
 * Stream one window of a pi transcript: user/assistant text only.
 *
 * pi keeps every tool result and every assistant message in one append-only
 * JSONL file, so a long session is routinely hundreds of megabytes while the
 * actual conversation is a few dozen kilobytes. Reading such a file with
 * `readFileSync` blows up memory, and reading only its tail loses the middle
 * of the session. So this parses line by line from a byte offset, keeps
 * running until the character budget is met, and hands back the exact offset
 * to continue from — a 400 MB transcript costs one read buffer.
 *
 * Cheap guards run before `JSON.parse`: a line must start with
 * `{"type":"message"` and its role must be user/assistant. Tool results, the
 * session header, and model-change events are rejected on the raw bytes.
 */
export function readTranscriptWindow(path: string, options: TranscriptOptions = {}): TranscriptWindow {
  const maxLength = options.maxLength ?? 2400;
  const maxChars = Math.max(1, options.maxChars ?? Number(process.env.PI_MEMORY_NIGHTLY_WINDOW_CHARS || 60000));
  const includeAssistant = options.assistant !== false;
  const maxLineBytes = Math.max(1024, options.maxLineBytes ?? Number(process.env.PI_MEMORY_NIGHTLY_MAX_LINE_BYTES || 2 * 1024 * 1024));

  let size: number;
  try { size = statSync(path).size; } catch { return { messages: [], nextOffset: 0, size: 0, done: true, oversize: 0 }; }
  const start = Math.max(0, Math.min(options.offset ?? 0, size));
  const NEWLINE = 0x0a;
  const chunkBytes = 1024 * 1024;
  // One reusable buffer: a whole chunk plus room for a partial line. Nothing
  // here scales with the file size, only with the largest line we accept.
  const buffer = Buffer.allocUnsafe(chunkBytes + maxLineBytes);
  const messages: MemoryMessage[] = [];
  let bufferStart = start;   // file offset of buffer[0]
  let used = 0;              // meaningful bytes in buffer
  let scanned = 0;           // bytes already turned into lines
  let skipping = false;      // discarding bytes of a line longer than maxLineBytes
  let eof = false;
  let chars = 0;
  let oversize = 0;
  let stoppedAt = -1;

  const fd = openSync(path, "r");
  try {
    for (;;) {
      // 1. Keep the unscanned tail (normally one partial line) at the head.
      if (scanned > 0) {
        if (scanned < used) buffer.copy(buffer, 0, scanned, used);
        bufferStart += scanned;
        used -= scanned;
        scanned = 0;
      }
      // 2. A partial line already past the byte budget is dropped; the reader
      //    then resyncs on the next newline without materialising the line.
      if (used > maxLineBytes) {
        // Only count it when the header looks like conversation we wanted —
        // a giant tool result is noise we would have skipped anyway.
        if (!skipping && conversationLineInBuffer(buffer, used)) oversize++;
        skipping = true;
        bufferStart += used;
        used = 0;
      }
      // 3. Refill. `used` is bounded by the buffer, so a 400 MB file is walked
      //    chunk by chunk and a multi-megabyte line is dropped, not buffered.
      if (!eof) {
        const read = readSync(fd, buffer, used, buffer.length - used, bufferStart + used);
        if (read === 0) eof = true;
        used += read;
      }
      // 4. Consume whole lines. '\n' never occurs inside a multi-byte UTF-8
      //    sequence, so byte-level splitting always yields valid lines. The
      //    search is bounded by `used`: bytes past the read are stale.
      for (;;) {
        // Buffer#indexOf has no end argument, so bound the live region with a
        // view: bytes past `used` are stale leftovers from an earlier chunk.
        const relative = buffer.subarray(scanned, used).indexOf(NEWLINE);
        if (relative < 0) {
          if (skipping) scanned = used;
          break;
        }
        const newline = scanned + relative;
        skipping = false;
        const line = buffer.subarray(scanned, newline);
        scanned = newline + 1;
        if (!line.length) continue;
        const message = messageFromLine(line, { includeAssistant, maxLength, maxLineBytes });
        if (message === "oversize") { oversize++; continue; }
        if (!message) continue;
        messages.push(message);
        chars += message.content.length;
        if (chars >= maxChars) break;
      }
      // 5. Stop either on the character budget (resume point on a line
      //    boundary) or when the file is exhausted.
      if (chars >= maxChars) {
        stoppedAt = bufferStart + scanned;
        break;
      }
      if (eof) break;
    }

    // A final line without a trailing newline is still a complete record.
    if (stoppedAt < 0 && !skipping && used > scanned) {
      const tail = buffer.subarray(scanned, used);
      const message = messageFromLine(tail, { includeAssistant, maxLength, maxLineBytes });
      if (message === "oversize") oversize++;
      else if (message) messages.push(message);
    }
  } finally {
    closeSync(fd);
  }

  const done = stoppedAt < 0;
  return { messages, nextOffset: done ? size : Math.min(stoppedAt, size), size, done, oversize };
}

type LineResult = MemoryMessage | "oversize" | null;

/** Peek a line header that is still growing in the buffer: is it conversation? */
function conversationLineInBuffer(buffer: Buffer, length: number): boolean {
  const header = buffer.subarray(0, Math.min(200, length)).toString("utf8");
  if (!header.startsWith('{"type":"message"')) return false;
  const role = header.match(/"role":"([a-zA-Z]+)"/)?.[1];
  return role === "user" || role === "assistant";
}

function messageFromLine(line: Buffer, options: { includeAssistant: boolean; maxLength: number; maxLineBytes: number }): LineResult {
  if (!line.length) return null;
  // Role first, size second: a giant tool result is noise we would have
  // dropped anyway, and counting it as "oversize conversation" would lie.
  const header = line.subarray(0, 200).toString("utf8");
  if (!header.startsWith('{"type":"message"')) return null;
  const roleMatch = header.match(/"role":"([a-zA-Z]+)"/);
  const role = roleMatch?.[1];
  if (role !== "user" && role !== "assistant") return null;
  if (role === "assistant" && !options.includeAssistant) return null;
  if (line.length > options.maxLineBytes) return "oversize";
  let entry: any;
  try { entry = JSON.parse(line.toString("utf8")); } catch { return null; }
  const content = entry?.message?.content;
  const text = Array.isArray(content)
    ? content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text || "")).join("\n")
    : typeof content === "string" ? content : "";
  const cleaned = stripMemoryContext(text).replace(/\s+\n/g, "\n").trim();
  if (!cleaned || looksSynthetic(cleaned)) return null;
  return { role, content: clip(cleaned, options.maxLength) };
}

export interface TranscriptOptions {
  /** Include assistant turns (default true). */
  assistant?: boolean;
  /** Per-message character cap. */
  maxLength?: number;
  /** Overall character budget; oldest messages are dropped first. */
  maxChars?: number;
}

/**
 * Convenience wrapper over `readTranscriptWindow` for callers that just want
 * the conversation: keeps reading windows until EOF (or `maxWindows`).
 */
export function readTranscript(path: string, options: TranscriptOptions & { maxWindows?: number } = {}): MemoryMessage[] {
  const messages: MemoryMessage[] = [];
  const maxWindows = options.maxWindows ?? Number(process.env.PI_MEMORY_NIGHTLY_MAX_WINDOWS || 0);
  let offset = options.offset ?? 0;
  for (let window = 0; ; window++) {
    const result = readTranscriptWindow(path, { ...options, offset });
    messages.push(...result.messages);
    // Never spin on a reader that cannot advance, even if a future change
    // breaks the offset math.
    if (result.done || result.nextOffset <= offset) break;
    offset = result.nextOffset;
    if (maxWindows > 0 && window + 1 >= maxWindows) break;
  }
  return messages;
}

/** Local-command shells, hook output, and compaction stubs are not conversation. */
function looksSynthetic(text: string): boolean {
  const head = text.slice(0, 80);
  return /^(<user-shell-input>|\[Request interrupted|This session is being continued|<system-reminder|Caveat:)/i.test(head);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 16).trimEnd()} [truncated]`;
}

/** Split a transcript into LLM-sized batches without cutting a turn in half. */
export function chunkMessages(messages: MemoryMessage[], maxChars = 12000): MemoryMessage[][] {
  const batches: MemoryMessage[][] = [];
  let current: MemoryMessage[] = [];
  let size = 0;
  for (const message of messages) {
    if (current.length && size + message.content.length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += message.content.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function loadNightlyState(path = nightlyStatePath()): NightlyStateFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === "object") {
      const files: NightlyStateFile["files"] = {};
      for (const [key, value] of Object.entries(parsed.files as Record<string, any>)) {
        files[key] = {
          mtimeMs: Number(value?.mtimeMs) || 0,
          size: Number(value?.size) || 0,
          processedAt: String(value?.processedAt || ""),
          memories: Number(value?.memories) || 0,
          offset: Number(value?.offset ?? value?.size) || 0,
        };
      }
      return { version: 1, files };
    }
  } catch { /* first run */ }
  return { version: 1, files: {} };
}

export function saveNightlyState(state: NightlyStateFile, path = nightlyStatePath()): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...state, files: sanitizeStateFiles(state.files) }, null, 2), { mode: 0o600 });
}

function sanitizeStateFiles(files: NightlyStateFile["files"]): NightlyStateFile["files"] {
  // Absolute paths stay on this machine only; cap growth to the newest 2000.
  const entries = Object.entries(files).sort((a, b) => (a[1]?.mtimeMs || 0) - (b[1]?.mtimeMs || 0));
  return Object.fromEntries(entries.slice(-2000));
}

/**
 * Done means the cursor passed the current end of the file. A session that is
 * still growing is not "processed" - only its new tail gets read next run.
 */
export function isProcessed(state: NightlyStateFile, file: SessionFile): boolean {
  const seen = state.files[file.path];
  return Boolean(seen && seen.offset >= file.size);
}

/** Where the next read starts: 0 for a fresh file, the stored cursor to resume. */
export function resumeOffset(state: NightlyStateFile, file: SessionFile): number {
  const seen = state.files[file.path];
  if (!seen) return 0;
  return Math.max(0, Math.min(seen.offset || 0, file.size));
}

export function markProcessed(state: NightlyStateFile, file: SessionFile, memories: number, now = new Date(), offset = file.size): void {
  const previous = state.files[file.path];
  const carried = previous && previous.offset < file.size ? previous.memories : 0;
  state.files[file.path] = {
    mtimeMs: file.mtimeMs,
    size: file.size,
    processedAt: now.toISOString(),
    memories: carried + memories,
    offset,
  };
}

/** Default: build the per-workspace request context the same way the plugin does. */
export function nightlyContextFor(cwd: string, options: { userId?: string; agentId?: string; tenantId?: string; purpose?: "chat" | "coding" } = {}): MemoryRequestContext {
  const workspace = resolveWorkspaceIdentity({ cwd });
  const identity = localIdentity({
    tenantId: options.tenantId || process.env.MEMORY_TENANT_ID || "local",
    userId: options.userId || process.env.VIKING_MEMORY_USER_ID || process.env.OPENVIKING_USER || "user_01",
    agentId: options.agentId || process.env.VIKING_MEMORY_ASSISTANT_ID || "pi",
    workspaceId: workspace.id,
    sessionId: `nightly-${shortHash(workspace.id)}`,
    source: "local",
  });
  return requestContext(identity, {
    purpose: options.purpose || (process.env.MEMORY_PURPOSE === "chat" ? "chat" : "coding"),
    lifecycle: {
      expiryEnabled: process.env.MEMORY_EXPIRY_ENABLED !== "0",
      conflictPolicy: process.env.MEMORY_CONFLICT_POLICY === "auto-merge" ? "auto-merge" : "preserve-and-confirm",
    },
  });
}

export interface SweepOptions {
  now?: Date;
  sinceHours?: number;
  root?: string;
  stateFile?: string;
  dryRun?: boolean;
  includeAssistant?: boolean;
  maxBatchChars?: number;
  /** Characters of conversation per read window (streaming, never the whole file). */
  windowChars?: number;
  /** 0 = keep reading a file until EOF; >0 caps the windows per file per run. */
  maxWindowsPerFile?: number;
  limit?: number;
  /** Apply one curator batch. Provided by the caller (provider.curateBatch). */
  curate: (batch: MemoryMessage[], sessionId: string, context: MemoryRequestContext) => Promise<{ handled: boolean; count: number; rejected: number; error?: string }>;
  /** Build (and cache) the provider context for a workspace cwd. */
  contextFor?: (cwd: string) => MemoryRequestContext;
  log?: (line: string) => void;
}

/**
 * Run the sweep over recent transcripts.
 *
 * Idempotent and resumable: each file keeps a byte cursor, so an unfinished
 * long session continues where the previous run stopped, and a growing
 * session only pays for its new tail. A file is only marked complete when the
 * cursor reached EOF with every batch accepted.
 */
export async function runNightlySweep(options: SweepOptions): Promise<NightlyReport> {
  const now = options.now || new Date();
  const sinceHours = options.sinceHours ?? Number(process.env.PI_MEMORY_NIGHTLY_HOURS || 26);
  const cutoff = now.getTime() - sinceHours * 3600_000;
  const log = options.log || (() => {});
  const stateFile = options.stateFile;
  const state = loadNightlyState(stateFile);
  const contextFor = options.contextFor || nightlyContextFor;
  const cache = new Map<string, MemoryRequestContext>();
  const windowChars = options.windowChars ?? Number(process.env.PI_MEMORY_NIGHTLY_WINDOW_CHARS || 60000);
  const maxWindowsPerFile = options.maxWindowsPerFile ?? Number(process.env.PI_MEMORY_NIGHTLY_MAX_WINDOWS || 0);
  const report: NightlyReport = { scanned: 0, skipped: 0, processed: 0, resumed: 0, windows: 0, batches: 0, memories: 0, rejected: 0, oversize: 0, workspaces: [], errors: [] };

  const files = listSessionFiles({ root: options.root, cutoffMs: cutoff, limit: options.limit });
  report.scanned = files.length;
  if (!files.length) { log("no transcripts in window"); return report; }

  for (const file of files) {
    if (isProcessed(state, file)) { report.skipped++; log(`skip (done) ${basename(file.path)}`); continue; }
    const context = cache.get(file.cwd) || contextFor(file.cwd);
    cache.set(file.cwd, context);
    const workspaceId = String(context.identity.workspaceId || "local");
    if (!report.workspaces.includes(workspaceId)) report.workspaces.push(workspaceId);

    let cursor = resumeOffset(state, file);
    if (cursor > 0) { report.resumed++; log(`resume ${basename(file.path)} @${cursor}/${file.size}`); }
    let writtenHere = 0;
    let totalMessages = 0;
    let complete = false;

    for (let windowIndex = 0; ; windowIndex++) {
      let window: TranscriptWindow;
      try {
        window = readTranscriptWindow(file.path, {
          offset: cursor,
          maxChars: windowChars,
          assistant: options.includeAssistant,
        });
      } catch (error: any) {
        report.errors.push(`${basename(file.path)}:${String(error?.message || error)}`);
        break;
      }
      report.windows++;
      report.oversize += window.oversize;
      totalMessages += window.messages.length;

      let windowOk = true;
      if (window.messages.length) {
        for (const batch of chunkMessages(window.messages, options.maxBatchChars ?? Number(process.env.PI_MEMORY_NIGHTLY_BATCH_CHARS || 12000))) {
          report.batches++;
          try {
            const result = await options.curate(batch, `nightly_${file.sessionId.slice(0, 24)}`, context);
            if (!result.handled) {
              report.errors.push(`llm-unavailable:${basename(file.path)}`);
              // Surface WHY: "pi CLI not found" and "HTTP 401" need very
              // different fixes and the job runs where nobody can see it.
              log(`llm unavailable for ${basename(file.path)} at ${cursor}: ${result.error || "no reason reported"}`);
              windowOk = false;
              break;
            }
            report.memories += result.count;
            report.rejected += result.rejected;
            writtenHere += result.count;
          } catch (error: any) {
            report.errors.push(`${basename(file.path)}:${String(error?.message || error)}`);
            log(`error ${basename(file.path)}: ${String(error?.message || error)}`);
            windowOk = false;
            break;
          }
        }
      }
      // The cursor only advances past a window whose batches all succeeded.
      if (!windowOk) break;
      const advanced = window.nextOffset > cursor;
      cursor = window.nextOffset;
      if (!options.dryRun) { markProcessed(state, file, writtenHere, now, cursor); saveNightlyState(state, stateFile); }
      if (window.done) { complete = true; break; }
      if (!advanced) {
        // Defensive: a reader that cannot advance must not spin through an
        // entire night. Record it and move to the next file.
        report.errors.push(`no-progress:${basename(file.path)}`);
        break;
      }
      if (maxWindowsPerFile > 0 && windowIndex + 1 >= maxWindowsPerFile) {
        log(`window budget reached for ${basename(file.path)}, continuing next run at ${cursor}`);
        break;
      }
    }

    if (complete && totalMessages < 2) { report.skipped++; log(`skip (no conversation text) ${basename(file.path)}`); }
    if (complete) report.processed++;
    if (writtenHere) log(`${workspaceId} :: ${basename(file.path)} -> +${writtenHere} memories${complete ? "" : " (partial, resumes next run)"}`);
  }

  if (!options.dryRun) saveNightlyState(state, stateFile);
  return report;
}

/**
 * Completion hook that shells out to the pi CLI. A nightly process has no pi
 * session, so it cannot use the in-host pilot; `pi -p --no-session --no-tools`
 * reuses the user's configured provider, model list, and stored credentials
 * with zero extra secret.
 */
export function makePiCliComplete(options: { cli?: string; model?: string; thinking?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  const cli = options.cli || process.env.PI_MEMORY_NIGHTLY_CLI || "pi";
  const env = options.env || process.env;
  const model = options.model ?? env.PI_MEMORY_NIGHTLY_MODEL ?? env.PI_MEMORY_LLM_MODEL ?? "";
  const thinking = options.thinking ?? env.PI_MEMORY_NIGHTLY_THINKING ?? "";
  const timeoutMs = options.timeoutMs ?? Number(env.PI_MEMORY_NIGHTLY_TIMEOUT_MS || 180000);

  return async (messages: Array<{ role: "system" | "user"; content: string }>): Promise<string> => {
    const system = messages.find((m) => m.role === "system")?.content || "";
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const file = join(tmpdir(), `pi-memory-nightly-${randomBytes(6).toString("hex")}.md`);
    writeFileSync(file, `${system}\n\n---\n\n${user}`, { mode: 0o600 });
    const resolved = resolvePiCli(cli);
    if (!resolved) {
      throw new Error(`pi CLI not found (looked for "${cli}" on PATH=${process.env.PATH || ""}); set PI_MEMORY_NIGHTLY_CLI or PI_MEMORY_LLM_URL`);
    }
    const args = ["-p", "--no-session", "--no-tools", "--mode", "text"];
    if (model) args.push("--model", model.split(":")[0]);
    if (thinking) args.push("--thinking", thinking);
    args.push(`@${file}`, "Apply the instructions at the top of the attached file. Reply with the JSON object only.");
    try {
      const result = spawnSync(resolved, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: childEnv() });
      if (result.error) throw result.error;
      const text = String(result.stdout || "").trim();
      if (result.status !== 0 && !text) throw new Error(`pi CLI exit ${result.status}: ${String(result.stderr || "").slice(0, 300)}`);
      if (!text) throw new Error("pi CLI returned no text");
      return text;
    } finally {
      try { writeFileSync(file, ""); } catch { /* temp cleanup is best effort */ }
    }
  };
}

/**
 * launchd hands the job a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), which
 * almost never contains the node-global `pi`. Resolve the binary once, from the
 * usual homes, so a scheduled sweep is not silently downgraded to "no model".
 */
export function resolvePiCli(configured = 'pi', env: NodeJS.ProcessEnv = process.env, home = homedir()): string | null {
  if (configured.includes('/')) return isFile(configured) ? configured : null;
  for (const dir of (env.PATH || '').split(':').filter(Boolean)) {
    if (isFile(join(dir, configured))) return join(dir, configured);
  }
  // Version managers nest `bin` at unpredictable depths (~/.nvm/versions/node/
  // v24/bin, ~/.workbuddy/binaries/node/versions/22/bin), so walk those roots
  // a few levels down instead of guessing the layout.
  const roots = [join(home, '.workbuddy/binaries'), join(home, '.nvm/versions'), join(home, '.volta'), join(home, '.local/share/mise'), '/usr/local', '/opt/homebrew'];
  for (const root of roots) {
    const found = findBinary(root, configured, 4);
    if (found) return found;
  }
  return null;
}

function findBinary(dir: string, binary: string, depth: number): string | null {
  const direct = join(dir, 'bin', binary);
  if (isFile(direct)) return direct;
  if (depth <= 0) return null;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const entry of entries) {
    if (!entry || entry.startsWith('.')) continue;
    const found = findBinary(join(dir, entry), binary, depth - 1);
    if (found) return found;
  }
  return null;
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

/**
 * The nested `pi -p` must not talk back to the memory backend: with
 * PI_MEMORY_BACKEND set it would load this very plugin and start recalling or
 * capturing from the sweep's own prompt. Dropping the selector makes the child
 * a pure model call.
 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["PI_MEMORY_BACKEND", "MEMORY_CONFIG_FILE", "PI_MEMORY_WORKSPACE_ID", "MEMORY_WORKSPACE_ID", "OV_DEBUG_LOG"]) delete env[key];
  return env;
}

export function defaultNightlyWorkspaceLabel(cwd: string): string {
  return resolveWorkspaceIdentity({ cwd }).id;
}

/**
 * Launch the standalone sweep script as a child process. Used by the
 * `/memory-nightly` command so a manual run behaves exactly like the
 * scheduled one instead of duplicating its wiring.
 */
export function runNightlySweepProcess(options: { extraArgs?: string[]; timeoutMs?: number; scriptPath?: string } = {}): Promise<{ ok: boolean; summary: string; output: string }> {
  const script = options.scriptPath || fileURLToPath(new URL("../scripts/nightly-sweep.mjs", import.meta.url));
  const args = ["--experimental-strip-types", "--no-warnings", script, ...(options.extraArgs || [])];
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { env: process.env, timeout: options.timeoutMs ?? Number(process.env.PI_MEMORY_NIGHTLY_TIMEOUT_MS || 1800000) });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += String(chunk); });
    child.stderr?.on("data", (chunk) => { output += String(chunk); });
    child.on("close", (code) => {
      const lines = output.trim().split("\n").filter(Boolean);
      resolvePromise({ ok: code === 0, summary: lines[lines.length - 1] || `exit ${code}`, output });
    });
    child.on("error", (error) => resolvePromise({ ok: false, summary: String(error?.message || error), output }));
  });
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function safeReadDir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
