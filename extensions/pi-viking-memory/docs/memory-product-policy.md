# Memory Product Policy

本文档先定义 `pi-viking-memory` 的产品策略和架构边界，再逐步实现生命周期、统计、企业权限和召回优化。当前默认支持单人本地使用，同时为外部鉴权系统预留稳定协议。

## 1. 产品范围

记忆系统负责：

- 捕获经过安全清洗的对话和工具摘要
- 调用后端抽取事件、画像、项目事实和经验
- 按身份、空间、Agent 和记忆类型召回
- 提供来源、状态、置信度和时效信息
- 记录可脱敏的写入、抽取、召回和错误统计

记忆系统不负责：

- 企业账号注册、登录、JWT/OAuth 签发
- 部门和组织的最终权限管理
- 擅自修改或删除远端已有记忆
- 让模型自行决定用户身份或提升记忆可见范围

## 2. 记忆策略维度

每条记忆策略至少需要同时考虑以下维度：

| 维度 | 要回答的问题 |
| --- | --- |
| Identity | 这条记忆属于哪个租户、用户、部门、空间和 Agent？ |
| Ownership | 谁拥有、谁可以更新、谁可以让它失效？ |
| Visibility | private、workspace、department、tenant 还是 global？ |
| Kind | profile、preference、project、decision、event、experience 还是 workflow？ |
| Status | candidate、confirmed、active、superseded、expired 还是 archived？ |
| Source | 来自用户、文件、命令、测试、Agent 推断还是管理员？ |
| Confidence | 证据强度是多少？ |
| Merge | 新旧事实冲突时 skip、merge、supersede 还是 conflict？ |
| Freshness | 什么时候需要复核、衰减或过期？ |
| Recall | 在 chat、coding、部门共享和租户共享中的优先级是什么？ |
| Safety | 写入前是否脱敏，召回前是否授权过滤？ |
| Audit | 能否追溯 request、session、来源和策略版本？ |

## 3. 统一记忆记录

后续统一 Record 使用以下概念。后端可以只实现其中一部分，但不能丢失权限和来源边界。

```yaml
id: backend-owned-id
kind: profile | preference | project | decision | event | experience | workflow
scope:
  tenant_id: local-or-tenant-id
  department_id: optional
  workspace_id: optional
  visibility: private | workspace | department | tenant | global
owner:
  user_id: optional
  agent_id: optional
status: candidate | confirmed | active | superseded | conflicted | expired | archived
confidence: low | medium | high
content: sanitized-memory-content
source:
  backend: viking-memory | openviking
  session_id: session-id
  files: []
  commands: []
  request_id: optional
  observed_at: timestamp
created_at: timestamp
updated_at: timestamp
valid_from: optional-timestamp
valid_until: optional-timestamp
review_at: optional-timestamp
stale_after: optional-duration
supersedes: []
related: []
policy_version: "1"
```

## 4. 默认单人模式

当前安装默认按单用户使用：

```text
tenant_id: local
department_id: local
workspace_id: local
user_id: user_01
agent_id: pi
```

Viking Memory 当前配置：

```bash
VIKING_MEMORY_USER_ID=user_01
VIKING_MEMORY_ASSISTANT_ID=pi
VIKING_MEMORY_GROUP_ID=optional-workspace
```

OpenViking 当前本地 Docker 配置：

```text
account=pi-local
user=pi
peer=workspace-derived-or-explicit
```

### 无显式身份时的兼容 fallback

为了兼容个人本地部署，允许以下 fallback：

1. 优先使用外部鉴权适配器提供的完整身份。
2. 其次使用当前 Pi session 绑定的本地身份配置。
3. 再其次使用用户环境中的静态开发配置。
4. 最后才允许后端提供“当前默认用户/默认 collection”的兼容查找。

“默认第一个用户和 collection”只能是开发兼容行为，必须满足：

