# 3. 参考项目与取舍

> 参考代码均以 2026-07-12 本机 checkout 为准。本文只借鉴可验证的并发与事件机制，不把其他产品的交互语义直接搬进 ohbaby。

## 3.1 结论先行

| 来源 | Adopt | Adapt | Reject |
|------|-------|-------|--------|
| Codex | 每个 thread 独立持有 active turn；提交和执行完成解耦 | 在 thread 之外增加 workspace 10 槽调度与 durable submission | 用“全局唯一 active turn”解释整个 workspace；依赖进程内状态恢复队列 |
| Kimi Code | per-session active/queued map；稳定 prompt/message ID；submitted 事件即时投影 | 把进程内队列改为服务端 SQLite 真相，并加 100 条安全上限 | 本批把后续输入变成 steer/merge；由 Web 自己维护队列顺序 |
| ohbaby subagent | 原子 claim、期望 owner/run ID 的条件完成、晚到结果防护 | 为 prompt 建独立、可查询、跨 session 排序的表和状态机 | 复用 subagent JSON 队列字段或把 prompt 混进 subagent 表 |

共同结论：成熟实现都不会让“一个全局布尔值”代表所有会话的运行状态。ohbaby 应将活跃执行收敛到 `sessionId → active prompt/run`，并在更外层增加 workspace admission；客户端只消费 receipt、snapshot 和事件。

## 3.2 Codex：thread 隔离 active turn

### 3.2.1 代码证据

本机来源：`/Users/hansun025/Projects/code-cli/codex`，基线 commit `5c19155`。

- `codex-rs/core/src/thread_manager.rs`：`ThreadManagerState` 持有 `HashMap<ThreadId, Arc<CodexThread>>`，不同 thread 是独立运行单元。
- `codex-rs/core/src/session/session.rs`：每个 session 自己持有 `active_turn: Mutex<Option<ActiveTurn>>`，active turn 不是进程级单值。
- app-server 的提交边界先确认请求，再通过通知持续投影 turn/item 状态；调用方不需要阻塞到整个模型执行结束才知道“发送成功”。

### 3.2.2 借鉴

1. **隔离粒度放在 session/thread**：一个 session 同时只能有一个正式 active run，但不妨碍其他 session。
2. **控制面与执行面分离**：提交请求返回稳定标识；执行进展通过事件和 snapshot 呈现。
3. **取消带目标标识**：不能再依赖 workspace 中“唯一 active run”的隐含假设。

### 3.2.3 不照搬

- Codex 的 thread 管理回答的是“每个 thread 如何运行”，没有直接给出本产品需要的 workspace 10 槽与 100 条等待上限。
- 本批不把同 session 的普通发送解释成 steer。用户已确认严格 FIFO；steer/merge 需另立语义和工具调用安全规则。
- Codex 的具体事件名、item 模型和审批协议不是 ohbaby wire contract，不能为了表面一致而大规模改写现有 SDK。

## 3.3 Kimi Code：per-session prompt lane 与即时 submitted

### 3.3.1 代码证据

本机来源：`/Users/hansun025/Projects/code-cli/kimi-code`，基线 commit `19c5aa6`。

- `packages/agent-core/src/services/prompt/promptService.ts`：使用 `_active` 与 `_queued`，按 session key 管理正在执行和等待 prompt。
- prompt 提交会产生稳定 `promptId` / `userMessageId` 和状态，并发布 `prompt.submitted`，前端无需等待模型首 token 才显示用户输入。
- Web 端将事件投影到 UI；高频纯渲染事件可按 animation frame 批处理，但控制事件不会被“为了性能”延迟到模型执行结束。

### 3.3.2 借鉴

1. **submission 是一等对象**：先有“服务器已经接受的 prompt”，随后才是执行、正式消息与结果。
2. **同 session lane**：active 与 queued 都按 session 归属，避免一个 session 的 busy 状态把整个 workspace 锁死。
3. **稳定 ID 幂等合并**：HTTP/JSON-RPC receipt 与 SSE 事件可能乱序，客户端按 `promptId/userMessageId` upsert。
4. **即时控制事件**：`submitted/queued/failed/cancelled` 不与 token batching 混在一起，确保交互反馈及时。

### 3.3.3 需要适配

- Kimi 的 `_active/_queued` 是很好的职责形状，但 ohbaby 已确认 daemon 重启后 queued 要恢复，因此权威状态必须落 SQLite。
- ohbaby 同时有 Web、remote CLI 与 embedded TUI。全局 serve 内只能有一个 scheduler/store owner；TUI 复用契约但保留既有 in-process 边界。
- ohbaby 还需要 workspace 级 10 槽与 100 queued admission，这是产品资源护栏，不应从 provider 配额反推。

### 3.3.4 不照搬

- 本批不采用“新 prompt 立即 steer 当前 run”；普通发送严格 FIFO。
- Web 不维护第二份排序真相，不通过本地数组长度决定第 11 条是否 queued。
- 不把 request Promise 挂到 run 终态；只有非交互 `ohbaby run` 显式调用 wait completion。

## 3.4 ohbaby subagent：持久化 claim 与晚到完成防护

### 3.4.1 代码证据

仓库内已有可复用经验：

- `packages/ohbaby-agent/src/agents/subagents/database-store.ts` 使用带当前状态/owner 条件的原子更新和 `RETURNING`，避免两个执行者同时 claim。
- `packages/ohbaby-agent/src/agents/subagent-host.ts` 将 pending/current 与运行完成分开管理；完成时核对当前 run，避免旧异步结果覆盖新状态。

### 3.4.2 借鉴

- `queued → starting` 必须是条件 claim，而不是先读后写。
- `finish(promptId, expectedRunId, outcome)` 必须核对 run，晚到 completion 不得复活 cancelled/interrupted submission。
- durable store 只暴露窄状态转移，不提供任意 record update。

### 3.4.3 不直接复用

prompt queue 与 subagent queue 的查询和一致性需求不同：

- prompt 需要按 workspace 统计 100 cap、跨 session 找最早 eligible lane head、按 session 投影到 Web。
- queued prompt 的正文不能提前成为 conversation message。
- prompt 与 `run_ledger`、message、SSE 有稳定 ID 关联。

因此应复用原子 claim 的工程模式，而不是复用 subagent 表或 JSON 队列字段。

## 3.5 参考结论如何落到方案

| 参考结论 | 02 中的落点 | 验收重点 |
|----------|-------------|----------|
| per-session active state | §2.5、§2.6 | 10 个不同 session 真并发，同 session 永不重叠 |
| submit 与 completion 解耦 | §2.7.1、§2.7.4 | receipt 立即返回；非交互 CLI 仍等待终态 |
| submission 一等对象 | §2.3、§2.4 | queued 可刷新/重启恢复，且不进入模型 context |
| 稳定 ID 与事件投影 | §2.7.2、§2.10.1 | receipt/SSE 任意顺序都不重复 user bubble |
| atomic claim / expected run | §2.4.1、§2.5.2 | 双 drain 与晚到 completion 不破坏状态 |
| 客户端不是 queue owner | §2.1.1、§2.10 | 多 Web/CLI 观察到相同队列状态和次序 |

## 3.6 最终建议

采用“Codex 的 session 隔离 + Kimi 的 submission/即时事件 + ohbaby 自身的 durable atomic claim”，但由 ohbaby 的产品约束补上 workspace 10 槽、100 waiting cap、重启恢复和 TUI/serve 明确边界。这比照搬任一项目更符合当前单 daemon 架构，也为未来 `/loop` 复用 session lane 与 scheduler 状态留下了清晰接口。
