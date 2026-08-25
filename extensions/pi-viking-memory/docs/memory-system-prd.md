# Pi Agent Memory 系统 PRD

## 1. 文档目的

本 PRD 定义 Pi 长期记忆系统（pi-viking-memory）应该"做什么、为什么做、做到什么程度"，用于对齐实现、评审、迭代。

**In scope**

- 跨会话记忆的捕获、抽取、合并、召回与人工确认闭环
- 双后端接入：OpenViking（本地/自托管）与 Viking Memory（云端 API）
- 存储治理：记忆分层、时间线、去重、盘点
- 安全：脱敏、scope 隔离、注入防护、审计
- 成本治理：默认零 LLM 成本、可选本地模型增强

**Out of scope**

- OpenViking / Viking Memory 服务端自身的能力改造
- 多模态（图片、音视频记忆）
- 记忆的图数据库实现与实体关系图谱

---

## 2. 背景与问题

### 2.1 背景

Pi 是一个本地 CLI coding agent。单会话上下文是工作记忆，但以下场景需要跨会话的长期记忆：

1. "这个项目后续都用 pnpm"一周后开新会话还要被问
2. "上次那个端口冲突的坑是怎么修的"——维修记录早已随会话消失
3. "我们决定把 CI 从 Jenkins 迁到 GitHub Actions"——决策本身需要留存并可追溯
4. 用户偏好（回复语言、风格、项目约定）需要稳定跨会话

因此需要一套长期记忆层：**会话消息是原料，长期记忆是产品**。

### 2.2 用户故事


| 编号   | 故事                                           | 对应功能                      |
| ---- | -------------------------------------------- | ------------------------- |
| US-1 | 作为用户，我希望项目级偏好（工具链、语言）跨会话自动生效，不必每次重申          | 候选抽取 + 召回注入               |
| US-2 | 作为用户，当我修正一个过时事实（"不再是 X 了"）时，系统应识别为高置信变更并可控处理 | 纠错信号 + 合并决策               |
| US-3 | 作为用户，当新旧记忆冲突时，要有 TUI 弹窗让我当场选择，而不是静默覆盖或静默丢失   | HITL 确认闭环                 |
| US-4 | 作为用户，我希望被替代的旧记忆保留可查（"当时为什么用的 A"），而不是被删除      | 时间线/validUntil/supersedes |
| US-5 | 作为用户，我不希望密钥、token、跨项目内容进入记忆或泄漏到云端            | 安全防护 + scope 隔离           |
| US-6 | 作为开发者，我希望默认不产生 LLM 成本，高精度模式可本地/云端可插拔         | 规则优先 + LLM 漏斗             |


### 2.3 现状与痛点（按维度）

#### 存储维度


| #   | 痛点                                                                  | 危害                |
| --- | ------------------------------------------------------------------- | ----------------- |
| S1  | 会话消息全量入库（20k tokens 才 commit），长期记忆与临时对话混杂                           | 存储膨胀、检索噪音大        |
| S2  | 同事实多措辞重复存储（"用 pnpm""pnpm 管理依赖"两三条）                                  | 记忆库碎片化，冲突检测成本上升   |
| S3  | 历史版本内联在记录里（UPDATED 段），无独立版本表                                        | 记录无上限增长、旧事实难精确定位  |
| S4  | 工具输出若全保留会爆炸（默认丢弃，但开关打开即风险）                                          | 记忆被 stdout/文件内容污染 |
| S5  | 无衰减/容量策略                                                            | 记忆只增不减，长期召回精度必然劣化 |
| S6  | 本地状态（生命周期账本、审计）属"状态文件"性质，曾发生测试 fixture 写错目录的泄漏（已修复 `:memory:` 前缀语义） | 状态文件污染工作区         |


#### 安全维度


