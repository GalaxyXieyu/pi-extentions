# Pi Extensions

这是个人 Pi 插件与 harness 的汇总仓库。每个插件保持独立 Git 历史，通过 Git submodule 组合到这里，便于分别开发、发布和升级。

## 记忆后端

仓库提供统一的 Memory Provider 抽象，同时支持两种远端后端：

| 后端 | 插件 | 适合场景 |
| --- | --- | --- |
| Viking Memory API | [`extensions/pi-agents-memory`](./extensions/pi-agents-memory) | 火山引擎远端长期记忆、用户画像、事件和会话抽取 |
| OpenViking API | [`extensions/pi-agents-memory`](./extensions/pi-agents-memory) | OpenViking REST、`viking://` 资源、session commit 和 context takeover |

两个插件可以同时安装，但同一 Pi 进程只激活一个主动写入后端：

```bash
export PI_MEMORY_BACKEND=viking-memory   # 或 openviking
```

公共契约和能力矩阵见 [`extensions/pi-agents-memory/core`](./extensions/pi-agents-memory/core)；抽取与召回模板见 [`extensions/pi-agents-memory/core/templates.md`](./extensions/pi-agents-memory/core/templates.md) 与 [`extensions/pi-agents-memory/core/memory-policy.json`](./extensions/pi-agents-memory/core/memory-policy.json)。设计依据、企业检索、生命周期、产品策略和本地 Docker 文档见 [`extensions/pi-agents-memory/docs`](./extensions/pi-agents-memory/docs)。

切换后端后重启 Pi：

```bash
export PI_MEMORY_BACKEND=openviking   # 或 viking-memory
pi
```

排障时使用 `/memory` 查看状态（旧命令名 `/viking-memory`、`/viking` 仍作为别名可用）；将 `VIKING_MEMORY_DEBUG_LOG` 或 `OV_DEBUG_LOG` 指向本地临时文件可打开脱敏调试日志。

## 子项目

| 路径 | 项目 | 用途 |
| --- | --- | --- |
| [`extensions/pi-agents-flow`](./extensions/pi-agents-flow) | [pi-agents-flow](https://github.com/GalaxyXieyu/pi-agents-flow) | Supervisor-led 多 Agent 编排、持久工作流与质量门禁 |

## 初始化

首次克隆后初始化所有子项目：

```bash
git clone --recurse-submodules https://github.com/GalaxyXieyu/pi-extentions.git
```

已有 checkout 则执行：

```bash
git submodule update --init --recursive
```

## 日常维护

记忆插件源码随汇总仓库维护；官方 OpenViking 示例的上游同步需要人工 review，避免覆盖本地 provider 接线和模板策略。更新任一插件后重新运行其测试、`pi install` 和 `pi list`。

在子项目目录内开发和提交，子项目的提交由它自己的远端管理：

```bash
cd extensions/pi-agents-flow
# 开发、测试并提交子项目改动
npm test
git pull --ff-only origin main
```

回到汇总仓库后，更新并提交 submodule 指针：

```bash
cd ../..
git add extensions/pi-agents-flow
git commit -m "chore: update pi-agents-flow"
```

查看子项目当前指针：

```bash
git submodule status
```

## Pi 安装

安装编排插件：

```bash
pi install ./extensions/pi-agents-flow
```

安装记忆插件时选择一个后端并设置对应凭证。

Viking Memory：

```bash
export MEMORY_API_KEY='your-key'
export VIKING_MEMORY_COLLECTION='piAgent'
export VIKING_MEMORY_PROJECT='default'
export VIKING_MEMORY_USER_ID='user_01'
export VIKING_MEMORY_ASSISTANT_ID='pi'
export PI_MEMORY_BACKEND=viking-memory
pi install ./extensions/pi-agents-memory
```

OpenViking：

```bash
export PI_MEMORY_BACKEND=openviking
pi install ./extensions/pi-agents-memory
node ./extensions/pi-agents-memory/scripts/setup.mjs
```

具体使用方式、测试命令和发布说明见各插件 README。不要同时让两个后端主动 capture，避免双写和重复召回。
