# 01 · 代码现状与问题分析

> **文档职责**：罗列 Phase-4 后 `runtime/daemon/` 通信层的真实结构，并逐一定位面向 web/app 适配的缺口，精确到文件与行号。不涉及解决方案（方案见 04/05）。
> **基线**：`mvp`，HEAD `044333f1`。

---

## 一、当前通信层结构（逐文件）

所有传输代码目前集中在 `packages/ohbaby-agent/src/runtime/daemon/`：

| 文件 | 职责 | 关注层 |
|------|------|--------|
| `server.ts` | 手写 Node `http` 服务：`/api/health`、`/api/rpc`、`/api/events`、`/api/shutdown` 路由 + SSE 广播 | 传输 + 协议 |
| `client.ts` | remote `UiBackendClient`：RPC 经 `POST /api/rpc`，事件经 SSE fetch loop | 传输（客户端） |
| `protocol.ts` | `DaemonRpcRequest`/`DaemonRpcResponse`/`DaemonSseEvent` 信封 + 校验 | 协议（json-rpc wire） |
| `auth.ts` | bearer token 创建/校验/脱敏 | 鉴权 |
| `permission-router.ts` | per-client 审批归属（按 session→client 映射） | 协调 |
| `prompt-queue.ts` | daemon 全局 FIFO（per-session lane） | 协调 |
| `spawn.ts` | 客户端侧发现/版本握手/拉起 daemon | 生命周期 |
| `supervisor.ts` | 进程生命周期：PID 锁、状态文件、信号、空闲自退 | 生命周期 |
| `state-file.ts` | `daemon-state.json` 读写（连接元数据 + 版本 + token） | 生命周期 |
| `pid-file.ts` | 跨平台 PID 文件锁 | 生命周期 |
| `main.ts` | `startDaemonServer` 组合根（persistent backend + http server + Supervisor） | 组合根 |
| `types.ts` `errors.ts` `index.ts` | 类型/错误/导出 | 杂项 |
| `bootstrap.ts` `app-events.ts` | `bootstrapRuntime` 组装 / Bus→StreamBridge 投影 | ⚠️ 见 S7 |

客户端选择入口在 `packages/ohbaby-agent/src/host/core-api-factory.ts`（`buildCoreAPIImpl`）：根据选项在 in-process / 显式 remote / auto-spawn daemon 三种模式间选择。

### 当前通信栈（as-is）

```
CLI 终端 ──► createRemoteCoreApiHost (client.ts)
              │  RPC:  POST /api/rpc      (DaemonRpcRequest 信封)
              │  事件: GET  /api/events   (SSE, event: ui.event)
              ▼
          DaemonHttpServer (server.ts, 绑 127.0.0.1)
              ├─ auth: Bearer token (auth.ts)
              ├─ permission-router: 按 client 过滤审批事件
              ├─ prompt-queue: 全局 per-session FIFO
              └─ backend: 唯一 createPersistentUiBackendClient (单写者)
```

这套栈对 **多 CLI 终端** 已完整可用（`tests/integration/cli/daemon-global-fifo.integration.test.ts` 覆盖）。问题全部出在"换成浏览器/弱网/远程消费者"时。

---

## 二、面向 Web/App 的问题清单

### S1 · SSE 无重放，断线即丢事件 🔴 正确性

| 位置 | 现状 |
|------|------|
| `daemon/server.ts:546-574` `handleEvents()` | 只读 `clientId`，**不解析 `lastEventId`**；事件无序号、无缓冲 |
| `daemon/server.ts:584-592` `broadcast()` | 实时遍历当前连接直接 `writeSse`，过期即丢 |
| `daemon/client.ts:253-289` `runSseLoop`/`readSseFrames` | SSE 读循环 `done → return`，**无重连、无补发** |

CLI 在稳定本机长连接下无感。但浏览器刷新页面、移动端切后台/弱网抖动都会断开 SSE，**断开到重新订阅之间产生的所有事件永久丢失**，前端状态与后端 DivergE。这是 web/app 的硬伤，且是*正确性*而非体验问题。

### S2 · 无 CORS，浏览器跨 origin 被拦 🔴 阻断

`daemon/server.ts` 全文无任何 `access-control-*` 响应头，也无 `OPTIONS` 预检处理。本机 web UI 若从另一端口/origin（如 vite dev server :5173）访问 daemon（:4096），浏览器直接拦截。**本机 web 端的第一道墙。**

### S3 · 仅绑 `127.0.0.1`，无远程能力 🟡 范围

