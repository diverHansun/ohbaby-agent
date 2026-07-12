# 1. 问题基线与当前实施状态

> 分析基线：2026-07-12，`main@63f1810383a454ad73c740d1de57ad53db3c7437`。
>
> 本文只描述现状、证据与风险；目标方案见 [02](./02-optimization-plan-and-change-scope.md)。

## 1.1 核心问题

| ID | 用户可见问题 | 技术根因摘要 | 严重度 |
|----|--------------|--------------|--------|
| P0-1 | 多 session 看起来仍串行，延迟明显 | daemon 有 per-session lane，但 backend 仍由全局 queue + `promptInFlight` 串行 | 高 |
| P0-2 | Enter/点击发送后长时间看不到用户消息 | HTTP 只返回 `202 + sessionId`；user message 在真正启动 run 后才 append | 高 |
| P0-3 | queued 刷新/重启后消失 | 两层 prompt queue 都是进程内数组，没有 durable submission 实体 | 高 |
| P0-4 | provider 错误无法绑定 prompt，语义丢失 | core 有错误类型，但 lifecycle 统一写 `Unknown`，RunLedger/SDK/SSE 再降为 string | 高 |
| P1-1 | 并发状态和取消只能正确表示一个 active run | `promptInFlight`、`activeRunId`、顶层 `UiSnapshot.status` 都是单值 | 中高 |
| P1-2 | Web 与 remote CLI 的 submit 语义不一致 | Web fire-and-forget 后 202；JSON-RPC await queue 直到 backend submit settle | 中 |
| P1-3 | CLI 的 queued 只是本地猜测 | Ink 根据 `isRuntimeRunning` 和未完成 Promise 维护计数，不来自 snapshot/event | 中 |
| P1-4 | 现有测试容易给出“已经并发”的假阳性 | queue 单测只测 fake submit；没有穿透真实 `UiBackendClient` 的全局门闩 | 中高 |

## 1.2 已完成前置能力

本议题不是从零开始。下列能力应保留并复用：

1. **Per-workspace runtime**：`packages/ohbaby-server/src/runtime/instance-store.ts` 的 `InstanceStore` 按 canonical scope 缓存独立 workspace instance。
2. **Per-scope server app/coordination**：`packages/ohbaby-server/src/runtime/daemon/server.ts#createWorkspaceInstance` 为每个 scope 创建 backend、Hono app、client view、permission router、EventBus/SSE replay。
3. **同 session 最终防线**：`packages/ohbaby-agent/src/runtime/run-ledger/database.ts#claimPendingRun` 使用事务抛出 `SessionRunBusyError`，阻止同 scope/session 双 active run。
4. **RunManager 已按 session 索引 active**：`packages/ohbaby-agent/src/runtime/run-manager/manager.ts` 的 `activeBySession` 与 session lock 本身允许不同 session 的 run 并存。
5. **Permission routing 已考虑重叠 session**：`packages/ohbaby-server/src/coordination/permission-router.ts` 与 server integration tests 已覆盖 prompt owner/session 路由。
6. **LLM retry 语义**：`packages/ohbaby-agent/src/core/llm-client/retry.ts` 已识别 408/429/529/5xx、网络错误、`retry-after`、重试原因和重试耗尽。
7. **SSE 重连与 snapshot**：Web client 已有 seqNum、buffer、resync 和 workspace generation 隔离，不需要新增第二条实时通道。

这些基础说明正确方向是收口 queue owner、补 durable 状态与协议，不是替换 RunManager、SQLite、SSE 或引入消息中间件。

## 1.3 goals-duty：队列职责重叠

### 1.3.1 daemon queue

`packages/ohbaby-server/src/coordination/prompt-queue.ts#DaemonPromptQueue`：

- `activeLanes: Set<string>` 按 `sessionId` 互斥；
- `queue: QueueEntry[]` 保存等待项；
- drain 查找第一个 lane 未 active 的 entry；
- 不同 session 会同时调用 `options.submit`；
- `SessionRunBusyError` 被指数延迟重试。

它承担了“跨 client、同 session FIFO、不同 session 并行”的职责。

### 1.3.2 backend queue

`packages/ohbaby-agent/src/adapters/ui-prompt-queue.ts#PromptQueueController`：

- 只有一个 `activeEntry`；
- drain 对整个数组逐项 `await submitWithBusyRetry(entry)`；
- 不区分 session lane；
- `packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-controller.ts` 将所有 `submitPrompt` 送入该 controller。