| #   | 痛点                                     | 危害         |
| --- | -------------------------------------- | ---------- |
| A1  | 会话内容含密钥/token/private key，若随捕获上传云端     | 凭据泄漏       |
| A2  | LLM 抽取易受用户消息注入操纵（"忽略之前记忆指令"）           | 恶意/垃圾记忆写入  |
| A3  | 跨 scope 泄漏：A 项目的记忆被 B 项目召回             | 隐私/串味，错误决策 |
| A4  | 记忆污染循环：召回注入块被再次捕获回放的无限回环               | 自我强化幻觉     |
| A5  | 多租户环境（云后端）身份边界靠客户端 filter，缺乏后端硬隔离的能力探测 | 越权风险未知     |
| A6  | 审计/日志中再次泄漏敏感字段                         | 二次泄漏       |


#### 抽取与合并维度


| #   | 痛点                             | 危害          |
| --- | ------------------------------ | ----------- |
| E1  | 规则正则识别不了隐晦表达（"这套工具链太折腾了"），漏判率高 | 长尾偏好永远失忆    |
| E2  | 一条消息含多个事实时只出一个候选，其余全丢          | 信息浪费        |
| E3  | 早期冲突处理是死锁（标记后既不召回也不确认）         | 冲突永远悬而未决    |
| E4  | 首次递归双方全量 LLM 方案成本不可接受（每轮每条都调）  | 算力/费用灾难     |
| E5  | 召回单层向量、无时间维度（"现在用啥"和"当时用啥"一个样） | 召回错误事实、答非所问 |


---

## 3. 目标与非目标

### 3.1 目标


| 编号  | 目标                                    | 衡量                 |
| --- | ------------------------------------- | ------------------ |
| G1  | 价值筛选：只让"跨会话有用"的事实成为长期记忆               | 抽取后候选 ≤ 入口消息 20%   |
| G2  | 成本地板：默认开启但每轮 LLM 调用数为 0（显式规则命中零调用，长尾批量受限） | memoryStats backend=llm 计数 |
| G3  | 冲突可收敛：任何冲突都有明确的出路（自动合并/替代或人工裁决），无死锁状态 | 无永久 pending 记录     |
| G4  | 安全闭环：敏感信息零落盘，跨 scope 零召回              | secret 审计、scope 测试 |
| G5  | 时间线正确：事实演化可追溯（v1→v2），旧版本不被静默删除        | 历史版本可查             |
| G6  | 可插拔增强：LLM 抽取、确认交互模式均可配置，失败自动降级        | 配置项 + 回退测试         |


### 3.2 非目标


| 编号  | 非目标                          | 理由                      |
| --- | ---------------------------- | ----------------------- |
| NG1 | LLM 全量接管抽取（每条消息都过模型）         | 违背 G2 成本地板              |
| NG2 | 自己研发通用向量数据库                  | 双后端已提供检索，客户端不做存储引擎      |
| NG3 | 让 agent 自律管理记忆（Letta 模式、无规则） | 无兜底不可控，已排除              |
| NG4 | 项目初期即实现衰减/遗忘引擎 + 完整版本表       | 单用户本地场景记忆量小，属过度设计，列入 P1 |


## 4. 竞品分析

### 4.1 竞品概览


| 竞品                        | 定位                    | 核心机制                                                                                                                         |
| ------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Mem0**                  | 通用记忆 SDK/平台（社区最大）     | LLM 抽取（ADD-only 原则）+ 写入时 LLM 去重（ADD/NOOP/UPDATE 三选一）+ 显式 update/delete + SQLite 变更历史 + 混合检索（语义/BM25/实体/时间）                   |
| **Letta / MemGPT**        | 带动记忆引科学的 agent 平台     | 无独立冲突规则；agent 直接读写核心记忆块；围绕块/文件/档案三层做检索（DMR 基准被新一代超过）                                                                         |
| **reaatech/agent-memory** | 开源长期记忆库（主打"curation"） | LLM 抽取 + 余弦相似度 ≥0.85 冲突检测 + 四策略冲突解决（newest/oldest/highest-confidence/manual-review）+ pending_review 生命周期 + 指数衰减/遗忘 + 完整版本历史表 |
| **Zep Graphiti**          | 时序知识图谱式记忆服务           | 实体+时序边；矛盾用边失效（旧边保留可查）表达时间演化，不删除                                                                                              |
| **OpenViking**            | 本地可部署的上下文数据库（我们已接入）   | 服务端 session commit + 抽取流水线（跳过/合并/删除）+ 目录制记忆（profile/preferences/events/cases/trajectories…）+ 三层内容（抽象/概述/全文）+ 配额分层检索          |


