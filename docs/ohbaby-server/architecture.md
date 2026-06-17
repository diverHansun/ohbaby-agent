# ohbaby-server · architecture（架构设计）

> 前置：[`goals-duty.md`](./goals-duty.md) 已确认。本文每一项结构都可追溯到其中的 Design Goal / Duty，不引入新职责。
>
> 本文描述的是**当前合理结构**，不是终态。结构可随真实需求演进。

---

## 1. Architecture Overview（总体架构）

`ohbaby-server` 采用**端口-适配器（六边形）**风格。这不是为了形式，而是 G1（关注点分离）与 G3（协议中性）的直接产物：中心是领域核心（agent 暴露的 backend），外圈是可插拔的协议适配器，**核心永远看不见适配器**。

```
        前端                适配器层(protocols/)          核心契约
   ┌──────────┐
   │ CLI/attach├──► jsonrpc 适配器 ─┐
   └──────────┘                     │
   ┌──────────┐                     ├─► coordination ─► CoreApiHost ─► agent backend
   │ browser   ├──► web 适配器 ──────┘   排队/审批/        (sdk 契约)   (createPersistent
   │ (web UI)  │     REST + SSE        事件分发+replay                  UiBackendClient)
   └──────────┘
   横切: auth(token / CORS) 作为 Hono 中间件包在所有路由外侧
   装配: transport 用 Hono 把 适配器路由 + 中间件 组装成一个 HTTP server
   生命周期: lifecycle/foreground 启动这一整套; detached 是降级抽屉
```

子组件职责：

| 子组件 | 职责 | 追溯 |
|--------|------|------|
| **transport** | 用 Hono 装配 HTTP server：挂载各协议路由、套中间件、绑定监听 | D1 |
| **protocols/jsonrpc** | jsonrpc 信封解析 + RPC handler + remote client（供 CLI/attach/测试） | D2, D5 |
| **protocols/web** | 浏览器用 REST + SSE 路由 | D2 |
| **coordination** | 单写者协调：prompt-queue、permission-router、event-bus（seqNum + 环形缓冲 + replay） | D3 |
| **auth** | Hono 中间件：token（fail-closed）、CORS（origin 白名单） | D4 |
| **lifecycle** | foreground 启动/停止（主路径）；detached 降级抽屉 | D6, N6 |

依赖方向恒为 `protocols → coordination → CoreApiHost(sdk 契约)`，无环（G5）。`ohbaby-server` 只依赖 `ohbaby-agent` 拿 `createPersistentUiBackendClient` + `ohbaby-sdk` 契约类型；`ohbaby-agent` 不反向依赖 `ohbaby-server`。

---

## 2. Design Pattern & Rationale（设计模式与理由）

### 采用：端口-适配器（Hexagonal / Ports & Adapters）

- **解决什么**：让一个 backend 同时服务多种协议（jsonrpc/web/未来 ACP/A2A），且新增协议时核心零改动。
- **如何支持目标**：直接落实 G3（协议中性）与 G1（关注点分离）。每个 `protocols/*` 是一个 inbound 适配器，统一架在 `CoreApiHost` 契约上；契约就是"端口"。

### 采用：Hono 作为传输/路由层

- **解决什么**：当前手写 Node http + 内联 `if (pathname===...)` 路由不是端口、难扩展（S6）。web 引入后路由与中间件（CORS/auth）显著增多。
- **如何支持目标**：Hono 提供声明式路由 + 中间件管线，让 D2（多协议路由）、D4（auth/CORS 中间件）干净落地。**更关键——Hono 是"重协议依赖只进本包"的第一个实证**，让 G2（依赖隔离）从假设变事实（文档 04 触发点 A）。
- **代价**：需把现有 `server.ts` 的路由部分重写为 Hono handler；新增一个运行时依赖（`hono` + `@hono/node-server`）。

### 采用：Ring Buffer + 单调序号（event-bus）

- **解决什么**：S1——SSE 断线即丢事件，web 刷新/弱网会让前后端状态发散（正确性问题）。
- **如何支持目标**：D3。事件带 `seqNum`、缓冲在环形 buffer，客户端用 `Last-Event-ID` 重连补发。

### 刻意不采用：领域事件投影层（Projector）

- 采纳 A2：UiEvent 直发 + replay。CLI 与 web 共用 `UiEvent` 无痛点，提前抽象"领域事件→各协议形状"是为想象的未来付费（YAGNI / N5）。ACP/A2A 接入时再补，那是它们各自的回头改一次成本。

### 刻意不采用：进程 supervisor 作为默认稳定性手段

- detached supervisor/pid/state 只服务"后台常驻 server"，而 ohbaby 是即开即关的 coding CLI（N6）。foreground 靠终端管生命周期，不需要监工。

---

## 3. Module Structure & File Layout（模块结构与文件组织）

