# 2. 优化方案与改动面

> 本文是后续实施会话的执行契约。本规划会话不据此修改业务代码。

## 2.1 目标架构

每个 backend workspace runtime 只保留一个 `WorkspacePromptScheduler`。transport 负责鉴权、路由和编码；scheduler 负责接受、持久化、lane、公平性、容量、恢复和终态推进；`PromptExecutor` 只负责执行一个已经 claim 的 submission。

```text
Web / remote CLI / embedded TUI
          │ submitPrompt(text, session?)
          ▼
UiBackendClient acceptance boundary
  1. resolve/create session
  2. create promptId + userMessageId
  3. store.accept(queued)          ← queue full 在这里 fail-closed
  4. publish prompt.submitted
  5. return receipt immediately
          │
          ▼
WorkspacePromptScheduler
  per-session FIFO
  maxActiveSessions = 10
  maxQueuedPrompts = 100
          │ claim oldest eligible lane head
          ▼
PromptExecutor
  commit user message with reserved ID
  RunManager / RunLedger / Lifecycle / LLM
          │
          ▼
prompt.updated + run.updated + message.*
          │ terminal settle
          └──────── release lane/slot → drain next
```

### 2.1.1 单一真相的含义

- queue order/state 只有 scheduler/store 一份。
- `DaemonPromptQueue` 与 `PromptQueueController` 不再各自维护一套 active/queued。
- Web/CLI 不根据“当前看起来 running”推测 queued。
- RunLedger 仍是执行审计和同 session 原子 claim，不替代 submission store。
- conversation message 仍是模型上下文真相，不替代 queued submission。

### 2.1.2 TUI/serve 边界

保持既有决策：

- 全局 serve 的每个 `WorkspaceInstance` 使用 SQLite durable `PromptSubmissionStore`，多个 Web/remote client 共享。
- 默认 TUI 仍创建 in-process backend；它使用同一 receipt/event/scheduler 契约，但 queue store 默认进程内，不 attach serve。
- 默认 TUI 与 serve 同时写同一 DB 时，不承诺跨 runtime 严格 FIFO；`run_ledger.claimPendingRun` 继续作为同 session 双写最终防线。
- 本批 “workspace 10 槽” 的产品承诺首先指单个全局 serve `WorkspaceInstance`。若未来要做机器级跨 TUI/serve 总槽位，需要另立跨 runtime admission 议题，不能在本批暗加全局 lease。

## 2.2 设计决策

| 决策 | 选择 | 理由 | 放弃方案 | 已知代价 |
|------|------|------|----------|----------|
| queue owner | backend runtime 的 `WorkspacePromptScheduler` | 最接近 session/run/message 生命周期；transport 不再知道 busy retry | daemon queue + backend queue 双层 | 需要拆分当前 `submitPromptInternal` |
| daemon persistence | SQLite `prompt_submission` | queued 重启恢复、snapshot 可查询、已有 DB/WAL | 纯内存、localStorage | 增加 migration/store/恢复状态机 |
| embedded TUI store | in-memory adapter，协议一致 | 保留 TUI in-process 和低启动复杂度 | 强制 attach daemon、共享 durable consumer | TUI 与 serve 不共享严格 FIFO |
| active limit | 10 distinct session lanes/workspace runtime | 用户确认；正常使用低感知、仍有资源护栏 | 1、5、无限 | 10 个 permission wait 可占满槽 |
| queue limit | 100 queued/workspace | 防止无界本地磁盘/内存增长 | 无限、按 provider 限制 | 第 101 条需明确失败 UX |
| same session | strict FIFO | conversation/context 顺序一致 | reject、interrupt-current、steer | 后续 prompt 必须等待旧 run settle |
| queued UI | 仅 `queued` 进入独立 Queue 区；其余状态进入 conversation 投影 | 最小字段、立即可见且不污染模型 context | 展示完整状态机、提前写正式 message、本地 optimistic message | reducer 仍需按 ID 合并 submission/message |
| running recovery | interrupted，不 replay | 避免模型/工具副作用重复 | 自动重试 | 用户需显式继续 |
| queued recovery | 自动 resume | durable queue 的直接价值 | 全部 cancel | daemon 重启后会继续用户已接受工作 |
| error contract | core normalize + SDK DTO | Web/CLI 共享同一语义 | 各端解析 `Error.message` | 需要兼容旧 string error |
| submit completion | receipt 即完成 | 输入立即可见；与 Kimi/Codex app-server 习惯一致 | await whole run | 非交互 CLI 需显式 wait API |
| event transport | 扩展既有 UiEvent/SSE/JSON-RPC | 复用 seqNum/resync/generation | 新 WebSocket/第二 event bus | SDK 为 packageVersion breaking change |