### 4.2 关键对比

**核心机制对比**


| 维度   | 我们（当前 v0.3）                                                       | Mem0             | reaatech            | Letta    | Zep        | OpenViking                   |
| ---- | ----------------------------------------------------------------- | ---------------- | ------------------- | -------- | ---------- | ---------------------------- |
| 抽取   | 规则优先 + 可选 LLM 批量（默认关）                                             | LLM（必需）          | LLM+重要性/置信度         | agent 自写 | LLM 抽实体/事件 | 服务端 LLM（黑盒）                  |
| 默认成本 | **零 LLM**                                                         | 每次 add 必调        | 每次必调                | 无        | 每次必调       | 服务端算力                        |
| 冲突检测 | 语义检索+同 kind/scope（LLM 路径 Top-8）                                   | 写入时查旧记忆再比        | 余弦 ≥0.85            | 无        | 时序边冲突      | 服务端 dedup                    |
| 合并决策 | `create/skip/merge/supersede/conflict` 规则 + LLM `add/noop/update` | LLM 三选一          | 四策略可插拔              | 无        | 边失效保留时间线   | 服务端 skip/create/merge/delete |
| 冲突出路 | **pending_review + TUI 确认 + review 工具**                           | 显式 update/delete | pending_review+自动策略 | —        | 旧边保留       | 服务端裁决                        |


**能力对比**


| 维度     | 我们                                          | Mem0            | reaatech            | Letta | Zep     | OpenViking  |
| ------ | ------------------------------------------- | --------------- | ------------------- | ----- | ------- | ----------- |
| 版本/时间线 | supersedes+validUntil+账本 history+recall 附历史 | SQLite history  | 完整版本表（最强）           | 块可编辑  | 时序图（最强） | 目录制+archive |
| 来源可信度  | user/agent 区分→置信度                           | attributed_to   | user/agent 区分       | 无     | 部分      | 无           |
| 遗忘/衰减  | 仅 validUntil ⏳                              | 平台 decay        | 指数衰减+遗忘引擎（最强）       | 无     | 时间衰减    | 无           |
| 召回信号   | 相似度+时间意图重排（本地零成本）                           | 语义+BM25+实体+时间四路 | 语义+rerank+diversify | 分层读取  | 时序感知    | 三层内容+配额     |
| 工具输出   | 默认丢弃只留动作摘要                                  | 调用方控制           | 抽取前脱敏               | —     | —       | 丢弃          |
| 部署     | pi 扩展内嵌、双后端可切                               | SDK/平台          | TS SDK+pgvector     | 自托管   | 托管/自托管  | 自部署服务       |


### 4.3 借鉴与舍弃

**借鉴（已/将落地）**

- Mem0 的 add/noop/update 三选一协议 → 我们的 LLM 抽取协议
- reaatech 的 pending_review + 人工裁决 → 我们的 HITL 确认闭环
- Zep 的边失效不删除 → 我们的 supersedes + 历史版本 + 时间线召回
- Mem0/OpenViking 的多信号/多层级检索 → 我们的时间意图重排 + 分层检索规划（§9）

**舍弃（刻意不学）**

- Letta 的 agent 自管理块模式：无规则兜底，不可审计
- 全量 LLM 抽取：违背 G2 成本地板
- reaatech 的完整衰减引擎 + 版本表工程：单用户本地场景初期过度设计

## 5. 我们的架构（当前搭建）

### 5.1 总体架构

