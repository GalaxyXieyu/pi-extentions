# Enterprise Memory Retrieval Architecture

这份设计用于把当前单机 `pi-viking-memory` 演进到企业多用户、多部门、多 Agent 场景。它是架构规划，不会改变当前单用户运行默认值。

## 核心结论

企业记忆检索不是“把所有记忆做一次向量搜索”，而是：

```text
认证身份
  -> 权限和 scope 裁剪
  -> 记忆类型/状态过滤
  -> 语义召回
  -> 时间/相关性/可信度排序
  -> token budget 组装
  -> 来源和权限标记注入
```

必须先完成授权范围裁剪，再做语义检索。不能先从全库召回，再让模型判断哪些内容能看。

## 统一身份模型

```typescript
interface MemoryIdentity {
  tenantId: string;       // 企业/租户
  userId: string;         // 登录用户
  departmentIds: string[];
  workspaceId?: string;   // 当前空间/项目
  agentId: string;        // 当前 Agent
  sessionId: string;      // 当前对话
  roles: string[];
  permissionVersion?: string;
}
```

身份必须来自登录/session 鉴权上下文，不能由模型输入、prompt 或记忆内容推断。

## Scope 层级

```text
tenant
  ├── department
  │     ├── workspace/project
  │     │     ├── agent
  │     │     └── user
  │     └── department-shared
  ├── tenant-shared
  └── user-private
```

记忆的可见范围和内容类型是两个维度：

```yaml
scope:
  visibility: private | workspace | department | tenant | global
  tenant_id: org_001
  department_id: engineering
  workspace_id: project_alpha
  owner_user_id: user_123
  owner_agent_id: coding-agent
```

不要把 `profile`、`event`、`project` 直接当作权限范围。`kind` 表示记忆内容类型，`visibility` 表示谁能访问。

## Viking Memory 映射

| 统一字段 | Viking 字段 |
| --- | --- |
| tenantId | collection/project 与服务端租户权限 |
| userId | `user_id` |
| agentId | `assistant_id` |
| department/workspace | `group_id` 或 collection 级隔离策略 |
| sessionId | `session_id` / `conversation_id` |
| kind | `memory_type` / event/profile type |

当前插件使用：

```text
user_id=user_01
assistant_id=pi
group_id=可选 workspace
```

企业版本必须从 `MemoryIdentity` 动态生成这些字段，不能继续固定环境变量作为所有用户身份。

Viking 的过滤顺序建议：

1. 强制 `user_id` 精确匹配私有记忆。
2. 追加当前 workspace/department 的允许 `group_id`。
3. 只允许当前 Agent 可见的 `assistant_id` 或共享 Agent 类型。
4. 再传 `memory_type`、状态和时间过滤。
5. 最后才做语义搜索和 score 排序。

## OpenViking 映射

OpenViking 官方多租户模型使用：

```text
X-OpenViking-Account: tenant_id
X-OpenViking-User: user_id
X-OpenViking-Actor-Peer: workspace_or_agent_peer
```

建议：

- `account`：企业/租户边界。
- `user`：登录用户私有空间。
- `actor_peer`：项目、部门 Agent、渠道或工作空间来源。
- `viking://~/memories`：当前认证用户的私有记忆入口。
- 部门共享内容使用显式共享 URI/metadata，不把别人的用户空间直接加入搜索范围。

默认采用 `peer_scope=actor`，只有明确授权的跨 peer 检索才使用 `all`。跨 peer 结果需要降权并显示来源，不能静默混入私有上下文。

## 多 Agent 策略

### Agent identity

每个 Agent 都有稳定的 `agentId`，例如：

```text
coding-agent
research-agent
support-agent
hr-agent
```

Agent 身份不是用户身份。一个用户可以使用多个 Agent；一个部门可以共享一个 Agent，但记忆仍需按用户/部门 scope 控制。

### 共享与私有

默认优先级：

1. 当前用户私有、当前项目相关记忆。
2. 当前 workspace 共享记忆。
3. 当前部门共享记忆。
4. 租户共享记忆。
5. 全局公共记忆。

低层 scope 与高层 scope 内容相冲突时，优先当前用户和当前项目的确认事实，并保留冲突来源。

### Agent-specific memory

Agent 产生的记忆分三类：

- `user-owned`：关于用户的偏好和交互习惯。
- `workspace-owned`：项目事实、架构决策、环境和工作流。
- `agent-owned`：某个 Agent 的工具经验、成功轨迹和程序性策略。

不能把 Agent 的推断自动提升为全组织知识。组织共享需要确认、审批或重复验证。

## Recall policy

### Chat

```text
user profile/preferences
> current user events
> workspace shared
> department shared
> tenant shared
> global resources
```

### Coding

```text
current project facts/decisions
> current workspace commands and debugging experiences
> department engineering standards
> user coding preferences
> tenant/global resources
```

### Permission-aware scoring

排序可以使用：

```text
final_score = semantic_score
            * scope_weight
            * permission_confidence
            * freshness_weight
            * memory_status_weight
```

但权限不是普通 score。未授权记忆必须在候选阶段被过滤，不能通过低分来“降低可见性”。

建议 scope 权重：

```text
private current user: 1.00
current workspace: 0.95
department shared: 0.85
tenant shared: 0.70
global: 0.50
other peer: 0.00 unless explicitly authorized
```

## 写入策略

写入时必须携带完整 identity：

```text
capture(identity, messages)
```

写入规则：

- 用户偏好写入 `user-owned`。
- 项目事实和架构决策写入 `workspace-owned`。
- 部门规范只有来源明确且经过确认才写入 `department-shared`。
- Agent 经验默认写入 `agent-owned` 或当前 workspace，不自动跨部门共享。
- 用户不能通过 prompt 把记忆提升到 `tenant/global` scope。
- 管理员或审批流程才能改变 visibility。

## 防止跨租户泄漏

必须有以下测试：

1. user A 的 private profile 对 user B 不可见。
2. department A 的共享记忆对 department B 不可见。
3. workspace A 的 coding 决策不会出现在 workspace B 的默认召回中。
4. agent A 的内部工具经验不会自动进入 user-facing assistant。
5. 显式授权跨部门搜索时，结果带来源和授权 scope。
6. session fork/continue 不得改变 authenticated user identity。
7. prompt 中伪造的 `user_id`、`department_id`、`role` 不得改变查询过滤。

## 单机到企业迁移

当前单机配置：

```bash
VIKING_MEMORY_USER_ID=user_01
VIKING_MEMORY_ASSISTANT_ID=pi
VIKING_MEMORY_GROUP_ID=
```

下一阶段改为：

```text
Pi session
  -> authenticated identity provider
  -> MemoryIdentity
  -> selected backend adapter
```

环境变量只保留本地开发 fallback；生产环境禁止用全局固定 `user_01`。

## 官方依据与工程推断

官方事实：

- OpenViking 使用 account/user 身份边界和 actor peer 过滤。
- OpenViking retrieval 支持 peer scope、session context、context type、budget 和 dedup。
- Viking Memory 支持 user_id、assistant_id、group_id、session_id 过滤。

工程推断：

- 企业默认应采用权限先于向量召回。
- Agent-owned、user-owned、workspace-owned 需要独立 visibility 元数据。
- 跨部门召回应是显式授权能力，而不是普通 score 降权。
