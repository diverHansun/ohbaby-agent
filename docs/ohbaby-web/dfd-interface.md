# ohbaby-web · dfd-interface（数据流与接口）

> 数据流优先、接口其次。说明数据如何进入 web、经过什么处理、流向哪里，以及通过什么接口完成交互。
>
> 前置：[`goals-duty.md`](./goals-duty.md)、[`architecture.md`](./architecture.md)、[`data-model.md`](./data-model.md) 已确认。

---

## 1. Context & Scope（上下文与范围）

web 只与 daemon 的 `/v1` 面交互（同源）。

- **入站三个来源**：`window.__OHBABY__`（引导，依赖 S-C）、`/v1` REST 响应、`/v1/events` SSE 流。
- **出站一个去向**：用户动作 → `/v1` REST 命令。

本文不描述 daemon 内部（路由/协调/replay 属 `ohbaby-server`）。web 管理当前 selected directory，并在每个 workspace HTTP/SSE 请求中显式发送 `x-ohbaby-directory`；它不做 realpath/git-root canonicalization（ND10）。

---

## 2. Data Flow Description（数据流描述）

**① 引导流**：页面加载 → `bootstrap.ts` 读 `window.__OHBABY__`{token, clientId, baseUrl, directory}，再读取 URL fragment 中的一次性初始 selected hint → 构造 `OhbabyWebRuntime`。runtime 为选中的 workspace 创建一个 `BrowserDaemonClient`；没有可选 workspace 时 `runtime.client` 为 `null`。fragment 只在浏览器端消费，server 不接受 query/cwd fallback。

**② 建连 / 首屏流（关键顺序，防漏拍/重复）**：
1. `POST /v1/clients`（startup intent）→ 拿 clientId。
2. **先开** `GET /v1/events` SSE → 收到 `hello` → 进入 `connecting`，并**开始缓冲**到达的事件。
3. `GET /v1/snapshot` → 响应携带它反映的 **seqNum 基线**（依赖 S-A）→ client 本地构造一次 `snapshot.replaced` barrier，经统一分发投影为初始 ViewState，置 `lastAppliedSeqNum = 基线`。
4. 把缓冲事件中 **seq > 基线** 的部分按序应用，丢弃 seq ≤ 基线的（已含在 snapshot 内）→ 进入 `live`。

**③ 事件流（异步、事件驱动）**：一条 SSE 推送 transport frame → `events.ts` 解包一次 → `BrowserDaemonClient.dispatchUiEvent` → store 校验 seq 并先投影 → SDK subscribers 后通知 → UI 重渲染。多个 subscriber 共享同一 SSE，不会各建连接。StreamingMessage 必须先由 snapshot / `message.appended` 建立；`message.part.delta` 只按 messageId 更新已有消息，并在 tool part 之后追加新的 text part，直到 `message.updated` 定稿。缺少 messageId 或目标消息时静默丢弃该 delta 内容但推进 seq，避免制造无身份消息；恢复仍由 replay/resync 负责。

工具结果投影在 live stream 与持久化 snapshot 两条路径共用同一终态规则：scheduler/state 的错误终态，以及 metadata 中的 `failed` / `timed_out` / `cancelled` 或非零 `exitCode`，均折叠为 UI `failed`。Web 再按 call id 配对 call/result，只渲染一张工具卡。

**④ 命令流（出站）**：
- 发话：UI 调 `runtime.client.submitPromptAccepted(text, options)` → `POST /v1/prompts` → `202 Accepted` + `UiPromptReceipt`；最终状态经 SSE 投影。需要显式等待的调用方可按 `promptId` 调 `GET /v1/prompts/:id/completion`，或使用只组合 accepted + wait 的 `submitPromptAndWait`。
- 审批：`POST /v1/permissions/:id` → `200`（错主 → `403`）。
- 中断：`POST /v1/sessions/:id/abort` → `200`（同步）。
- slash passthrough：`GET /v1/commands?surface=web` 拉取 web palette catalog；`executionKind:"passthrough"` 命令执行前仍用 `ohbaby-sdk` 的 slash parser/resolve 与 web-safe catalog helper 生成 invocation，再 `POST /v1/commands` 执行。server 对手写请求再次使用同一 SDK helper 校验 allowlist，拒绝 `interaction` 与 overlay 命令；结果经 `command.*` SSE 事件投影为 `CommandNotice`，只读命令可升级为结构化 modal。
- structured slash overlays：同一 catalog 中的 `executionKind:"overlay"` 命令只打开表单；`/connect` 走 `POST /v1/model`，`/connect-search` 走 `POST /v1/settings/search-api-key`，`/compact` 走 `POST /v1/sessions/:id/compact`。这些 mutation 不经 `POST /v1/commands`。
- 命令目录更新：收到 `command.catalog.updated` 时，web 使本地 catalog 缓存失效，下次 slash 打开/执行重新拉目录。

**⑤ 断线 / 重同步流**：
- SSE 断 → `reconnecting` → 带 `Last-Event-ID`(= `lastAppliedSeqNum`) 重连 → 命中 replay 则补发 `(id, now]` 事件，回 `live`。
- 命中 `resync-required`（缓冲已驱逐）→ `resyncing` → 重拉 snapshot → 经本地 snapshot barrier 替换投影 → 只 replay 更新的 buffer → 回 `live`。
- 不可恢复（如 `401`）→ `disconnected`，UI 提示用户介入。

