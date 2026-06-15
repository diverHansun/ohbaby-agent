# 04 · 路线 A：抽 `ohbaby-server` 新包（完整方案）

> **2026-06-15 状态更新**：路线 A 仍是长期目标，但不建议短期立即执行。当前短期推荐先看 [`07-route-c-cli-inprocess-explicit-server.md`](./07-route-c-cli-inprocess-explicit-server.md)：默认 CLI 回到 in-process，`ohbaby serve`/未来 `ohbaby-server` 作为显式能力。路线 A 应在 web/app、ACP/A2A 或重协议依赖成为真实需求后再启动。

> **文档职责**：一次到位的架构方案——把传输/协议/协调从 `ohbaby-agent` 抽成独立包，承载 web / 未来 app / ACP / A2A。给出架构改动、文件迁移清单、sdk/agent 调整、借鉴点引用、触发条件与风险。
> **配套**：现状 `01`，目标 `02`，借鉴 `03`。**这是终态参考，不是必须现在执行——触发条件见第六节。**

---

## 一、命名与定位

不叫 "gateway"：网关本义是"前面一个入口、后面 N 个服务做路由聚合"，而 ohbaby 是**单写者、一个 backend**，后面没有要聚合的多服务。准确叫法是 **`ohbaby-server`**（暴露唯一 backend 给多前端）。

正当性（拆包的三条 SWE 依据）：
- **独立职责**：传输/协议网关，与领域核心是两个变化原因。
- **独立演进**：协议（web/ACP/A2A）随生态变，领域随业务变。
- **依赖隔离**（最硬）：Hono、`@agentclientprotocol/sdk`、`@a2a-js/sdk` 等重协议依赖**不进** `ohbaby-agent`。这一条只有在真的引入这些依赖时才成立——见触发点。

---

## 二、目标依赖图

```
ohbaby-cli ─┐
ohbaby-web ─┼─► ohbaby-server ──► ohbaby-agent ──► ohbaby-sdk
(future app)┘   传输/协议/协调      领域核心          纯契约(seam)

不变量：protocols → coordination → CoreApiHost(sdk 契约)；核心永远看不见适配器。无环。
```

`ohbaby-server` 依赖 `ohbaby-agent` 仅为拿 `createPersistentUiBackendClient`（被驱动的 backend 工厂）+ `ohbaby-sdk` 契约。

---

## 三、新包内部分层

```
packages/ohbaby-server/src/
├── coordination/     单写者协调核心
│   ├── prompt-queue.ts        (从 daemon 移)  全局 FIFO
│   ├── permission-router.ts   (从 daemon 移)  审批归属
│   └── event-bus.ts           (新)  seqNum + 环形缓冲 + 重放   ← R1
├── runtime/          传输端口
│   ├── adapter.ts             (新)  Runtime/Adapter 端口        ← R4
│   └── node-adapter.ts        (新)  由 server.ts 的 http 部分重构
├── auth/             横切中间件
│   ├── token.ts               (从 daemon/auth.ts 移)
│   ├── cors.ts                (新)  origin 白名单               ← R3
│   └── ws-protocol.ts         (新)  Sec-WebSocket-Protocol token ← R2
├── events/
│   └── projectors.ts          (新)  领域事件→协议形状，先恒等   ← R5
├── protocols/        协议适配器（都在 CoreApiHost 上）
│   ├── jsonrpc/               protocol.ts(移) rpc-handler(由 server.ts 拆) client.ts(移)
│   ├── web/                   (新)  REST + SSE for browser
│   ├── acp/                   (空抽屉，需求驱动)                ← R7
│   └── a2a/                   (空抽屉，需求驱动)                ← R8
├── lifecycle/        进程生命周期
│   ├── supervisor.ts state-file.ts pid-file.ts spawn.ts  (从 daemon 移)
│   ├── main.ts                (从 daemon 移)  组合根
│   └── mdns.ts                (空抽屉，远程 app 才建)           ← R6
└── host/
    └── core-api-factory.ts    (从 agent/host 移)  客户端模式选择
```

---

## 四、文件迁移清单（`runtime/daemon/` + factory → `ohbaby-server`）

