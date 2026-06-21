# ohbaby-web · data-model（数据模型）

> web 端的概念词典。只收**web 自己拥有的投影态与连接态**；领域类型（`UiSnapshot` / `UiEvent` / `UiMessage` / `UiRun` / `UiPermissionRequest` 等）是 `ohbaby-sdk` 的真相，web 只引用、不重定义（ND3/ND4）。
>
> 前置：[`architecture.md`](./architecture.md) 已确认。

---

## 1. Core Concepts（核心概念）

- **ViewState** —— store 持有的、从 snapshot + 事件投影出的 UI 状态。是 `eventReducer` 的输出，UI 的唯一读取源。
- **ConnectionState** —— web 对"浏览器↔daemon 链路"的视角。daemon 没有这个概念，是 web 独有的连接态机。
- **StreamingMessage** —— 一条尚在流式到达、未定稿的 assistant 消息：`message.part.delta` 不断累积进它，直到 `message.updated` 定稿。
- **PendingPermission** —— 本连接待用户处置的权限请求 + 归属信息。
- **CommandNotice** —— slash 命令事件的轻量 UI 投影。它只展示命令 started/result/failed 的状态、输出或错误，不进入会话消息历史，不持久化。

---

## 2. Entity / Value Object 区分

- **Entity（有身份、有生命周期）**：`StreamingMessage`（按 messageId 跟踪、随 delta 演进至定稿）、`PendingPermission`（按 requestId 跟踪、随用户应答或 resync 消失）、`CommandNotice`（按 commandRunId/clientInvocationId 跟踪，随命令结果或新 run 清理）。
- **Value Object（无身份、不可变快照）**：`ConnectionState`（某一时刻的连接阶段枚举值）、`ViewState`（某一次投影产出的不可变快照，reducer 每次产出新值）。

> 不强行套 DDD，此区分仅帮助理解"谁会变、按什么 id 变"。

---

## 3. Key Data Fields（关键数据要素，描述含义而非类型）

### ViewState
- `sessions` / `activeSessionId` —— 当前会话与选中项（投影自 snapshot）。
- `messages` —— 当前会话的消息序列，含已定稿消息与至多一条 `StreamingMessage`。
- `runStatus` —— 当前 run 的状态（idle / running / interrupted）。
- `pendingPermissions` —— 待审批队列（`PendingPermission` 列表）。
- `commandNotices` —— slash 命令的轻量结果/错误列表，最多保留少量近期项，避免长输出挤占会话流。
- `contextWindowUsage` —— 上下文用量（投影自事件）。
- `lastAppliedSeqNum` —— 已应用到 ViewState 的最大事件 seqNum（投影游标）。

### ConnectionState（五态机）
- 取值：`connecting` → `live` → `reconnecting` → `resyncing` → `disconnected`。
- `connecting`：已发起建连/订阅，尚未进入 live。
- `live`：SSE 正常、事件实时流入。
- `reconnecting`：SSE 断开，正带 `Last-Event-ID` 重连（事件可经 replay 补回）。
- `resyncing`：重连命中 `resync-required`（缓冲已被驱逐）——须丢弃 ViewState、重拉 snapshot 后回 live。
- `disconnected`：放弃/不可恢复（如 401），等待用户介入。

### StreamingMessage
- `messageId` —— 在途消息标识。
- `parts` —— 已累积的片段（按 partId/顺序拼接）。
- `finalized` —— 是否已收到 `message.updated` 定稿。

### PendingPermission
- `requestId` —— 权限请求标识。
- `request` —— 引用 sdk 的 `UiPermissionRequest`（领域真相，不在此展开）。
- `ownedByThisClient` —— 归属本连接与否（错主时 server 返回 403，用于 UI 提示）。

### CommandNotice
- `id` —— 本地展示 id，优先来自 `commandRunId`。
- `kind` —— `running` / `success` / `error`。
- `commandId` / `path` —— 命令身份，用于标签与调试。
- `text` —— 可展示输出；`markdown` 输出须走同一 markdown+sanitize 通道；`data` 输出先格式化为简洁文本。
- `sessionId` —— 可选，用于后续过滤非当前 session 的命令结果；v0.1.6 可先按事件原样展示。

---

## 4. Lifecycle & Ownership（生命周期与归属）

- **创建**：ViewState 在首屏由 `GET /v1/snapshot` 投影产生；StreamingMessage 在首个 `message.part.delta` 创建；PendingPermission 在 `permission.requested` 入队；ConnectionState 在 bootstrap 建连时进入 `connecting`。
- **更新**：均由 `eventReducer` 依据 SSE 事件推进；`lastAppliedSeqNum` 单调前进。CommandNotice 由 `command.started` / `command.result.delivered` / `command.failed` 推进。
- **失效/销毁**：StreamingMessage 在 `message.updated` 定稿后并入消息序列；PendingPermission 在用户应答或 `resyncing` 重建后移除；CommandNotice 在新 prompt/run 或达到保留上限时清理；整个 ViewState 在 `resyncing` 时被**整体丢弃重建**。
- **归属**：以上概念**全部由 store 拥有、易失、绝不持久化**（落 G1）。daemon 拥有会话真相与 replay 缓冲；web 仅拥有自己的投影游标 `lastAppliedSeqNum` 与连接态。

> 概念变化需同步检查 [`dfd-interface.md`](./dfd-interface.md)（投影流）与 [`test.md`](./test.md)（投影/连接态场景）。