```text
                     Pi 会话（branch entries）
                              │
              ┌───────────────▼────────────────┐
              │    ① 捕获层（capture-adapter）    │   去注入块/脱敏/工具输出丢弃(默认)
              └───────────────┬────────────────┘
                              ▼
              ┌───────────────────────────────┐
              │     ② 决策漏斗（两段式）         │
              │   规则抽取命中 → 直接决策          │
              │   规则未命中 → CurationQueue     │
              │        ↓ 批量阈值触发            │
              │   ③ LLM 抽取(可选,默认关)         │
              └───────┬───────────────┬────────┘
                      │ 候选+决策      │ 低价值/后门
                      ▼               ▼
        ┌──────────────────┐  ┌──────────────────┐
        │ ④ 合并决策/Lifecycle │  │ ⑤ 双后端 session    │
        │ create/skip/merge  │  │   写入(batch)      │
        │ supersede/conflict │  └──────────────────┘
        └───────┬───────────┘              │ commit
                │ 生命周期账本           (服务端兜底抽取)
                ▼
        ┌──────────────────────────────────────┐
        │ ⑥ 召回管线（pending_review 重浮出/时间线  │
        │   + 时间意图重排 + scope 过滤）           │
        └──────────────────────────────────────┘

  后端：OpenViking（session/uri/commit） | Viking Memory（event/profile/session API)
```

### 5.2 核心概念


| 概念              | 定义                                                                                |
| --------------- | --------------------------------------------------------------------------------- |
| **消息**          | Pi 会话中的一条原始消息（role/content/tool parts），经清洗后为捕获单元                                  |
| **会话**          | 后端的 session（OpenViking `pi-<sessionId>` 或 Viking session_id），是长期记忆的原料仓            |
| **候选**          | 一条消息中抽取出的"可能是长期记忆"的单元（kind/scope/confidence/sourcedata）                           |
| **记忆记录**        | 已判定为长期记忆的持久单位（含状态、所有者、来源、supersedes/contradicts 时间线字段）                            |
| **生命周期账本**      | 本地 Ledger：每份记忆的 fingerprint、remoteId、状态变迁史、lastAccessed（驱动 pending_review、时间线、盘点） |
| **fingerprint** | `tenant                                                                           |


### 5.3 双后端接入


| 能力   | OpenViking                                  | Viking Memory（云）                      |
| ---- | ------------------------------------------- | ------------------------------------- |
| 会话   | POST session + 消息 + commit                  | session/add + get_context             |
| 记忆写入 | 直接写 URI（viking://~/memories/…） + session 兜底 | profile/event add/update + session 兜底 |
| 召回   | /search mode=context（服务端组装/配额/三层内容）         | get_context（事件+画像+短期）                 |
| 特有   | takeover（archive 替换历史）、commit 边界、目录浏览       | 云端托管、企业多租户                            |
| 适配差异 | client.ts（URI/commit/context face）          | client.ts（profile/event/session API）  |


### 5.4 写入管线（漏斗，G2 成本地板的实现）

```text
消息 → 安全扫描 → 规则抽取
  ├─ 命中 → 语义检索旧记忆 → decideMerge 全流程（零 LLM）
  └─ 未命中 → CurationQueue 跨轮累积
                  ↓ 达到阈值（默认 4 条 / 1200 字符）
              LLM 批量抽取（add/noop/update JSON，规则命中从未触发）
                  ↓ 失败/不可达
              回退重试，超限放弃（消息已入 session，无损失）
```

### 5.5 召回管线

```text
当前用户 prompt（完整文本）→ 后端语义检索
  → scope/身份/状态过滤（tenant+user+workspace，superseded/conflicted 不召回）
  → 时间意图重排（"现在/当前"偏新，"上次/当时"偏旧）
  → pending_review 打 [待确认] 标记重新浮出
  → 历史版本附注（v1: …）
  → <memory-context> 文本块注入用户消息前
