# Changelog

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