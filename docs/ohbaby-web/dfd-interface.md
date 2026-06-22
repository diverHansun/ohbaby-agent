# ohbaby-web · dfd-interface（数据流与接口）

> 数据流优先、接口其次。说明数据如何进入 web、经过什么处理、流向哪里，以及通过什么接口完成交互。
>
> 前置：[`goals-duty.md`](./goals-duty.md)、[`architecture.md`](./architecture.md)、[`data-model.md`](./data-model.md) 已确认。

---

## 1. Context & Scope（上下文与范围）

web 只与 daemon 的 `/v1` 面交互（同源）。

- **入站三个来源**：`window.__OHBABY__`（引导，依赖 S-C）、`/v1` REST 响应、`/v1/events` SSE 流。
- **出站一个去向**：用户动作 → `/v1` REST 命令。

本文不描述 daemon 内部（路由/协调/replay 属 `ohbaby-server`）。web 同源继承伺服它的 daemon 的 workspace scope，不自行解析（ND10）。

---

## 2. Data Flow Description（数据流描述）

**① 引导流**：页面加载 → `bootstrap.ts` 读 `window.__OHBABY__`{token, clientId, baseUrl} → 构造 `client` 门面。

**② 建连 / 首屏流（关键顺序，防漏拍/重复）**：
1. `POST /v1/clients`（startup intent）→ 拿 clientId。
2. **先开** `GET /v1/events` SSE → 收到 `hello` → 进入 `connecting`，并**开始缓冲**到达的事件。
3. `GET /v1/snapshot` → 响应携带它反映的 **seqNum 基线**（依赖 S-A）→ 投影为初始 ViewState，置 `lastAppliedSeqNum = 基线`。
4. 把缓冲事件中 **seq > 基线** 的部分按序应用，丢弃 seq ≤ 基线的（已含在 snapshot 内）→ 进入 `live`。

**③ 事件流（异步、事件驱动）**：SSE 推 `UiEvent`（带 seqNum）→ `events.ts` 解析 → `eventReducer(event, state)` → 新 ViewState → store 通知 → UI 重渲染。`message.part.delta` 累积成 StreamingMessage，直到 `message.updated` 定稿。

**④ 命令流（出站）**：
- 发话：`POST /v1/sessions/:id/prompt` → `202 Accepted`（异步，结果经 SSE 回）。
- 审批：`POST /v1/permissions/:id` → `200`（错主 → `403`）。
- 中断：`POST /v1/sessions/:id/abort` → `200`（同步）。
- slash passthrough：`GET /v1/commands?surface=web` 拉取 web palette catalog；`executionKind:"passthrough"` 命令执行前仍用 `ohbaby-sdk` 的 slash parser/resolve 与 web-safe catalog helper 生成 invocation，再 `POST /v1/commands` 执行。server 对手写请求再次使用同一 SDK helper 校验 allowlist，拒绝 `interaction` 与 overlay 命令；结果经 `command.*` SSE 事件投影为 `CommandNotice`，只读命令可升级为结构化 modal。
- structured slash overlays：同一 catalog 中的 `executionKind:"overlay"` 命令只打开表单；`/connect` 走 `POST /v1/model`，`/connect-search` 走 `POST /v1/settings/search-api-key`，`/compact` 走 `POST /v1/sessions/:id/compact`。这些 mutation 不经 `POST /v1/commands`。
- 命令目录更新：收到 `command.catalog.updated` 时，web 使本地 catalog 缓存失效，下次 slash 打开/执行重新拉目录。

**⑤ 断线 / 重同步流**：
- SSE 断 → `reconnecting` → 带 `Last-Event-ID`(= `lastAppliedSeqNum`) 重连 → 命中 replay 则补发 `(id, now]` 事件，回 `live`。
- 命中 `resync-required`（缓冲已驱逐）→ `resyncing` → 重拉 snapshot + **整体重置 ViewState** → 回 `live`。
- 不可恢复（如 `401`）→ `disconnected`，UI 提示用户介入。

