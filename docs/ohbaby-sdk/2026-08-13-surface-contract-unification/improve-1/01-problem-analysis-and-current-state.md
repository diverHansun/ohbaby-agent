# 1. 问题基线与当前实施状态

> 时间口径：2026-08-13 工作区代码。目标文档目录当前为未跟踪内容；本文只描述实施前基线，不把规划目标写成已经实现。

## 1.1 核心问题

| ID | 当前矛盾 | 直接风险 |
|----|----------|----------|
| P1 | `submitPrompt` 名字没有表达“等待完成”，Web 同名方法却是“接单即返回” | 只改返回类型会改变 Promise resolve 时机，CLI 可能提前退出 |
| P2 | `UiPromptCompletion` 包含普通 `UiPromptSubmission`，类型上仍允许 queued/running | “完成”对象无法保证终态，调用方被迫写无意义分支 |
| P3 | `UiPromptQueueClient` 把基本提交/等待与队列编辑租约捆绑 | Server 只能整体 feature-detect；少一个高级方法就退回旧路径 |
| P4 | `UiBackendClient`、`CoreAPI + SDKAPI`、Web 手写 client 重复表达能力 | 同一方法出现不同参数、返回值和生命周期语义 |
| P5 | 多种 ID 被早期方案误判为应统一成 `clientRequestId` | 运输、幂等、实体和执行身份被压扁，关联反而失真 |
| P6 | 写操作没有统一、真实使用的记录合同和 recorder | in-process 路径缺少权威记录；若在 Server 和 backend 都加日志又会重复 |
| P7 | SDK 权威文档中的“事件优先、方法只代表提交”与代码不完全一致 | 实施者可能按旧文档破坏现有完成语义 |
| P8 | scheduler 关闭不处理已注册 waiter；运行失败/中断会被异常链压成 failed | Promise 可能悬空，终态数据在层间丢失 |

## 1.2 已确认的技术分界

```text
业务调用面：具名方法
  Query（观察世界） + Command（改变世界）
                          │
                          ▼
外部写入口：唯一记录 gateway
  UiCommandRecord started/completed，fail-open
                          │
                          ▼
raw backend / scheduler / store
  负责执行与持久化，不重复记录
```

本轮区分三类事实：

1. **调用结果**：方法正常 returned 或 threw；
2. **Prompt 业务终态**：succeeded / failed / cancelled / interrupted；
3. **业务内容**：消息、run、权限等继续由 `UiEvent` / `UiSnapshot` 表达。

三者不得互相冒充。

## 1.3 ohbaby-sdk 现状

### 1.3.1 goals-duty

`docs/ohbaby-sdk/goals-duty.md` 的 G4 强调方法只表示请求已提交、结果通过事件传播；`docs/ohbaby-sdk/architecture.md` 也把调用面概括为 `Promise<void>`。代码已经偏离这一绝对表述：

- `packages/ohbaby-sdk/src/client.ts` 的 `submitPrompt` 是 `Promise<void>`，但注释明确它是 legacy submit-and-wait；
- `compactSession`、`connectModel`、`setPermission` 等写方法会返回结构化业务结果；
- `UiPromptQueueClient.submitPromptAccepted` 才是接单回执语义。

因此“事件是业务状态真相”仍成立，但“所有命令都只能表示提交”已不是准确合同。权威文档需要在合同稳定后更新。

### 1.3.2 architecture

`packages/ohbaby-sdk/src/client.ts` 的 `UiBackendClient` 同时包含读取、订阅和写操作。接口规模本身不算巨大，真正的问题是其他模块开始复制它：

- `packages/ohbaby-sdk/src/rpc/types.ts` 的 `CoreAPI` 几乎是去掉 `subscribeEvents` 后的手抄版；
- 同文件 `SDKAPI` 只保留 `subscribeEvents`；
- `packages/ohbaby-agent/src/host/core-api-factory.ts` 又逐方法手工转发。

当前没有真实“只读消费者”证明 Query/Command 拆分会自动降低所有耦合；拆分的实际价值应落在能力依赖、记录边界和停止手抄，而不是只增加类型名。