> 下面是抽包阶段的结构。**`server.ts`→Hono 的具体装配、web REST+SSE surface、多项目 runtime 的细化布局见 [`hono-app/01`](./hono-app/01-app-assembly-and-transport.md) 与 [`hono-app/02`](./hono-app/02-web-api-surface.md)、[`hono-app/04`](./hono-app/04-multi-project-runtime.md)**——当前包仍是保守迁移后的手写 http，尚未落 Hono。

```
packages/ohbaby-server/src/
├── index.ts                  对外窄导出面：startServer + remote client + 必要类型
│
├── transport/
│   ├── app.ts                组 Hono app：挂路由 + 套中间件
│   └── node-server.ts        @hono/node-server 绑定监听 + 优雅关闭
│
├── protocols/
│   ├── jsonrpc/
│   │   ├── protocol.ts       (从 daemon/protocol.ts 移) 信封 + 校验
│   │   ├── rpc-handler.ts    (由 daemon/server.ts 拆) /api/rpc 处理
│   │   └── client.ts         (从 daemon/client.ts 移) remote UiBackendClient
│   └── web/
│       └── routes.ts         (新) 浏览器 REST + SSE 路由
│
├── coordination/
│   ├── prompt-queue.ts       (从 daemon 移；顺修 S8 fresh-lane)
│   ├── permission-router.ts  (从 daemon 移；顺修 S9 断连待决)
│   └── event-bus.ts          (新) seqNum + 环形缓冲 + replay (S1)
│
├── auth/
│   ├── token.ts              (从 daemon/auth.ts 移) fail-closed + 常量时间比较 (S4)
│   └── cors.ts               (新) origin 白名单中间件 (S2)
│
└── lifecycle/
    ├── foreground.ts         (主路径) 前台启动/Ctrl+C 停止
    ├── server-main.ts        (从 daemon/main.ts 拆) server 装配组合根
    └── detached/             (降级抽屉，N6) supervisor / pid-file / state-file / spawn
```

- **对外稳定接口**：仅 `index.ts`（`startServer` + remote client）。其余为内部实现。
- **命名体现角色**：`transport` / `protocols` / `coordination` / `auth` / `lifecycle` 是职责名，不是技术名。
- **协议 seam（不建空目录）**：未来 ACP/A2A 各为 `protocols/` 下新增一个兄弟目录，架在同一 `CoreApiHost` 上即可。本期不建空壳（N4/YAGNI），仅在此记录扩展位。
- **不迁入**：`daemon/bootstrap.ts`、`daemon/app-events.ts` 先审计（S7），废弃则删。`host/core-api-factory.ts` 留在 `ohbaby-agent`（N2）。

---

## 4. Architectural Constraints & Trade-offs（约束与权衡）

| 决策 | 放弃的方案 | 当前方案的代价 |
|------|-----------|---------------|
| 引入 Hono | 保留手写 Node http（零新依赖） | 新增运行时依赖 + 重写路由；换来中间件管线与 G2 实证 |
| A2（UiEvent 直发 + replay） | A1（现在抽领域事件投影层） | ACP/A2A 接入时要回头补投影一次；换来当前不为想象未来付费 |
| foreground 主路径、detached 降级 | 把 detached 当一等能力一起做 | 后台常驻能力暂不打磨；换来避开 daemon 最复杂、bug 最多的部分 |
| `core-api-factory` 留在 agent | 随 04 移入 server/host | server 不掌管"选 local/remote"；换来默认 CLI 彻底不依赖 server 包 |
| 端口-适配器分层 | 单文件按 if 分发（现状） | 多几个目录/文件；换来新增协议时核心零改动 |
| 窄导出面（只 `index.ts`） | 直接导出深路径 | 需维护一层 re-export；换来调用方不耦合内部结构 |

### 后续维护者须知（为什么不能随意改）

- **不要让 `ohbaby-agent` 反向 import 本包**：依赖方向是 server → agent。迁移后由 `ohbaby-cli` 命令层选择 local/remote：local 调 agent，remote/serve 调 server。
- **不要把 detached 提升为默认路径**：它是 N6 抽屉，提升前需要重新评估"ohbaby 是否要变成常驻服务"。
- **新增协议走 `protocols/` 新目录**，不要往 jsonrpc/web 里塞——那会让适配器互相耦合（回退到 S6）。
- **event-bus 的 seqNum 是 web 正确性依赖**，不是优化项，不可为省事去掉。

---

## 自检

- 每个子组件都能说出存在理由？✅ 见 §1 表与追溯列。
- 是否有无法追溯到 goals-duty 的结构？无——已删除 04 中的 `host/`、`events/projectors`、空抽屉。
- 是否有为"优雅"增加的复杂性？已规避：不建空目录、不抽投影层、不做 detached 打磨。
