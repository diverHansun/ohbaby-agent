# 03 · kimi-code / codex 设计借鉴（agents 服务层视角）

对照项目：

- `/Users/hansun025/Projects/code-cli/kimi-code`
- `/Users/hansun025/Projects/code-cli/codex`

本文只提取和本轮相关的设计：实例隔离、host/control-plane 收敛、单召唤入口、lazy resume。

---

## 一、借鉴：SessionSubagentHost 是唯一 child owner

kimi-code 用 `SessionSubagentHost` 管理某个 owner agent 的全部 child agent：

- 路径：`kimi-code/packages/agent-core/src/session/subagent-host.ts`
- 能力：`spawn`、`resume`、`retry`、`runQueued`
- 运行态：`activeChildren` 记录 child id、`AbortController`、运行 handle
- 关键约束：一个 child 就是一个独立 `Agent` 实例，foreground/background 只是等待方式不同

映射到 ohbaby-agent：

| kimi-code | ohbaby-agent 本轮 |
|-----------|-------------------|
| `SessionSubagentHost` | `agents/subagent-host.ts` |
| child `Agent` | child `AgentInstance` |
| `activeChildren: Map<childId, ...>` | `active: Map<subagentId, ActiveSubagentState>` |
| `spawn` / `resume` | `subagent_run` 创建或继续 |
| `runQueued` | host 内部 queue/interrupt 调度 |

这支持“实例隔离优先”：不是每次靠参数重新拼一个 `runAgent`，而是恢复同一个 child instance 继续 turn。

---

## 二、借鉴：一个召唤工具，两种运行模式

kimi-code 的 collaboration agent 工具用一个入口表达 foreground/background：

- 路径：`kimi-code/packages/agent-core/src/tools/builtin/collaboration/agent.ts`
- foreground：父 turn 等待 child 完成。
- background：立即返回 handle，child 在后台继续。

映射到 ohbaby-agent：

| 语义 | 本轮工具 |
|------|----------|
| 创建 foreground child | `subagent_run({ role, prompt, mode:"foreground" })` |
| 创建 background child | `subagent_run({ role, prompt, mode:"background" })` |
| 继续 child | `subagent_run({ subagent_id, prompt, mode })` |
| 查询 child | `subagent_status({ subagent_id })` |
| 关闭 child | `subagent_close({ subagent_id })` |

因此本轮不再保留 `task` 与 `agent_open` 两个召唤入口，也不再需要单独的 `agent_eval` 动词。

---

## 三、借鉴：持久化实例树 + lazy resume

kimi-code 的 session 与 agent records 分层持久化：

- `session/index.ts` 记录 session 的 agent 树。
- `agent/records/index.ts` 记录每个 agent 的事件流。
- session resume 时只 eager resume main agent，subagent lazy resume。

映射到 ohbaby-agent：

| kimi-code | ohbaby-agent 本轮 |
|-----------|-------------------|
| session agents tree | `subagent_instance` 表 |
| child id | `subagent_id` |
| per-agent records | SQLite `message` 作为已有真相源 |
| lazy resume | `SessionSubagentHost` 按 `subagent_id` 恢复 `AgentInstance` |
| 不自动重启 child run | 重启时 `pending/running -> interrupted` |

取舍：ohbaby 不引入 `wire.jsonl` 事件溯源。已有 SQLite message 足够重建上下文，`subagent_instance` 只补 durable instance handle、状态、队列与恢复语义。

---

## 四、借鉴：实例校验比字段约定更重要

kimi-code 的 child agent 不是靠“传了 parent id 所以它是 subagent”来成立，而是在 host 与 child instance 关系中成立。ohbaby-agent 本轮对应到两个层次：

1. `AgentContextScope.assertSession()` 校验 session、parent、role/name 与实例 identity 一致。
2. `SessionSubagentHost` 校验 `subagent_id` 属于当前 parent，且同一时间只有一个有效 turn 在运行或排队。

这正好修复当前“DB 字段逻辑隔离”不够的问题：DB 仍是 durable truth，但运行时隔离由实例对象和 scope 行为承载。

---

## 五、codex 对照：AgentControl + thread-per-subagent

codex 的 multi-agent V2 更像“每个 subagent 是一个 thread，由 control-plane 统一管理”：

- 路径：`codex-rs/core/src/agent/control.rs`
- `AgentControl` 由 root session tree 共享，持有 agent registry、execution limiter、V2 residency。
- `spawn_agent_with_metadata` 创建 child thread，`send_input` / `interrupt_agent` / `get_status` 管理既有 child。
- child 通过 `SessionSource::SubAgent`、`parent_thread_id`、`AgentPath` 与 parent 建立运行时关系。
- `V2Residency` 可把 finished / errored / interrupted 且无 active turn 的 child 从内存卸载，需要时再加载。

映射到 ohbaby-agent：

| codex | ohbaby-agent 本轮 |
|-------|-------------------|
| root tree-scoped `AgentControl` | parent-scoped `SessionSubagentHost` |
| child thread id / `AgentPath` | `subagent_id` / child session 下的 `context_scope_id` |
| `send_input` / `interrupt_agent` / `get_status` | `subagent_run` / `interrupt` / `subagent_status` |
| residency unload + reload | 重启或卸载后从 `subagent_instance` + SQLite message lazy restore |
| `AgentStatus::Interrupted` 可卸载 | `interrupted` 是重启后的显式恢复态 |

对本轮最有价值的是 control-plane 归属：subagent 的状态、容量、恢复、消息投递集中在一个对象中，而不是散落在多个工具后端。

---

## 六、codex 对照：不直接照搬的点

| codex 机制 | 本轮取舍 |
|------------|----------|
| thread-per-subagent + thread store | 不搬，ohbaby 已有 session/message 存储，先用 `AgentInstance` |
| fork parent rollout history | 不搬，本轮只继续同一 child session，不做 fork 模式 |
| 多工具面 `spawn_agent/send_message/wait/interrupt/list` | 不搬，用户已确认只保留一个召唤入口 `subagent_run` |
| V2 residency LRU 卸载 | 暂不做；先实现重启 `interrupted` 与 lazy restore |

---

## 七、暂不借鉴的 kimi-code 点

| kimi-code 能力 | 本轮取舍 |
|----------------|----------|
| `wire.jsonl` replay | 不做，避免与 SQLite message 双写 |
| background completion steer/notification | 暂不做，仍使用 `subagent_status` |
| `SubagentBatch` swarm 限流 | 暂不做，保留现有并发上限策略 |
| primary eager resume | 暂不做，primary root instance 后续阶段 |

---

## 八、小结

本轮从 kimi-code 与 codex 合并得到四个结论：

1. subagent 要有独立实例，不只靠 DB 字段隔离。
2. foreground/background 是同一个 child instance 的两种等待模式。
3. subagent control-plane 要集中在 `SessionSubagentHost`，不能散在多个工具后端。
4. 重启后只恢复可观测状态，不自动续跑；继续必须由主 agent 显式触发。