它又承担一次“入口 FIFO + busy retry”。两层都认为自己拥有排队真相，但并发模型互相矛盾：外层按 session 并行，内层按 workspace 全局串行。

### 1.3.3 隐式第三层门闩

`packages/ohbaby-agent/src/adapters/ui-inprocess.ts#submitPromptInternal` 在进入生命周期前还执行：

```text
waitForPromptSlot(owner)
promptInFlight = true
promptInFlightSessionId = ...
...
finally promptInFlight = false
```

`waitForPromptSlot` 对同 owner 的第二个 prompt 直接抛 `A prompt is already running`。这不是 session-scoped 状态，而是 backend 级全局状态。

**职责诊断**：排队策略分散在 transport coordination、UI adapter controller 和 adapter 全局 flag 三处。任何一处改并发上限，都不能单独改变真实行为，违反单一知识来源与信息隐藏。

## 1.4 architecture：真实数据流

### 1.4.1 Web 当前提交链

```text
React Composer
  → BrowserDaemonClient.submitPrompt
  → POST /v1/prompts
  → DaemonClientViewCoordinator.preparePromptSubmit
  → DaemonPromptQueue.enqueue (fire-and-forget)
  → HTTP 202 { sessionId? }

后台：
DaemonPromptQueue lane
  → UiBackendClient.submitPrompt
  → InProcessPromptController
  → PromptQueueController (workspace 全局串行)
  → submitPromptInternal
  → runtime.startSession
  → append user message
  → waitForCompletion
```

代码锚点：

- `apps/ohbaby-web/src/ui/App.tsx#submitText`
- `apps/ohbaby-web/src/api/daemon/client.ts#submitPrompt`
- `packages/ohbaby-server/src/app/create-app.ts` 的 `POST /v1/prompts`
- `packages/ohbaby-server/src/coordination/prompt-queue.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts#submitPromptInternal`

### 1.4.2 延迟为什么发生

`POST /v1/prompts` 在把 entry 放进内存 queue 后立即返回 202，但 response 类型 `PromptAcceptedResponse` 只有 `ok + sessionId?`（`apps/ohbaby-web/src/api/daemon/wire.ts`）。

与此同时，`submitPromptInternal` 在 `runtime.startSession()` 成功以后才：

1. upsert 新 session；
2. `stateStore.setActiveSessionId`；
3. 将 user message 加到 session；
4. 发布 `message.appended`。

如果前面已有其他 session 的长 run，当前 prompt 会被 backend 全局 queue 挡住，因此浏览器既没有 receipt 可投影，也没有 SSE message 可消费。UI “没有发送”的感觉是后端时序的直接结果，不只是 React 渲染问题。

### 1.4.3 依赖方向

现有 queue policy 主要位于 `ohbaby-server` transport 层，但真正的 session lifecycle、message ID、run ID、context 构建和 cancel 都在 `ohbaby-agent`。transport 为了排队不得不依赖 `SessionRunBusyError`，而 backend 又保留自己的 queue。

这形成抽象泄漏：HTTP/JSON-RPC 层知道 run busy 细节，runtime 层又不知道外层 receipt/queued 状态。队列属于运行时应用策略，却被拆到两个包分别实现。

## 1.5 data-model：缺少 PromptSubmission

当前 SQLite migration 到 `013_workspace_registry`，主要相关表为：

- `session`
- `message`
- `part`
- `run_ledger`
- `workspace_registry`

当前 production 默认数据库是用户数据目录下的单个 application SQLite。`createPersistentUiBackendClient()` 对不同 `workdir` 复用同一已初始化连接，session/message 依靠 project root 隔离；`workspace_registry` 也在该库中。因此新增 submission 需要显式 `scope_key`，daemon 启动时可以在加载 workspace backend 之前查询哪些 scope 存在 queued。这里不是“每项目一个无法发现的数据库”；实施测试仍需覆盖显式 `OHBABY_DB_PATH/dbPath` 的隔离库。

代码锚点：

- `packages/ohbaby-agent/src/services/database/migrations.ts`
- `packages/ohbaby-agent/src/services/database/schema.ts`

没有表能表达：

- prompt 已被服务端接受、但尚未成为 run；
- prompt 的稳定 ID、预分配 user message ID；
- queued 顺序；
- queued/running/failed/cancelled/interrupted 状态；
- queue owner/recovery；
- 结构化 prompt 失败。

