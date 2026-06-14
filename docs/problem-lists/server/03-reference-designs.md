# 03 · 优秀项目借鉴点（真实代码引用）

> **文档职责**：从四个参考项目中提取与 web/app 通信层直接相关的**真实**设计点。每条给出：相对路径（相对各项目根目录）+ 具体构造名 + 借鉴说明 + 映射到 ohbaby 的用法。被 `04`/`05` 引用。
> **参考项目根目录**：`D:\Projects\Code-cli\{claude-code, opencode, gemini-cli, kimi-code}`。

---

## 借鉴点总览

| # | 能力 | 来源 | 用于 ohbaby 哪个问题 | 路线 |
|---|------|------|------|------|
| R1 | 事件总线 + seqNum + 环形缓冲（重放） | claude-code / kimi-code | S1（SSE 无重放） | A+B |
| R2 | 鉴权中间件多模 + WS 免头 token | claude-code | S4（鉴权） | A+B |
| R3 | CORS origin 白名单 | claude-code | S2（无 CORS） | A+B |
| R4 | 运行时无关传输端口 | opencode | S6（传输非端口） | A |
| R5 | 事件投影 seam | opencode | S5（无投影） | A |
| R6 | LAN 服务发现（mDNS） | opencode | S3（远程，未来） | A |
| R7 | ACP 薄适配层 | opencode / claude-code | P3（ACP，未来） | A |
| R8 | A2A task 协议 | gemini-cli | P3（A2A，未来） | A |
| R9 | 多前端审批队列 | kimi-code | S8/审批路由进阶 | A |
| R10 | 客户端多传输抽象 | claude-code | S6 客户端侧 | A |

---

## R1 · 事件总线 + seqNum + 环形缓冲（重放）

**来源**：`claude-code/packages/remote-control-server/src/transport/event-bus.ts`
**构造**：`class EventBus`，字段 `seqNum`、`events: SessionEvent[]`、常量 `MAX_EVENTS_PER_BUS = 5000`。

```ts
publish(event): SessionEvent {
  const full = { ...event, seqNum: ++this.seqNum, createdAt: Date.now() };
  this.events.push(full);
  if (this.events.length > MAX_EVENTS_PER_BUS)
    this.events = this.events.slice(-Math.floor(MAX_EVENTS_PER_BUS / 2));  // 环形淘汰
  for (const cb of this.subscribers) { try { cb(full); } catch {} }
  return full;
}
getLastSeqNum(): number { return this.seqNum; }
```

**借鉴**：每个事件带单调 `seqNum`，服务端保留有界缓冲；重连时客户端带上最后见过的 seq，服务端补发缺口。**这正是 ohbaby S1 缺的那一块。**

**第二佐证**：`kimi-code/apps/vis/server/src/lib/wire-replay.ts` —— 独立的 wire 事件重放模块，证明"事件可重放"是 web 端的通用刚需，不是 claude 特例。

**映射 ohbaby**：新增 `event-bus`（路线 B 在 `runtime/daemon/`，路线 A 在 `coordination/`），包住现有 `backend.subscribeEvents`，给 `UiEvent` 套 `{ seq, event }` 信封缓冲；`server.ts:handleEvents` 解析 `?lastEventId=` 补发；`client.ts:runSseLoop` 重连时带上 last seq。

---

## R2 · 鉴权中间件多模 + WS 免头 token

**来源**：`claude-code/packages/remote-control-server/src/auth/middleware.ts`
**构造**：`apiKeyAuth(c, next)`（Hono 中间件）、`encodeWebSocketAuthProtocol(token)`、`extractWebSocketAuthToken(c)`。

```ts
// 双模：Web UI 用 Bearer token；CLI bridge 用 API Key + X-Username
const tokenUsername = resolveToken(token);
if (tokenUsername) { c.set("username", tokenUsername); return next(); }
if (validateApiKey(token)) { /* ... */ }

// 浏览器 WebSocket 无法设 Authorization 头 → 把 token 编进 Sec-WebSocket-Protocol
export function encodeWebSocketAuthProtocol(token) {
  return `rcs.auth.${Buffer.from(token,"utf8").toString("base64url")}`;
}
```

**借鉴**：(a) 鉴权是横切中间件，从 handler 分离；(b) **浏览器 WS 不能设头**，token 走 `Sec-WebSocket-Protocol` 子协议——任何 web/app 端用 WS 时绕不开这个技巧；(c) 默认 fail-closed（无有效 token 不放行），与 ohbaby S4 的 fail-open 正好相反。

**映射 ohbaby**：`auth.ts` 收紧为 fail-closed + 常量时间比较；若上 WS，加 `ws-protocol` token 编解码；当前 SSE/RPC 用 Bearer 头即可。

---

## R3 · CORS origin 白名单

**来源**：`claude-code/packages/remote-control-server/src/auth/cors.ts`
**构造**：`getAllowedWebCorsOrigins()`、`resolveWebCorsOrigin(origin)`、`webCorsOptions`。

