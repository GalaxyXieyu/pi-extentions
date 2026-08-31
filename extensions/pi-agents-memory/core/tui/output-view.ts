/**
 * Memory tool result renderer — turns raw memory tool output into a Pi TUI
 * "memory card": a one-line collapsed summary, status colouring
 * (pending/success/error/empty/warning), an expand hint, and full detail on
 * expand. Same standard pi-tui component pattern used by pi-hermes-memory's
 * shared output view, but with ZERO third-party dependencies — it only relies
 * on `keyHint` (re-exported by @earendil-works/pi-coding-agent, which the
 * plugin already imports) and self-contained ANSI/width helpers. This keeps the
 * plugin a single bare directory that Pi can load from any location.
 */

export type MemoryCardStatus = "success" | "failure" | "empty" | "warning";

/**
 * Expand-hint text. A plain, dependency-free label: the renderer must not
 * import from @earendil-works/pi-coding-agent so it can be unit-tested and
 * loaded outside Pi. (Inside Pi the tool row already shows an expand affordance
 * from the built-in tool-execution component; this is a secondary hint.)
 */
export function expandHint(): string {
  return "(to expand)";
}

export interface MemoryCardView {
  summary: string;
  expandedText: string;
  status: MemoryCardStatus;
}

interface CardTheme {
  fg?: (color: string, text: string) => string;
  getBgAnsi?: (color: string) => string;
}

export interface MemoryCardOptions {
  /** Show "(to expand)" hint when there is hidden detail. */
  hint?: boolean;
  /** Prefix shown while a tool is still streaming. */
  partialPrefix?: string;
  /** Optional maximum display width for the collapsed summary. 0 means auto. */
  maxSummary?: number;
}

type CardBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

/* ---------- dependency-free helpers ---------- */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\p{Cc}\p{Cs}\uFFF9-\uFFFB]/gu;

/** Strip ANSI escape sequences plus stray control chars (keep \n and \t). */
export function sanitizeDisplay(text: string): string {
  return text.replace(ANSI_RE, "").replace(CONTROL_RE, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));
}

/** Visible (display) width, counting wide/emoji chars as width 2. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0 || code === 27) continue;
    width += (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) || (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x1f900 && code <= 0x1f9ff))) ? 2 : 1;
  }
  return width;
}

/** Truncate to a display width, appending ellipsis. */
export function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  const tail = ellipsis;
  const tailW = visibleWidth(tail);
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = visibleWidth(ch);
    if (w + cw + tailW > width) return out + tail;
    out += ch;
    w += cw;
  }
  return out;
}

/** Slice a string by columns (preserving wide chars) from offset for length. */
export function sliceByColumn(text: string, offset: number, length: number, _preserve = true): string {
  let out = "";
  let col = 0;
  for (const ch of text) {
    const cw = visibleWidth(ch);
    if (col + cw <= offset) { col += cw; continue; }
    if (col < offset + length && col + cw > offset) {
      out += ch;
      col += cw;
      if (col >= offset + length) break;
    } else {
      col += cw;
      if (col >= offset + length) break;
    }
  }
  return out;
}