---

## 3. Interface Definition（接口定义）

### 3.1 依赖接口（web → daemon，OpenAPI 生成 typed client）

| 端点 | 语义 | 同步性 |
|------|------|--------|
| `POST /v1/clients` | 建立 client 视图（startup intent），返回 clientId | 同步 |
| `GET /v1/snapshot` | 该连接视图的初始状态，**含 seqNum 基线** | 同步 |
| `GET /v1/events` | SSE 事件流，带 `Last-Event-ID` replay | 长连接/流 |
| `POST /v1/sessions/:id/prompt` | 入队 prompt，结果经 SSE 出 | 异步（202） |
| `POST /v1/permissions/:id` | 审批应答（归属校验，错主 403） | 同步 |
| `POST /v1/sessions/:id/abort` | 中止当前 run | 同步 |
| `GET /v1/commands?surface=web` | 读取 web slash palette（passthrough + overlay metadata） | 同步 |
| `POST /v1/commands` | 执行已解析的 passthrough `UiSlashCommandInvocation`，结果经 SSE 出 | 异步 |
| `GET /v1/model` | 读取当前模型配置（不含真实 key） | 同步 |
| `POST /v1/model/context-window-probe` | 只读探测模型 context window；不写配置、不 reset runtime | 同步 |
| `POST /v1/model` | 保存当前模型配置并重置 runtime | 同步 |
| `POST /v1/settings/search-api-key` | 保存 Tavily 搜索 key / env 引用并刷新 search config | 同步 |
| `GET /v1/sessions/:id/context-window` | 读取当前 session context window 用量 | 同步 |
| `POST /v1/sessions/:id/compact` | 执行当前 session 压缩 | 同步 |

> 每个端点都对应一个既有 `UiBackendClient` 能力；语义经同一 coordination 与 jsonrpc 对齐，不产生只在 web 才有的行为。

### 3.2 内部门面接口（`client`）

浏览器版 backend 门面，UI 只依赖它：
- `connect()` —— 执行②建连/首屏流，进入 live。
- `getSnapshot()` —— 取当前 ViewState（喂 store）。
- `submitPrompt(text, sessionId?)` —— 发话（异步）。
- `respondPermission(requestId, response)` —— 审批。
- `abortRun(runId?)` —— 中断。
- `listCommands()` / `executeCommand(invocation)` —— web slash 候选、补全与 passthrough 执行。
- `getCurrentModel()` / `probeModelContextWindow()` / `connectModel()` —— `/connect` overlay 的读取、只读探测与保存。
- `setSearchApiKey()` —— `/connect-search` overlay 保存。
- `getContextWindowUsage()` / `compactSession()` —— `/compact` overlay 的 usage 与压缩。
- `subscribe(listener)` —— 订阅 ViewState/ConnectionState 变化。

### 3.3 store 接口

- `subscribe(listener)` / `getSnapshot()` —— 喂 React `useSyncExternalStore`。

---

## 4. Data Ownership & Responsibility（数据归属与责任）

- **daemon 拥有**：会话真相（创建/更新 `UiSnapshot` / `UiEvent`）、prompt 队列调度、权限归属校验、SSE replay 环形缓冲、workspace scope 解析。
- **web 拥有**：ViewState / ConnectionState（派生、易失、**绝不持久化**）、自己的 `lastAppliedSeqNum` 游标。
- **token**：daemon 拥有；web 只读注入副本、仅存内存（ND2）。
- **跨进程并发**（web daemon 与并发 in-process CLI 同写一份 DB）：由 DB 原子 claim 防写坏；web **不负责** live 双向同步（ND9）——只在下次 snapshot/resync 时反映对端改动。

> 关键数据流 ②（seqNum 基线对齐）、⑤（reconnect/resync）是 [`test.md`](./test.md) 必须覆盖的正确性流；其依赖的 server 契约见 README 的 S-A/S-D。
