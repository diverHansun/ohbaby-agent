# ohbaby-web · architecture（架构设计）

> 解释 web 端内部结构为什么这样设计。每一项都服务于 [`goals-duty.md`](./goals-duty.md) 的目标与职责，不引入新职责。
>
> 前置：goals-duty.md 已确认。

---

## 1. Architecture Overview（总体架构）

web 端由 SDK client、浏览器 façade、store 与 UI 四个角色组成。业务能力的类型依赖恒为 `ui/runtime → UiBackendClient(ohbaby-sdk)`；传输实现位于 `api/daemon`，投影状态进入 store，再由 React 读取。

- **连接层 `api/daemon/`**（纯逻辑，无 UI）：对 daemon 讲 `/v1`。子组件：
  - `wire` —— `/v1` 线类型，只描述 HTTP/SSE wrapper；业务 DTO 对齐 SDK 类型并在 client 边界去掉 `{ok, seqNum}` 等 transport 字段。
  - `http` —— REST 命令封装（建连、发 prompt、审批、中断、commands passthrough 等）。
  - `events` —— SSE over fetch-stream，含 `Last-Event-ID` 续传与 `resync-required` 处理。
  - `eventReducer` —— 纯函数 `(event, state) → state`：把 `UiEvent` 投影为 ViewState（含轻量 `CommandNotice`）。
  - `BrowserDaemonClient` —— 唯一浏览器 backend client，直接实现 SDK `UiBackendClient`；一个活动 workspace 只拥有一个实例和一条逻辑 SSE。
- **应用 façade `src/runtime.ts`**：`BrowserOhbabyWebRuntime` 实现 `OhbabyWebRuntime`，编排 workspace、导航、client 生命周期、session 选择和 slash 文本解析；它是既有 façade 的独立落点，不复制整套 backend 方法。`api/daemon/client.ts` 不反向依赖 runtime。
- **状态层 `store/`**：持有投影后的 ViewState、ConnectionState 与独立 PermissionSyncState，喂给 React（`useSyncExternalStore`）。
- **视图层 `ui/`**：会话流、输入框、权限弹窗、状态条等组件。

纯逻辑（`wire` / `events` / `eventReducer`）**不 import React**，可无头单测（落 G2）。

---

## 2. Design Pattern & Rationale（设计模式与理由）

- **单向数据流（Flux 式）**：用户命令经 `http` 出站；会话真相只经 SSE 事件 → `eventReducer` → store → view 回来。**不对会话真相做乐观本地改写**（落 G1）。
  - 理由：daemon 是唯一事实源。乐观更新会引入"本地态 vs 真相"分叉，而 resync 时要丢弃本地态重建——单向流让 普通事件 resync 退化为"清空 ViewState + 重拉 snapshot"；审批使用独立 snapshot 与 revision 恢复，最简单可靠。
- **端口适配器 `BrowserDaemonClient`**：把 `http` + `events` + `eventReducer` 适配为 SDK `UiBackendClient`。UI 的业务调用走 `runtime.client`，浏览器编排走 `OhbabyWebRuntime`；二者不是两套 client。
- **应用 façade `OhbabyWebRuntime`**：负责选择/切换 workspace，并保证旧 client 失效后才启用新 client。无活动 workspace 时 `client` 明确为 `null`，不靠 getter 抛错伪装可用。
- **Reducer 模式 `eventReducer`**：纯 `(event, state) → state`，框架无关，是最易出错逻辑（流式累积、顺序、resync）的可单测内核。
- **不引入 SSR / 路由框架**：单屏 SPA，YAGNI；引入会增大产物、复杂化同源伺服（违 G4）。

---

## 3. Module Structure & File Layout（模块结构与文件组织）

```text
apps/ohbaby-web/
  index.html
  vite.config.ts
  package.json
  src/
    bootstrap.ts        读注入 → 创建 runtime → 挂载 React；导入唯一 styles.css 入口
    runtime.ts          浏览器 façade、workspace/导航与 client 生命周期
    api/daemon/
      wire.ts           /v1 线类型与现有浏览器投影类型
      http.ts           REST 命令封装
      events.ts         SSE over fetch-stream + Last-Event-ID/resync
      eventReducer.ts   UiEvent → ViewState（纯函数）
      client.ts         BrowserDaemonClient，实现 SDK UiBackendClient
      navigation-state.ts  导航持久化 helper，由 runtime 消费
    store/
      store.ts          现有同步投影及 subscribe/getSnapshot
    ui/
      App.tsx           根挂载、空 workspace 与 SessionScreen 切换
      workspace/        ProjectRail、directory-picker/DirectoryPickerDialog
      session/          SessionScreen、SessionSidebar、SessionStatus、selectors、Stop/同步提示 hook
      conversation/     ConversationStream、MessageRow、tool-card、TodoDock、滚动与执行计时
      composer/         Composer、draft-storage、ReasoningControl、IME/textarea/placeholder
      commands/         slashCommands、SlashPalette、结果 modal、connect/compact/goal overlay
      permissions/      PermissionModal、PermissionPolicyControl（含 full-access 确认）
      shared/           MarkdownBlock、ContextUsage
      styles/           全局基础、布局及跨功能覆盖块
      styles.css        固定顺序导入 14 个连续样式块；功能样式随功能目录放置
```

