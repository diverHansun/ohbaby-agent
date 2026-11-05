# 1. 现状与问题分析

> 代码基线：2026-11-04，`main` 分支 `c9cbd475`。本议题开始前没有任何相关实施。`A/` 表示 `packages/ohbaby-agent/src/`，`W/` 表示 `apps/ohbaby-web/src/`。

## 1.1 问题陈述

1. **没有任何复制会话的能力。** 代码里没有 fork、clone、duplicate 或导入。会话导出只有 HTML 和 JSONL 两种格式（`A/services/session-export/types.ts:4`），没有导入。
2. **`parent_id` 已经被子代理占用。** 会话列表、归档、移动都按 `parent_id` 判断“这是子代理”，fork 不能借用它。
3. **一段历史不只存在 message 和 part 两张表里。** Web 按 prompt 记录把消息分成轮；steer 和子代理结果能不能进模型上下文，取决于当前轮输入记录。只复制消息，新会话要么显示不对，要么模型看到的上下文和源会话不一样。
4. **ID 散落在 JSON 里。** 消息之间、消息和 run、prompt 之间的引用，大多写在 `data` JSON 的各个字段里，逐个字段改写容易漏。
5. **压缩标记可能“超前”。** 切点之后发生的压缩，会给切点之前的片段打上“已压缩”标记，但摘要在切点之后。原样复制会让新会话丢上下文。

## 1.2 已确认的产品分界

见 [00 §2](00-discussion.md)：在一轮已结束的对话末尾 fork，复制到这一轮为止的历史；来源信息记在 `session.data`；侧栏平级；标题 `(n)`；Web 两处入口，TUI `/fork`。

## 1.3 会话

### 1.3.1 创建

- `SessionManager.create(dir, { id, title, agentName, parentId })`（`A/services/session/manager.ts:109-153`）由 `createSessionRecord`（:73-101）生成记录后插入，并发布 `SessionEvent.Created`。工作区由 `projectResolver.fromDirectory(dir)` 推出，统计从 `messageCount: 0` 开始。
- `CreateSessionOptions`（`A/services/session/types.ts:46-51`）设不了 reasoning、模型、工作区、待切换目录和统计。
- 会话存储的 `withTransaction`（`A/services/session/database-store.ts:688-713`）只是暂存写入、稍后提交，不能和消息的 SQL 写入放进同一个事务。

**结论**：fork 不能直接复用 `SessionManager.create`，要在一个数据库事务里自己写会话行。

### 1.3.2 字段

会话行的列：`id, project_id, working_directory, workspace_directory, pending_working_directory, agent, parent_id, title, status, created_at, updated_at, message_count, last_message_at, data`。`data` 里是 `{ reasoning, modelEntryId, childrenIds, isSubagent }`（`database-store.ts:24-46, 176`）。

### 1.3.3 标题

- 默认标题是 `New session - <ISO 时间>`（`manager.ts:38`），判断函数是 `isDefaultSessionTitle`（`A/services/session/prompt-sanitizer.ts:38`）。
- 下一条 prompt 是否触发起标题，由 `isFirstUserMessageForTitle`（`A/adapters/ui-inprocess.ts:3419-3451`）决定：会话已有消息就不起。

**结论**：fork 出来的会话带着历史，永远不会自动起标题，必须在 fork 时直接写好。

### 1.3.4 侧栏

全局列表取 `parent_id IS NULL` 的会话，按 `updated_at DESC, id DESC` 排序（`A/services/session/global-query.ts:120-141`）。fork 出来的会话只要 `parent_id` 为空、`updated_at` 是当前时间，就会作为普通会话出现在最上面。

## 1.4 历史数据

### 1.4.1 涉及的表

| 表 | 作用 | 不复制会怎样 |
|---|---|---|
| `message`、`part` | 消息正文 | 没有历史 |
| `prompt_submission` | 一轮对话的入口。视图通过 `listForSession` 按 `scope_key`、`session_id`、`user_message_id` 或 `run_id` 取 prompt（`A/runtime/prompt-scheduler/database-store.ts:691-720`，调用在 `ui-inprocess.ts:790-806`） | `projectRunProcesses`（`W/ui/conversation/run-process.ts:19-31`）拿不到 prompt，执行过程无法折叠，所有消息平铺显示 |
| `current_run_input` | steer、子代理结果这类“运行时输入”消息的登记 | 构建上下文时 `filterModelHistory` 会把没有登记的运行时输入消息全部丢掉（`A/runtime/prompt-scheduler/current-run-inputs.ts:521-537`；默认行为见 `A/core/context/context-manager.ts:647-650`），新会话的模型上下文和源会话不一致 |
| `run_ledger` | run 记录 | `current_run_input` 有外键指向它（`A/services/database/migrations.ts:666`，外键检查已开启，`A/services/database/index.ts:126`） |