### 1.5.1 为什么不能直接提前写 message

`message` 是 conversation/context 的正式事实。`submitPromptInternal` 构建模型 prompt 时会读取 session history。若 prompt B 在 A 运行期间就作为正式 user message 写入，A 的后续 lifecycle step/compaction 可能读到 B，造成未来输入提前泄漏。

因此 “用户立即看见” 与 “模型立即看见” 是两种不同语义；当前 data model 无法区分。

### 1.5.2 RunLedger 不能代替 submission

`run_ledger` 从 claim/start 才有意义，且记录的是执行审计。queued prompt 尚未拥有有效 run，也可能在排队上限处被拒绝。强行用 pending run 表示 queued 会混淆：

- workspace capacity slot；
- session active claim；
- 用户输入接受状态；
- run 生命周期。

## 1.6 dfd-interface：协议与状态投影缺口

### 1.6.1 SDK submit 契约

`packages/ohbaby-sdk/src/client.ts#UiBackendClient.submitPrompt` 返回 `Promise<void>`。调用方无法区分：

- 已接受 queued；
- 已启动 running；
- 整个 run 已完成；
- 提交前校验失败。

Web HTTP 自己定义 202 receipt，JSON-RPC 则 `await promptQueue.enqueue`。同一个 `submitPrompt` 在两个 transport 上代表不同完成点。

### 1.6.2 Snapshot 与 event

`packages/ohbaby-sdk/src/snapshot.ts`：

- `UiSnapshot.status` 是单个全局 status；
- `UiRun[]` 可按 session 保存多个 run；
- `UiMessage.status` 只支持 assistant streaming/completed/error；
- 没有 prompt submission collection。

`packages/ohbaby-sdk/src/events.ts` 没有 `prompt.submitted/updated`。Web 因此无法通过 snapshot 恢复 queued，也无法把失败绑定到 prompt。

### 1.6.3 客户端视图投影

`packages/ohbaby-server/src/coordination/client-view.ts#statusForClientSnapshot` 会用 client active session 过滤单个 `snapshot.status`。该方法能隐藏其他 session 的状态，却无法从多个真实 active run 中推导每个 session 的 permission/running 状态，因为源头仍是单值。

## 1.7 use-case 现状

### UC-1：不同 session 同时发送

外层 queue 会并发调用 backend，但内层 controller 串行。结果是“API 层并发、执行层串行”。

### UC-2：同 session 连续发送

daemon 外层可保证顺序；backend 内层也会再次排队。用户只能在 CLI 看到本地猜测的 `Queued`，Web 没有对应卡片。

### UC-3：双击 Esc

Web/CLI 已有 double-Esc 交互和 `abortRun/abortSession` API，但 `InProcessRuntimeController` 只保存一个 `activeRunId`。多 session 真并发后：

- 无参 abort 无法确定目标；
- `isActiveRun(runId)` 只能命中一个 run；
- permission cancel fallback 可能拿到错误的全局 active run。

相关文件：

- `packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts#respondPermission/#abortRun`
- `apps/ohbaby-web/src/ui/App.tsx` double-Esc handler
- `packages/ohbaby-cli/src/tui/app.tsx`

### UC-4：daemon 重启

`DaemonPromptQueue.shutdown()` 拒绝所有尚未开始的 entry；没有恢复入口。即使数据库仍有 session/run，queued text 已丢失。

### UC-5：provider 失败

LLM retry 层能区分 retryable 与非 retryable，但最终 Web 常收到全局 SSE `{type:"error", message}`；切到其他 session 时错误仍可能显示为全局页面错误。

## 1.8 error model：定义存在，链路退化

### 1.8.1 已有结构

`packages/ohbaby-agent/src/core/message/types.ts#MessageError` 定义：

- `ProviderAuthError`
- `MessageOutputLengthError`
- `MessageAbortedError`
- `APIError {statusCode?, isRetryable}`
- `Unknown`

`packages/ohbaby-agent/src/core/llm-client/retry.ts` 定义：

- `ProviderStreamInterruptedError`
- `ProviderRetryExhaustedError {attempts}`
- `providerErrorStatus`
- `retryReason`
- `isRetryableProviderError`

### 1.8.2 退化点