| 现位置 | 去向 | 动作 |
|--------|------|------|
| `daemon/prompt-queue.ts` | `coordination/` | 移动（顺手修 S8 fresh-lane） |
| `daemon/permission-router.ts` | `coordination/` | 移动（顺手加 S9 断连待决队列，R9） |
| `daemon/protocol.ts` | `protocols/jsonrpc/` | 移动 |
| `daemon/server.ts` | 拆：`runtime/node-adapter.ts` + `protocols/jsonrpc/rpc-handler.ts` + `protocols/web/` | 拆分 |
| `daemon/client.ts` | `protocols/jsonrpc/client.ts` | 移动（抽 `Transport` 接口，R10） |
| `daemon/auth.ts` | `auth/token.ts` | 移动 + fail-closed（R2） |
| `daemon/{supervisor,state-file,pid-file,spawn,main}.ts` | `lifecycle/` | 移动 |
| `daemon/{types,errors,index}.ts` | 随层拆分 | 移动 |
| `daemon/bootstrap.ts` `daemon/app-events.ts` | —— | **先审计（S7），废弃则删，不盲目搬** |
| `host/core-api-factory.ts` | `ohbaby-server/host/` | 移动（依赖 agent 做 in-process 兜底） |
| **新增** | `coordination/event-bus.ts`、`auth/cors.ts`、`auth/ws-protocol.ts`、`runtime/adapter.ts`、`events/projectors.ts`、`protocols/web/*` | 新建 |

迁移后 **`ohbaby-agent` 不再含任何 http/传输/协议代码**。

---

## 五、`ohbaby-sdk` / `ohbaby-agent` 调整

### ohbaby-sdk（保持最小，+2）
- ➕ **连接状态契约**：`ConnectionState`（connected/reconnecting/closed）+ 可选 `UiBackendClient.subscribeConnection` —— 远程重连让前端可感知（S1 配套）。
- ➕（可选）把 `DaemonStartupIntent`（resume/continue/permission）从 `daemon/protocol.ts` 提到 sdk —— 协议中性的启动意图。
- ❌ 不加 seqNum 信封、wire 格式、CORS（都是 server 实现细节）。

### ohbaby-agent（做减法 + 收口）
- ➖ 移出整个 `runtime/daemon/`（除待审计的 bootstrap/app-events）+ `host/core-api-factory.ts`。
- ✅ 保留 persistent backend、`ui-*` 适配器、services、backend-lease、`package-version.ts`。
- ➕ **窄公共导出面**（`index.ts`）：只暴露 `createPersistentUiBackendClient` + re-export sdk 契约类型，让 server 依赖稳定工厂而非深路径。

---

## 六、事件层取舍（路线 A 的待定决策）

| 方案 | 内容 | 代价 |
|------|------|------|
| **A1 现在抽领域事件 + 投影 seam** | event-bus 发协议中性领域事件，jsonrpc/web 投影器写恒等，ACP/A2A 将来零摩擦 | 一次性改事件发布路径 |
| **A2（推荐默认）保持 UiEvent 直发 + 留 TODO 缝** | 先覆盖 CLI+web；ACP/A2A 接入时再补投影层 | 那次接入回头改一次 |

倾向 **A2**：当前 CLI+web 共用 `UiEvent` 无痛点，提前抽象领域事件是"为想象中的未来付费"（YAGNI）。除非确认 ACP/A2A 近期上，再选 A1。

---

## 七、何时该执行路线 A（触发条件）

路线 A 不是现在做，是**等它赚到**：

- **触发点 A**：引入第一个**重协议 SDK**（为路由人体工学上 Hono，或上 `@agentclientprotocol/sdk` 做 ACP）。此刻"别让协议依赖污染领域包"从假设变事实。
- **触发点 B**：**第二个协议适配器**成为真需求（web 之外又来 ACP/A2A）。此刻 `protocols/` 才有两个真实成员，分层才有意义。
- **触发点 C**：**远程 app** 立项（需 mdns + 网络绑定 + TLS + 多用户）。

触发前，路线 B 的就地改动已足够支撑本机 web，且其产物（event-bus/cors/auth）在路线 A 中原样复用——**B 是 A 的子集，不浪费**。

---

## 八、风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 大迁移 | ~16 文件跨包移动 + import 重写 | 独立分支；按层分批 commit；每批跑全量门 |
| Windows 深路径 | 见 `.worktrees` 删除曾因 "Filename too long" 失败 | 迁移用 `git mv`，不手工拷贝 node_modules |
| 测试面广 | daemon/server/client 集成测试需跟随迁移 | contract 测试套件先参数化（terminal-daemon Phase 4 遗留项），保证迁移前后行为一致 |
| 过度设计 | `protocols/{acp,a2a}`、`mdns`、`adapter` 端口当前是空/投机 | **空抽屉只留目录约定，不写空实现**；长到匹配真实需求 |

---

## 九、与路线 B 的关系

路线 A 的 `coordination/event-bus.ts`、`auth/cors.ts`、fail-closed 收紧，与路线 B 就地新增的是**同一批代码**，只是落点不同（A 在新包、B 在 `runtime/daemon/`）。因此可以：**先按路线 B 就地落地这三件 → 本机 web 跑通 → 触发点到来时，把它们随 daemon/ 一起迁进 `ohbaby-server`**。无返工。
