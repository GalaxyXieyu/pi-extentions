# 记忆抽取策略：会话内纯关键词 + 夜间 LLM 摸查

默认行为（v0.2.12 起）：

- **正常会话**：`turn_end` 只做关键词/规则抽取，**不调用任何模型**，因此不会在对话中间产生等待，也不消耗会话 token。
- **夜间 00:00**：独立进程读取 pi 自己落盘的会话记录，做批量 LLM 抽取，写回当前后端。

## 会话内路径（纯规则）

`core/candidate-extractor.ts`：

- `classify()` 正则命中才产出候选：`记住/请记住/记得/以后(都|一直|就)/偏好/希望`→preference；`决定/确定/选定/采用/方案是`→decision；`根因是/已修复/验证通过/测试通过`→experience；`迁移到/已完成/上线了/切到/改用`→event；coding 场景下 `package.json/pnpm install/测试命令/workspace`→project；`不要/别用/不用/纠正`→preference。
- `isNoise()` 直接丢弃：问句、寒暄、`我先/让我/正在/接下来/我在看` 这类过程叙述。
- 命中后走 `core/runtime.ts::gateCapture()`：指纹去重 → `decideMerge()` → create / merge / supersede / conflict。冲突默认 `preserve-and-confirm`，进 `pending_review`，不自动覆盖。

规则没命中的消息只是原样同步进后端会话（云端抽取是兜底网），**不再**在会话里攒批喂 LLM。

## 夜间路径（LLM）

`core/nightly.ts` + `scripts/nightly-sweep.mjs`：

1. 扫 `~/.pi/agent/sessions/<cwd-slug>/*.jsonl`（`PI_MEMORY_SESSIONS_DIR` 可改），按 `mtime >= now - PI_MEMORY_NIGHTLY_HOURS`（默认 26 小时，故意大于 24 防漏）。
2. 每个文件首行的 `cwd` 决定 workspace（不信目录名编码，编码后无法反解），用 `resolveWorkspaceIdentity({ cwd })` 生成与插件一致的 workspace id；按 workspace 分组。
3. `readTranscriptWindow()` **流式**读一扇字符窗口：`fs.openSync` + 一个 1MB 重用 buffer 逐行扫描；session 头、`model_change` 和 `role:"toolResult"` 在 `JSON.parse` **之前**就按字节头丢弃；单行超 `PI_MEMORY_NIGHTLY_MAX_LINE_BYTES`（默认 2MB）直接跳过不缓冲，计入 `oversize`。
   - 为什么必须流式：pi 会话记录是 append-only 且保留每一次工具结果，实测单文件最大 396MB，而真正的 user/assistant 正文只有 34k 字符。整文件 `readFileSync` 会先吃几百 MB 内存，再按预算丢掉开头——长会话等于只抹到尾巴。
4. 每文件维护字节游标：窗口内再按 `PI_MEMORY_NIGHTLY_BATCH_CHARS`（默认 12000 字符）切批 → `curateWithLlm()` → `provider.curateBatch()`，和以前会话内漏斗用同一套 prompt、同一套 secret 扫描与 lifecycle 落库，所以夜间写入不会绕过冲突门。游标只在**整窗成功**后前进并落盘，崩了或模型挂一晚既不丢也不重复抽。
5. `PI_MEMORY_NIGHTLY_WINDOW_CHARS`（默认 60000）控制一扇窗口读多少正文；`PI_MEMORY_NIGHTLY_MAX_WINDOWS`（默认 0 = 不限制）限制每轮每文件读几扇窗口，超长会话可以跳好几个晚上接着抽。
6. 结束后按 workspace 跑一次 `consolidateLocal()`，把近似重复/矛盾项推到 `pending_review`（不想做这步加 `--no-consolidate`；它不看 `MEMORY_CONSOLIDATION_ENABLED`，那是会话内 takeover 用的开关）。

幂等：`~/.pi/agent/pi-agents-memory/nightly-state.json` 为每个文件记一个**字节游标** `offset`（外加 size/mtime/累计条数）。读到文件尾才算完成；会话还在增长时下一轮从游标接着读，只处理新增部分；模型不可用的那扇窗口不推游标，下次自动重跑。

## LLM 从哪来

`scripts/nightly-sweep.mjs` 按顺序选：