根入口不再承载各功能实现。`SessionScreen` 订阅既有 store、计算提交投影并组合各功能；叶组件接收具体数据和 `Pick<UiBackendClient, ...>`/回调能力，不接收整个 runtime 或 ViewModel。Composer 独占草稿、队列编辑租约生命周期、slash 选中态及键盘链；commands 提供纯规则、候选展示和表单，permissions 提供策略控件。SessionScreen 将 `conversation/TodoDock` 通过 `topContent`、权限控件通过 `permissionControl` 传给 Composer；TodoDock 仍在 Composer section 顶部、消息滚动容器之外。

依赖方向为 `bootstrap → runtime → api/daemon/client`、`App → workspace/session`、`session → conversation/composer/commands/permissions/shared`。Composer 只单向使用 commands 的 slash 规则与 SlashPalette；shared 不反向依赖功能层。样式入口按原级联顺序保留，不能按目录重新排序。

本次结构落地对应 [Web improve-3](./improve-3/README.md)；跨包 New session 行为与最终验收归 [中央 improve-2.1](../problem-lists/2026-09-19-execution-reliability/improve-2.1/README.md)，验收编号不在本文重复定义。

- **对外稳定面**：SDK `UiBackendClient` + `OhbabyWebRuntime` façade + store hooks。
- **内部实现**：`wire` / `http` / `events` / `eventReducer` —— 可在不动 UI 的前提下替换。
- **视图层详细设计**见 [`ui/`](./ui/README.md)：组件规格、状态可视化、设计 token、最终屏幕参考。三项已锁 UI 决策：StatusBar **不暴露诊断行**（seqNum/clientId/端口属开发者，正确性只经 ConnectionState 五态对用户可见）；权限用**模态 slide-up**；composer 的 **mode/policy 切换纳入 v0.1.6**。

---

## 4. Architectural Constraints & Trade-offs（约束与权衡）

- **放弃 WebSocket，选 SSE over fetch-stream**：复用 server 已建的 `Last-Event-ID` replay/resync；代价是上行命令走 REST（符合"命令出/事件回"单向模型）。选 fetch-stream 而非原生 `EventSource` 是硬约束——`EventSource` 不能设 `Authorization` header，而 `/v1/events` 需要它；fetch-stream 顺带支持 `Last-Event-ID`。
- **放弃乐观更新**：换取零分叉 + resync 极简；代价是发话后等 SSE 回显的轻微延迟感（本地 daemon，延迟可忽略）。
- **放弃 SSR / 路由框架**：换取产物极小、同源伺服简单；代价是无服务端渲染（本地工具无所谓）。
- **选 React（与 CLI 一致）而非更轻的 Preact**：换取团队熟悉度与生态；代价是运行时略大（本地工具可接受）。
- **SDK 类型作为业务合同权威，wire 类型只留在 transport helper**：`BrowserDaemonClient implements UiBackendClient` 由 TypeScript 直接校验；当前没有额外的 OpenAPI 生成 client，避免文档把尚未落地的生成链误写成现状。
- **slash UI 消费 web palette catalog**：v0.1.6 把以 `/` 开头的 composer 输入分成两类。web-safe passthrough 命令解析为 `UiSlashCommandInvocation` 并经 daemon 执行；`/connect`、`/connect-search`、`/compact` 打开结构化 overlay 并提交专用 REST。web-safe allowlist 与过滤谓词由 `ohbaby-sdk` 导出，server 和 web 共用同一份真相；interaction 命令仍属后续批次。
- **store 用 `useSyncExternalStore` 手卷而非 Context**：同步 `runtime.store.getSnapshot(): StoreSnapshot` 只服务渲染；SDK `runtime.client.getSnapshot(): Promise<UiSnapshot>` 只服务后端查询，两种同名操作不再混在一个接口。

### 单一事件数据流

`FetchDaemonEventStream` 只负责一个物理 fetch-stream 的连接、重连和 frame 解析。普通有效 `ui.event` 进入 `BrowserDaemonClient.dispatchUiEvent` 后，先由 store 做 sequence 校验和投影，再通知所有 SDK subscriber；重复、过期或无效序号不会通知 subscriber。subscriber 或 store listener 抛错均被隔离。首屏和 resync 以本地 `snapshot.replaced` barrier 进入同一分发点，只有实际应用成功后才推进 `Last-Event-ID`。

> 以上取舍都为后续维护者标注"为什么不能随意改"：尤其单向流 + 非乐观更新是 resync 正确性的结构前提，改动需回到本文与 dfd 重新评估。

### 独立审批数据流

审批事件在普通 seq 检查之前分流给 SDK `createPermissionSync`，不进入普通 replay 或 ViewState reducer。连接先安装订阅，再由 `hello` 确认 epoch、root 和 bindingGeneration；独立 `GET /v1/permissions` 提供基线。共享引擎负责有界查询、增量缓冲、gap 恢复和旧 generation 隔离，Web store 只保存其输出。全量 snapshot 慢或失败不阻塞审批恢复；消息的连接态 `live` 也不能使未完成基线同步的审批按钮可用。

记忆会话恢复使用轻量 session index，不等待历史或 model 查询。恢复期间的旧快照不能覆盖记忆目标；显式 startup resume/fresh、后续手动选择及 new/resume 命令优先。metadata 暂时失败保留记忆偏好和现有连接，只有确认不存在或属于 child 时才跳过目标。导航持久化优先采用当前 transport binding；历史查询期间绑定改变则重新读取当前视图，避免迟到历史覆盖新选择。
