# ohbaby-web · goals-duty（目标与职责）

> 模块设计第一份、也是最重要的一份文档。它定义 `apps/ohbaby-web` **为什么存在、做什么、刻意不做什么**。后续 architecture / data-model / dfd / use-case / test 文档都不得引入超出本文 Duties 的职责。

---

## 一句话存在意义

把**唯一的 agent backend**，通过 daemon 的 `/v1` REST+SSE，呈现为浏览器里的交互式 coding-agent 界面。它是 backend 会话状态的**投影与 adapter**——不持有独立事实源，不重定义领域语义，是与 CLI/TUI 并列的"又一个前端消费者"。

---

## 背景：web 是消费者，不是新架构

服务端（`ohbaby-server`）已经把 agent backend 通过显式 daemon 暴露给多前端，并做完了多客户端协调的重活（SSE replay/resync、权限路由、prompt 队列、Bearer token 鉴权）。web 端要做的是**讲这套协议的浏览器客户端 + 交互 UI**，而不是另起一套后端架构。

进程模型上，web 维持 `docs/problem-lists/server` 的 ADR-001 边界：**默认 CLI 仍 in-process，web 走显式 `ohbaby serve` daemon**。web 的引入对 CLI 零侵入。

---

## Design Goals（设计目标）

- **G1 状态投影，非事实源**：UI 是 daemon 会话状态的投影，唯一事实源在 backend；web 不持久化、不二次定义会话真相。
- **G2 连接层与视图层分离**：`api/daemon`（纯逻辑）能脱离 UI 独立测试；UI 能独立替换。该解耦同时让连接层保持干净 seam，将来若需抽成共享包（desktop/app 复用）代价低——但**那不是本期目标**（见 ND7）。
- **G3 行为与 CLI/TUI 一致**：不产生"只有 web 才有"的会话行为——把 server ADR-001 的契约一致性延伸到前端。
- **G4 轻量、同源**：纯静态 SPA，能被 daemon 同源伺服，零额外后端、零 CORS。
- **G5 断线可恢复**：面向"网络失败模型"设计——基于 `Last-Event-ID` / snapshot 重建视图，这正是 in-process CLI 不需要、也不应背负的复杂度。

---

## Duties（职责）

- **D1 浏览器 daemon 客户端**：对 daemon 讲 `/v1` REST + SSE（fetch-stream），含 `Last-Event-ID` 续传与 `resync-required` 处理。
- **D2 事件投影**：把 `UiEvent` 投影为 UI 视图状态（消息流 / run 状态机 / 待审批队列 / 连接态）。
- **D3 会话交互 UI（v0.1.6 闭环）**：snapshot 首屏、流式消息、发 prompt、权限审批（准/拒，模态 slide-up）、中断 run，以及 composer 的 **mode 切换（auto/plan）** 与 **权限策略切换（default / full-access）**。视图层详细设计见 [`ui/`](./ui/README.md)。
- **D4 引导接入**：从 daemon 注入的 `window.__OHBABY__` 读取 `token / clientId / baseUrl` 并附带到请求。
- **D5 纯静态构建产物**：产出可被 daemon 伺服的 `dist`（HTML/JS/CSS/资源）。
- **D6 web-safe slash commands UI**：composer 中以 `/` 开头的输入走既有 `UiSlashCommand` 解析/执行链路，经 `/v1/commands` REST adapter 调用 daemon。浏览器提供候选面板、分组、键盘选择、Tab 补全，以及只读命令结果的结构化弹层；命令集合只来自 web-safe allowlist（`/status`、`/help`、`/new`、`/mcps`、`/skills`）。任何 `parentBehavior: "interaction"` 命令、未完成后端接线的命令（如 `/connect`、`/connect-search`、`/compact`）必须被过滤/拒绝。

---

## Non-Duties（非职责）—— 边界声明

- **ND1 不伺服自身静态资源**：由 `ohbaby-server` 的 webAssets 路由负责（依赖 S-B）。
- **ND2 不生成/存储/轮换 auth token**：由 daemon 负责；web 只读注入副本、仅存内存（依赖 S-C）。
- **ND3 不重定义领域语义/业务规则**：会话真相在 `ohbaby-agent` backend；web 只投影 + adapter。
- **ND4 不定义 `/v1` wire 契约**：契约真相在 server 的 OpenAPI（`/doc`）+ `ohbaby-sdk` 领域类型；web 消费（生成 typed client）。
- **ND5 v0.1.6 不做**：未接线命令的交互式表单（`/connect`、`/connect-search`、`/compact`）、模型切换器、多项目界面切换、interaction 请求、分页/高级命令面板——后续版本。v0.1.6 只做 D6 的 web-safe slash commands UI。
- **ND6 不做远程/多用户鉴权、不直连 LAN**：同源本地优先，延续 server 的 N4。
- **ND7 不为想象中的 app 提前抽共享包**：`api/daemon` 内置于本包；保持干净 seam 即可，YAGNI。
- **ND8 不管理 daemon 生命周期 / 不 auto-spawn**：假定用户显式 `ohbaby serve`（延续 ADR-001 G4 显式生命周期）。"打开 web" = 跑 `ohbaby serve` + 开浏览器，无隐藏 daemon。
- **ND9 不与并发 in-process CLI 做同 session live 同步**：两者是独立 backend 实例，跨进程安全由 DB 原子 claim 层保证（防写坏），live 共享需显式 attach（`ohbaby --remote-port`）。
- **ND10 不解析 / 管理 workspace scope**：web 同源继承伺服它的 daemon 的 scope（被端口钉死）；scope 解析与启动锁是 server/runtime 的职责（依赖 S-D）。

---

## 自检

- 能否用一句话说明存在意义？✅ 见顶部。
- 能否清楚回答"不该做什么"？✅ ND1–ND10。
- 是否存在与其他模块明显重叠的职责？无——伺服资源/token/契约/scope 全部划给 server（ND1/ND2/ND4/ND10），领域语义划给 agent（ND3）。