- 明确标记为 `development_fallback=true`
- 只允许单用户或本地环境
- 启动状态中显示实际选中的 account/user/collection，但不显示密钥
- 禁止在多用户服务模式自动启用
- 找不到唯一用户或 collection 时 fail-closed，不随机选择
- 不允许从记忆正文、prompt 或模型推断用户

建议不要真的按列表顺序取“第一个用户”。更安全的协议是要求后端返回明确的 `default_user` / `default_collection`，并记录来源和配置版本。

## 5. 外部鉴权适配协议

企业登录、部门、角色和权限由外部系统负责；插件只消费规范化身份。

### Identity Provider 接口

```typescript
export interface MemoryIdentity {
  tenantId: string;
  userId: string;
  departmentIds: string[];
  workspaceId?: string;
  agentId: string;
  sessionId: string;
  roles: string[];
  permissionVersion?: string;
  source: "local" | "env" | "session" | "jwt" | "oauth" | "gateway" | "custom";
}

export interface MemoryIdentityResolver {
  resolve(context: {
    piSessionId?: string;
    cwd: string;
    env: Record<string, string | undefined>;
  }): Promise<MemoryIdentity | null>;
}
```

### 解析优先级

```text
external IdentityResolver
  > Pi session identity
  > explicit local config
  > environment fallback
  > backend default only in development mode
```

### 安全要求

- `userId`、`tenantId`、roles 和 department 只能来自可信鉴权上下文。
- prompt 中的 `user_id`、`role`、`department_id` 不参与身份解析。
- session continue/fork 不能改变已绑定的 authenticated identity。
- identity 变更必须开启新 session 或显式重新认证。
- resolver 返回 null 时，多用户模式必须停止主动写入和召回。
- fallback 身份不能用于生产多用户服务。

## 6. 后端身份映射

### Viking Memory API

```text
MemoryIdentity.tenantId     -> collection/project/服务端租户策略
MemoryIdentity.userId       -> user_id
authenticated Agent id      -> assistant_id
MemoryIdentity.workspaceId  -> group_id
MemoryIdentity.sessionId    -> session_id / conversation_id
```

所有 `get_context`、`session/add`、`search`、`event/add` 和 `profile/add` 都必须使用同一份 identity 映射。不能只在召回时过滤用户，写入时却使用固定用户。

### OpenViking

```text
MemoryIdentity.tenantId     -> X-OpenViking-Account
MemoryIdentity.userId       -> X-OpenViking-User
MemoryIdentity.workspaceId  -> X-OpenViking-Actor-Peer
MemoryIdentity.agentId      -> peer metadata / agent scope
MemoryIdentity.sessionId    -> OpenViking session_id
```

默认使用 `peer_scope=actor`。跨 peer 或部门检索必须由权限适配器显式授权，并保留来源标记。

## 7. 安全配置分层

安全配置不能散落在 provider、prompt 和 README 中，分成四层：

### A. Identity / Auth Layer

负责：

- 登录、JWT/OAuth、API gateway
- tenant/user/department/workspace/roles
- session identity 绑定
- 权限版本和撤销

插件只读取标准 `MemoryIdentity`，不实现企业登录。

### B. Capture Safety Layer

负责：

- secrets、token、密码、cookie、私钥和认证头检测
- 工具输入/输出裁剪
- `.env`、凭证文件和环境 dump 拒绝捕获
- 召回块剥离
- 高风险内容整条丢弃，中风险只保存摘要

捕获策略按来源处理：

| 来源 | 默认策略 |
| --- | --- |
| 普通 user text | 脱敏后允许候选抽取 |
| 明确 remember | 脱敏后热路径写入 |
| bash input | 只保留安全命令摘要 |
| bash output | 默认不保存原文 |
| credential file | 整条拒绝 |
| HTTP header/body | 只保留路径和状态 |
| test log | 保存症状、根因、修复和验证 |
| recall block | 必须剥离 |

