# 3. 优秀项目借鉴（codex / kimi-code）

## 3.1 对比维度

| 维度 | ohbaby（目标态） | kimi-code | codex |
|------|------------------|-----------|-------|
| 逻辑实例 | SubagentInstanceRecord + child session | session.metadata.agents[id] | Thread 树 + rollout |
| 编排 vs 执行 | goals 编排 / agents 执行 | Session + AgentHost | ThreadManager + spawn |
| 跨进程恢复 | DB record + recoverInterrupted；手动 subagent_run | ensureAgentResumed 从磁盘 reload Agent | resume_thread 恢复 history |
| 停止语义 | goal 停 => interrupt 主+子，不 close | parent abort + suspended 事件 | thread interrupt + SubAgentActivity |
| complete 语义 | main 宣告；不强制删 spawn 树 | host 不强制销毁 sibling agents | thread complete 不自动删子 thread |
| background | subagent_run mode=background | runInBackground | 多 thread 并发 |

---

## 3.2 kimi-code

### 3.2.1 相关代码

- `packages/agent-core/src/session/subagent-host.ts` — spawn / resume / retry / runQueued
- `packages/agent-core/src/session/index.ts` — `createAgent`, `ensureAgentResumed`, `resumePersistedAgent`
- `packages/protocol/src/events.ts` — `subagent.spawned`, `subagent.suspended`, `subagent.completed`

### 3.2.2 可借鉴点

**1. 显式 resume API**

kimi 的 `SessionSubagentHost.resume(agentId, options)` 与 ohbaby 的 `subagent_run(subagent_id=...)` 同构：续接由 **parent/main 显式发起**，host 不自动 drain。

ohbaby 目标态一致：`/goal resume` 不自动恢复 subagent。

**2. Agent 元数据持久 + ensureAgentResumed**

kimi 在 session metadata 中持久 agent 身份，进程重启后 `ensureAgentResumed(id)` 从磁盘重建 Agent 对象（`session/index.ts:547-553`）。

ohbaby 等价物：`SubagentInstanceRecord` + child session 消息/context 在 SQLite；重启后 `recoverInterrupted` + main 显式 `subagent_run`。**不**自动 reload 跑 queue——与 kimi 的「resume 是显式动作」一致。

**3. subagent.suspended 事件**

kimi 用 `subagent.suspended` 通知 parent（`subagent-host.ts:204-208`），便于 UI/模型感知。

ohbaby 可选：在 `interruptByParent` 后通过 stream-bridge 发 notice（非 MVP）。

**4. persistMetadata: false 的 side-agent**

kimi 对轻量 side 对话使用 `persistMetadata: false`（`subagent-host.ts:221`），与主 subagent 区分。

ohbaby 暂无等价物；goal paused 时用户琐事走 primary user prompt，不单独 side-agent instance。

### 3.2.3 不必照搬

- kimi 的 `ensureAgentResumed` 自动从 metadata 重建 Agent——ohbaby 已选择 tool 显式续接，更简单、与 goals ignorant 一致。
- kimi swarm / batch 并发模型——ohbaby 有 `maxSubagentConcurrency: 3`，goal 议题不扩展 swarm。

### 3.2.4 Goal budget 接口

Kimi 的 `/goal` 不提供 budget 子命令；停止条件由用户写在自然语言 objective 中，main 通过 `SetGoalBudget(value, unit)` 翻译成结构化限制。tool 每次只设置一个维度，支持 turns、tokens、milliseconds、seconds、minutes、hours，并明确禁止模型自行发明预算。time 以 active pursuit 为准，在 turn/continuation 边界执行，不承诺精确 deadline。

ohbaby 采用相同产品契约：用户不接触结构化 flags，main 只翻译用户、system 或 developer 明确限制。与 Kimi 不同的是，ohbaby 另保留始终生效的 1000 goal-turn 系统绝对安全阀；它不是预算，不进入预算报告。

---

## 3.3 codex

### 3.3.1 相关代码

- `codex-rs/protocol/src/protocol.rs` — `SubAgentSource::ThreadSpawn`, `SessionSource::SubAgent`
- `codex-rs/thread-store/` — thread 持久、resume、list_threads
- `codex-rs/tui/src/chatwidget/replay.rs` — `SubAgentActivity` 回放

### 3.3.2 可借鉴点

**1. Thread 树作为 spawn 关系真相源**

codex 用 `parent_thread_id` + spawn 树表达 subagent 关系；resume thread 时恢复整棵 history 树。

ohbaby 用 `parentSessionId` + `subagentId` + child session；关系更 flat，但 **持久 record + 显式续接** 可达类似效果。

**2. complete 不销毁 spawn 树**

codex thread complete 不会自动删除子 thread；子 thread 可独立存在直到显式关闭。

与 ohbaby 决策一致：**goal complete 不 force close subagent**。

**3. SubAgentActivity 可观测性**

codex TUI 用 `SubAgentActivity`（Started / Interrupted / Contacted）展示多 agent 状态。

ohbaby 可通过 `subagent_status` + stream-bridge goal/subagent 快照增强 UI（非 MVP）。

**4. 长任务 goal 与 thread 分离**

codex TUI 有 thread goal pause/resume（`app_event.rs` 提及），与 subagent thread 生命周期分离。

与 ohbaby goals 模块定位一致：goal 是编排，subagent 是 execution 增强。

### 3.3.3 不必照搬

- codex 的 thread 即 session 模型——ohbaby 已固定 session + contextScopeId，不宜为 goal 议题改模型。
- codex app-server 持久 resume _attach 到 running thread——ohbaby daemon 走 SQLite + recoverInterrupted，架构不同。

---

## 3.4 综合结论

| 借鉴 | 落地到 ohbaby |
|------|----------------|
| 显式 resume，不 auto-drain | 已符合；保持 `/goal resume` 不触 subagent |
| complete 不删 spawn 树 | 已确认；goal complete 不 close subagent |
| 停止时 interrupt 子任务 | kimi/codex 在 parent abort 路径有；ohbaby **需补** pause/cancel/budget 路径 |
| 持久 + 显式唤醒 | persistent 模式 + subagent_run(subagent_id) |
| 可观测性 | 后续 stream/UI；非 MVP 阻塞 |
| 自然语言预算 → 单维工具翻译 | 移除 `/goal budget`；SetGoalBudget 支持 turns/tokens/time units，禁止模型发明 |

ohbaby 的差异是 **更严格的分层**（goals ignorant）。借鉴时应补 **adapter 薄契约 + 测试**，而非把 kimi 的 ensureAgentResumed 或 codex thread 树搬进 goals。
