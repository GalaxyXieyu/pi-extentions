# pi-viking-memory

Pi 的统一记忆插件入口，同时支持两个后端：

- `viking-memory`：火山引擎 Viking Memory API
- `openviking`：本地或远程 OpenViking REST API

安装一次：

```bash
pi install ./extensions/pi-viking-memory
```

通过环境变量选择唯一主动后端：

```bash
export PI_MEMORY_BACKEND=viking-memory
# 或
export PI_MEMORY_BACKEND=openviking
```

两个后端不会同时自动召回或写入。

## 文档

- [记忆架构调研](./docs/memory-architecture-research.md)
- [企业多用户检索](./docs/enterprise-memory-retrieval.md)
- [生命周期与可观测性](./docs/memory-lifecycle-and-observability.md)
- [企业 Memory 产品策略](./docs/memory-product-policy.md)
- [本地 Docker OpenViking](./docs/local-openviking-docker.md)
- [抽取模板](./core/templates.md)
- [机器可读策略](./core/memory-policy.json)
- [统一 Provider 契约](./core/README.md)
- [Memory Platform 产品策略](./docs/memory-product-policy.md)

## 本地基础能力

当前插件已包含本地可用的基础控制层：

- `core/contracts.ts`：MemoryIdentity、MemoryRecord、RequestContext、ConfigV1
- `core/config-protocol.ts`：版本化 canonical config 与本地 fallback
- `core/content-scanner.ts`：secret/threat candidate gate
- `core/candidate-extractor.ts`：纠正、故障、偏好、项目候选分类
- `core/policy-engine.ts`：chat/coding priority、quota、status/confidence/expiry 过滤
- `core/lifecycle.ts`：candidate/confirmed/superseded/conflicted/expired 状态和合并决策
- `core/observability.ts`：脱敏 stats、事件日志和 session audit

当前提供的 Pi 命令：

```text
/viking-memory
/viking-memory-stats
/viking-memory-audit
/viking-memory-capabilities
/viking-capabilities
```

后台配置中心和外部鉴权尚未绑定；后续接入 `MemoryIdentityResolver` 和版本化配置 API，不需要重写 provider。

## 项目与全局记忆分层

不需要为每个项目维护 tenant/project/department 等一堆 ID。插件自动生成一个稳定 workspace ID：

1. `PI_MEMORY_WORKSPACE_ID` / `MEMORY_WORKSPACE_ID`：仅在你需要强制指定时设置；
2. 否则从 Git `origin` remote 生成：同一仓库在不同电脑、不同 clone 路径上仍是同一个 workspace；
3. 无 Git remote 时使用 cwd 指纹：安全地只限本机目录，不会和别的本地项目串。

召回是严格两层：**当前 workspace 的项目记忆** + **用户全局 profile**，不会召回其它项目的 event/project/decision。全局 profile 适合“回答尽量简明”“优先中文、先结论”等跨项目偏好；当前 workspace 适合语言/包管理器/代码风格/架构/测试命令等项目事实。

通常只需要：

```bash
export PI_MEMORY_BACKEND=viking-memory
export MEMORY_API_KEY='...'
# 可选：仅无 Git remote、monorepo 或你想人为统一多个目录时设置
export PI_MEMORY_WORKSPACE_ID='acme-platform'
```

## 后端配置

Viking Memory 使用 `MEMORY_API_KEY`、`VIKING_MEMORY_COLLECTION`、`VIKING_MEMORY_PROJECT`、`VIKING_MEMORY_USER_ID`、`VIKING_MEMORY_ASSISTANT_ID`。`VIKING_MEMORY_GROUP_ID` 仍兼容旧配置，但推荐使用更明确的 `PI_MEMORY_WORKSPACE_ID`。

OpenViking 使用 `OPENVIKING_URL`、`OPENVIKING_API_KEY` 或本地安全 `ovcli.conf`，本地 Docker 启动方式见 [Docker 文档](./docs/local-openviking-docker.md)。

## TUI 记忆卡片（可选，默认开启）

内存工具（`viking_memory_search`/`remember`/`profile`，以及 OpenViking 的 `viking_search`/`remember`）在 Pi TUI 里默认以**可展开的记忆卡片**显示：一行折叠摘要 + 状态着色（进行中/成功/错误/空）+ 展开查看完整结果。渲染器实现见 `core/tui/output-view.ts`，零第三方依赖，与 pi-hermes-memory 的 shared output view 同属 pi-tui 组件模式。

它是工具的一个可选 `renderResult` 钩子；不想要时回到纯文本只需不传该字段（或注释 `tools.ts` 里的 `renderResult: createMemoryCardRenderer()`）。

```bash
node ./extensions/pi-viking-memory/tests/run-tests.mjs
node ./tests/run-all.mjs
```

远端测试数据和本地 runtime 配置不由插件自动删除；测试 marker 和清理边界见 `verification/`。
