# 00 · 范围、delta 与核心决策

> 本文做三件事：(1) 钉死当前包的**真实状态**与本阶段的 **delta 清单**；(2) 记录本阶段最重的**架构决策 ADR**（默认 CLI 走直连）；(3) 列出对父目录文档的**指针更新**，让冲突处不留暗坑。
>
> 前置：[`README.md`](./README.md)、父目录 [`../goals-duty.md`](../goals-duty.md)。

---

## 1. 当前包真实状态（基线）

> 本节记录进入 Hono 迁移前的历史基线，不是 2026-07-11 的当前实现清单；当前实施状态见本目录 README 顶部。

`packages/ohbaby-server/src`：

```
auth/token.ts                       fail-closed token（已迁，已具备）
coordination/prompt-queue.ts        全局 FIFO（已迁；S8 fresh-lane 未修）
coordination/permission-router.ts   审批归属（已迁；S9 断连待决未补）
protocols/jsonrpc/protocol.ts       jsonrpc 信封 + 校验（已迁）
protocols/jsonrpc/client.ts         remote UiBackendClient（已迁，固定 baseUrl）
runtime/daemon/server.ts            ⚠️ 手写 Node http：/api/health /api/rpc /api/events /api/shutdown
runtime/daemon/{main,supervisor,state-file,pid-file,errors,types}.ts   foreground/detached lifecycle（已迁）
index.ts                            窄导出面（daemon 风味命名）
```

关键事实：
- `server.ts` 仍是**手写 http + 内联 `if (pathname===...)` 路由**，且**无 SSE replay**（无 seqNum/缓冲，确认 S1）。
- `server.ts` 内**已经承载了大量 per-client 视图逻辑**（`snapshotForClient`、`routeEventForClient`、`activeSessionId` 跟踪、command/permission 归属）——这是多客户端协调，不是传输细节。本阶段要把它**提取为 coordination 的具名单元**（见 [`05`](./05-consumption-path-unification.md)）。
- `hono` / `@hono/node-server` / `@hono/zod-openapi` / `zod` **尚未**是依赖。
- 默认 CLI 已走 in-process 直连 backend（C1 已合并），`ohbaby --remote-port` 走 `protocols/jsonrpc/client.ts`。

---

## 2. Delta 清单（本阶段要改什么）

| # | Delta | 解决 | 落点文档 |
|---|------|------|---------|
| Δ1 | `server.ts` 手写 http → **Hono app**（`app/create-app.ts`），路由声明式、中间件管线化 | S6 | [`01`](./01-app-assembly-and-transport.md) |
| Δ2 | app 暴露**可注入 `fetch`**：web/app + 测试 harness 不开端口即可调；`serve` 才 `listen`（`@hono/node-server`） | 统一传输 | [`01`](./01-app-assembly-and-transport.md) |
| Δ3 | 新增 **web REST + SSE** 路由组（浏览器/app 友好） | D2 | [`02`](./02-web-api-surface.md) |
| Δ4 | 路由用 **zod schema**，经 `@hono/zod-openapi` 出 `/doc` OpenAPI → web/app typed client | web/app 合约 | [`02`](./02-web-api-surface.md) |
| Δ5 | 新增 **event-bus**：seqNum + 环形缓冲 + replay；SSE 支持 `Last-Event-ID` | S1 | [`03`](./03-event-replay.md) |
| Δ6 | token middleware fail-closed 化 + **CORS** middleware（origin 白名单，scope 到 web 路由） | S4 / S2 | [`01`](./01-app-assembly-and-transport.md) |
| Δ7 | 新增 **InstanceStore（git-root scope）+ 用户级 pid/state + fail-closed `x-ohbaby-directory` 路由 + 全局面板 + `serve ps`**；Phase 1 已完整落地并通过发布门 | 反多后端 | [`04`](./04-multi-project-runtime.md) |
| Δ8 | 把 `server.ts` 的 per-client 视图逻辑**提取到 `coordination/client-view`**，jsonrpc 与 web adapter 共用；建**跨 transport 契约测试** | 消费路径统一 | [`05`](./05-consumption-path-unification.md) |
| Δ9 | jsonrpc `/api/rpc` + 旧 SSE **降为兼容路由**，挂在同一 Hono app 上 | 平滑过渡 | [`01`](./01-app-assembly-and-transport.md) |
| Δ10 | 顺手修 S8（fresh-lane 串行）、S9（disconnectClient 待决队列） | backlog 兑现 | [`04`](./04-multi-project-runtime.md) |

**明确不在本阶段**（延续父目录 N4/N6/N5）：LAN/mDNS/TLS/多用户、detached 后台常驻打磨、领域事件投影层（projector 仍恒等）。

---

## 3. 核心架构决策（ADR）

### ADR-001：默认 CLI 走直连 backend，不经过 Hono app

