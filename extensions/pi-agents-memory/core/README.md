# Memory Core

`memory-core` 是两个 Pi 记忆插件共用的 provider 契约，不直接访问远端服务。

## 公共接口

- `health()`：连接和认证检查
- `recall()`：当前 prompt 的背景记忆召回
- `capture()`：批量提交 user/assistant 对话
- `search()`：显式语义搜索
- `remember()`：显式写入事件/事实
- `updateProfile()`：显式更新画像
- `unsupported()`：后端不具备能力时抛出明确错误

## 能力矩阵

| 能力 | Viking Memory API | OpenViking API |
| --- | --- | --- |
| 自动召回 | `get_context` | `search` 或 context mode |
| 对话写入 | `session/add` | session messages + commit |
| 语义搜索 | `memory/search` | `search` / `find` |
| 显式记忆 | `event/add` | session message + commit |
| 用户画像 | `profile/add`（需 collection 配置 `profile_v1` 或自定义 profile schema） | 仅通过 memory policy / session extraction（统一 adapter 不提供直接写入） |
| 资源导入 | 不支持 | 支持 `add_resource` |
| URI 读取 | 不支持 | 支持 `viking://` read |
| Context takeover | 不支持 | 支持 session commit/overview |
| Archive 展开 | 不支持 | 支持 |

统一接口只承诺公共部分。调用方必须先检查 `capabilities`；后端不支持的功能不得伪造成功。

## 后端选择

同一个 Pi 进程默认只加载一个主动写入后端。provider id 由插件配置决定：

- `viking-memory`
- `openviking`

两个插件可以共存于仓库，但不要在同一个 Pi 配置中同时启用自动 capture。

## 运行时策略

`memory-policy.json` 不只是文档：`policy-engine.ts` 会在召回格式化前按 purpose、kind priority、quota、status、confidence 和 valid_until 过滤排序。`candidate-extractor.ts` 会在 remember/profile/capture 路径识别纠正、故障、决策和项目候选；高风险 secret/threat candidate 会拒绝。

当前 canonical config、identity 和生命周期是本地控制层。外部登录、后台配置 API 和企业 ACL 只预留接口，尚未接入具体产品。

## 调试与维护

- `PI_MEMORY_BACKEND` 未设置或值不合法时，两个插件都不主动读写。
- Viking 使用 `VIKING_MEMORY_DEBUG_LOG`；OpenViking 使用 `OV_DEBUG_LOG`。日志只记录阶段、数量和错误摘要，不记录密钥或完整请求体。
- 修改 provider 契约时同时更新两个 adapter、能力矩阵和对应测试。
- 调整抽取策略时优先修改 `memory-policy.json` 与 `templates.md`，再更新后端特定映射。
