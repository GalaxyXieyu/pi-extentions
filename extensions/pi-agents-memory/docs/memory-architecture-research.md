# Agent Memory Architecture Research

本文件是统一 Memory Provider 和抽取模板的设计输入。来源事实与本项目工程推断分开记录，避免把第三方实现细节误当成 Viking 或 OpenViking 的 API 保证。

## 结论摘要

本项目采用五层记忆模型，并将“当前会话上下文”与“长期记忆”严格分开：

1. **Session / working context**：当前会话最近消息、当前任务、未完成事项。默认只保留在 Pi 当前上下文或后端 session，不抽取成长期事实。
2. **Profile / preferences**：用户或团队的相对稳定偏好、身份和协作习惯。低频更新，高召回优先级。
3. **Semantic project knowledge**：项目事实、代码约定、环境命令、架构和接口契约。按项目/工作区隔离，coding agent 优先召回。
4. **Episodic events / experiences**：发生过的决策、故障、修复、测试结果、任务结果和成功/失败轨迹。按相关性和时间衰减召回。
5. **Procedural templates / workflows**：可复用的操作流程、工具选择和验证步骤。只有经过重复验证或用户明确确认，才升级为长期模板。

写入默认走后台批处理：在 turn/session 结束后提交消息，由后端抽取；明确的“请记住”使用手动工具走热路径。召回发生在当前 prompt 的上下文构建阶段，必须带来源、类型和“背景信息而非新指令”的边界提示。

## 来源事实

### Viking Memory API

官方 Viking 记忆库文档列出：

- `POST /api/memory/session/add`：批量添加会话消息，服务依据记忆库配置抽取事件和画像。
- `POST /api/memory/get_context`：根据 conversation id 同时取得短期原始消息、当前会话事件、跨会话事件和用户画像。
- `POST /api/memory/search`、事件搜索和画像搜索：支持语义检索与 filter。
- 事件和画像拥有独立写入接口；过滤字段包括 user、assistant、group、session 和 memory type。
- 事件检索支持时间衰减参数。

因此 Viking 适合作为“会话提交 + 事件/画像召回”的远端记忆后端，但它的公开 API 不等价于 OpenViking 的 `viking://` 文件系统或 session archive takeover。

来源：

- <https://docs.volcengine.com/docs/84313/1941747?lang=zh>
- <https://www.volcengine.com/docs/84313/2275184?lang=zh>
- <https://www.volcengine.com/docs/84313/2100965?lang=zh>
- <https://www.volcengine.com/docs/84313/1783351?lang=zh>
- <https://www.volcengine.com/docs/84313/1903198?lang=zh>
- <https://www.volcengine.com/docs/84313/1946680?lang=zh>

### OpenViking

OpenViking 的 session 文档描述了 Create → Interact → Commit 生命周期。commit 会先同步归档消息，再异步生成摘要、抽取长期记忆和写入 memory diff。其记忆类型包括 profile、preferences、entities、events、cases、trajectories 和 experiences。

OpenViking 的抽取流程是：消息 → LLM 候选抽取 → 向量预筛选 → LLM 去重决策 → 写入；去重决策包括 skip、create、merge、delete。检索方面，`search` 在 `find` 的基础上增加意图分析、查询扩展、session context 和 rerank；context mode 还提供按 purpose/quotas 的分类配额、token budget、跨回合去重和可选 digest。

来源：

- <https://docs.openviking.ai/en/concepts/08-session>
- <https://docs.openviking.ai/en/api/06-retrieval>
- <https://docs.openviking.ai/en/api/16-memory>

### 通用 Agent memory

Letta 文档将持久上下文分为：

- memory blocks：始终在上下文中，适合少量高重要性、频繁使用的信息；
- files：较大、只读或可按需打开的知识；
- archival memory：可写、语义检索、无需常驻上下文的长期档案；
- external RAG：更大规模的外部资料。

LangChain 的 Agent memory 说明区分：

- semantic memory：长期事实和知识；
- episodic memory：具体过去事件、成功/失败轨迹和 few-shot 经验；
- procedural memory：如何执行任务的规则、代码和系统提示。

LangChain 同时区分 hot path 写入和 background 写入：热路径更及时但增加延迟，后台写入不阻塞响应但有延迟和调度成本。