不需要复制的：`current_run_request_owner`（只对运行中的 run 有意义）、`goal_record`、`snapshot_checkpoint` 与 `snapshot_patch`、`subagent_instance` 与 `subagent_execution`。

### 1.4.2 写入方式

- 消息存储没有批量写入。`insertMessage`（`A/core/message/database-store.ts:378-396`）保留传入的 ID 和时间，但每次调用自带一个事务；`appendPart`（:420-456）会重新分配顺序号、改写时间。
- 消息管理器的 `createMessage` 会分配新 ID 和新时间，并发布事件。
- 同步事务入口是 `runWriteTransaction(db, cb)`（`A/services/database/index.ts:324`），回调不能是异步的。`A/services/session/archive.ts` 和 `workspace-move.ts` 都是这个写法。

**结论**：fork 用 SQL 在一个 `runWriteTransaction` 里完成全部复制。

### 1.4.3 JSON 里的 ID 引用

| 位置 | 字段 |
|---|---|
| 消息 `data` | `id`、`sessionId`、`runId`、`parentId`（`A/core/message/types.ts:75`）、`runtimeInput.{inputId, targetRunId, sourceId}`、`modelRequests[].{runId, messageId, requestId, inputIds}` |
| 片段 `data` | `id`、`messageId`、`sessionId`、`contextScopeId`；提醒片段的 `metadata.anchorAssistantId`（没有锚点的提醒会被隐藏，`A/core/context/reminder-history.ts:8-45`）；推理片段的 `metadata.runId`；工具片段的 `metadata.execution.runId` |
| 提醒片段 ID | 格式是 `${messageId}:${i}`（`context-manager.ts:1656`） |
| 压缩摘要 `metadata` | `compactionId, readIds, keptIds, protectedInputIds, omittedPartIds`（`context-manager.ts:1120-1131`），只在生成时用，之后不再读取 |
| `prompt_submission` | `prompt_id`（主键）、`user_message_id`（唯一）、`run_id`、`client_request_id`（同一 `scope_key` 内唯一，`migrations.ts:536`）、`steer_receipt`（JSON，含 promptId、userMessageId、inputId 等，有唯一索引 :537）、`resend_of_prompt_id`；`admission_order` 在同一 `scope_key` 内递增（`database-store.ts:975`） |
| 子代理工具片段 | `state.metadata.subagent.execution.{executionId, subagentId, childSessionId, ...}`（`A/tools/subagent.ts:121-200`），指向源会话的子代理 |

另外，`current_run_input.source_id` 对 steer 存的是 promptId（`A/runtime/prompt-scheduler/current-run-inputs.ts:461`），steer 恢复会拿它去比对（`A/adapters/ui-inprocess/steer-recovery.ts:70-82`）。被转成 steer 的 prompt 状态是 `steered`，它的 `steer_receipt.clientRequestId` 是另一个值，在同一 `scope_key` 内也有唯一约束。

**结论**：要改写的字段很多，而且分散。逐个列举一定会漏，适合用“值完全等于旧 ID 就替换”的统一规则。子代理的执行、实例 ID 不在映射表里，会保持原值；子代理元数据里的会话 ID 会被换成新会话的，两种情况下卡片都打不开（见 1.5）。消息 ID 的现有生成器带无序随机后缀（`A/core/message/id-generator.ts:14-18`），用户消息又是 UUID 格式，所以新 ID 不能直接用生成器，否则同一毫秒内的消息会乱序。

### 1.4.4 模型原生状态

`model-state` 片段保存服务商的原生输出，例如 Responses 的加密推理、Anthropic 的 thinking 签名（`packages/ohbaby-llm/src/providers/native-state.ts:99-132`）。项目不使用 `previous_response_id`，请求都是 `store: false`（`openai-responses.ts:168`，`openai-responses-stream.ts:292-300`），状态和会话没有绑定。序列化时只在来源一致、轮次已完成、工具 `callId` 对得上时才回放（`A/core/context/serializer.ts:121-200`）。