### 1.3.3 data-model

`packages/ohbaby-sdk/src/prompt.ts` 定义：

```ts
interface UiPromptCompletion {
  prompt: UiPromptSubmission;
}
```

而 `UiPromptSubmission.status` 仍允许 `queued | starting | running`，`endedAt` 和 `error` 都可选。由此可构造语义矛盾的数据：

- completion 中仍是 running；
- failed 没有 error；
- succeeded 却残留 error；
- completion 没有 endedAt。

内部 `packages/ohbaby-agent/src/runtime/prompt-scheduler/types.ts` 已经有更严格的执行终态 union，但没有投影成 SDK 的完成子类型。

### 1.3.4 dfd-interface

当前 Prompt 实际存在两条入口：

```text
submitPrompt
  → ui-inprocess.submitPromptAndWait
  → submitPromptAcceptedInternal
  → waitForPromptInternal
  → failed/interrupted 再抛普通 Error

submitPromptAccepted
  → scheduler.accept
  → UiPromptReceipt
```

代码锚点：

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`：`submitPromptAcceptedInternal`、`waitForPromptInternal`、`submitPromptAndWait`；
- `packages/ohbaby-sdk/src/client.ts`：`UiBackendClient`、`UiPromptQueueClient`。

`submitPromptAndWait` 已经作为内部函数存在，但公开合同仍叫 `submitPrompt(): Promise<void>`，造成名字和行为不一致。

### 1.3.5 use-case

不同调用方确实需要不同能力：

- `packages/ohbaby-cli/src/cli/commands/run.ts` 等待 `host.core.submitPrompt(prompt)` 后立即 unsubscribe/dispose；它依赖“完成后返回”。
- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx` fire-and-forget 旧 Promise，并用 `.catch()` 显示最终运行错误。
- `apps/ohbaby-web/src/ui/App.tsx` 生成 `clientRequestId`，等待 HTTP 202 receipt，并用 receipt 选择新 session；它依赖“接单即返回”。

因此两端需要共享同一组能力和语义，不需要强迫所有场景选同一个时间点。

### 1.3.6 non-functional

- Prompt `clientRequestId` 已在 `packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.ts` 用于幂等：相同 ID/相同输入复用记录，相同 ID/不同输入冲突。
- SDK 公开租约 input 仍带 `ownerClientId`。REST（`create-app.ts`）和 JSON-RPC（`rpc-route.ts`）已经用已认证 `clientId` **覆盖**调用方传入值，不信任客户端自报。剩余缺口是：公开 SDK 类型仍暴露该字段；in-process 路径（`ui-inprocess.ts`）仍原样转发。本轮收紧公开 input，由 gateway 注入可信 identity。
- SDK 输入包含 Prompt 文本、model API key、search API key 等敏感内容。把 raw params 放入通用记录会直接扩大泄露面。
- `packages/ohbaby-sdk/src/rpc/proxy.ts` 只是 JSON clone 的 in-memory 边界模拟，不是审计存储，也不是网络命令信封。

### 1.3.7 test

现有测试已锁定一部分旧语义：

- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts` 期待 provider/stream 失败使 `submitPrompt` reject；
- `tests/integration/cli/daemon-global-fifo.integration.test.ts` 使用旧 Promise 生命周期验证 FIFO/abort；
- `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts` 已大量覆盖 `submitPromptAccepted + waitForPrompt` 的排队、失败、取消和恢复；
- `packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts` 覆盖未知 prompt reject 和完成竞态。

迁移不能简单批量替换方法名；测试必须按“接单”“等待”“业务终态”重新归类。

## 1.4 ohbaby-agent 现状

### 1.4.1 scheduler 终态与等待者

`packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.ts`：

- `TERMINAL_STATUSES` 已包含四种终态；
- `waitForCompletion()` 先登记 waiter，再读 store，避免完成竞态；
- 未知 prompt 会 reject；
- `close()` 只设置 `closed = true`，没有清理 `completionWaiters`。

最后一点会使已有等待在 host dispose 后永远 pending。持久化 store 能在 daemon 启动时把失去 owner 的 starting/running 记录恢复为 interrupted，但当前进程里的 Promise 仍需明确结束。

### 1.4.2 终态被压扁

压扁发生在 **scheduler 捕获执行异常之后**，不是 `submitPromptAndWait` 自己把 cancelled 改成 failed。

当前分层：

- `ui-inprocess.ts` 的 `submitPromptInternal()`：`cancelled` 直接返回 completion；其它非 `succeeded` 抛 `RunCompletionFailureError`。
- `scheduler.ts` 外层 catch：把抛出的异常统一 `finish(... status: "failed")`。因此正常运行链路里的 `interrupted` 常被记成 `failed`；进程恢复路径较稳定地产生 `interrupted`。
- 现有内部 `submitPromptAndWait`（仍返回 `void`）：只对 completion 的 `failed` / `interrupted` 再抛普通 `Error`；`cancelled` 静默成功、不抛。improve-1 兼容桥必须保持这一旧行为，新 `submitPromptAndWait` 才改为四种终态都 resolve。

目标合同要求 RunCompletion → PromptExecutionResult → PromptSubmissionRecord → UiPromptCompletion 全链保留终态。

### 1.4.3 host 与 raw backend

`createPersistentUiBackendClient()` 同时被 CLI/TUI host 和 daemon Server 使用。若直接在 persistent/in-process backend 内记录：

```text
Web → Server 记录 → backend 再记录
```

会产生重复。适合的本地记录边界是 `packages/ohbaby-agent/src/host/core-api-factory.ts`；raw backend 和 scheduler 应保持可执行但不自记。

另有一条内部再写路径：`executeCommand` → `packages/ohbaby-agent/src/commands/service.ts` 的 skill 命令会调用注入的 `submitPrompt`，当前注入的是同一 in-process client 上的 `submitPromptAndWait`。若 gateway 同时包住对外 `executeCommand` 和这次内部接单，一次斜杠 skill 会记两条。实施时内部注入必须指向 raw backend（见 02 Phase 4 步骤 5a、04 T35）。

## 1.5 ohbaby-server 现状

### 1.5.1 JSON-RPC 已有运输 ID

`packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts` 的 `DaemonRpcRequest` 已有：

```ts
{ id, clientId, method, params }
```

`packages/ohbaby-server/src/protocols/jsonrpc/client.ts` 为每次调用生成随机 `id`。它是一次 request/response 的 transport correlation，不是 Prompt 幂等键，也不是后端 operation ID。

### 1.5.2 feature detection 粒度过粗

`packages/ohbaby-server/src/coordination/prompt-backend.ts` 的 `supportsPromptQueue()` 同时检查接单、等待、编辑、取消和三个租约方法。Server 的 Web/RPC 路由因此把“能否提交”与“能否协作编辑队列”绑在一起，并保留旧 `submitPrompt` fallback。

生产 in-process、persistent、remote client 实际都已实现这些能力；可选性主要服务旧测试桩和兼容实现。

### 1.5.3 尚无统一命令 recorder

REST route、JSON-RPC route 和 Agent host 都能观察到写操作，但当前没有共享的记录合同、脱敏 builder、started/completed 对应关系或去重规则。早期文档建议的 `{ id, method, params, at }` 也没有真实 sink，并会复制 transport ID 和敏感 params。

## 1.6 ID 现状与正确分类

| 层次 | 已有 ID | 当前用途 | 是否应保留 |
|------|---------|----------|------------|
| 运输 | JSON-RPC `id` | 请求与响应配对 | 是；记录为 `transportRequestId` |
| Prompt 意图 | `clientRequestId` | 重试幂等与前端 pending 对账 | 是 |
| Prompt 实体 | `promptId` | 队列、等待、编辑、完成 | 是 |
| Agent 执行 | `runId` | run 状态、abort、权限归属 | 是 |
| slash 意图 | `clientInvocationId` | 客户端命令意图 | 是 |
| slash 执行 | `commandRunId` | 命令执行和结果事件 | 是 |
| 权限 | `requestId` | permission request/response | 是 |
| 交互 | `interactionId` | interaction request/response | 是 |
| 后端写操作 | 尚无 | 一次原子写的 started/completed | 新增 `operationId` |

`packages/ohbaby-sdk/src/events.ts` 与 `snapshot.ts` 已保存这些自然领域 ID。真正缺失的是统一规则和后端写操作 ID，不是把所有字段改名。

## 1.7 文档与实现对照

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| SDK 方法只表示“请求已提交” | `submitPrompt` 等待完成；多个写方法返回业务结果 | goals-duty / architecture 需要按真实分类修订 |
| 结果通过 `UiEvent` | 消息和状态确实走事件；Prompt completion 另有结构化等待结果 | 两者不冲突，但需明确 completion 不承载消息正文 |
| SDK 是稳定会话合同 | `CoreAPI`、`SDKAPI` 和 Web client 手抄 | 权威性未落实到类型依赖 |
| 事件关联 ID 必备 | command/interaction/prompt 已有领域 ID | 不应再无差别新增一个通用 ID |
| prompt queue 是额外能力 | 生产链路实际依赖 durable admission 和队列管理 | 可选 feature detection 已成兼容债务 |

## 1.8 改动影响面

| 包/目录 | 影响 |
|---------|------|
| `packages/ohbaby-sdk/src/` | Prompt 完成类型、client 能力、命令记录合同、导出与 contract tests |
| `packages/ohbaby-agent/src/runtime/prompt-scheduler/` | 终态保持、waiter 关闭和等待中止 |
| `packages/ohbaby-agent/src/adapters/` | 新方法实现、运行终态投影 |
| `packages/ohbaby-agent/src/host/` | in-process 唯一记录 gateway、派生 SDK 类型 |
| `packages/ohbaby-server/src/coordination/` | Prompt 能力判断与 fallback 迁移 |
| `packages/ohbaby-server/src/protocols/jsonrpc/` | 新方法、旧 method 兼容、RPC 记录 gateway |
| `packages/ohbaby-server/src/app/` | REST 记录 gateway |
| CLI/TUI/Web | 本轮只维持兼容；完整采用在 improve-2 |
| `docs/ohbaby-sdk/` 等 | 合同实施后更新权威描述 |

## 1.9 SWE 原则审视

### 管理复杂度

- 正确抽象是“Prompt 生命周期能力”和“写操作记录边界”，而不是通用 Op 解释器。
- Query/Command 拆分只有在消费者依赖窄接口、记录器只包命令时才有价值；只新增类型别名没有价值。

### 高内聚、低耦合

- Prompt completion 的约束应集中在 SDK 数据模型。
- scheduler 负责状态机，gateway 负责外部操作记录，raw backend 不同时承担两种职责。

### DRY 与错误抽象

- `CoreAPI`/`SDKAPI` 手抄应改为从 SDK 权威接口派生。
- 不把 transport request ID、Prompt 幂等 ID 和 operation ID 合并；错误统一比重复更危险。

### KISS / YAGNI

- 不建设审计数据库、回放 UI、无界重试队列或统一 `submit(op)`。
- recorder 先用端口 + 结构化日志/内存测试 sink，需求出现后再扩展持久化。

## 1.10 问题到后续文档的追踪

| 问题 | 02 回应 | 04 验收 |
|------|---------|---------|
| P1/P2 Prompt 方法与 completion | 02 Phase 1–2 | T1–T10、T20 |
| P8 scheduler 关闭/终态/竞态 | 02 Phase 2 | T11–T15f |
| P3 接口能力与队列必选 | 02 Phase 2 | T16–T18、T20a |
| P4 契约重复 | 02 Phase 2、5 | T19、T18 |
| P5 ID 分类 | 02 Phase 3 | T21–T22 |
| P6 记录、去重、interaction owner | 02 Phase 3–4 | T23–T40 |
| P7 权威文档 | 02 Phase 5 | G8 |