1. `PI_MEMORY_LLM_URL` 已设置 → 直接打这个 OpenAI 兼容端点（例：本地 Ollama `http://127.0.0.1:11434/v1`，模型名 `PI_MEMORY_LLM_MODEL`）。
2. 否则起子进程 `pi -p --no-session --no-tools --mode text @prompt.md`，复用 pi 现有 provider/模型/凭据，不需要额外配 key。
   - `PI_MEMORY_NIGHTLY_MODEL` / `PI_MEMORY_NIGHTLY_THINKING` 可单独指定夜间用的模型和 thinking 档位（建议 `off`，抽取不需要推理链）。
   - 子进程环境里会**删掉** `PI_MEMORY_BACKEND`、`MEMORY_CONFIG_FILE`、`PI_MEMORY_WORKSPACE_ID`，否则嵌套的 pi 会把这个记忆插件再加载一遍，对着抽取提示词自己召回/写入。

## 安装定时任务（macOS launchd）

```bash
cd extensions/pi-agents-memory
node scripts/install-nightly.mjs --dry-run   # 先看 plist
node scripts/install-nightly.mjs             # 默认 00:00，每天
node scripts/install-nightly.mjs --hour 0 --minute 0
node scripts/install-nightly.mjs --status
node scripts/install-nightly.mjs --uninstall
```

装完立刻手跑一次：`launchctl kickstart -k gui/$(id -u)/com.pi.agents-memory.nightly`

产物：

- `~/Library/LaunchAgents/com.pi.agents-memory.nightly.plist`（0644，不含密钥）
- `~/.pi/agent/pi-agents-memory/nightly.env`（0600，从当前 shell 里 `PI_MEMORY_/MEMORY_/VIKING_/OPENVIKING_/OV_` 前缀的变量种出来；**请在已导出 `MEMORY_API_KEY` 的终端里安装**，或用 `--force-env` 重写）
- `~/.pi/agent/pi-agents-memory/nightly.log` / `.out` / `.err`

笔记本合盖时错过的时间点，launchd 会在唤醒后补跑一次；想主动补：`npm run nightly -- --since-hours 30`。

## 开关一览

| 变量 | 默认 | 作用 |
|---|---|---|
| `PI_MEMORY_LLM_ENABLED` | `1` | 模型使用总开关；`0` = 连夜间抽取也只用规则 |
| `PI_MEMORY_LLM_INLINE` | `0` | 会话内 LLM 漏斗 + LLM 冲突仲裁；`1` 恢复旧行为 |
| `PI_MEMORY_NIGHTLY_HOURS` | `26` | 夜间窗口，往前捞多少小时 |
| `PI_MEMORY_NIGHTLY_BATCH_CHARS` | `12000` | 单次 LLM 调用的字符预算 |
| `PI_MEMORY_NIGHTLY_WINDOW_CHARS` | `60000` | 一扇流式窗口的正文字符预算 |
| `PI_MEMORY_NIGHTLY_MAX_WINDOWS` | `0` | 每轮每文件最多读几扇窗口（`0` = 读到文件尾） |
| `PI_MEMORY_NIGHTLY_MAX_LINE_BYTES` | `2097152` | 单行字节上限，超出直接丢弃不缓冲 |
| `PI_MEMORY_NIGHTLY_MAX_CHARS` | `60000` | 单份会话记录读取预算（超出丢最旧） |
| `PI_MEMORY_NIGHTLY_MODEL` | 空 | 夜间用模型 `provider/model`，空则用 pi 当前默认 |
| `PI_MEMORY_NIGHTLY_THINKING` | 空 | `off/minimal/low/…`，建议 `off` |
| `PI_MEMORY_NIGHTLY_CLI` | `pi` | 夜间调用的 CLI |
| `PI_MEMORY_NIGHTLY_TIMEOUT_MS` | `1800000` | 手动命令路径超时；launchd 侧单次 LLM 调用默认 180s |
| `PI_MEMORY_SESSIONS_DIR` | `~/.pi/agent/sessions` | 会话记录根目录 |
| `PI_MEMORY_NIGHTLY_STATE` | `~/.pi/agent/pi-agents-memory/nightly-state.json` | 水位文件 |
| `PI_MEMORY_NIGHTLY_LOG` | 空 | 追加日志文件（安装脚本会自动设） |

## 命令

- `/memory-nightly`（openviking 后端为 `/memory-nightly`）：立刻跑一次摸查，可带参数，如 `/memory-nightly --since-hours 6 --dry-run`。
- `/memory` 状态行会显示 `capture=rules-only, llm=nightly-sweep`；开了 `PI_MEMORY_LLM_INLINE` 时多一个 `+inline-llm`。

## 已知边界

- 夜间写入用的仍是当前 `PI_MEMORY_BACKEND` 配置；切换后端后记得重装 launchd 任务（plist 只引用 env 文件，改 `nightly.env` 也行）。
- `--dry-run` 不调模型，只打印会被送出去的批次规模。
- 会话记录里如果包含别的 tenant/user 的对话（共享机器），只按当前 env 身份写入，不会跨 workspace 合并。