## 2.3 状态模型

### 2.3.1 Core record

```ts
type PromptSubmissionStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

interface PromptSubmissionRecord {
  promptId: string;
  scopeKey: string;
  sessionId: string;
  userMessageId: string;
  text: string;
  status: PromptSubmissionStatus;
  runId?: string;
  error?: NormalizedPromptError;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  endedAt?: number;
}
```

本批仍只支持 text prompt；不为了未来附件提前设计通用 content AST。

### 2.3.2 状态转移

```text
accept ───────────────→ queued
queued ──claim───────→ starting
starting ─run ready──→ running
running ─────────────→ succeeded | failed | cancelled
queued ─shutdown─────→ queued                 (durable daemon)
starting/running ─restart recovery──────────→ interrupted
queued ─workspace unavailable on recovery───→ failed
```

禁止的转移：

- terminal → running
- queued → succeeded
- failed/cancelled/interrupted 自动回 queued
- 同一 `promptId` 二次 claim

### 2.3.3 queued 与 message 的关系

1. accept 时预分配 `userMessageId`，但不写 core `message`。
2. snapshot/UI 将 queued submission 投影为临时 user bubble。
3. claim 后，executor 用该 `userMessageId` 写正式 message。
4. reducer 以 ID 合并，queued bubble 变为正式 message；不得 append 第二条。
5. context/history 查询只读取正式 `message`，不读取 `prompt_submission`。

此边界是防止未来 prompt 泄漏到当前 lifecycle 的承重不变量。

## 2.4 SQLite schema 与 store

新增 migration `014_prompt_submission`（最终编号以实施时 HEAD 的下一号为准，若期间已有 migration 必须顺延，不得复用版本号）：

```sql
CREATE TABLE prompt_submission (
  prompt_id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'starting', 'running',
      'succeeded', 'failed', 'cancelled', 'interrupted'
    )
  ),
  run_id TEXT,
  owner_id TEXT,
  owner_pid INTEGER,
  error_data TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE INDEX idx_prompt_submission_scope_status_order
  ON prompt_submission(scope_key, status, created_at, prompt_id);

CREATE INDEX idx_prompt_submission_session_status_order
  ON prompt_submission(session_id, status, created_at, prompt_id);
```

为兼容现有 `run_ledger.error TEXT`，新增可选 `error_data TEXT`，原 `error` 继续保存安全的人类可读 message：

```sql
ALTER TABLE run_ledger ADD COLUMN error_data TEXT;
```

### 2.4.1 Store API

建议落点：`packages/ohbaby-agent/src/runtime/prompt-scheduler/`。

```ts
interface PromptSubmissionStore {
  accept(input): Promise<PromptSubmissionRecord>;
  editQueued(promptId, expectedUpdatedAt, text): Promise<PromptSubmissionRecord>;
  cancelQueued(promptId, expectedUpdatedAt): Promise<PromptSubmissionRecord>;
  claim(promptId, input): Promise<PromptSubmissionRecord | null>;
  markRunning(promptId, runId): Promise<PromptSubmissionRecord>;
  finish(promptId, expectedRunId, outcome): Promise<PromptSubmissionRecord>;
  listQueued(scopeKey): Promise<readonly PromptSubmissionRecord[]>;
  listVisible(scopeKey): Promise<readonly PromptSubmissionRecord[]>;
  listScopesWithQueued(): Promise<readonly string[]>;
  recoverInterrupted(owner): Promise<number>;
}
```

