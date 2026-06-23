# ohbaby-web 模块设计

> `apps/ohbaby-web` 的模块级设计文档集。本包是 v0.1.6 引入的**轻量 web 端**——把唯一的 agent backend，通过 daemon 的 `/v1` REST+SSE，呈现为浏览器里的交互式 coding-agent 界面。
>
> 服务端契约/职责见 [`../ohbaby-server/`](../ohbaby-server/README.md)（尤其 [`hono-app/`](../ohbaby-server/hono-app/README.md) 的 web/app 适配阶段）；本目录是 web 前端的模块设计。

## 一句话定位

web 端是 daemon 会话状态的**投影与 adapter**，不持有独立事实源。它是与 CLI 并列的"又一个前端消费者"，共享同一个 `UiBackendClient`/`CoreApiHost` 契约，而非新搭一套架构。

## 文档导航（按设计顺序）

| 文档 | 职责 |
|------|------|
| [`goals-duty.md`](./goals-duty.md) | 目标 / 职责 / 非职责——边界声明，最重要 |
| [`architecture.md`](./architecture.md) | 三层单向流；门面模式；技术栈与权衡 |
| [`data-model.md`](./data-model.md) | web 独有概念（ConnectionState 五态机、ViewState、StreamingMessage、PendingPermission） |
| [`dfd-interface.md`](./dfd-interface.md) | 数据流（引导/建连/事件/命令/重同步）+ 接口语义 |
| [`use-case.md`](./use-case.md) | 四个用例的编排与失败点 |
| [`non-functional.md`](./non-functional.md) | 质量优先级与刻意暂缓项 |
| [`test.md`](./test.md) | 测试范围、关键场景、契约打真 app.fetch |
| [`ui/`](./ui/README.md) | **视图层设计**：组件规格、状态可视化、设计 token、最终屏幕参考 |
| [`ui/slash-commands/structured-overlays.md`](./ui/slash-commands/structured-overlays.md) | `/connect`、`/connect-search`、`/compact` 的结构化 REST + overlay 契约 |
| [`session-archive/`](./session-archive/README.md) | Web-only session 归档语义、REST/API 设计、侧边栏交互与实现计划 |

## v0.1.6 范围

- **完整交互客户端**的第一刀：**核心会话闭环**——连接 + snapshot 首屏 + SSE 流式消息 + 发 prompt + 权限审批（准/拒，模态 slide-up）+ 中断 run + composer 的 **mode(auto/plan) / 权限策略(default/full-access) 切换**。
- **web-safe slash commands UI**：允许 web-safe passthrough（`/status`、`/help`、`/new`、`/mcps`、`/skills`），补齐 `commands` REST adapter、浏览器端解析/执行、候选面板、Tab 补全、键盘选择，以及只读命令结果的结构化弹层展示；需要 `interaction.requested` 的命令仍不进入 web passthrough。
- **结构化 slash overlays**：`/connect`、`/connect-search`、`/compact` 作为 slash 入口打开 overlay，但 mutation 走结构化 REST（model/search/compact），不加入 raw passthrough allowlist；模型 provider interface 由 server 按 `baseUrl` 推断。
- 多项目界面切换、完整 provider preset、interaction 请求 → 后续批次。

## 关键决策一览

| 维度 | 决策 |
|------|------|
| 托管 | daemon **同源伺服**静态产物 + 注入 `window.__OHBABY__`（无 CORS、token 不手填） |
| 技术栈 | React + Vite，纯静态 SPA；不上 SSR/路由框架 |
| typed client | 从 server `/doc` OpenAPI **生成** wire 类型 |
| 状态管理 | `useSyncExternalStore` 手卷外部 store（零依赖、精准订阅） |
| 事件传输 | SSE over **fetch-stream**（非 EventSource，可带 Authorization header + Last-Event-ID） |
| 初始同步 | **SSE 先开 + snapshot 带 seqNum**，只应用 seq>基线的缓冲事件 |
| 进程模型 | web=显式 daemon；默认 CLI 仍 in-process；"终端+浏览器同看 live"靠 opt-in attach |
| 多项目 scope | git-root；**Option A（一 serve 一 scope）+ 预留 Δ7 的缝** |

## 进程模型与"踩坑"对照（重要背景）

web 的引入**不统一 CLI 到 daemon**——那正是 [`../problem-lists/daemon-workspace-scope`](../problem-lists/daemon-workspace-scope/00-index.md)（已归档）和 [`../problem-lists/terminal-daemon`](../problem-lists/terminal-daemon/README.md) P6 踩过的坑。`docs/problem-lists/server` 的 ADR-001 已定：**默认 CLI in-process，daemon 显式入口**。三种运行模式：

- **默认 CLI** = in-process，无 daemon（零改动，无连接可断）。
- **web** = 显式 `ohbaby serve` daemon + 浏览器同源；自带 reconnect/replay/resync。
- **opt-in attach**（`ohbaby --remote-port`）= 终端接到同一 daemon，与 web 共享同一 live 状态。

v0.1.6 真正新增的只有 **web** 这一个；另两种模式已存在。

## 依赖的服务端前置（跨模块，见各文档展开）

本包的设计对 `ohbaby-server` 提出 4 项依赖（server 文档已加指针）：

- **S-A**：`GET /v1/snapshot` 须返回它反映的 **seqNum 基线**。
- **S-B**：**webAssets 静态路由**伺服 `apps/ohbaby-web/dist`。
- **S-C**：向 `index.html` 注入 `window.__OHBABY__`（token/clientId/baseUrl）。
- **S-D**：**git-root scope** + per-scope `.ohbaby/` 启动锁（pid 探活 / stale takeover / 版本握手）；状态文件与 `/v1` 寻址预留 scope 维度，便于将来升级到 Δ7 多实例。

`/v1` REST 面与 OpenAPI `/doc` 本身是 server 既有规划（`hono-app/02` 的 Δ3/Δ4），待建。
