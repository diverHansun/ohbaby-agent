# 05 · 路线 B：就地优化（最小可适配本机 web 端）

> **文档职责**：不新增包，在现有 `runtime/daemon/` 就地加最少的东西，让**本机浏览器 web 端**可接入。给出架构改动、逐文件调整、借鉴点引用。
> **配套**：现状 `01`，目标 `02`，借鉴 `03`；与新包路线对照见 `04`。

---

## 一、核心判断

本机 web 端真正缺的只有三件事（对应 S1/S2/S4），全部能加在现有 `runtime/daemon/` 里，**不动 `ohbaby-sdk`、不动 `ohbaby-agent` 领域代码、不抽包**：

1. **事件重放**（S1）—— 唯一的*正确性*缺口
2. **CORS**（S2）—— 浏览器跨 origin 的第一道墙
3. **鉴权 fail-closed**（S4）—— 安全收紧

`UiEvent` 不动（web 是 TUI 等价 UI，直接复用）。工作量约数天，纯增量、可回退。

---

## 二、改动 B1：事件重放（治 S1）

借鉴 **R1**（`claude-code/.../transport/event-bus.ts` 的 `EventBus` + seqNum + `MAX_EVENTS_PER_BUS` 环形缓冲）与 `kimi-code/apps/vis/server/src/lib/wire-replay.ts`。

### 架构

```
backend.subscribeEvents ──► event-bus(新)  给 UiEvent 套 { seq, event }，环形缓冲保留近 N 条
                                 │
          ┌──────────────────────┼─ broadcast: 实时推 { seq, event }
          └─ replay(lastSeq): 补发 (lastSeq, now] 区间
                                 ▼
          SSE 帧带 id: <seq>  ──► client 重连带 Last-Event-ID / ?lastEventId=
```

### 逐文件

| 文件 | 动作 |
|------|------|
| `runtime/daemon/event-bus.ts` | **新建**：`class DaemonEventBus`，`publish(UiEvent)→{seq,event}`、环形缓冲（建议 2000-5000）、`replay(afterSeq)`、`subscribe` |
| `runtime/daemon/server.ts` | `broadcast`（:584）改为经 event-bus 取 seq；SSE 写 `id: <seq>` 行；`handleEvents`（:546）解析 `?lastEventId=`/`Last-Event-ID` 头，先 `replay` 补发再转入实时 |
| `runtime/daemon/protocol.ts` | `DaemonSseEvent` 的 `ui.event` 变体加 `seq` 字段 |
| `runtime/daemon/client.ts` | `runSseLoop`（:253）记录最后 seq；断开后**重连**并带 last seq；`readSseFrames` 解析 `id:`；新增有界重试（指数退避） |
| `ohbaby-sdk`（可选） | `UiBackendClient` 加 `subscribeConnection`（connected/reconnecting）让 TUI/web 显示连接态 |

### 验收
- SSE 断开重连后，断开期间事件经 `lastEventId` 补回，无丢失、无重复。
- 缓冲溢出（超过 N 条）时明确降级：返回"需全量 `getSnapshot` 重建基线"信号，而非静默丢。

---

## 三、改动 B2：CORS（治 S2）

借鉴 **R3**（`claude-code/.../auth/cors.ts` 的 `webCorsOptions` 白名单 + 自动放行 localhost + `OPTIONS`）。

### 逐文件

| 文件 | 动作 |
|------|------|
| `runtime/daemon/cors.ts` | **新建**：`allowedOrigins()`（默认含 `http://localhost:*`、`http://127.0.0.1:*`，可经 env/选项追加 dev origin）、`resolveOrigin(origin)` |
| `runtime/daemon/server.ts` | `handleRequest` 入口：① 命中白名单则写 `Access-Control-Allow-Origin: <origin>`、`-Allow-Headers: Authorization,Content-Type`、`-Allow-Methods: GET,POST,OPTIONS`；② `OPTIONS` 预检直接 204 返回 |
| `runtime/daemon/main.ts` / `serve.ts` | 透传可配置的额外 origin（如 `--cors-origin`） |