| 层 | 当前行为 | 丢失信息 |
|----|----------|----------|
| lifecycle | `markAssistantMessageError` 总是 `{name:"Unknown", message}` | provider/type/status/retryability |
| RunWorker/RunManager | `errorToMessage` 后写 string | 原始 error class/fields |
| RunLedger | `error TEXT` 保存 message | 结构化 error |
| SDK | `UiRunStatus.error` 只有 message/recoverable | prompt/provider/statusCode |
| Web HTTP | 非 2xx 重新构造 `Error(message)` | code/name/details |
| Web async | queue reject 写全局 SSE error | promptId/sessionId/runId |
| CLI prompt | catch 后显示 `Error.message` | 同上 |

相关文件：

- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts#markAssistantMessageError`
- `packages/ohbaby-agent/src/runtime/run-manager/worker.ts`
- `packages/ohbaby-agent/src/runtime/run-manager/manager.ts`
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts#runStatusToUiStatus`
- `packages/ohbaby-server/src/app/create-app.ts#writeErrorToClient`
- `apps/ohbaby-web/src/api/daemon/http.ts#request`
- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx#submitInput`

结论：不是“没有错误机制”，而是规范化与传输 DTO 没有接上；重复在 Web/CLI 解析厂商错误会进一步制造分叉。

## 1.9 non-functional

### 1.9.1 性能与公平

- 当前真实 workspace 并发接近 1，长 run 会造成 head-of-line blocking。
- daemon queue 的 `findIndex(lane not active)` 保证同 session 后续不会挡住其他 session，但没有 workspace active 上限，理论上可同时启动任意多 session。
- `SessionRunBusyError` 通过 250ms→2s polling retry，负载下会增加无意义 wakeup；它适合作为跨 runtime 最终防线，不适合作为正常服务内调度机制。

### 1.9.2 可靠性

- 内存 queue 在 crash/restart 时丢失。
- Web 202 表示“进入内存数组”，不是 durable accepted。
- client disconnect 不取消 entry 是正确行为，但也意味着没有 snapshot 时用户无法知道它仍存在。

### 1.9.3 安全

- HTTP body 已有 1 MiB 限制与 Bearer auth，应保留。
- provider 原始 error 可能包含 response/header；若结构化透传必须显式 allowlist 字段，不能序列化整个 error/cause。
- queue cap 缺失会形成无界本地资源增长；本议题已确认 100 queued/workspace。

### 1.9.4 可观测性

现有 `/v1/connections` 和 run events 无法回答：

- workspace queued/active 数；
- 某 prompt 处于哪种状态；
- 为什么失败；
- daemon 重启后恢复了哪些 queued。

## 1.10 test：现有覆盖与缺口

### 1.10.1 已有覆盖

| 能力 | 测试 |
|------|------|
| daemon same-session FIFO / fake different-session concurrent | `packages/ohbaby-server/src/coordination/prompt-queue.unit.test.ts` |
| server 多 client、permission owner、same-session queue | `packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts` |
| RunLedger 同 session claim / 双进程 | `packages/ohbaby-agent/src/runtime/run-ledger/*.test.ts` |
| CLI 清空输入、本地 queued 提示、double Esc | `packages/ohbaby-cli/src/tui/app.contract.test.tsx` |
| Web HTTP/SSE/snapshot/scope switch | `apps/ohbaby-web/src/api/daemon/*.test.ts` |
| provider retry/stream interruption | `packages/ohbaby-agent/src/core/llm-client/*.test.ts` |

### 1.10.2 承重缺口

1. **没有真实 backend 并发断言**：外层 queue 的 different-session test 使用 fake `submit`，不会触发 `PromptQueueController` 与 `promptInFlight`。
2. **没有 max=10/第 11 queued**。
3. **没有 queued cap=100/第 101 reject**。
4. **没有 durable queue migration/store/restart recovery**。
5. **没有“queued prompt 不进入当前 context”测试**。
6. **没有 receipt/SSE 双到达顺序幂等测试**。
7. **没有 prompt-scoped provider error 的 Web/CLI 断言**。
8. **没有 10 个 session 中一个等待 permission、其他继续工作的集成测试**。
9. **没有多 activeRunId 下定向 abort 与 FIFO 续排测试**。

## 1.11 文档与实现对照