---

## 3. Interface Definition（接口定义）

### 3.1 依赖接口（web → daemon，内部 wire helper）

| 端点 | 语义 | 同步性 |
|------|------|--------|
| `POST /v1/clients` | 建立 client 视图（startup intent），返回 clientId | 同步 |
| `GET /v1/snapshot` | 该连接视图的初始状态，**含 seqNum 基线** | 同步 |
| `GET /v1/events` | SSE 事件流，带 `Last-Event-ID` replay | 长连接/流 |
| `POST /v1/prompts` | 接受并持久化 prompt，返回 `UiPromptReceipt` | 异步接单（202） |
| `GET /v1/prompts/:id/completion` | 按 promptId 等待四种终态；请求中止只停止等待 | 长请求 |
| `PATCH/DELETE /v1/prompts/:id` | 编辑/取消 queued prompt，使用 lease 与认证 client owner | 同步 mutation |
| `POST/PATCH/DELETE /v1/prompts/:id/edit-lease` | 获取、续租、释放 prompt 编辑租约 | 同步 mutation |
| `POST /v1/permissions/:id` | 审批应答（归属校验，错主 403） | 同步 |
| `POST /v1/interactions/:id/respond` | 交互应答；Server 原子校验并 claim owner | 同步 |
| `POST /v1/sessions/:id/abort` | 中止当前 run | 同步 |
| `POST /v1/sessions`; `PATCH /v1/sessions/:id/select` | 创建/选择会话 | 同步 |
| `PATCH /v1/sessions/:id/archive` | 归档会话 | 同步 mutation |
| `GET /v1/commands?surface=web` | 读取 web slash palette（passthrough + overlay metadata） | 同步 |
| `POST /v1/commands` | 执行已解析的 passthrough `UiSlashCommandInvocation`，结果经 SSE 出 | 异步 |
| `GET /v1/model` | 读取当前模型配置（不含真实 key） | 同步 |
| `POST /v1/model/context-window-probe` | 只读探测模型 context window；不写配置、不 reset runtime | 同步 |
| `POST /v1/model` | 保存当前模型配置并重置 runtime | 同步 |
| `POST /v1/settings/search-api-key` | 保存 Tavily 搜索 key / env 引用并刷新 search config | 同步 |
| `PATCH /v1/permission` | 更新 permission mode/level | 同步 mutation |
| `GET /v1/sessions/:id/context-window` | 读取当前 session context window 用量 | 同步 |
| `POST /v1/sessions/:id/compact` | 执行当前 session 压缩 | 同步 |

> 每个端点都对应一个既有 `UiBackendClient` 能力；语义经同一 coordination 与 jsonrpc 对齐，不产生只在 web 才有的行为。

### 3.2 SDK client 与 runtime façade

- `BrowserDaemonClient implements UiBackendClient`：公开 SDK 权威业务能力；`getSnapshot()` 异步返回 `UiSnapshot`，`subscribeEvents()` 注册本地 subscriber，三种 Prompt 方法、必选 queue/lease、permission/interaction/model/command 能力均使用 SDK 参数与返回值。
- `OhbabyWebRuntime`：只负责编排 workspace/directory、client 生命周期、create/select/archive/abort session 和 slash 文本解析；`runtime.client` 的静态类型是 `UiBackendClient | null`，不是第二份业务接口。
- `DaemonHttpClient`：内部 wire helper，只返回 transport wrapper，不暴露给 UI，也不实现 `UiBackendClient`。

### 3.3 store 接口

- `subscribe(listener)` / 同步 `getSnapshot(): StoreSnapshot` —— 喂 React `useSyncExternalStore`。它与 SDK client 的异步 snapshot 查询是两个对象、两种明确语义。

---

## 4. Data Ownership & Responsibility（数据归属与责任）

- **daemon 拥有**：会话真相（创建/更新 `UiSnapshot` / `UiEvent`）、prompt 队列调度、权限归属校验、SSE replay 环形缓冲、workspace scope 解析。
- **web 拥有**：ViewState / ConnectionState（派生、易失、**绝不持久化**）、自己的 `lastAppliedSeqNum` 游标与当前 selected directory。
- **token**：daemon 拥有；web 只读注入副本、仅存内存（ND2）。
- **跨进程并发**（web daemon 与并发 in-process CLI 同写一份 DB）：由 DB 原子 claim 防写坏；web **不负责** live 双向同步（ND9）——只在下次 snapshot/resync 时反映对端改动。

> 切换 selected directory 时关闭旧 scope SSE、清空旧 scope 派生状态，再以新 header 重建 client + snapshot + SSE；旧 generation 事件不得写入新 scope。该 v0.1.7 切换闭环已落地，并由 `workspace-switch.integration.test.ts` 覆盖。
>
> 关键数据流 ②（seqNum 基线对齐）、⑤（reconnect/resync）是 [`test.md`](./test.md) 必须覆盖的正确性流；其依赖的 server 契约见 README 的 S-A/S-D。
