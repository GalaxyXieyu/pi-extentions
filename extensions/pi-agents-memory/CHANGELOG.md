# Changelog

## 0.3.1 - 2026-08-31

### Fixes

- **修好从 npm 安装时的夜间抹查**。`scripts/nightly-sweep.mjs` 之前靠 `tests/` 和 `providers/*/tests/` 里的 `.js -> .ts` resolve hook 加载 TypeScript 源码，而 `.npmignore` 不把 `tests/` 进包：npm 安装后定时任务会在读任何会话之前直接 `ERR_MODULE_NOT_FOUND` 退出（本地仓库开发时因为 `tests/` 存在而看不出来）。现在 `scripts/lib/{ts-resolver,register-loader}.mjs` 随身发布（已加入 `files`），一个全局 hook 覆盖整个包，不再依赖只用于测试的 loader。验证：`npm pack` 解出的包（无 `tests/`）能 `--dry-run` 扫完 3 个会话。

## 0.3.0 - 2026-08-31

### Breaking

- **改名：`pi-viking-memory` → `pi-agents-memory`**。包名、目录、用户可见文案、启动任务、状态目录、命令与工具名全部改拢。`viking-memory` / `openviking` 这两个 **backend id 不变**（它们是厂商产品名，`PI_MEMORY_BACKEND` 取值与 `VIKING_MEMORY_*` / `OPENVIKING_*` 环境变量照旧），`viking://` URI 方案也不变。
  - 命令：`/viking-memory*`、`/viking*` → `/memory`、`/memory-stats`、`/memory-audit`、`/memory-capabilities`、`/memory-workspace`、`/memory-consolidate`、`/memory-nightly`；**旧命令名保留为别名**（描述里会标“旧命令名”）。
  - 工具：`viking_memory_search|remember|profile|review` 与 `viking_search|read|browse|remember|add_resource|archive_expand|review` → `memory_search|read|browse|remember|add_resource|archive_expand|profile|review`。
  - 状态目录：`~/.pi/agent/pi-viking-memory` → `~/.pi/agent/pi-agents-memory`，`core/local-paths.ts` 首次使用时做一次原子重命名（lifecycle 账本、audit、夜间游标全部沿用，不会重新开始去重）。
  - launchd：`com.pi.viking-memory.nightly` → `com.pi.agents-memory.nightly`，`scripts/install-nightly.mjs` 会先 bootout 并删掉旧任务（旧 plist 里的脚本路径已经失效）。

### Fixes

- 夜间抹查的会话读取改为**流式字节窗口**（`readTranscriptWindow`）：不再 `readFileSync` 整个 jsonl。pi 的会话记录会保留每一次工具结果，长的能到几百 MB（实测机器上最大 396MB），旧实现会先吃进整文件再按 60k 字符丢掉开头，既爆内存又只抹到尾巴。现在每文件只持有一个 1MB 重用 buffer，非对话行在 `JSON.parse` 之前按字节头丢弃，单行超过 `PI_MEMORY_NIGHTLY_MAX_LINE_BYTES`（默认 2MB）直接跳过并计数。
- 夜间任务新增**逐文件游标**（`nightly-state.json` 存 `offset`）：超长会话可在多个晚上接着跑（`PI_MEMORY_NIGHTLY_MAX_WINDOWS` 限每轮窗口数），失败的窗口不推游标，仍在增长的会话下轮只读新增部分。

## 0.2.12 - 2026-08-31

### Changes

- **会话内不再调用模型**：新增 `PI_MEMORY_LLM_INLINE`，默认 `0`。规则未命中的长尾不再在 `turn_end` 里攒批跑 LLM，冲突仲裁也不再走模型（`makePilotComplete` 默认返回 null），对话不会因为记忆而等待。`PI_MEMORY_LLM_ENABLED` 仍是总开关，默认保持 `1`，以便夜间任务使用。
- **夜间会话摸查**：`core/nightly.ts` + `scripts/nightly-sweep.mjs` + `scripts/install-nightly.mjs`。每天 00:00（可改）扫描 `~/.pi/agent/sessions` 最近 26 小时的会话记录，按 workspace 分组，只送 user/assistant 文本，复用原有 `curateWithLlm()` + 新的 `provider.curateBatch()` 写入（同一套 secret 扫描与 lifecycle 门），最后跟一次 consolidation。
- 水位文件 `~/.pi/agent/pi-agents-memory/nightly-state.json` 记录 `size + mtime`，重复运行幂等；模型不可用的文件不标记，留给下次补跑。
- LLM 来源：优先 `PI_MEMORY_LLM_URL`（OpenAI 兼容端点），否则子进程 `pi -p --no-session --no-tools`，复用 pi 的 provider/凭据；子进程剔除 `PI_MEMORY_BACKEND` 等变量，避免嵌套 pi 再次加载本插件。
- 新命令 `/memory-nightly`（openviking 为 `/memory-nightly`）立即跑一次；`/memory`、`/memory` 状态行新增 `capture=rules-only, llm=nightly-sweep`。
- 文档：`docs/nightly-curation.md`。

## 0.2.11 - 2026-08-26

### Fixes

- Extraction tightened (rule + LLM paths): bare process words (做了/执行/报错/架构) no longer trigger events/experiences/decisions alone; questions, greetings, and open task narration are filtered out; the LLM extraction prompt now defaults to noop with a durable/stable/reusable gate and explicit NEVER list (one-off workarounds, conversation events, repo-readable details). Low-confidence (<0.5) LLM extractions are dropped. Stops project chatter and one-off task steps from flooding memory.
- Conflict review prompt redesigned: `VM conflict: new fact ... vs existing ...` (raw slice, markdown noise) → multi-line `Viking Memory 记忆冲突` with `formatConflictPreview` (strips markdown, collapses whitespace, CJK-aware truncation). notify text localized. The `VM` abbreviation is gone.

## 0.2.10 - 2026-08-25

### Features

- /memory status now prints the extension version for quick load-version checks.

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