| 既有文档结论 | 实现现状 | gap |
|--------------|----------|-----|
| terminal-daemon：不同 session 并行 | daemon queue 可并行，backend 全局串行 | 目标只落在外层 |
| terminal-daemon：跨 client 同 session FIFO | daemon 内存 queue 已有 | 不持久、无 receipt/snapshot |
| global-single-daemon：per-scope prompt queue | 每 scope 确有独立 queue | queue owner 重复，scope 内仍串行 |
| global-single-daemon：TUI + serve 不共享 prompt queue | 实现与文档一致 | 本批不能偷偷改 attach/共享 FIFO |
| OpenCode Web navigation：运行中切项目不 stop | runtime 可保留 run | 顶层单 status 无法可靠展示多 session 同时运行 |

## 1.12 SWE 原则审视

1. **单一知识来源（DRY 的知识层）**：排队顺序与 busy retry 同时存在于 server 和 backend，两份策略已经产生行为分叉。
2. **高内聚/低耦合**：prompt 接受、排队、run 执行、transport ack、UI optimistic state 没有清晰边界；transport 依赖 runtime busy error 是抽象泄漏。
3. **状态是主要复杂度来源**：`promptInFlight + activeRunId + snapshot.status + queue.activeLanes + RunLedger` 多份状态没有统一主从关系。
4. **最小惊讶原则**：HTTP 202 后 UI 没有 prompt，违背“接受成功即可见”的自然预期。
5. **KISS/YAGNI**：无需 Kafka、worker 子进程或 provider-specific pool；SQLite + per-workspace scheduler 足以解决已证实问题。
6. **测试是设计探针**：fake queue test 通过但真实链路串行，说明测试边界停在了错误抽象层。

## 1.13 影响面预览

承重改动会跨越：

- `packages/ohbaby-agent/src/adapters/ui-inprocess*`
- `packages/ohbaby-agent/src/runtime/run-manager*`
- 新的 runtime prompt scheduler/store 边界
- `packages/ohbaby-agent/src/services/database/{migrations,schema}.ts`
- `packages/ohbaby-agent/src/core/{lifecycle,message,llm-client}`
- `packages/ohbaby-sdk/src/{client,snapshot,events}.ts`
- `packages/ohbaby-server/src/{coordination,app,protocols,runtime}`
- `apps/ohbaby-web/src/{api,store,ui}`
- `packages/ohbaby-cli/src/{tui,cli}`

具体方案、删除/保留边界和实施顺序见 02。

## 1.14 后端完成后的 Phase E 前端基线

> 时间口径：后端 Phase A–D 已实现并通过 04 的后端发布门；以下只描述 Web/TUI 尚未接线的当前状态，不改写本文前面的历史问题基线。

### 1.14.1 Web

- `apps/ohbaby-web/src/ui/selectors.ts#selectViewModel` 仍以 `connectionState === "live" && !isRunning` 计算 `canSend`，因此当前 session running 时无法接受后续 FIFO prompt。
- `apps/ohbaby-web/src/ui/App.tsx#Composer` 在 running 时用 Stop 按钮替换 Send，而不是让两个动作共存。
- `apps/ohbaby-web/src/api/daemon/client.ts#submitPrompt` 丢弃 HTTP 层已经返回的 `PromptAcceptedResponse`；receipt 不能立即进入 UI store。
- `apps/ohbaby-web/src/api/daemon/eventReducer.ts#reduceUiEvent` 尚未处理 `prompt.submitted/prompt.updated`，也没有 Queue 区所需的当前 session `queued` selector。

因此后端已经解决“立即 accepted”和“多 session 真并发”，但 Web 用户仍会感受到旧的发送空窗与 running 禁发。

### 1.14.2 TUI

- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx#submitInput` 仍通过 `pendingPromptSubmissionCountRef` 与 `isRuntimeRunning` 推测 queued 数量。
- 当前 TUI 只在 dock 显示 `Queued N`，没有查看正文、编辑或取消的入口。
- `packages/ohbaby-cli/src/tui/app.tsx` 已占用 Shift+Tab 切 permission mode、双击 Esc/Ctrl+C 中断等快捷键；继续塞全局 Queue 快捷键会增加冲突和认知负担。

Phase E 的最小目标不是把后端全部状态字段搬上屏幕，而是建立一个简单投影：`queued → Queue 区`、queued cancel → 消失、其他已接受状态 → conversation、目标错误 → 对应 message；TUI 管理动作集中在 `/queue` 面板。
