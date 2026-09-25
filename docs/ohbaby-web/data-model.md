# ohbaby-web · data-model（数据模型）

> web 端的概念词典。只收**web 自己拥有的投影态与连接态**；领域类型（`UiSnapshot` / `UiEvent` / `UiMessage` / `UiRun` / `UiPermissionRequest` 等）是 `ohbaby-sdk` 的真相，web 只引用、不重定义（ND3/ND4）。
>
> 前置：[`architecture.md`](./architecture.md) 已确认。

---

## 1. Core Concepts（核心概念）

- **ViewState** —— store 持有的、从 snapshot + 事件投影出的 UI 状态。是普通事件 `eventReducer` 的输出；审批另读独立的 `PermissionSyncState`。
- **ConnectionState** —— web 对"浏览器↔daemon 链路"的视角。daemon 没有这个概念，是 web 独有的连接态机。
- **StreamingMessage** —— 一条已由 snapshot / `message.appended` 建立、尚未定稿的 assistant 消息：后续 `message.part.delta` 只更新这条已有消息，直到 `message.updated` 定稿。
- **PendingPermission** —— 当前客户端所绑定根会话子树内待处置的独立权限请求；同根客户端共享可见范围。
- **CommandNotice** —— slash 命令事件的轻量 UI 投影。它只展示命令 started/result/failed 的状态、输出或错误，不进入会话消息历史，不持久化。

---

## 2. Entity / Value Object 区分

- **Entity（有身份、有生命周期）**：`StreamingMessage`（按 messageId 跟踪、随 delta 演进至定稿）、`PendingPermission`（按 requestId 跟踪，由权威 resolved 事件或审批 snapshot 确认移除）、`CommandNotice`（按 commandRunId/clientInvocationId 跟踪，随命令结果或新 run 清理）。
- **Value Object（无身份、不可变快照）**：`ConnectionState`（某一时刻的连接阶段枚举值）、`ViewState`（某一次投影产出的不可变快照，reducer 每次产出新值）。

> 不强行套 DDD，此区分仅帮助理解"谁会变、按什么 id 变"。

---

## 3. Key Data Fields（关键数据要素，描述含义而非类型）

### ViewState

- `sessions` / `activeSessionId` —— 当前会话与选中项（投影自 snapshot）。
- `messages` —— 当前会话的消息序列，含已定稿消息与至多一条 `StreamingMessage`。
- `runStatus` —— 当前 run 的状态（idle / running / interrupted）。
- 普通 ViewState 不承载审批真相；审批列表位于同一 store 的独立 `permissionSync.requests`。
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
- `parts` —— 按 producer 顺序累积的片段；delta 只续写尾部 text，否则追加新的 text part，不能跨 tool part 覆盖前文。
- `finalized` —— 是否已收到 `message.updated` 定稿。

工具调用的 Web 卡片是 `tool-call.call.id` 与 `tool-result.callId` 的派生配对视图，不是独立持久化实体。同一调用只渲染一张卡；稳定 key 使用 call id，但 call id 不作为用户可见标题。

### PendingPermission

- `requestId` —— 权限请求标识。
- `request` —— 引用 sdk 的 `UiPermissionRequest`（领域真相，不在此展开）。
- `sessionId` / `runId` —— 实际发起请求的来源会话和 run；`callId` 只用于工具关联，不能代替 run identity。
- `rootSessionId` / `sourceLabel` —— 根范围与简短来源标签；完整祖先链由 backend 校验，不作为 Web 自有字段。

### PermissionSyncState

- `status` —— `idle / syncing / ready / error / unavailable`，独立于普通连接态；只有 `ready` 才允许回复。
- `binding` —— `permissionEpoch / rootSessionId / bindingGeneration`；连接或选择变化后拒绝旧 generation 的结果。
- `requests` / `permissionRevision` —— 独立审批 snapshot 加连续审批增量所确认的列表与游标。
- `attempts` / `error` —— 有界恢复次数与可见失败；显式 Retry 开启新一轮，严重 `unavailable` 保持禁用。
- 共享 SDK `createPermissionSync` 推进此状态；全量 `UiSnapshot` 和普通 seq/replay 不覆盖它。

### CommandNotice

- `id` —— 本地展示 id，优先来自 `commandRunId`。
- `kind` —— `running` / `success` / `error`。
- `commandId` / `path` —— 命令身份，用于标签与调试。
- `text` —— 可展示输出；`markdown` 输出须走同一 markdown+sanitize 通道；`data` 输出先格式化为简洁文本。
- `sessionId` —— 可选，用于后续过滤非当前 session 的命令结果；v0.1.6 可先按事件原样展示。

---

## 4. Lifecycle & Ownership（生命周期与归属）

- **创建**：ViewState 由 `GET /v1/snapshot` 投影；StreamingMessage 由 snapshot 或 `message.appended` 建立。审批在收到当前连接的 `hello` binding 后，独立查询 `GET /v1/permissions` 并合并查询期间缓冲的增量。
- **更新**：普通事件由 `eventReducer` 推进 `lastAppliedSeqNum`；孤立消息 delta 不创建消息。审批只由共享恢复引擎按 epoch、root、bindingGeneration 与 `permissionRevision` 推进；CommandNotice 由 `command.*` 事件推进。
- **失效/销毁**：StreamingMessage 在 `message.updated` 定稿；审批由权威 resolved 或独立 snapshot 确认移除，HTTP 成功本身不做乐观删除。普通 `resync-required` 重建 ViewState，不覆盖审批。断线或 scope 切换立即禁止审批响应；服务端 pending 不随客户端断开取消。
- **归属**：store 持有以上易失投影，不持久化。backend 持有审批事实；web 仅持有普通事件游标、独立审批游标、绑定及连接态。

> 概念变化需同步检查 [`dfd-interface.md`](./dfd-interface.md)（投影流）与 [`test.md`](./test.md)（投影/连接态场景）。