### 要点
- **白名单而非 `*`**：带 Bearer 鉴权时 `*` 不安全。
- `credentials: false`（token 走 Authorization 头，不依赖 cookie）。

---

## 四、改动 B3：鉴权 fail-closed（治 S4）

借鉴 **R2**（`claude-code/.../auth/middleware.ts` 的默认拒绝姿态）。

### 逐文件

| 文件 | 动作 |
|------|------|
| `runtime/daemon/auth.ts` | `isAuthorizedDaemonRequest`（:17-18）**改 fail-closed**：token 未配置时拒绝（而非 `return true`）——daemon 生产路径总有 token，这只是 defense-in-depth；`:20` 的 `===` 换 `crypto.timingSafeEqual`（长度先比，避免抛错） |
| `runtime/daemon/server.ts` | `/api/events`（SSE）也走鉴权——当前 RPC 校验，需确认 SSE 同样校验（浏览器 SSE 能设 `Authorization` 头，故 Bearer 可用；若将来上 WS 再引入 R2 的 `Sec-WebSocket-Protocol` token） |

---

## 五、web 端如何消费（不需额外服务端协议）

做完 B1-B3，**现有 `/api/rpc` + `/api/events` 就是浏览器能直接说的协议**——浏览器 `fetch` 调 RPC、`EventSource`/`fetch`-stream 读 SSE。无需新建 REST 路由。

可选小增强（非必须）：给浏览器加 `GET /api/snapshot` 之类的便捷 REST 别名（内部转发 `getSnapshot`），但 `POST /api/rpc {method:"getSnapshot"}` 已够用。web 前端本体（vite 项目）是独立工作，不在本规划。

---

## 六、明确不做（推迟到路线 A 触发点）

| 项 | 为什么推迟 |
|----|-----------|
| 传输端口化 / WebSocket（R4/R10） | SSE 对本机 web 够用；WS 等双向需求或远程时再做 |
| 事件投影 seam（R5） | CLI+web 共用 UiEvent 无痛点；ACP/A2A 来时再抽（留 TODO 注释标位置即可） |
| mDNS / 网络绑定 / TLS（R6/S3） | 远程 app 才需要 |
| ACP / A2A（R7/R8） | 需求驱动 |
| 审批待决队列（R9/S9）、fresh-lane 拆分（S8） | 记 backlog，非 web 端阻塞项 |
| 抽 `ohbaby-server` 包 | 无重协议依赖前不抽（见 04 触发点） |

---

## 七、改动汇总

| 文件 | 类型 | 对应改动 |
|------|------|---------|
| `runtime/daemon/event-bus.ts` | 新建 | B1 |
| `runtime/daemon/cors.ts` | 新建 | B2 |
| `runtime/daemon/server.ts` | 修改 | B1+B2+B3（SSE seq/replay、CORS、SSE 鉴权） |
| `runtime/daemon/client.ts` | 修改 | B1（重连 + lastEventId） |
| `runtime/daemon/protocol.ts` | 修改 | B1（SSE 事件加 seq） |
| `runtime/daemon/auth.ts` | 修改 | B3（fail-closed + timingSafeEqual） |
| `runtime/daemon/main.ts`/`serve.ts` | 修改 | B2（透传 cors-origin） |
| `ohbaby-sdk/.../client.ts` | 可选 | B1（连接态契约） |

测试：`event-bus.unit.test.ts`（seq/环形/replay）、`server.integration.test.ts`（CORS 预检、lastEventId 补发、SSE 鉴权）、`client.integration.test.ts`（断线重连补事件）。

---

## 八、与路线 A 的衔接

B1-B3 产出的 `event-bus.ts`、`cors.ts`、fail-closed 的 `auth.ts`，正是路线 A 里 `coordination/event-bus.ts`、`auth/cors.ts`、`auth/token.ts` 的内容。**触发点到来时，随 `daemon/` 一起 `git mv` 进 `ohbaby-server`，零返工。** 因此路线 B 不是"临时方案"，是路线 A 的第一批砖。