/* ---------- adapters ---------- */

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    const block = record(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function reasonOf(details: Record<string, unknown> | null): string {
  for (const value of [details?.error, details?.message, details?.reason]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Adapt an arbitrary tool result (the object a tool returns from execute) into
 * a MemoryCardView. Recognised shapes:
 *  - memory search arrays: items have { kind, content/summary, id/uri, score, scope }
 *  - generic { summary?, expandedText?|content, error?/isError? }
 */
export function normalizeMemoryCardView(input: unknown): MemoryCardView {
  const result = record(input);
  if (!result) {
    const text = typeof input === "string" ? input : JSON.stringify(input);
    return { summary: sanitizeDisplay(text), expandedText: sanitizeDisplay(text), status: "empty" };
  }

  const details = record(result.details);
  const expandedRaw = textBlocks(result.content).join("\n") || String(result.expandedText || result.text || "");
  const expandedText = sanitizeDisplay(expandedRaw);
  const reason = sanitizeDisplay(reasonOf(details));
  const failure =
    result.isError === true ||
    result.accepted === false ||
    details?.isError === true ||
    details?.success === false;

  // Memory search results: arrays under details.results / details.items.
  const arrays = [details?.results, details?.items].filter((x) => Array.isArray(x)) as Array<Array<Record<string, unknown>>>;
  const items = arrays[0] || [];

  if (items.length) {
    const lines = items.map((item, i) => {
      const kind = String(item.kind || item.memory_type || "memory");
      const body = String(item.content || item.summary || item.abstract || item.text || "").trim();
      const source = String(item.uri || item.source || item.id || "").trim();
      const score = typeof item.score === "number" ? ` ${item.score.toFixed(2)}` : "";
      const label = body.trim() || source || `item ${i + 1}`;
      return `[${kind}${score}] ${label}`;
    });
    const kinds = items.map((it) => String(it.kind || it.memory_type || "item")).join(", ");
    return {
      summary: `Found ${items.length} memor${items.length === 1 ? "y" : "ies"}: ${kinds}`,
      expandedText: lines.join("\n"),
      status: "success",
    };
  }

  if (failure) return { summary: reason || firstLine(expandedText) || "Error", expandedText, status: "failure" };
  if (expandedText.trim()) return { summary: firstLine(expandedText), expandedText, status: "success" };
  return { summary: reason || "No output", expandedText, status: "empty" };
}

/* ---------- rendering ---------- */

function themed(theme: CardTheme | undefined, status: MemoryCardStatus, partial: boolean, text: string): string {
  if (typeof theme?.fg !== "function") return text;
  const color = partial ? "warning" : status === "failure" ? "error" : status === "empty" ? "muted" : "toolOutput";
  return theme.fg(color, text);
}

function restoreBg(text: string, background: CardBackground, theme: CardTheme | undefined): string {
  if (typeof theme?.getBgAnsi !== "function") return text;
  const ansi = theme.getBgAnsi(background);
  return text.replace(ANSI_RE, `$&${ansi}`);
}

function compactSummary(summary: string, width: number, preserveTail: boolean): string {
  if (visibleWidth(summary) <= width) return summary;
  if (!preserveTail || width < 13) return truncateToWidth(summary, width, "…");
  const tailWidth = Math.max(6, Math.floor(width / 2));
  const headWidth = Math.max(3, width - tailWidth - 1);
  const fullWidth = visibleWidth(summary);
  return `${sliceByColumn(summary, 0, headWidth, true)}…${sliceByColumn(summary, Math.max(0, fullWidth - tailWidth), tailWidth, true)}`;
}

/** Create a Pi tool renderResult that draws a memory card for a given tool. */
export function createMemoryCardRenderer(
  adapt: (result: unknown) => MemoryCardView = normalizeMemoryCardView,
  cardOptions: MemoryCardOptions = { hint: true },
) {
  return (result: unknown, options: any, theme: CardTheme, context?: { isError?: boolean }): {
    render(width: number): string[];
    invalidate(): void;
  } => {
    const view = adapt(result);
    const summary = sanitizeDisplay(view.summary);
    const expandedText = sanitizeDisplay(view.expandedText);
    const isPartial = !!options?.isPartial && !/progress|partial|in progress|处理中|完成/i.test(summary);
    const status: MemoryCardStatus = context?.isError ? "failure" : view.status;
    const background: CardBackground = isPartial
      ? "toolPendingBg"
      : context?.isError
        ? "toolErrorBg"
        : status === "failure"
          ? "toolErrorBg"
          : status === "empty"
            ? "toolPendingBg"
            : "toolSuccessBg";

    if (options?.expanded) {
      return {
        render(width: number): string[] {
          return (expandedText || summary).split("\n");
        },
        invalidate(): void {},
      };
    }

    return {
      render(width: number): string[] {
        const availableWidth = Math.max(1, width);
        const partialPrefix = isPartial && cardOptions.partialPrefix ? `${cardOptions.partialPrefix} ` : "";
        const fullSummary = `${partialPrefix}${summary}`;
        const hasHidden = expandedText.trim() !== summary.trim();
        const hint = cardOptions.hint && hasHidden ? ` ${expandHint()}` : "";
        const hintWidth = visibleWidth(hint);
        const visibleHint = hintWidth < availableWidth ? hint : "";
        const summaryWidth = Math.max(1, Math.min(
          availableWidth - visibleWidth(visibleHint),
          cardOptions.maxSummary && cardOptions.maxSummary > 0 ? cardOptions.maxSummary : availableWidth,
        ));
        const collapsed = compactSummary(fullSummary, summaryWidth, status === "failure" || /warning/i.test(fullSummary));
        const line = themed(theme, status, isPartial, `${collapsed}${visibleHint}`);
        return [restoreBg(line, background, theme)];
      },
      invalidate(): void {},
    };
  };
}