Store 不暴露任意 `update(record)`；状态转移使用窄方法和前置条件，防止晚到 completion 覆盖 cancel/interrupted。可借鉴 subagent store 的 `UPDATE ... WHERE current_run_id IS ? RETURNING *`。

`editQueued/cancelQueued` 必须使用 `WHERE prompt_id=? AND status='queued' AND updated_at=?` 条件更新。编辑只更新 `text/updated_at`，不改 `created_at`，因此不改变 FIFO；取消写 `cancelled/ended_at`。若 claim 已经胜出，返回 `PROMPT_NOT_QUEUED` 或 `PROMPT_VERSION_CONFLICT`，不能把 starting/running 改回 queued。

### 2.4.2 接受与 queue cap 原子性

- 同 workspace acceptance 通过 scheduler mutex 串行。
- durable store 在事务内重新计算 `status='queued'` 数量并插入，防止未来多 transport race。
- `queuedCount >= 100` 时不插入，抛 `PromptQueueFullError`。
- 新 session 必须在 acceptance boundary 创建/确认后再 insert，使 FK 与刷新恢复成立。
- 若 session 创建后 insert 意外失败，可保留为空 session；不得删除一个可能已被其他事件观察到的 session。queue-full 检查必须发生在新 session 创建前，避免常规满队列留下空 session。

### 2.4.3 保留与数据边界

- 100 cap 只统计 `status='queued'`；`starting/running` 受 10 槽约束，terminal 不占 admission 容量。
- 本批保留 terminal submission，不做 TTL 或后台 GC，以便错误详情、幂等事件和重启后 UI 仍可解释。
- prompt text 与 conversation message 使用同一 workspace SQLite 和文件权限边界，不复制到 `daemon-state.json`、日志或用户级 registry。
- 成功 submission 与正式 message 会短期/长期重复保存 text，这是本批为简单、可恢复状态机接受的存储代价；未来 compaction 必须保留 `promptId/userMessageId/status/error` 关联，且另立 migration/兼容设计。

## 2.5 Scheduler 算法

### 2.5.1 数据结构

```text
activeBySession: Map<sessionId, ActivePrompt>
activeCount: number              // <= 10
queuedHeads: durable store order // createdAt, promptId
acceptMutex / drain guard
```

### 2.5.2 drain

1. 若 `activeCount >= 10`，停止。
2. 读取最早的 queued entry，其 session 不在 `activeBySession`。
3. 原子 `queued → starting` claim；失败则重新读取。
4. 占用 session lane 与 workspace slot。
5. fire-and-forget 执行 executor；drain 继续寻找其他 eligible session，直到 10。
6. executor terminal 后先完成 RunLedger/stream/sandbox 收口，再 finish submission。
7. 在 `finally` 删除 active lane、减少 activeCount、再次 drain。

同 session 的第二条即使更早，也不能挡住其他 session 的 lane head；跨 session 是“按到达顺序选择当前可运行的 lane head”，不是虚假的全局串行 FIFO。

### 2.5.3 busy error

- 同一 scheduler 内不应靠 `SessionRunBusyError` 正常推进；lane 已保证互斥。
- `SessionRunBusyError` 只表示另一个 runtime（例如默认 TUI）持有同 session claim。
- 遇到该错误时保持该 submission 在队首并退避重试，不越过同 session 后续项；其他 session 可继续。
- provider/auth/API error 绝不进入 busy retry，直接终结该 prompt。

## 2.6 多 session runtime 状态

### 2.6.1 替换单值状态

当前全局字段：

- `promptInFlight`
- `promptInFlightOwner`
- `promptInFlightSessionId`
- `promptRunReady`
- `InProcessRuntimeController.activeRunId`

目标：

```ts
Map<sessionId, {
  promptId: string;
  runId?: string;
  owner: "user" | "goal";
  phase: "starting" | "running" | "settling";
}>
```

`abort`、permission、goal interruption、stream projection 必须显式带 sessionId/runId，不再依赖“当前唯一 active run”。

### 2.6.2 UiSnapshot.status 兼容

