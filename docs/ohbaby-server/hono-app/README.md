# ohbaby-server · hono-app（web/app 适配阶段设计）

> 本目录是 `packages/ohbaby-server` 的**第二阶段**模块设计：把已抽出的手写 Node `http` server（`runtime/daemon/server.ts`）转换为 **Hono app**，并铺好 web/app 客户端所需的 REST + SSE surface、OpenAPI/SDK、SSE replay、多项目 runtime 与消费路径统一。
>
> 触发条件：`docs/problem-lists/server/04` 的「触发点 A」（引入第一个重协议依赖 Hono）已成立，且 web/app 端进入设计。

> **实施状态（2026-07-11）**：Hono app、REST/SSE、OpenAPI、用户级 pid/state、InstanceStore、fail-closed workspace 路由、全局面板 known/loaded/switch、真实双进程/双写发布门与 `serve ps` 均已落地。下文中的“当前包真实状态”“目标文件布局”保留为迁移设计基线，实际状态以本提示、[`04`](./04-multi-project-runtime.md) 和全局单 serve 文档为准。

---

## 这一阶段相对父目录是什么关系

`docs/ohbaby-server/`（父目录）已经确立了**模块的目标、职责、概念词典、数据流、质量优先级**，并已经**选定 Hono**（[`../architecture.md`](../architecture.md) §2）。但 [`../migration-sequence.md`](../migration-sequence.md) §6 明确记录：S2 是**保守迁移**——「保留现有 server 文件的内部结构，避免在包迁移同时做 HTTP/router 大拆分。**后续 web/app 适配时，再把该文件拆入 `transport/` 与 `protocols/`**」。

所以本目录最初面对的基线是：**包已抽出，但 `server.ts` 仍是手写 Node `http` + 单一 jsonrpc 信封。** 该迁移主体目前已经落地；本文集继续作为设计理由与剩余发布门的契约。

| 父目录文档 | 本阶段如何对待 |
|------|------|
| `goals-duty.md` | **复用**；G5「单写者」在多项目 runtime 下细化为「**每 workspace scope 一个 backend**」（见 `04`） |
| `architecture.md` | **复用 + 具体化**；端口-适配器 + Hono 的抽象结构在此落成具体装配（`01`） |
| `data-model.md` | **复用 + 扩展**；新增 `WorkspaceInstance` / `ServerRegistry` 概念（见 `04`） |
| `dfd-interface.md` | **复用**；流 A–D 不变，本阶段补足 web 形态的具体端点 |
| `non-functional.md` | **修订一处**：§4 暂缓的 OpenAPI 在本阶段**重新激活**（web/app typed client 已成真实需求） |
| `migration-sequence.md` | **续写**；本阶段是其 S2 注记中「后续 web/app 适配」的兑现 |

> 原则：父目录是仍然成立部分的**单一事实源**，本目录只写**新增/细化/修订**，不复制粘贴。凡与父目录冲突处，在 [`00-scope-and-deltas.md`](./00-scope-and-deltas.md) 显式列出并给出指针更新。

---

## 文档导航（按设计顺序）

| 文档 | 职责 |
|------|------|
| [`00-scope-and-deltas.md`](./00-scope-and-deltas.md) | 相对当前包状态的 delta 清单；**核心架构决策 ADR（默认 CLI 走直连）**；对父目录的指针更新 |
| [`01-app-assembly-and-transport.md`](./01-app-assembly-and-transport.md) | `create-app` 装配、中间件管线与次序、可注入 `app.fetch`、`@hono/node-server` listen + 优雅关闭、jsonrpc 兼容路由 |
| [`02-web-api-surface.md`](./02-web-api-surface.md) | 浏览器/app 用的 REST 端点 + SSE 端点 + zod schema + `@hono/zod-openapi`→OpenAPI/SDK |
| [`03-event-replay.md`](./03-event-replay.md) | event-bus：seqNum + 环形缓冲 + replay；`Last-Event-ID` 语义；sdk 增 `ConnectionState` |
| [`04-multi-project-runtime.md`](./04-multi-project-runtime.md) | InstanceStore（git-root scope）、用户级 pid/state、`x-ohbaby-directory` workspace 路由、`serve ps`、反多后端、G5 细化 |
| [`05-consumption-path-unification.md`](./05-consumption-path-unification.md) | **本阶段新增步骤**：在契约层统一直连/server 两条消费路径，避免行为漂移 |
| [`06-migration-and-tests.md`](./06-migration-and-tests.md) | 从当前 `server.ts` 到 Hono 的增量步骤、新增依赖、测试/验收/回归范围 |
| [`07-v0.1.5-stable-server-kernel.md`](./07-v0.1.5-stable-server-kernel.md) | **v0.1.5 发布范围**：只做 M1-M4，先稳定显式 server 内核，暂缓 web REST/OpenAPI 与多项目 runtime |
| [`08-v0.1.6-scoped-serve-ports.md`](./08-v0.1.6-scoped-serve-ports.md) | **v0.1.6 发布门**：单 project-root web UI 下的 scoped `serve`、端口自动避让、同 scope 复用、默认打开浏览器 |

---

## 一句话定位

把多个 workspace 的 agent backend，经一个全局 **Hono server** 按显式 directory 暴露给多前端（CLI-attach / web / 未来 app）：**默认 CLI 不经过它**（直连 backend，守 N2），`ohbaby serve` 才 `listen`，测试 harness 可经 per-scope `app.fetch` 注入式调用。两条消费路径在 `CoreApiHost` 契约层统一，杜绝漂移。