**结论**：原样复制是安全的，前提是 `callId` 不改。

### 1.4.5 压缩

构建上下文时 `getActiveHistory` 去掉已压缩片段、把摘要移到最前（`context-manager.ts:219-237`）。切点之前发生的压缩，复制后行为一致。

问题在于切点之后的压缩：它在提交时把更早的片段标成已压缩（标记时间取提交时刻，`context-manager.ts:1103`），而摘要消息排在切点之后，不会被复制。

被压缩的片段上没有记录 `compactionId`，查不出是哪次压缩标记了它，只能比较时间。这样比较成立，依据有两条：

- 压缩只在准备模型步骤时提交，这时该步的助手消息还没创建（:1476）；
- 摘要消息没有 `runId`，`created_at` 不早于压缩时间（`A/core/message/manager.ts:264`）。

所以，片段的压缩时间晚于最后一条被复制消息时，标记它的摘要一定没被复制。按这条规则，切点那一轮中途的自动压缩会保留，切点之后、两轮之间的手动压缩会被清掉。

另外，上下文预算的校准系数等状态只存在于内存里（`context-manager.ts:280-395`），新会话从默认值开始。

## 1.5 子代理引用

- 新会话里，源会话的子代理卡片按 `metadata.subagent.execution` 渲染。实例列表加载后，因为找不到实例，“打开”入口会被隐藏（`W/ui/shared/subagent-instances.ts:64`）；直接打开会返回 `SUBAGENT_NOT_FOUND`（`A/adapters/ui-inprocess/subagent-conversation.ts:153-174, 216-220`），执行视图报“Unknown execution for this root”（`subagent-views.ts:111-118`）。不会显示源会话的子代理内容。
- 子代理的大结果文件只允许所属会话读取（`A/agents/subagents/result-artifacts.ts:246-281`），新会话的模型读不到。走普通沙箱时是弹窗还是拒绝，没有核实。[子代理结果搬迁议题](../../2026-11-05-subagent-results-location/README.md)在本议题之前实施，之后报告放在源会话的存储区 `sessions/<源会话>/subagents/` 下；fork 出来的会话不在源会话的存储区里，读取时按外部路径弹确认。

## 1.6 现有操作放在哪里

- 需要 prompt 作用域、忙碌判断和事件发布的会话操作在 adapter 层，例如归档 `archiveSessionInternal`（`ui-inprocess.ts:3258`）、压缩（:3609），对应路由在 `packages/ohbaby-server/src/protocols/web/routes/sessions.ts`（归档 :264-296）。
- 纯数据库的会话操作在 `A/services/session/*.ts`，例如 `archive.ts`、`workspace-move.ts`。

**结论**：SQL 复制放进 `A/services/session/fork.ts`，由 adapter 层的一个方法调用（它知道 `promptScopeKey`，也负责发布事件），路由放在 `sessions.ts` 的归档旁边。

## 1.7 TUI

- 命令清单在 `A/commands/catalog.ts`；TUI 在本地拦截部分命令（`packages/ohbaby-cli/src/tui/app.tsx:231`）。
- TUI 已有切换会话的能力（`/resume`、`/sessions`），fork 成功后可以复用切换逻辑。

## 1.8 测试现状

会话归档、移动、删除都有基于真实 SQLite 的集成测试，可以照着写。目前没有任何测试比较“两个会话的模型上下文是否一致”，这是 fork 最需要的验证。

## 1.9 SWE 原则审视

- **只复制必要的东西**：五张表各有一个“不复制就出错”的理由，其余一律不复制。
- **一条规则代替一张字段清单**：ID 改写按值替换，减少遗漏，也不用随 JSON 结构变化去维护。
- **不碰源会话**：fork 只读源会话，不需要占用它的执行闸门，失败也不会影响它。
- **接受已知的小缺口**：子代理卡片打不开、大结果文件读不到，都在 00 里写明，不为它们扩大改动面。

## 1.10 与既有文档关系

| 文档 | 本议题之后 |
|---|---|
| `docs/services/session/`（数据模型与生命周期） | 补充 fork 操作和 `session.data.fork` 字段 |
| `docs/core/message/data-model.md` | 说明 fork 复制消息时的 ID 改写规则 |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/fork` |
