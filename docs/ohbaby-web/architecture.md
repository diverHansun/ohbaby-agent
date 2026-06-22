# ohbaby-web · architecture（架构设计）

> 解释 web 端内部结构为什么这样设计。每一项都服务于 [`goals-duty.md`](./goals-duty.md) 的目标与职责，不引入新职责。
>
> 前置：goals-duty.md 已确认。

---

## 1. Architecture Overview（总体架构）

web 端内部分三层，数据**单向流动**，依赖方向恒为 `ui → store → api/daemon → (ohbaby-sdk 类型)`，无反向边、无环。

- **连接层 `api/daemon/`**（纯逻辑，无 UI）：对 daemon 讲 `/v1`。子组件：
  - `wire` —— `/v1` 线类型（由 OpenAPI 生成 / 对齐 sdk 类型）。
  - `http` —— REST 命令封装（建连、发 prompt、审批、中断、commands passthrough 等）。
  - `events` —— SSE over fetch-stream，含 `Last-Event-ID` 续传与 `resync-required` 处理。
  - `eventReducer` —— 纯函数 `(event, state) → state`：把 `UiEvent` 投影为 ViewState（含轻量 `CommandNotice`）。
  - `client` —— 门面，把上述四者组装成一个浏览器版 backend 客户端；slash passthrough 目录过滤使用 `ohbaby-sdk` 的 web-safe helpers，避免 server/web allowlist 漂移。
- **状态层 `store/`**：持有投影后的 ViewState 与 ConnectionState，喂给 React（`useSyncExternalStore`）。
- **视图层 `ui/`**：会话流、输入框、权限弹窗、状态条等组件。

纯逻辑（`wire` / `events` / `eventReducer`）**不 import React**，可无头单测（落 G2）。

---

## 2. Design Pattern & Rationale（设计模式与理由）

- **单向数据流（Flux 式）**：用户命令经 `http` 出站；会话真相只经 SSE 事件 → `eventReducer` → store → view 回来。**不对会话真相做乐观本地改写**（落 G1）。
  - 理由：daemon 是唯一事实源。乐观更新会引入"本地态 vs 真相"分叉，而 resync 时要丢弃本地态重建——单向流让 resync 退化为"清空 ViewState + 重拉 snapshot"，最简单可靠。
- **门面模式 `client.ts`**：把 `http` + `events` + `eventReducer` 收在一个浏览器版 backend 门面之后，UI 只依赖门面，不感知传输细节（落 G2 + 干净 seam，呼应 ND7）。
- **Reducer 模式 `eventReducer`**：纯 `(event, state) → state`，框架无关，是最易出错逻辑（流式累积、顺序、resync）的可单测内核。
- **不引入 SSR / 路由框架**：单屏 SPA，YAGNI；引入会增大产物、复杂化同源伺服（违 G4）。

---

## 3. Module Structure & File Layout（模块结构与文件组织）

```
apps/ohbaby-web/
  index.html            ← daemon 注入 window.__OHBABY__ 的位点（依赖 S-C）
  vite.config.ts
  package.json          ← private: true，包名 ohbaby-web
  src/
    bootstrap.ts        读注入 → 建 client → 挂载 React
    main.tsx            React 根
    api/daemon/
      wire.ts           /v1 线类型（OpenAPI 生成）
      http.ts           REST 命令封装
      events.ts         SSE over fetch-stream + Last-Event-ID/resync
      eventReducer.ts   UiEvent → ViewState（纯函数）
      client.ts         浏览器版 backend 门面（组装上面四者）
    store/
      store.ts          外部 store：subscribe/getSnapshot（喂 useSyncExternalStore）
    ui/
      ConversationStream.tsx   会话/消息流（流式渲染 + markdown 消毒 + 工具卡片）
      Composer.tsx             输入框 + 发/中断 + mode(auto/plan) + 权限策略(default/full-access)
      PermissionModal.tsx      权限模态（slide-up，队列驱动）
      StatusBar.tsx            连接态 / run 状态 / 上下文用量（无诊断行）
      CommandNotice.tsx         slash 命令结果/错误的轻量投影（非完整命令面板）
```

- **对外稳定面**：`client` 门面 + store hooks。
- **内部实现**：`wire` / `http` / `events` / `eventReducer` —— 可在不动 UI 的前提下替换。
- **视图层详细设计**见 [`ui/`](./ui/README.md)：组件规格、状态可视化、设计 token、最终屏幕参考。三项已锁 UI 决策：StatusBar **不暴露诊断行**（seqNum/clientId/端口属开发者，正确性只经 ConnectionState 五态对用户可见）；权限用**模态 slide-up**；composer 的 **mode/policy 切换纳入 v0.1.6**。

---

## 4. Architectural Constraints & Trade-offs（约束与权衡）

- **放弃 WebSocket，选 SSE over fetch-stream**：复用 server 已建的 `Last-Event-ID` replay/resync；代价是上行命令走 REST（符合"命令出/事件回"单向模型）。选 fetch-stream 而非原生 `EventSource` 是硬约束——`EventSource` 不能设 `Authorization` header，而 `/v1/events` 需要它；fetch-stream 顺带支持 `Last-Event-ID`。
- **放弃乐观更新**：换取零分叉 + resync 极简；代价是发话后等 SSE 回显的轻微延迟感（本地 daemon，延迟可忽略）。
- **放弃 SSR / 路由框架**：换取产物极小、同源伺服简单；代价是无服务端渲染（本地工具无所谓）。
- **选 React（与 CLI 一致）而非更轻的 Preact**：换取团队熟悉度与生态；代价是运行时略大（本地工具可接受）。
- **typed client 由 OpenAPI 生成而非手写**：换取契约单一来源、不漂移（落 ND4）；代价是多一道生成构建步骤（server 出 `openapi.json` → web prebuild 生成 `wire.ts`）。
- **slash passthrough 不等于命令面板**：v0.1.6 只把以 `/` 开头的 composer 输入解析为 `UiSlashCommandInvocation` 并经 daemon 执行，结果以 `CommandNotice` 呈现。web-safe allowlist 与过滤谓词由 `ohbaby-sdk` 导出，server 和 web 共用同一份真相；候选列表、Tab 补全、交互式 command panel 仍属 ND5，避免 UI 范围在收口阶段膨胀。
- **store 用 `useSyncExternalStore` 手卷而非 Context**：换取高频 SSE 增量下的精准订阅、避免全量重渲；代价是要自己写极小的 subscribe/getSnapshot（约定俗成、量很小）。

> 以上取舍都为后续维护者标注"为什么不能随意改"：尤其单向流 + 非乐观更新是 resync 正确性的结构前提，改动需回到本文与 dfd 重新评估。