### C. Policy Layer

负责：

- kind、scope、status、confidence
- 写入门槛
- merge/conflict/expiry
- chat/coding priority 和 quotas
- 最长内容与 token budget
- 低置信候选是否可默认召回

当前策略文件：

```text
core/memory-policy.json
core/templates.md
```

### D. Provider Layer

负责：

- 将 identity 和 policy 映射到 Viking/OpenViking 合同
- HTTP 超时、错误处理和脱敏日志
- 后端能力探测
- 不支持能力的显式返回
- 不执行模型不应拥有的批量删除

## 8. 检索安全顺序

```text
resolve identity
  -> calculate allowed scopes
  -> reject unauthorized scopes
  -> filter status/expiry/kind
  -> call backend semantic retrieval
  -> rank by scope/kind/score/freshness/trust
  -> redact again
  -> inject with source and permission labels
```

权限是硬过滤，不是 score 降权。未授权内容不能进入候选集。

默认 scope 优先级：

### Chat

```text
user private
> current workspace
> department shared
> tenant shared
> global
```

### Coding

```text
current project decisions/facts
> workspace commands/experiences
> department engineering standards
> user coding preferences
> tenant/global resources
```

## 9. 冲突与合并

不同 kind 使用不同规则：

| kind | 默认 merge |
| --- | --- |
| profile | 字段级 merge，用户新确认值 supersede 旧值 |
| preference | 明确新偏好 supersede，临时要求只留 session |
| project | 同 workspace 版本合并，不同 workspace 不冲突 |
| decision | 新决策 supersede 旧决策，保留决策链和理由 |
| event | append + 语义去重，不覆盖历史事件 |
| experience | 相同根因/修复语义合并，保留验证次数和版本 |
| workflow | 重复验证后升级，版本变化进入 review |

统一决策：

```yaml
decision: skip | create | merge | supersede | conflict | reject
target_id: optional
reason: required
evidence: []
policy_version: "1"
```

scope 不同的记录先隔离，再判断是否冲突。Agent 推断不能覆盖用户明确确认的事实。

## 10. 时效与过期

```text
event_time   事情发生时间
observed_at  观察时间
updated_at   记忆更新时间
valid_from   生效时间
valid_until  明确失效时间
review_at    下次复核时间
stale_after  开始降低召回优先级的时间
```

默认策略：

| kind | 时效 |
| --- | --- |
| profile | 长期，变更时 supersede |
| preference | 长期但需要 review |
| project command | 版本敏感 |
| dependency/env | 强时效 |
| decision | 直到被新决策替代 |
| event | 时间衰减 |
| experience | 版本敏感、定期复核 |
| workflow | 重复验证和 review |
| session | 仅当前 session |
| draft | 不进入长期记忆 |

过期流程：

```text
active -> stale -> expired -> archived
```

过期内容默认不注入，但保留用于审计和显式 inspect。不要因为过期直接删除。

## 11. 统计与审计

记录：

```yaml
event_type: extraction | write | recall | merge | conflict | expire
backend:
request_id:
identity_hash:
workspace_id:
agent_id:
memory_kind:
candidate_count:
accepted_count:
dropped_count:
latency_ms:
usage:
policy_version:
```

禁止记录：

- 原始 prompt
- 完整记忆正文
- API key 和认证头
- 完整工具输出
- 未脱敏的身份凭证

## 12. 演进顺序

1. 当前：单机单用户 + 静态 fallback。
2. 下一步：`MemoryIdentity` 注入 provider，增加用户/空间隔离测试。
3. 再下一步：接入外部 JWT/OAuth resolver，不改 provider 业务逻辑。
4. 之后：department/workspace ACL 和共享记忆审批。
5. 最后：stats、inspect、conflict、expiry、feedback 和模型 A/B。

当前插件名称保持唯一：`pi-viking-memory`。后端是内部 provider，不是独立 Pi 插件。
