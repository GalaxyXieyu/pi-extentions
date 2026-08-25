# Changelog

## 0.2.9 - 2026-08-25

### Fixes

- Cross-kind correction matching: sentences like "记住…改成 GitHub Actions" (profile) now collide with the older "…只用 Jenkins" record (event) instead of silently writing a second memory — the pair goes to the conflict gate and TUI confirmation.

## 0.2.8 - 2026-08-25

### Fixes

- preserve-and-confirm (default) now overrides LLM arbitration: supplement/supersede stay conflict → TUI confirmation; only MEMORY_CONFLICT_POLICY=auto-merge applies arbitration automatically.

## 0.2.7 - 2026-08-25

### Fixes

- Ship the dual-query conflict lookup (searchAll) that was missing from the
  0.2.6 tarball; correction signals no longer steal memory kind on classify.

## 0.2.6 - 2026-08-25

### Fixes

- Correction/update words (改成/换成/迁移到) no longer steal the memory kind
  during classification — "记住...用 Jenkins" and "记住...改成 GitHub Actions"
  now classify to the same kind so update conflicts are detected.
- Conflict lookup now runs a dual query (original + correction-stripped text)
  so the replaced memory is found even when the store is flooded with test
  duplicates.

## 0.2.5 - 2026-08-25

### Features

- LLM conflict arbitration: rule-triggered conflicts are refined by an LLM
  classification (duplicate/supplement/supersede/conflict/unrelated) —
  duplicate→skip, supplement→merge, high-confidence supersede→supersede,
  unrelated→create, rest falls back to pending_review + human review.
  Zero-config: inherits the pi session's model/auth through the pilot
  completion hook; any LLM failure falls back to plain rules.
- `viking_memory_remember` now runs the same conflict gate as automatic
  capture — a remembered fact that contradicts an existing memory becomes
  a pending review instead of silently writing a second record.

### Fixes

- Conflict raised by the remember tool now flows into turn_end so the TUI
  confirmation prompt (MEMORY_REVIEW_MODE=confirm) fires.

## 0.2.4 - 2026-08-25

### Fixes

- Recall merged get_context with /api/memory/search hits so server-truncated events still reach the model; normalized `result_list` + `context_parts` shapes in `flattenContextParts`; raised coding event quota 1→5 after e2e showed remembered facts being cut by the policy quota.

## 0.2.3 - 2026-08-25

### Fixes

- Viking recall returned 0 items after a successful remember: `get_context` returns bucket-shaped `context_parts` (events[]/profiles[]/messages[]) but `contextItems` expected flat keys. Added flattening before parsing — recall now returns search hits.

## 0.2.2 - 2026-08-25

### Features

- LLM curation funnel is now ON by default (auto):
  - rule hits never cost an LLM call; only the rule-miss tail invokes the LLM after batching thresholds (4 msgs / 1200 chars)
  - inherits the pi session's active provider/model/auth automatically — zero config
  - `PI_MEMORY_LLM_ENABLED=0` opts out to the pure zero-cost rule path

## 0.2.1 - 2026-08-25

### Features

- LLM curation inherits the pi session's active provider/model/auth via `ctx.modelRegistry.complete()` — zero standalone endpoint config
  - `PI_MEMORY_LLM_MODEL=provider/model` selects any configured pi model (auth inherited)
  - standalone `PI_MEMORY_LLM_URL` endpoint remains as fallback for non-catalog models (e.g. local Ollama)

## 0.2.0 - 2026-08-25

### Features

- Funnel capture: rule-based candidate extraction first, LLM batch extraction only for rule misses (`CurationQueue` with configurable thresholds `PI_MEMORY_LLM_BATCH_COUNT` / `PI_MEMORY_LLM_BATCH_CHARS`)
- LLM batch extraction protocol (`llm-extractor.ts`): add/noop/update decisions, Top-8 existing-memory window, OpenAI-compatible endpoint (`PI_MEMORY_LLM_ENABLED` / `PI_MEMORY_LLM_URL` / `PI_MEMORY_LLM_MODEL`), auto-fallback to rules on failure
- Conflict closure loop: conflicts become `pending_review` (no more dead-end), resurface in recall with `[待确认/与现有记忆冲突]` markers
- Human-in-the-loop confirmation: TUI `select` prompt on conflicts (`MEMORY_REVIEW_MODE=confirm`), default non-blocking `notify` mode
- Review tools: `viking_review` / `viking_memory_review` (list, accept-new, keep-old, merge)
- Temporal-intent recall rerank (`recall-rerank.ts`): "now/current" boosts recent facts, "last time/back then" boosts older ones
- Correction signals: "不对/错了/现在改成…" classify as high-confidence preference/decision candidates
- Proactive consolidation (`consolidation.ts`): scan ledger for near-duplicate/contradicting memories, promote to pending review (`viking-consolidate` / `viking-memory-consolidate`)
- Timeline history: superseded versions retained (not deleted) and annotated in recall as "历史版本"
- Source credibility: user/agent/system source affects candidate confidence
- `validUntil`/`supersedes`/`contradicts` fields wired into decision flow

### Fixes

- Tool results no longer leak into memory capture when `captureToolResults=false` (adapter-level filtering)
- `:memory:` lifecycle fixtures no longer write files into the working directory (lifecycle-store/observability honors the in-memory marker)

### Documentation

- New PRD: `docs/memory-system-prd.md` (pain points by storage/security dimension, competitor analysis, security design, layered retrieval plan)
- New implementation doc: `docs/memory-lifecycle-and-merge.md`