`daemon/server.ts:405` `this.server.listen(port, host)`，`host` 默认 `127.0.0.1`。同机浏览器可达，**别的设备/手机 app 不可达**。远程需网络绑定 + TLS + 真实鉴权，当前一概没有。（这是有意的 Phase-4 范围外，记录在案。）

### S4 · 单一共享 token + fail-open，无多用户 🟡 安全

| 位置 | 现状 |
|------|------|
| `daemon/auth.ts:17-18` | `if (!token) return true` —— token 未配置时**放行所有请求**（fail-open） |
| `daemon/auth.ts:20` | `authorization === daemonAuthHeader(token)` —— 字符串 `===`，非常量时间比较 |

生产 daemon 总是创建 token（`main.ts` `createDaemonAuthToken()`），所以 fail-open 当前不触发；但 defense-in-depth 应 fail-closed。单一共享 token = 单用户模型，多用户 web 需要 per-user authn/authz（本期不做，但要意识到天花板）。

### S5 · UiEvent 是 TUI 形状，无协议中性投影 🟡 演进

`daemon/server.ts:584` `broadcast(event: UiEvent)` 直接把 `ohbaby-sdk` 的 `UiEvent` 推给所有消费者。CLI 和 web 共用 `UiEvent` 没问题（web 是 TUI 等价 UI）。但 ACP 有自己的 `SessionUpdate`、A2A 有 `TaskStatusUpdate`——将来接它们时，适配器会被迫硬翻译 `UiEvent`，耦合到 TUI 视图模型。当前缺一个"领域事件→各协议形状"的投影 seam。

### S6 · 传输是手写 http + 内联路由，不是端口 🟡 结构

`daemon/server.ts` 用裸 Node `http` + `if (pathname === ...)` 内联路由（`:469`、`:474`）。加 WebSocket 或新协议路由意味着改这一个文件。没有"传输端口"抽象，传输实现与 handler 逻辑耦合。

### S7 · `bootstrap.ts` / `app-events.ts` 疑似废弃 🟢 清理债

`bootstrapRuntime`（`daemon/bootstrap.ts`）在生产路径**无任何调用**——`grep` 仅命中其自身、dist 产物与 `bootstrap.integration.test.ts`；`main.ts:90` 的 `bootstrap()` 是 Supervisor 回调，与之无关。`daemon/app-events.ts`（Bus→StreamBridge "app" scope 投影）同样未见生产引用。两者是 Phase 3 前遗留的"已实现未接入"模块，应在动通信层时一并审计：删除或明确用途。

### S8 · 全局队列 `__fresh__` lane 跨客户端过度串行 🟢 吞吐

`daemon/prompt-queue.ts:44-45` `laneForItem` 把所有无 sessionId 的 prompt 归入同一 `__fresh__` lane。两个不同客户端各自开新对话（互不冲突、建独立 session）会被串行化——第二个等第一个整个 run 跑完。正确但限制多前端吞吐。

### S9 · `disconnectClient` 是空 stub 🟢 资源

`daemon/prompt-queue.ts:79` `disconnectClient(_clientId): void { return undefined; }`。断连客户端**已排队但未启动**的 prompt 仍会执行、结果写进 DB 但无人消费。需确认是否有意（已接受的 prompt 不取消是设计，但排队中的要不要清需要决策）。

---

## 三、问题 × 路线对照

| # | 问题 | 严重性 | 路线 B（就地）解决? | 路线 A（新包）解决? |
|---|------|--------|------|------|
| S1 | SSE 无重放 | 🔴 正确性 | ✅ 核心 | ✅ |
| S2 | 无 CORS | 🔴 阻断 | ✅ 核心 | ✅ |
| S4 | 鉴权 fail-open | 🟡 安全 | ✅ 收紧 | ✅ |
| S5 | 无投影 seam | 🟡 演进 | ⏸️ 留 TODO 缝 | ✅ 建 seam |
| S6 | 传输非端口 | 🟡 结构 | ⏸️ 暂不动 | ✅ adapter 端口 |
| S3 | 仅本机绑定 | 🟡 范围 | ❌ 远程不做 | ⏸️ 远程仍需硬化 |
| S7 | 废弃模块 | 🟢 清理 | ✅ 顺手删 | ✅ 迁移时处理 |
| S8/S9 | 队列细节 | 🟢 优化 | 记 backlog | 记 backlog |

**结论**：本机 web 端真正缺的是 S1+S2（+S4 收紧），三者就地可加（路线 B）。S5/S6 是为 ACP/A2A/远程铺路的结构投资，属路线 A，需求驱动。