```ts
export function getAllowedWebCorsOrigins(): string[] {
  const origins = new Set(config.webCorsOrigins);
  origins.add(`http://localhost:${config.port}`);
  origins.add(`http://127.0.0.1:${config.port}`);   // 本机自动放行
  return [...origins];
}
export const webCorsOptions = {
  origin: resolveWebCorsOrigin,                       // 白名单函数，非 "*"
  allowHeaders: ["Authorization", "Content-Type", "X-UUID"],
  allowMethods: ["GET", "POST", "OPTIONS"],
  credentials: false,
};
```

**借鉴**：CORS 用**显式 origin 白名单 + 自动放行 localhost**，而非 `*`（带鉴权时 `*` 不安全）。`allowHeaders` 含 `Authorization`，`allowMethods` 含 `OPTIONS` 预检。

**映射 ohbaby**：`server.ts` 增加 CORS 响应头 + `OPTIONS` 预检分支，白名单默认含 `localhost`/`127.0.0.1`，可配置追加 dev server origin。

---

## R4 · 运行时无关传输端口

**来源**：`opencode/packages/opencode/src/server/adapter.ts`（+ `adapter.node.ts`、`adapter.bun.ts`）
**构造**：

```ts
export interface Runtime {
  upgradeWebSocket: UpgradeWebSocket;
  listen(opts: { port: number; hostname: string }): Promise<Listener>;
}
export interface Adapter { create(app: Hono): Runtime; }
```

**借鉴**：把"绑定 + 监听 + 升级 WS"抽象成 20 行的端口，一个 `app` 配多个运行时实现（Node/Bun）。加 WebSocket、换运行时都不动 handler。

**映射 ohbaby**：路线 A 把 `server.ts` 里裸 `http.createServer`/`listen` 抽成 `runtime/adapter.ts` 端口 + `node-adapter.ts` 实现；HTTP handler 与传输实现解耦（治 S6）。

---

## R5 · 事件投影 seam

**来源**：`opencode/packages/opencode/src/server/projectors.ts`（配合 `server/event.ts`）
**借鉴**：服务端发布**协议中性的领域事件**，每个消费面把它**投影**成自己的形状。这样同一份事件流可同时喂 CLI(UiEvent)、ACP(SessionUpdate)、A2A(TaskStatusUpdate)，互不耦合。

**映射 ohbaby**：路线 A 在 event-bus 与协议适配器之间放一个 `events/projectors.ts`。**关键的 YAGNI 守则**：现在只建 seam，web/jsonrpc 的投影写成恒等映射；ACP/A2A 投影器等需求来再填。留缝不建管（治 S5）。

---

## R6 · LAN 服务发现（mDNS）

**来源**：`opencode/packages/opencode/src/server/mdns.ts`
**构造**：`publish(port, domain?)`，基于 `bonjour-service`，类型 `http`，名 `opencode-${port}`。

**借鉴**：同网段 app/web 经 mDNS 自动发现 daemon，免硬编码 IP。

**映射 ohbaby**：**纯 YAGNI 抽屉**——仅当远程 app 成为真实需求时，在路线 A 的 `lifecycle/` 加一个 mdns publish（治 S3 的发现部分；网络绑定/TLS 另算）。

---

## R7 · ACP 薄适配层

**来源**：
- `opencode/packages/opencode/src/acp/agent.ts`（+ `session.ts`、`types.ts`）—— 基于 `@agentclientprotocol/sdk`，把 ACP `newSession/prompt/permission/cancel` 翻译成核心 SDK 调用。
- `claude-code/src/services/acp/`：`agent.ts`、`bridge.ts`、`entry.ts`、`permissions.ts`、`promptConversion.ts`、`utils.ts`（共 6 文件 + 测试）。

**借鉴**：ACP 是**纯翻译层**，不碰核心 session 逻辑。claude 用 6 文件、opencode 3 文件即完成。`bridge.ts`（内部消息↔ACP SessionUpdate）、`permissions.ts`（ACP permission↔内部 pipeline）是关键翻译件。

**映射 ohbaby**：路线 A 的 `protocols/acp/` 空抽屉。需求来时按此结构做薄适配，挂在 `CoreApiHost` 上，核心零改。

---

## R8 · A2A task 协议

**来源**：`gemini-cli/packages/a2a-server/src/agent/executor.ts`（`class TaskWrapper`、`CoderAgentExecutor`）+ `agent/task.ts`（Task 生命周期）+ `http/app.ts`/`http/server.ts`（HTTP 入口）。
**构造**：基于 `@a2a-js/sdk/server` 的 `AgentExecutor` + `TaskStore` + `ExecutionEventBus`。

**借鉴**：A2A 是**面向机器的 task 协议**——别的 agent 委派任务给你，有 Task 状态机、持久化（`persistence/gcs.ts`）、异步事件总线。与面向人的 UI 协议是**不同的轴**。

**映射 ohbaby**：路线 A 的 `protocols/a2a/` 空抽屉。仅当 ohbaby 要成为多 agent 系统里被调度的一员时再建。

---

## R9 · 多前端审批队列

**来源**：`kimi-code/apps/kimi-code/src/tui/reverse-rpc/approval/controller.ts`（+ `base-controller.ts`、`modal-coordinator.ts`、`question/controller.ts`）。
**借鉴**：多前端并发时审批请求**排队、逐个展示、可被任一前端接管**。比 ohbaby 当前 permission-router 的"发起方独占"更进一步——发起方断线时请求进待决队列，任一前端重连可接管。

**映射 ohbaby**：路线 A 协调层增强 `permission-router`：断连时审批进待决队列（治 S9 的审批侧 + 多前端健壮性）。

---

## R10 · 客户端多传输抽象

**来源**：`claude-code/src/cli/transports/`：`Transport.ts`（接口）、`SSETransport.ts`、`WebSocketTransport.ts`、`HybridTransport.ts`、`SerialBatchEventUploader.ts`。
**借鉴**：客户端把"传输"抽象成接口，SSE/WS/Hybrid 可换；`HybridTransport` 在 SSE 与 WS 间择优/降级。

**映射 ohbaby**：路线 A 客户端 `client.ts` 把 SSE 读循环抽成 `Transport` 接口，为将来 WS（双向、浏览器友好）留口；当前 SSE 实现是第一个 Transport。

---

## 引用形式说明

以上路径均相对各参考项目根目录，构造名为各项目源码中的真实类/函数/常量名，可直接定位。片段为说明性截取，非逐字全文。优先级最高的五条（先看）：R1、R2、R3、R4、R5。