- `UiRun[]` 与 `UiPromptSubmission[]` 是多 session 权威集合。
- 顶层 `UiSnapshot.status` 暂保留，作为当前 client selected session 的兼容投影。
- `DaemonClientViewCoordinator` 从该 client 的 active session 对应 run/permission 推导 status，不能复制 backend 的全局 status。
- Web selector 继续只控制当前 session composer，但切走不会停止其他 session run。

## 2.7 SDK 与协议

### 2.7.1 Receipt

```ts
interface UiPromptReceipt {
  promptId: string;
  userMessageId: string;
  sessionId: string;
  status: "queued" | "starting" | "running";
  createdAt: string;
}

interface UiEditQueuedPromptInput {
  promptId: string;
  text: string;
  expectedUpdatedAt: string;
}

interface UiCancelQueuedPromptInput {
  promptId: string;
  expectedUpdatedAt: string;
}

interface UiPromptQueueClient extends UiBackendClient {
  submitPromptAccepted(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<UiPromptReceipt>;
  editQueuedPrompt(input: UiEditQueuedPromptInput): Promise<UiPromptSubmission>;
  cancelQueuedPrompt(input: UiCancelQueuedPromptInput): Promise<UiPromptSubmission>;
  waitForPrompt(promptId: string): Promise<UiPromptCompletion>;
}

// 兼容契约：默认 TUI/CLI 仍提交并等待 terminal。
interface UiBackendClient {
  submitPrompt(
    text: string,
    options?: SubmitPromptOptions,
  ): Promise<void>;
}
```

interactive transport 调用 `submitPromptAccepted`，Promise 在 durable accept + event publish 后完成，不等待 run terminal。既有 `submitPrompt` 是兼容 submit-and-wait 边界，内部同样进入唯一 scheduler，不形成第二队列 owner。

### 2.7.2 Snapshot/event

```ts
interface UiPromptSubmission {
  promptId: string;
  userMessageId: string;
  sessionId: string;
  text: string;
  status: PromptSubmissionStatus;
  runId?: string;
  error?: UiPromptError;
  createdAt: string;
  updatedAt: string;
}

type UiEvent =
  | { type: "prompt.submitted"; prompt: UiPromptSubmission }
  | { type: "prompt.updated"; prompt: UiPromptSubmission }
  | /* existing */;
```

`UiSnapshot` 增加当前 workspace/client 可见 submissions。`client-view.ts` 按 active session 过滤 prompt 与 run，session list 仍可展示其他 session 的轻量元数据。

### 2.7.3 HTTP/JSON-RPC

- `POST /v1/prompts`：成功 202 返回完整 receipt。
- `PATCH /v1/prompts/:promptId`：仅编辑 queued text，返回更新后的 submission。
- `DELETE /v1/prompts/:promptId`：产品语义为取消 queued，返回 cancelled submission，不物理删除。
- JSON-RPC 新增 `submitPromptAccepted`：返回相同 receipt，不等待整个 run。
- 既有 JSON-RPC `submitPrompt` 保持 submit-and-wait，供默认 TUI/非交互调用链兼容使用；它不经过旧 daemon queue。
- JSON-RPC 增加同构 `editQueuedPrompt/cancelQueuedPrompt/waitForPrompt`。
- queue full：建议 HTTP 429，error code `QUEUE_FULL`，包含 `limit:100`；它不是 provider 429，`source:"scheduler"` 必须可区分。
- 旧 daemon/CLI 不做协议兼容；依赖已存在的 `packageVersion` 精确匹配阻止混用。
- Web receipt 与 `prompt.submitted` 可能任意先到，client 以 `promptId` 幂等 upsert。

### 2.7.4 非交互 CLI

`ohbaby run` 不能因为 submit 改为 receipt 就提前退出。新增后端等待能力或 SDK helper：

```ts
waitForPrompt(promptId: string): Promise<UiPromptCompletion>;
```

非交互 CLI 与当前 TUI：兼容 `submitPrompt` 直接等待 terminal。下一批交互式 Web：`submitPromptAccepted` receipt 后立即返回编辑状态，后续靠 events。

## 2.8 错误规范化

### 2.8.1 DTO

`ohbaby-sdk` 定义 transport-safe `UiPromptError`：