```

## 6. 功能需求

### FR-1 会话捕获与清洗 ✅

- **描述**：turn_end 时从 Pi branch 提取新消息，剥离注入块（`<openviking-context>` 等）、脱敏、截断（`captureMaxLength` 默认 24000），工具调用保留 `[tool] name + input` 动作摘要，工具输出默认丢弃（`captureToolResults=false`）。
- **验收**：含密钥/注入块/超长/纯工具输出四种消息入参 → 清洗后不含密钥、注入块、工具输出，长度受控。已有测试覆盖。

### FR-2 敏感信息与注入防护 ✅

- **SF-2.1** 秘密扫描（API key/token/password/private key/明文 authorization）→ redact 或整条拒绝
- **SF-2.2** 提示注入模式（"忽略所有系统/记忆指令"）→ 安全门拒绝
- **SF-2.3** 人工 remember/profile 写入口同样强制扫描

### FR-3 规则候选抽取 ✅

- 正则粗筛出候选并给 kind（preference/project/decision/event/experience/workflow/profile）+ scope（preference→user，其他→workspace）
- 置信度：显式措辞（"改用/决定/以后/请记住"）&gt; 来源（user&gt;agent&gt;system）
- 单候选/条，多事实拆解交给 LLM 层

### FR-4 LLM 批量抽取漏斗 ✅（可选）

- `PI_MEMORY_LLM_ENABLED=1` 才启用；默认零 LLM 成本
- 输入三段：新消息批次 + Top-8 旧记忆 + 动作摘要；输出 `{action: add|noop|update, text, kind, scope, confidence, supersedes_id[]}`
- 局部 OpenAI 兼容端点（Ollama/qwen/llama/gemma 本地均可）
- 失败回退规则，重试上限 3

### FR-5 冲突检测与合并决策 ✅

- 本地规则路径：`create / skip / merge / supersede / conflict` + `preserve-and-confirm` 默认不覆盖
- LLM 路径：add/noop/update + supersedes_id
- 纠错信号："不对/错了/现在改成…" → 高置信 preference/decision 候选

### FR-6 pending_review 闭环 + HITL 确认 ✅

- conflict → 旧记忆与候选均入 ledger pending_review + contradicts 引用
- 三档交互：`MEMORY_REVIEW_MODE=notify`（默认，不阻塞通知）/ `confirm`（`ctx.ui.select` TUI 选项 accept-new/keep-old/merge/defer）/ `silent`
- 工具闭环：`viking_review`/`viking_memory_review`（list + 裁决）
- 非交互环境（子 agent/headless）自动 defer

### FR-7 时间线 ✅

- supersede 不物理删除旧内容，账面 transition 成 superseded
- 召回对 active 记录附"历史版本（旧内容 120 chars）"
- `memoryHistoryById` 提供 remoteId←版本映射

### FR-8 主动盘点 ✅

- 命令 `viking-consolidate`/`viking-memory-consolidate`：扫描账本同 kind+scope 高相似（dice≥0.6）active 记录，冲突/重复对主动提升 pending_review
- 非破坏性：只标记，不删除

### FR-9 观测与审计 ✅

- capture/review/consolidation/error 全部记入 memoryStats（jsonl）
- 审计命令 `viking-memory-audit`（脱敏后）

### FR-10 升级项（P1）— 分层检索（§9），衰减引擎观察

---

## 7. 非功能需求


| 编号    | 要求                       | 当前实现                                      |
| ----- | ------------------------ | ----------------------------------------- |
| NFR-1 | 每轮记忆总时延 &lt; 60s hook 预算 | 本地零成本规则即时；LLM 路径 20s 超时+回退，实测不阻塞          |
| NFR-2 | 漏斗限频：显式规则命中不调 LLM；长尾累计达阈值才批量调一次 | ✅ 默认开启 auto；`PI_MEMORY_LLM_ENABLED=0` 回纯规则零 LLM |
| NFR-3 | LLM 调用批量、去重              | 阈值批量 + fingerprint/哈希去重 + 重试上限            |
| NFR-4 | 后端不可用降级不崩溃               | 健康检查失败即 no-op；recall/capture 全部 fail-open |
| NFR-5 | 所有外部写敏感信息已脱敏，本地状态 0600   | ✅ 全链路 sanitize + 0o600 persist            |
| NFR-6 | 状态文件不污染任意目录              | ✅ `:memory:` fixture 不再落盘                 |


## 8. 安全设计

### 8.1 威胁模型（简化 STRIDE）


| 威胁                           | 场景                    | 对策                                                                |
| ---------------------------- | --------------------- | ----------------------------------------------------------------- |
| 注入(Spoofing)                 | 用户消息诱导模型/记忆系统写坏事实     | 注入模式扫描拒绝；LLM 输出二次校验（target id 必须来自检索结果，禁编造）                       |
| 篡改(Tampering)                | 冲突时静默覆盖旧记忆            | preserve-and-confirm 默认 + pending_review + 人工裁决                   |
| 泄漏(Disclosure)               | 密钥/跨租户进入云端            | 三重防线：secret 扫描 redact/reject → sanitize 链路 → scope 过滤 fail-closed |
| 权限(Elevation)                | metadata 伪装身份 scope   | 身份字段只用本地解析的 identity，云端返回由 tenant/user/workspace 严格比对             |
| 污染(Repudiation/Reproduction) | 注入块被当作新会话内容存回         | `sanitizeCapturedText` 在捕获前剥离注入块（对用户/助手双向）                        |
| 拒绝服务(DoS)                    | 超大型消息/工具输出阻塞 pipeline | 截断上限 + 超时（fetch 均有 timeout，无阻塞无限等）                                |


### 8.2 数据安全清单

- [x] secret/私有 key/授权头扫描（redact 或拒绝）
- [x] 全链路上传前 `sanitizeSensitiveValue`
- [x] 本地账本/统计文件 mode 0600
- [x] `:memory:` fixture 不落盘（修复）
- [x] LLM 抽取每一输出再次过扫描（`scanMemoryContent`）+ kind 白名单
- [x] 审计输出脱敏

### 8.3 隔离


| 隔离级     | 机制                                                                               |
| ------- | -------------------------------------------------------------------------------- |
| 租户      | `tenantId` 全链路 comparator；后端过滤 `tenant_id`                                       |
| 用户      | `userId`；云后端 profile 走用户域，召回强制本人                                                 |
| 项目/工作区  | workspace 由 git origin/显式 env 派生；召回 fail-closed（非本 workspace + 全局 profile 的绝不召回） |
| 子 agent | 独立进程/独立 session，天然隔离，HITL 自动 defer                                               |


### 8.4 授权

- `authorize()` permission gate：`memory:recall/capture/remember/profile`
- HITL 确认只能通过 `ctx.ui.select`（用户按键），review 工具需显式调用

### 8.5 审计

- lifecycle 账本每步 transition + reason + target
- `memoryStats`（events.jsonl）+ `audit.jsonl` 留痕，含 LLM decision/confidence、consolidation 提升、review 裁决

## 9. 分层检索设计（规划核心）

> 现状：只有单层向量召回 + 时间意图重排（已实现）↩ 本节定义目标分层模型与已实现份额。

### 9.1 目标

给检索按"价值密度/更新频率/预算"分层，做到：**常驻的少而精、按需的不超配额、全文的显式才读**。

### 9.2 分层模型


| 层             | 内容                                            | 数量级   | 预算策略                                                                  |
| ------------- | --------------------------------------------- | ----- | --------------------------------------------------------------------- |
| **L0 会话**     | 当前 session 上下文                                | ~会话内  | 由 Pi 自管，不参记忆注入                                                        |
| **L1 核心常驻**   | profile / preferences（用户级稳定事实）                | 小（百级） | session_start 注入，profileBudget（默认 10000 tok）                          |
| **L2 语义召回**   | project/decision/event/experience/workflow 摘要 | 中（千级） | 每轮检索；purpose 配额（已有 policy 配额；OpenViking quotas；Viking limit）；时间意图重排 ✅ |
| **L3 全文/事实点** | 记忆全文文件、viking:// 资源                           | 大     | 只在需要时读（viking_read/archive_expand），不进每轮注入                             |
| **L4 关系/图**   | 实体-实体关系（Mem0 实体链接 / Zep 时序边）                  | 可延后   | P2 观察                                                                 |


### 9.3 当前实现映射


| 层   | OpenViking 后端                                       | Viking Memory 后端                           | 客户端侧                                      |
| --- | --------------------------------------------------- | ------------------------------------------ | ----------------------------------------- |
| L1  | profile block（session-start `<openviking-context>`） | profile_search_config limit 1（get_context） | profileTokenBudget                        |
| L2  | /search mode=context + quotas + 三层内容 tier           | 事件语义 search limit+score                    | 时间意图重排 ✅ + pending_review 标注 ✅ + 历史版本附注 ✅ |
| L3  | 显式 viking_read/browse/archive_expand                | 无 URI 体系（云端无全文族）                           | —                                         |
| L4  | 未实现                                                 | 未实现                                        | —                                         |


### 9.4 待实现列表（P1）

1. **L2 配额落地**：OpenViking 路径把 policy purpose 配额（project 3/decision 3/experience 3…）绑定到 /search quotas，保证噪声类别不挤占 project 预算
2. **混合信号**：离线路由（BM25/字符串匹配）补强，对代码路径、命令、项目名这类字面查询做第二路召回
3. **L3 按需泛化**：把 viking_read 工具与 L2 命中绑定（分数超阈值且 detail=abstract 时给出"读全文"hint）
4. **衰减接入**：用 ledger 的 lastAccessedAt（已记录）+ validUntil 让 L2 冷记忆降级为 L3-only（不每轮召回）
5. **L1 收紧**：profile 注入只在内容有更新时重读，否则缓存

### 9.5 分层检索验收标准

- 每轮注入的 L2 条目 ≤100，超时按配额+分数截断不报错
- 时间意图查询排序与静态查询排序可测（已有测试）
- L3 读取不占用 L2 预算
- 冷记忆（90 天无访问）不再出现在 L2 结果

## 10. 里程碑


| 阶段      | 内容                                             | 状态           |
| ------- | ---------------------------------------------- | ------------ |
| M0 v0.1 | 双后端捕获+召回基础、规则决策、审计                             | 已完成（历史）      |
| M1 v0.2 | 工具输出过滤、pending_review、supersedes 时间线字段、来源可信度   | ✅ 已交付（96 测试） |
| M2 v0.3 | 漏斗（规则优先+LLM兜底）、HITL 确认、纠错信号、时间意图重排、主动盘点、历史版本召回 | ✅ 已交付        |
| M3（P1）  | §9.4 分层检索完善：配额绑定、混合信号、冷记忆降级、L1 缓存              | ⏳ 规划         |
| M4（P2）  | 衰减/遗忘引擎、版本历史表（观察 reaatech 实践）                  | 🔮 观察        |


## 11. 成功指标


| 指标           | 当前度量来源                       | 目标                   |
| ------------ | ---------------------------- | -------------------- |
| recall 命中相关率 | memoryStats 召回计数/审计反馈        | 逐步追踪                 |
| 冲突判断误报率      | conflict→review 流量的 audit 结果 | &lt;10%（观测）          |
| 冲突裁决时间       | ledger history 时间戳           | &lt;1 会话（confirm 模式） |
| LLM 增强抽取调用/轮 | memoryStats backend=llm      | 仅 rule-miss 轮次       |
| 污染回环         | audit 中 recall-block 检测      | 0 事故                 |
| 成本           | 本地模型/云端计费                    | 默认 0                 |


## 12. 风险与开放问题

1. **风险**：`MEMORY_REVIEW_MODE=confirm` 在 `turn_end` 里 `ctx.ui.select` 阻塞——真实 pi TUI 未按验，非交互环境已 defer 但需实测。
2. **风险**：OpenViking /search 的 quotas/purpose 参数具体语义靠服务端文档推断，M3 前需建探测样例。
3. **开放**：云后端的计费模型（session/add 是否触发服务端抽取）官方文档未知，成本评估占位。
4. **开放**：绘图式关系层（L4）是否值得接实体链接，留待召回质量数据出来再定。

