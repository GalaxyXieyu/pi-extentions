# Memory Extraction Templates

这些模板是 provider 无关的语义契约。后端可以把它们映射到 Viking 的 event/profile/session，或 OpenViking 的 memory policy/type；不要把下列标签直接当成某个后端一定存在的字段。

## 共用候选格式

```yaml
kind: profile | preference | project | decision | event | experience | workflow | resource | session
scope: user | project | workspace | session | global
status: candidate | confirmed | superseded | expired
confidence: low | medium | high
summary: one concise statement
facts: []
source:
  session_id: "..."
  files: []
  commands: []
  timestamp: "..."
valid_until: null
related: []
```

## 通用 Agent

### profile / preference

写入条件：用户明确表达或跨至少两次会话稳定出现，并会改变未来交互。

```text
提取用户明确确认的身份、偏好、沟通风格、长期约束和禁忌。
只保存会影响后续回答的稳定信息；不要把一次性的情绪、临时计划或未经确认的推断写成画像。
输出：summary、scope=user、confidence、source、valid_until。
```

### event / experience

写入条件：对话产生了可复用的决定、承诺、重要事件、失败与修复结果。

```text
提取发生了什么、为什么重要、结果是什么、下一次如何识别或复用。
保留时间和会话来源；事件默认可衰减，成功经验只有经过验证才升级为 workflow。
```

### 不写入

密钥、令牌、密码、完整认证头、完整工具输出、无结论闲聊、召回块、模型猜测和只对当前 turn 有效的草稿。

## Coding Agent

### project facts

```text
提取稳定的项目事实：语言/框架、入口、目录边界、构建/测试/格式化命令、运行时版本、依赖约束、部署前置条件。
每条事实必须附 project/workspace scope 和来源文件或验证命令。
版本敏感信息必须带版本或更新时间；不确定时保存为 candidate，不作为硬规则。
```

### architecture / decision

```text
提取已确认的架构决策：选择、被放弃的替代方案、理由、影响范围、状态和验证证据。
冲突时不要静默覆盖旧决策；记录新旧来源并标记 supersedes 或 needs-confirmation。
```

### environment / command

```text
只保存可复用且不含秘密的命令、环境前置条件和平台差异。
命令必须去除 token、cookie、路径中的个人敏感信息和完整环境 dump。
```

### debugging / experience

```text
提取症状、根因、修复、验证命令、适用范围和失效条件。
失败尝试只有在根因或排除结论清晰时写入；否则留在当前 session。
```

### workflow / task state

```text
只有跨会话仍有价值的工作流或阻塞才写入长期记忆。
记录触发条件、步骤、验收契约、回滚路径和当前状态；普通 TODO 留在 goal/session 系统。
重复验证或用户确认后，才把 experience 升级为 workflow。
```

## 召回排序

- `purpose=coding`：当前 project facts/architecture > commands/environment > debugging/experience > user preferences > global resources。
- `purpose=chat`：profile/preferences > current events > recent experiences > project facts > large resources。
- 先按 scope 过滤，再按语义分数，最后使用时间衰减和状态过滤。
- `superseded`、`expired`、低置信 candidate 不进入默认注入，只能通过显式搜索查看。
- 注入时每条保留 `kind`、`source`、`scope` 和时间信息，整体受字符/token budget 限制。