```ts
interface UiPromptError {
  code: string;
  message: string;
  source: "provider" | "runtime" | "scheduler" | "validation";
  retryable: boolean;
  providerId?: string;
  statusCode?: number;
  attempts?: number;
  terminalReason?: string;
}
```

code 至少覆盖：

- `PROVIDER_AUTH`
- `PROVIDER_API`
- `PROVIDER_RETRY_EXHAUSTED`
- `PROVIDER_STREAM_INTERRUPTED`
- `CONTEXT_OVERFLOW`
- `OUTPUT_LENGTH`
- `ABORTED`
- `QUEUE_FULL`
- `WORKSPACE_UNAVAILABLE`
- `SESSION_BUSY`
- `UNKNOWN`

终态语义补充：`OUTPUT_LENGTH` 是 provider 以 `finishReason=length` 截断输出时的失败 detail；用户主动取消仍以 submission/run 的 `cancelled` 状态为权威，`ABORTED` 仅作为需要序列化取消原因时的稳定映射；`SESSION_BUSY` 是 scheduler 的内部退避信号，正常 admission 会重排而不会把它伪装成面向客户端的 terminal provider error。

### 2.8.2 Core mapping

- 新建单一 `normalizePromptError(error, context)`，复用 `providerErrorStatus/isRetryableProviderError`。
- `markAssistantMessageError` 不再无条件写 `Unknown`。
- `ProviderRetryExhaustedError.cause` 只用于提取 allowlist 字段，不整体序列化。
- `RunCompletion` 保留兼容 `error?: string`，新增结构化 detail；RunLedger 同时写 `error` 与 `error_data`。
- Web/CLI 不识别 provider SDK class，只消费 `UiPromptError`。

### 2.8.3 展示归属

- admission error：提交调用直接失败，不出现 queued bubble。
- accepted 后失败：`prompt.updated(status=failed,error)`，只影响目标 session/prompt。
- 全局 SSE `{type:"error",message}` 仅保留连接/协议级错误，不能再承载 prompt/provider 失败。
- Queue 区只显示 `queued`；accepted 后的失败/中断进入目标 conversation message 下方的一条简短结果，不建立第二个失败/中断列表。
- CLI 用同一 message，并在非交互模式映射非零 exit code。

## 2.9 重启恢复

### 2.9.1 启动顺序

1. 初始化 DB/migration。
2. RunLedger 继续执行 orphan recovery。
3. Prompt store 只将死 owner 或旧无 owner 的 `starting/running` 标记 `interrupted`，保留 error detail；存活 TUI/隔离 runtime 的 claim 不得误恢复。
4. 查询 distinct `scope_key` where status=`queued`。
5. 只为这些 scope 调用 `InstanceStore.loadScope`，不加载全部历史 workspace。
6. backend/scheduler 初始化完成后异步 drain；daemon readiness 不等待 LLM run 完成。

该顺序依赖当前 production 的单个 application SQLite：registry、session 与各 scope submission 在同一数据库中，`scope_key` 是恢复索引。不得把实现悄悄改为每项目独立 DB 后仍声称能按上述流程发现 queued；若未来拆库，必须先增加全局 recovery index/registry 协议。

### 2.9.2 不可用 workspace

`scopeKey` 必须重新 realpath/validate，禁止 cwd/query fallback。无法加载时将该 scope queued submissions 标为 failed `WORKSPACE_UNAVAILABLE`，保留记录供 UI 下次连接查看。

### 2.9.3 shutdown

- 正常 daemon stop 不删除 durable queued。
- active run 走既有 cancel/settle；若进程退出前未完成，下一次启动按 interrupted 处理。
- in-memory embedded store 关闭时可 reject/取消未开始 entry，不声称跨进程恢复。

## 2.10 Web 与 CLI 接线

### 2.10.1 Web

> 本节是 Phase E Web/TUI 接线契约；已完成的后端批次不修改 `apps/ohbaby-web` 的视觉与 composer 行为。

