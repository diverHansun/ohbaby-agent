# 03 · kimi-code / codex 设计借鉴（core/agents 视角）

对照项目：

- `/Users/hansun025/Projects/code-cli/kimi-code`
- `/Users/hansun025/Projects/code-cli/codex`

本文只取与「实例级 context owner + 单实例压缩契约 + context window 边界」直接相关的借鉴点。本地对照不作为仓库依赖。

---

## 一、核心借鉴：ContextMemory 作为 Agent 的 context owner

kimi-code 每个 `Agent`（含 subagent）持有一个独立的 `ContextMemory`：

- 路径：`kimi-code/packages/agent-core/src/agent/context/index.ts`
- `ContextMemory` 持有 `_history`、`_tokenCount`、`pendingToolResultIds`、`deferredMessages` 等运行时状态。
- **关键点**：context 的 owner 是一个对象（Agent → ContextMemory），而不是一个字符串 id。

**映射到 ohbaby-agent**

| kimi-code | ohbaby-agent 本轮 |
|-----------|-------------------|
| `Agent` 实例 | `AgentInstance` |
| `Agent.context: ContextMemory` | `AgentInstance.contextScope` |
| context 在内存中随 Agent 生命周期 | SQLite message 仍是真相源；`AgentContextScope` 做运行时身份与 scope/filter 门面 |
| `ensureIdleSubagent` 校验 parent/active turn | `AgentContextScope.assertSession` + `SessionSubagentHost` 并发保护 |

> 取舍：ohbaby 不照搬 kimi 的「内存 history + wire.jsonl replay」。message 已在 SQLite，运行时只新增实例归属与行为门面，避免双写一致性复杂度。

---

## 二、借鉴：per-step 压缩契约（beforeStep）

kimi-code 在每个 step 前检查并可能阻塞压缩：

- 路径：`kimi-code/packages/agent-core/src/agent/turn/index.ts`
- 模式：`fullCompaction.beforeStep(signal)`；触达阈值则阻塞当前 turn 直到压缩完成。
- overflow 时走 `fullCompaction.handleOverflowError`，压缩完成后继续同一 turn。

**映射到 ohbaby-agent**

- ohbaby 的等价能力已存在：`Lifecycle.run` 每 step 前 `contextManager.prepareTurn`，overflow 时强制 `prepareTurn({ force:true })`。
- 本轮不再造一套 beforeStep，而是把“每轮必经压缩”的契约挂到 `AgentInstance.turn()`：任何 subagent turn 都必须经 lifecycle。
- `AgentContextScope` 作为行为门面存在，负责提供稳定 run scope 身份参数；`runAgent` 再把同一组 `sessionId/contextScopeId/isSubagent` 传给 message、run manager、lifecycle/context manager，确保下游不是吃调用方临时拼出来的字段。

---

## 三、借鉴：handoff 收口（lastAssistantText + summary-continuation）

kimi-code 的 subagent 完成后，父 agent 只拿摘要文本：

- 路径：`kimi-code/packages/agent-core/src/session/subagent-host.ts`
- 机制：`lastAssistantText()` 取最后 assistant 文本；若太短，追加一轮 `summary-continuation` 要求扩展摘要（有次数上限）。

**映射到 ohbaby-agent**

- ohbaby 现状：`extractFinalOutput` 取最后可见 assistant 文本，等价于 `lastAssistantText()`。
- 本轮：保留 `extractFinalOutput`，作为 `AgentInstance.turn()` / `SessionSubagentHost` 的收口原语。
- 后续增强：summary-continuation 放在 `SessionSubagentHost` 的 handoff 策略里，因为它涉及再发一轮 subagent turn，属服务层调度决策。

---

## 四、codex 借鉴：context window 是显式链路

codex 对 model-visible context 有几个非常硬的工程约束：

- 路径：`codex/AGENTS.md` 的 Model visible context 规则。
- context 只能增量构建，尽量避免频繁改写历史。
- 注入模型的内容必须有边界与硬上限。
- 大片段要进入 `core/context` 的结构化 fragment，而不是临时字符串拼接。

它还把 context window 身份持久化到协议项中：

- 路径：`codex-rs/protocol/src/protocol.rs` 的 `CompactedItem`。
- 字段包括 `window_number`、`first_window_id`、`previous_window_id`、`window_id`。
- `TurnContextItem` 在真实 user turn 后、以及 mid-turn compaction 重新建立上下文后持久化 durable baseline。
- `new_context_window` 工具显式开启新窗口，不伪装成普通消息。

映射到 ohbaby-agent：

| codex | ohbaby-agent 本轮 |
|-------|-------------------|
| context window id chain | 本轮不实现，但 `AgentContextScope` 是未来挂 window identity 的位置 |
| bounded contextual fragments | 保持 `core/context` 结构化 assemble/reduce，不在 `agents` 层拼大字符串 |
| compaction item durable baseline | 继续复用 SQLite message + compaction 结果，不引入 rollout trace |
| explicit new context window tool | 不做；本轮只保证 subagent turn 不绕过 prepare/compact |

对当前设计的启示：`AgentContextScope` 不只是字段集合，它应成为“某个 agent 实例当前 context 边界”的身份入口。即使 window chain 以后再做，也不该把窗口身份散落到工具或 DB 查询参数中。

---

## 五、codex 不直接借鉴的部分

| codex 机制 | 是否借鉴 | 理由 |
|------------|----------|------|
| thread rollout / fork 历史截断 | ❌ 本轮不做 | ohbaby 目标是继续同一 child session，不做 thread fork |
| protocol-level context window id | ⏳ 后续 | 有价值，但需先完成 `AgentContextScope` 行为化 |
| `new_context_window` 工具 | ❌ 本轮不做 | 与 subagent 隔离问题正交 |
| context fragment trait 体系 | ⏳ 后续 | 原则借鉴，类型体系不照搬 Rust 实现 |

---

## 六、明确不借鉴的 kimi-code 部分（避免过度设计）

| kimi-code 机制 | 是否借鉴 | 理由 |
|----------------|----------|------|
| wire.jsonl 事件溯源 replay | ❌ 本轮不做 | ohbaby message 已在 SQLite；引入事件溯源是独立大改 |
| `PromptOrigin` 消息来源标记 | ⏳ 后续 | 有价值（精准压缩/审计），但不阻塞本轮 context owner |
| Micro compaction（tool 输出投影截断） | ❌ 复用 ohbaby 现状 | ohbaby `core/context` 已有 mask/prune/summary |
| primary eager resume | ❌ 本轮不做 | primary root instance 延后，避免扩大风险面 |

---

## 七、借鉴小结

本轮从 kimi-code 与 codex 取一个共同思想：**context 的 owner 必须是运行时对象，压缩与窗口边界要挂在对象生命周期上**。ohbaby 的落地方式是 `AgentInstance + AgentContextScope + SQLite message 真相源`，不是照搬 kimi 的内存 history/wire 模型，也不是照搬 codex 的 thread rollout/window chain。
