# Viking Memory Extension for Pi

这是一个直接调用火山引擎 Viking 长期记忆 API 的 Pi 插件，不依赖本地或 OpenViking Server。

## 能力

- 每次 prompt 前调用 `POST /api/memory/get_context`，自动召回用户画像、事件记忆和相关短期上下文
- 每轮对话结束调用 `POST /api/memory/session/add`，由 Viking 自动抽取事件和画像
- 提供 `viking_memory_search`、`viking_memory_remember`、`viking_memory_profile` 三个 Pi 工具
- `profile/add` 是否可用取决于 collection 是否配置 `profile_v1` 或自定义 profile schema；插件会把服务端错误明确返回，不伪造成功
- 提供 `/viking-memory` 状态命令和 `/viking-memory search <query>` 搜索命令
- 支持用户、助手、项目、collection 和 group 隔离

本插件不使用 OpenViking 的 `viking://` 文件系统、资源导入或上下文 takeover。需要这些能力时使用同一汇总仓库里的 [`../openviking`](../openviking)。

## 配置

插件源码和 `config.json` 不保存密钥。设置用户环境变量，并选择唯一主动后端：

```bash
export PI_MEMORY_BACKEND='viking-memory'
export MEMORY_API_KEY='your-viking-memory-api-key'
export VIKING_MEMORY_COLLECTION='piAgent'
export VIKING_MEMORY_PROJECT='default'
export VIKING_MEMORY_USER_ID='user_01'
export VIKING_MEMORY_ASSISTANT_ID='pi'
```

默认远端地址：

```text
https://api-knowledgebase.mlp.cn-beijing.volces.com
```

如需覆盖：

```bash
export VIKING_MEMORY_URL='https://api-knowledgebase.mlp.cn-beijing.volces.com'
```

环境变量优先于 `config.json`。行为参数见 [`config.json`](./config.json)。

## 安装

从当前汇总仓库的 checkout 直接安装：

```bash
pi install ./extensions/pi-viking-memory
```

然后重新启动 Pi。必须设置 `PI_MEMORY_BACKEND=viking-memory` 才会激活本 provider。建议一次只启用一个主动写入后端：

- `viking-memory`：火山引擎 Viking Memory API
- `openviking`：OpenViking REST API

两个插件都可以安装，未选中的插件会直接退出，不注册自动召回、capture 或工具。

## 接口流程

```text
Pi before_agent_start
  -> context
  -> POST /api/memory/get_context
  -> 注入 <viking-memory-context>

Pi turn_end
  -> POST /api/memory/session/add
  -> Viking 自动抽取长期记忆
```

注意：Viking 文档建议批量提交多轮消息；插件按新增 branch 内容提交，并为每次批次生成唯一 session id，避免重复 session 写入覆盖之前的抽取结果。

## 验证

只读查看插件状态：

```text
/viking-memory
```

搜索远端记忆：

```text
/viking-memory search 天气
```

手动工具由模型按需调用。连接失败时插件 fail-open，Pi 主流程继续运行。

线上抽取测试已验证：`session/add` 能抽取 `event_v1`；截图确认 `piAgent` collection 使用 `profile_v1`，`profile/add` 与 profile 搜索也已验证成功。

## 上游文档

- [Viking 记忆库 SDK 初始化](https://docs.volcengine.com/docs/84313/1941747?lang=zh)
- [GetContext](https://www.volcengine.com/docs/84313/2275184?lang=zh)
- [AddSession](https://www.volcengine.com/docs/84313/2100965?lang=zh)
- [SearchMemory](https://www.volcengine.com/docs/84313/1783351?lang=zh)