- store/reducer 增加 `promptsById` 或 snapshot prompts 投影。
- receipt 和 SSE 都调用同一个 `upsertPrompt`。
- 当前 session 只有 `status=queued` 的 submissions 按 `createdAt,promptId` 放在 composer 上方 Queue 区；使用预分配 `userMessageId` 作为稳定 React key。
- submission 不再 queued 后立即离开 Queue 区并投影进 conversation；正式 message 到达后以 `userMessageId` 合并，不能重复或闪烁。
- UI 只展示 `queued` 标签；starting/running/succeeded 不显示额外字段，failed/interrupted 只在对应 conversation message 下显示简短结果，queued cancel 直接消失。
- 提交时保留草稿，receipt 到达并完成 `upsertPrompt` 后清空；admission 失败保持原文并显示 composer-local 错误，不生成假的 Queue 卡片。
- `selectors.ts` 的 `canSend` 下一批不再依赖 workspace 全局 `!isRunning`；当前 session running 时仍保留输入和 Send，Stop 与 Send 共存。
- Queue 小框附着在 composer 上方，宽度略窄、视觉层级更轻；pencil 在卡片内 inline edit 并调用 edit API，trash 调 cancel API，二者只对 queued 可用。
- Queue viewport 固定为最多约两条卡片的可见高度；溢出使用原生/可访问的手动纵向滚动，支持滚轮、触控板和拖动细滚动条。滚动条默认弱化、hover/scroll 时增强，`Queued N` 提示总数，可加轻微底部渐隐；禁止自动轮播和自动改变滚动位置。
- edit 期间保持原队列位置；claim/version race 返回冲突时刷新 snapshot，不伪造编辑成功。取消成功后直接从 Queue 区消失。
- 刷新、切项目、切 session 后完全由 snapshot 恢复。

### 2.10.2 CLI

- 移除以 pending Promise 数量作为 queue truth 的逻辑；改为 prompt events/snapshot。
- interactive TUI 主界面显示 `queued N · /queue to manage`，N 只统计当前 session 的 queued submissions。
- 新增 `/queue` 管理面板：方向键选择，`e` 对 queued inline/edit form，`d` 调 cancel，Esc 返回 composer；starting/running/terminal 项不进入该可编辑列表。
- `/queue` 复用既有 overlay/command panel 习惯，不占用 Shift+Tab、Tab、双击 Esc、Ctrl+C 等现有按键。
- double Esc 显式发送 active session/run ID。
- remote CLI 收到与 Web 相同 receipt/error。
- embedded TUI 使用同一 scheduler contract；不因本批 import `ohbaby-server`。
- 非交互 CLI 继续 `submit → waitForPrompt → terminal exit code`，不能在 receipt 后提前退出。

## 2.11 分阶段实施

### Phase A：契约、schema、store

**目标**：先建立 durable submission 与结构化 UI DTO，不改变现有运行路径。

改动：

- `packages/ohbaby-sdk/src/{client,snapshot,events,index}.ts`
- `packages/ohbaby-agent/src/services/database/{migrations,schema}.ts`
- 新增 `packages/ohbaby-agent/src/runtime/prompt-scheduler/{types,errors,store,in-memory-store,database-store}.ts`
- `packages/ohbaby-agent/src/runtime/run-ledger/*` additive `errorData`

DoD：migration/store/状态前置条件/100 cap/旧 string error decode 单测通过；尚不双写生产 queue。

### Phase B：PromptExecutor 与唯一 Scheduler

**目标**：拆开 accept/schedule/execute，真实支持 10 个不同 session。

改动：

- 拆分 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- 新增或抽取 `adapters/ui-inprocess/prompt-executor.ts`
- 重构 `adapters/ui-inprocess/runtime-controller.ts` 为 per-session active map
- 新增 `runtime/prompt-scheduler/scheduler.ts`
- 删除/降级 `adapters/ui-prompt-queue.ts`、`adapters/ui-inprocess/prompt-controller.ts`
- 调整 goal/user owner-aware interruption，不把 goal 自动并发语义扩大

DoD：真实 backend 10 session 并发；同 session FIFO；第 11 queued；cancel settle 后续排；queued context 不泄漏。

### Phase C：daemon wiring、recovery、protocol

**目标**：global serve 的 WorkspaceInstance 使用 durable store，transport 返回 receipt。

改动：