**背景 / 触发信号**
- web/app 要进开发，需要一个 Hono app 承载 REST+SSE。随之产生一个岔路：默认交互式 `ohbaby` 该不该也走这同一个 app（opencode 式 injected `app.fetch`），还是维持直连 `createPersistentUiBackendClient`（父目录 N2）。
- 这是个会影响系统形态、且**难以低成本回退**的决策（牵动默认路径的依赖图与失败面），必须显式定夺，不能既成事实。
- 参考复核：opencode `run` 走 `app.fetch`；claude-code 默认 REPL 直连、server 独立；kimi 默认 in-process、server 独立。

**决策**
- **默认 `ohbaby` / `ohbaby run` 维持直连**：UI 层直接消费 `ohbaby-agent` 的 `UiBackendClient`，**不 import Hono、不经过本包**。
- Hono app 只服务三类消费者：`ohbaby serve`（`listen`）、web/app（HTTP）、**测试 harness（`app.fetch` 注入，不开端口）**。

**理由（按质量属性裁决）**
1. 默认交互 CLI 的主导属性是**故障隔离/可预测性**与**低延迟流式**——这正是 `docs/problem-lists/server` 路线 C 的立命之本。直连让默认路径**不可能**出 `fetch failed`/CORS/auth/SSE-replay-gap，失败语义=本进程抛错。
2. 高频 token 事件走原生 in-process callback，**零序列化税**；走 `app.fetch` 会让每个事件过 Request→handler→Response + SSE encode/decode，纯 CPU/GC 开销换不来网络收益。
3. 默认路径是单人单进程，**永远不会「涨 100 倍」**；用「统一协议面好扩展」去优化它，是解一个它没有的问题。100x 故事属于 `serve`（web/app/多客户端）。
4. 守住 N2，依赖隔离落到二进制级：`ohbaby-agent` + CLI 不引 hono 即可驱动会话。

**取舍 / 已知代价**
- 存在**两条消费路径**（直连 / 经 Hono app）。代价是**行为漂移风险**。
- **缓解（本阶段强制新增步骤，见 [`05`](./05-consumption-path-unification.md)）**：不靠「逼全部走 HTTP」消漂移，而在**契约层**消——唯一事实源是 `CoreApiHost`/`UiBackendClient`；per-client 视图逻辑提取为共享 coordination 单元；web 路由是纯 adapter（零业务逻辑）；建**跨 transport 参数化契约测试**（direct vs `app.fetch`）断言单客户端行为等价。`app.fetch` 用在**测试里**验证两路一致，而非放到运行时热路径。

**何时回头重看（失效条件）**
- 若默认 CLI 要变成**可被 attach 的常驻/多客户端**（即 N6 被推翻）——届时统一协议面的价值压过隔离，应改走 injected `app.fetch`。
- 或契约测试反复抓到 direct↔hono 漂移、且 adapter 纯化压不住——说明 seam 选错，需收敛到单面。

> 落库：本 ADR 即仓库内决策记录。若后续 ohbaby 建立 `docs/adr/` 习惯，可平移过去并在此留指针。

---

## 4. 对父目录文档的指针更新（避免冲突暗坑）

这些更新在 [`06`](./06-migration-and-tests.md) 的文档步骤里执行，列在此处供审阅追溯：

| 父目录文档 | 现状 | 本阶段更新 |
|------|------|-----------|
| [`../non-functional.md`](../non-functional.md) §4 | 「OpenAPI / 协议文档自动化——未到投资点」列为暂缓 | **改为已激活**：web/app typed client 是真实需求（Δ4），并加指针到 `hono-app/02` |
| [`../goals-duty.md`](../goals-duty.md) G5 | 「后面只有一个 backend」（全局表述） | **细化**：serve 内「每 workspace scope 一个 backend/runtime」；TUI+serve 是合法 SQLite 多写进程，同 session 靠 claim；依赖方向仍无环。加指针到 `hono-app/04` |
| [`../data-model.md`](../data-model.md) | 概念词典无多项目概念 | **新增**：`WorkspaceInstance`、`ServerRegistry`（指针到 `hono-app/04`） |
| [`../architecture.md`](../architecture.md) §3 文件布局 | 抽象描述 `transport/app.ts` 等 | 加前向指针：「具体装配与 web surface 见 `hono-app/01`、`hono-app/02`」 |
| [`../README.md`](../README.md) 导航 | 无 hono-app 入口 | 导航表加一行指向 `hono-app/` |
| [`../migration-sequence.md`](../migration-sequence.md) §6 | 注记「后续 web/app 适配时再拆」 | 加指针：「该适配的设计与步骤见 `hono-app/06`」 |

---

## 自检

- delta 清单每项都有落点文档？✅ §2。
- 最重决策有 ADR（背景/决策/取舍/失效条件）？✅ §3。
- 与父目录的冲突是否显式化而非暗改？✅ §4。