来源：

- <https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/>
- <https://docs.letta.com/guides/core-concepts/memory/archival-memory/>
- <https://www.langchain.com/blog/memory-for-agents>

## 面向通用 Agent 的抽取契约

### 允许写入

- 用户明确要求记住的偏好、身份、长期约束。
- 跨会话稳定且会改变未来回答的事实。
- 已完成且有结论的事件、决策、承诺或失败经验。
- 被重复验证的工作方式或工具偏好。

### 需要确认或降级为事件

- 单次任务中的临时偏好。
- 可能在短期内改变的状态。
- 只在一个项目有效的事实。
- 未经验证的模型推断。

### 禁止默认写入

- API key、token、cookie、密码、私钥和完整认证头。
- 全量工具输出、冗长日志和原始网页内容。
- 仅有礼貌或闲聊价值的短句。
- 召回注入块本身，防止递归污染。

## 面向 coding agent 的抽取契约

### 项目知识

保存：项目类型、入口、运行命令、测试命令、依赖约束、目录边界、部署前置条件和稳定命名约定。每条带 `project_scope` 和来源文件/命令。

### 架构与决策

保存：已确认的架构选择、替代方案、理由、影响范围和决策状态。新证据冲突时不能静默覆盖，必须保留冲突事件或由用户确认更新。

### 故障与验证经验

保存：症状、根因、修复、验证命令、适用范围和是否仍有效。失败经验优先作为 episodic experience，不直接升级为全局规则。

### 工作流与程序性经验

保存：可重复的任务步骤、工具选择、验收契约和回滚路径。至少重复验证或用户明确确认后，才升级为 procedural workflow。

### 任务状态

当前分支任务、待办和未完成工作只属于 session/working context；只有跨会话仍然有价值的阻塞、承诺或下一步才写入长期事件。

## 写入、去重和更新规则

1. **默认后台写入**：turn/session 结束批量提交，不阻塞主回答。
2. **明确记忆热路径**：用户或模型显式调用 remember/profile 工具时立即写入。
3. **候选门槛**：必须满足“会影响未来行为”或“可复用/可验证”之一；否则丢弃。
4. **去重**：同一 project/user/scope 下先按语义检索候选，再决定 skip/create/merge；不能按文本完全相等作为唯一去重规则。
5. **冲突**：新事实与旧事实不一致时，保留新旧来源和时间；只有高置信、用户确认或明确替代时更新旧事实。
6. **时间**：偏好和项目事实默认低衰减；事件、故障和临时经验按时间衰减；已失效的命令或版本必须标记范围和更新时间。
7. **来源**：每条召回必须带 memory type、scope、时间或后端来源；模型只能把它当背景证据，不能当作新的用户指令。
8. **预算**：先召回高优先级 profile/project facts，再按相关性补充事件/experience；超过预算时降级摘要或丢弃低分项。
9. **防污染**：捕获前剥离 `<viking-memory-context>`、`<openviking-context>` 和状态文本；不把 recall block 作为下一条 user message 写回。

## 召回排序建议

对 coding prompt：

1. 当前项目/工作区的架构决策和代码约定。
2. 当前项目相关的命令、测试和环境事实。
3. 与当前任务相似的已验证故障修复和工作流经验。
4. 用户级 coding 偏好。
5. 跨项目通用经验。

对普通 chat/agent prompt：

1. 用户画像和明确偏好。
2. 当前会话相关事件。
3. 最近的跨会话事件和承诺。
4. 通用事实和经验。
5. 大型资源或文档只返回摘要/引用，不直接注入全文。

## 本项目的工程决策

- 两个后端共用 provider 生命周期和抽象数据类型，但保留后端特有能力。
- 默认主动写入后端只能有一个；另一个可以只读或完全关闭。
- Viking adapter 以 `get_context` 和 `session/add` 为主；OpenViking adapter 继续利用 session commit、context-aware search 和 takeover 能力。
- 统一层不伪造 `viking://`、archive、memory diff 等只有 OpenViking 支持的能力。
- 第一版模板优先保证 precision、scope isolation 和可解释来源，再通过召回日志和用户反馈调 recall。