- `packages/ohbaby-server/src/runtime/daemon/{main,server}.ts`
- `packages/ohbaby-server/src/runtime/instance-store.ts` 或新增 recovery coordinator
- `packages/ohbaby-server/src/app/create-app.ts`
- `packages/ohbaby-server/src/protocols/jsonrpc/{protocol,rpc-route,client}.ts`
- 删除 `packages/ohbaby-server/src/coordination/prompt-queue.ts`；非 durable 注入后端只直接调用自身 `submitPrompt`，不得在 server 再维护第二套 lane/queue
- `coordination/{client-view,permission-router}.ts` 绑定 prompt/run/client ownership

DoD：HTTP/JSON-RPC accepted receipt 一致，兼容 submit-and-wait 不回归；queued 重启恢复；死 owner active interrupted 不 replay；存活 owner 不误恢复；不同 workspace 独立。

### Phase D：错误链路

**目标**：provider/runtime/scheduler error 从 core 到 surface 不丢语义。

改动：

- `core/lifecycle/lifecycle.ts`
- `core/message/{types,events}.ts`
- `core/llm-client/*` 只补规范化出口，不重复 retry 策略
- `runtime/run-manager/{types,worker,manager}.ts`
- `adapters/ui-{runtime,state}/*`
- server error body/SSE routing

DoD：认证、429 retry exhausted、stream interruption、context overflow、queue full 各有 prompt-scoped 自动测试；敏感字段不出 wire。

### Phase E：Web/CLI UX 与真实验收（下一实施批次）

**目标**：用户发送立即可见，Web Queue 与 TUI `/queue` 的编辑/取消闭环成立，同时不把后端状态机完整暴露给用户。

#### Phase E1：共同投影契约

- `apps/ohbaby-web/src/api/daemon/{wire,http,client,eventReducer}.ts`
- `apps/ohbaby-web/src/store/*`
- `packages/ohbaby-cli/src/tui/store/*`

DoD：receipt/SSE/snapshot 任意顺序按 `promptId/userMessageId` 幂等；两端 Queue 数量只来自 backend truth；当前 session/scope 不串。

#### Phase E2：Web Queue 与 composer

- `apps/ohbaby-web/src/ui/selectors.ts`
- `apps/ohbaby-web/src/ui/App.tsx`
- `apps/ohbaby-web/src/ui/styles.css` 及可抽取的 Queue 组件

DoD：running 时 Stop/Send 共存；只展示 queued；两条可见高度 + 手动滚动；inline edit/trash cancel、冲突刷新、草稿恢复、conversation 合并全部通过。

#### Phase E3：TUI `/queue`

- `packages/ohbaby-cli/src/tui/{app,store,components/prompt}/*`
- `packages/ohbaby-cli/src/cli/commands/run.ts`

DoD：删除本地 Promise queue truth；主界面摘要和 `/queue` 查看/edit/cancel 完成；既有快捷键、默认 in-process、非交互 wait/exit 不回归。

#### Phase E4：真实验收

DoD：按 04 完成 Web/TUI unit/contract，启动真实 daemon + production Web + fake provider，Playwright 验证即时反馈、FIFO、编辑取消、刷新恢复、滚动与错误归属。

### 当前后端批次边界

当前临时分支只实施 Phase A–D、HTTP/JSON-RPC receipt、queued edit/cancel、恢复和真实 daemon process E2E。不得修改 `apps/ohbaby-web` 的组件、样式、selector 或 Playwright 视觉测试。Phase E 的 Web/TUI 视觉与交互在下一批单独实施；为避免 CLI 行为回归，本批允许做纯协议兼容或非交互 wait 的最小非视觉调整。

## 2.12 文件改动面汇总

| 包/目录 | 新增 | 修改 | 删除/降级 |
|---------|------|------|-----------|
| `ohbaby-agent/runtime/prompt-scheduler` | types/store/scheduler/errors + tests | — | — |
| `ohbaby-agent/services/database` | migration 014 | migrations/schema/tests | — |
| `ohbaby-agent/adapters/ui-inprocess*` | prompt executor 或等价窄模块 | runtime state/submit/abort/permission | 旧全局 queue owner |
| `ohbaby-agent/core` | error normalizer（建议） | lifecycle/message/run result | — |
| `ohbaby-sdk` | prompt receipt/submission/error/completion types | client/snapshot/events exports | — |
| `ohbaby-server/coordination` | recovery/ownership glue（若需） | client-view/permission | 删除 `DaemonPromptQueue`，backend scheduler 为唯一 owner |
| `ohbaby-server/app/protocols/runtime` | — | receipt、recovery、InstanceStore wiring | fire-and-forget global error path |
| `ohbaby-web` | Queue component（可抽） | client/store/reducer/composer/selectors/styles | `!isRunning` 禁发与本地 inferred queue truth |
| `ohbaby-cli` | `/queue` overlay/panel | TUI prompt/event/store、run wait | pending Promise queue truth |

## 2.13 兼容、迁移与回滚

### 2.13.1 版本

新增 `UiPromptQueueClient`、prompt event schema 与 JSON-RPC method 属于 package contract change；`UiBackendClient.submitPrompt(): Promise<void>` 保留，避免当前 TUI/CLI 行为破坏。现有 packageVersion 精确匹配已经禁止新 CLI 连接旧 daemon，因此不做旧 daemon 的新 method 兼容；发布目标可与后续 `/loop` 一起进入 v0.1.8，但本议题必须可独立验收。

### 2.13.2 数据

- migration additive；不删除 `run_ledger.error`。
- 新代码可读取 `error_data`，缺失/坏 JSON 时回退为 `{code:"UNKNOWN", message:error}`。
- 回滚旧代码时会忽略新表/新列；queued submission 不应由旧代码执行。
- 不提供 downgrade migration。

### 2.13.3 实施切换

- Phase A 可先合入不接生产路径。
- Phase B/C 切换时必须一次性确定唯一 queue owner；禁止 daemon queue 和新 scheduler 同时接受同一 prompt。
- 发布实现删除旧 `DaemonPromptQueue` 及其公共导出；仅为注入测试/兼容 backend 保留无排队的直接 `submitPrompt` 路径。该路径不承诺 durable/FIFO，正式 serve backend 必须实现 `UiPromptQueueClient` 并由 `WorkspacePromptScheduler` 排队。

## 2.14 风险与防护

| 风险 | 后果 | 防护 |
|------|------|------|
| receipt 与 SSE 竞态 | 重复 user bubble | `promptId/userMessageId` 幂等 reducer |
| queued message 进 context | 模型提前看到未来输入 | submission 与 message 分表；context 只读 message |
| cancel 后抢跑 | 同 session 双副作用 | terminal/claim/stream settle 后才 release lane |
| late completion 覆盖 interrupted | 重启后状态复活 | `finish(expectedRunId)` 条件更新 |
| 100 cap race | 超上限或错误拒绝 | scheduler mutex + DB transaction recheck |
| 10 session 写 SQLite | 锁竞争 | WAL、短事务、现有 busy retry；provider 流不持 DB 事务 |
| provider error 泄密 | key/header 暴露 | allowlist DTO，禁止序列化 cause/response |
| 顶层 status 互相覆盖 | 切 session 状态错误 | runs/prompts 权威，status 仅 selected-session projection |
| daemon restart加载所有历史 scope | 启动变慢 | 只加载有 queued 的 distinct scope |
| TUI/serve 同时运行 | 超过单 runtime 10、claim busy | 明示边界；DB claim 防同 session 双写，不恢复全局 lease |

## 2.15 与 00 的边界核对

- [x] 10 active session lanes/workspace runtime。
- [x] 100 queued/workspace，第 101 fail-closed。
- [x] 同 session FIFO；第 11 queued。
- [x] provider 不设厂商专属并发限制。
- [x] permission/retry 占 active slot。
- [x] server/backend 是唯一 queue truth。
- [x] queued durable；running interrupted 不 replay。
- [x] user message 立即可见但不污染 context。
- [x] double Esc 只取消当前，settle 后继续 FIFO。
- [x] LLM error 结构化并绑定 prompt。
- [x] 不做 `/loop`、steer、全队列取消、TUI attach。
