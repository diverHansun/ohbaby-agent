# 1. 问题基线与当前实施状态

> 时间口径：2026-08-14，improve-1 已通过验收与独立审查。本文描述 improve-2 仍需处理的 surface 采用 gap。

## 1.1 本轮核心问题

| ID | 当前矛盾 | 直接风险 |
|----|----------|----------|
| P1 | CLI、TUI、Web 用同一个“提交”动作却依赖不同 Promise 时机 | 改名时容易让 CLI 提前退出或让 UI 等到模型结束 |
| P2 | Web 手写 `OhbabyWebClient` 与 SDK `UiBackendClient` 重复且已漂移 | 同名方法参数、返回类型和支持能力继续分叉 |
| P3 | Web client 的同步 `getSnapshot(): StoreSnapshot` 与 SDK 异步后端查询冲突 | 一个类无法诚实实现权威接口，调用方分不清读本地还是读后端 |
| P4 | Browser client 混有 SDK 命令、store、SSE、workspace/session 应用编排 | 若机械拆分，容易造出两个 client；若不拆，SDK 仍不权威 |
| P5 | 初始/resync snapshot 直接写 store，而 SSE `ui.event` 走另一分支 | SDK subscriber 与 UI store 可能看见不同顺序或漏掉 snapshot replacement |
| P6 | Web REST 尚未覆盖 `waitForPrompt`、`respondInteraction` 等完整 backend 能力 | BrowserDaemonClient 无法实现必选 `UiBackendClient` |
| P7 | Server 仍用 `supportsPromptQueue()` 与旧 `submitPrompt` fallback | improve-1 的必选队列能力没有真正进入生产边界 |
| P8 | `CoreAPI`/`SDKAPI` 已改为 derived alias，但逐方法 runtime wrapper、TUI `TuiEvent`、`Partial<UiPromptQueueClient>` 仍保留重复知识 | 删除旧 API 时仍容易漏调用点 |
| P9 | improve-1 落地后，多入口迁移仍可能绕过或再套一层 gateway | Server 与 Agent 包会出现重复记录或完全漏记；这是采用风险，不是当前代码里已有双记 |
| P10 | 权威文档仍可能描述旧方法/事件模型 | 代码收口后下一次改造仍从错误前提开始 |

## 1.2 当前 CLI/TUI Prompt 数据流

### 非交互 CLI

`packages/ohbaby-cli/src/cli/commands/run.ts` 当前执行：

```text
subscribeEvents
  → await host.core.submitPrompt(prompt)
  → unsubscribe / dispose
```

它实际上依赖旧方法“等待最终结束”的隐藏语义。若只把旧 `submitPrompt` 改成接单回执，run 命令会在 Agent 仍运行时释放 host。目标迁移必须使用 `submitPromptAndWait`，并把四种 completion 终态映射为 CLI 成功/非成功，而不是再依靠普通异常区分业务失败。

### TUI

`packages/ohbaby-cli/src/tui/components/prompt/index.tsx` 当前调用旧 `submitPrompt(...).catch(...)`。这个 Promise 同时承担：

1. 请求有没有被接收；
2. 最终运行有没有失败；
3. UI 何时显示错误。

TUI store 已经订阅 `UiEvent`，Prompt 也有 `prompt.submitted` / `prompt.updated`。因此正确切分是：accepted reject 只表示提交技术失败；accepted resolve 后的四种业务终态由事件更新 UI。TUI 不需要为每个提交额外启动 `waitForPrompt`，否则会重复订阅同一事实。

### TUI 类型重复

`packages/ohbaby-cli/src/tui/store/snapshot.ts` 的 `TuiEvent` 又联合 `SdkUiEvent`、`message.part.delta` 和 `snapshot.replaced`。后二者已经属于 SDK `UiEvent`，只是局部字段曾更窄/更严。`TerminalClient` 还组合 `CoreAPI & Partial<UiPromptQueueClient>`。这些类型会掩盖权威合同不一致，应在调用迁移后删除。

## 1.3 当前 Web 结构

### 1.3.1 三层对象的真实职责

| 当前对象 | 代码位置 | 当前职责 | 问题判断 |
|----------|----------|----------|----------|
| `DaemonHttpClient` | `apps/ohbaby-web/src/api/daemon/http.ts` | fetch、auth/directory/client headers、wire JSON | 合理 transport helper，不应升级为业务 client |
| `BrowserDaemonClient` | `apps/ohbaby-web/src/api/daemon/client.ts` | SDK 类命令、SSE、buffer/resync、store、session façade | 应保留 class，但缩到 SDK client + 连接适配职责 |
| `BrowserOhbabyWebRuntime` | 同文件 | workspace 控制面、导航、store、活动 client 生命周期 | 合理应用 façade，不应复制 SDK 方法 |

问题不是对象数量，而是能力边界：`OhbabyWebClient` 手写了几乎一整套业务接口，并把浏览器动作混入其中；`BrowserDaemonClient implements OhbabyWebClient`，所以 SDK 不再是类型权威。

### 1.3.2 getSnapshot 冲突

当前：

```ts
OhbabyWebClient.getSnapshot(): StoreSnapshot;
OhbabyWebStore.getSnapshot(): StoreSnapshot;
UiBackendClient.getSnapshot(): Promise<UiSnapshot>;
```

Web client 的方法只是转发 store，同一个概念被暴露两次；同时占用了 SDK 查询方法的名字。这个冲突必须通过删除 client 上的同步 store getter解决，不能靠 overload 或 `unknown` 掩盖。

### 1.3.3 Web 方法形状漂移

当前 Web 例子：

- `submitPrompt(input: SubmitPromptRequest): Promise<PromptAcceptedResponse>`，而 SDK 使用 `(text, options)` 与 `UiPromptReceipt`；
- queue 方法使用多个位置参数，SDK 使用输入对象；
- `listCommands()` 无 query 并返回 Web catalog；
- `connectModel`/`probeModelContextWindow` 使用 Web wire input，部分字段由 Server 推断；
- `abortSession(sessionId, runId?)` 与 SDK `abortRun(runId)` 不是同一能力；
- `createSession`、`selectSession`、`listWorkspaceScopes` 是 Web 应用/控制面能力，不属于 SDK 会话 backend。

wire DTO 可以继续存在于 HTTP 层，但 BrowserDaemonClient 的公开方法必须接收/返回 SDK DTO，并在内部做一次明确映射。Server 可以保留防御性默认值，浏览器不能借此省略 SDK 必填语义。

### 1.3.4 SSE 与 snapshot 当前路径

`BrowserDaemonClient.doConnect()` 当前大致为：

```text
注册 client
  → 开始 SSE 并 buffer
  → HTTP getSnapshot
  → store.replaceSnapshot
  → replay buffered ui.event 到 store
```

`handleSseEvent()` 已正确把 `hello`、`error`、`resync-required` 与 `ui.event` 分开，也已有 sequence 校验、buffer 和 resync。基础设计无需推倒。

剩余 gap：

- class 没有 SDK `subscribeEvents(handler)`，只有 store 的 `subscribe(listener)`；
- `ui.event` 直接 `store.applyEvent`，没有统一 SDK 分发点；
- initial/resync 直接 `store.replaceSnapshot`，没有构造成已有 `snapshot.replaced`；
- workspace 切换虽会关闭旧 client，但目标测试需证明旧 generation 的迟到响应/事件不会污染新 workspace。

“SSE 只有一个连接”若按物理 socket 理解并不严谨，因为网络重连会换连接；需要以“每个活动 workspace 同时一个逻辑订阅”作为合同。

## 1.4 当前 Server transport gap

### REST

`packages/ohbaby-server/src/app/create-app.ts` 已提供 Prompt accepted、编辑、取消和租约 route，且 `/v1/prompts` 返回 HTTP 202 receipt。它仍：

- 通过 `supportsPromptQueue()` 决定新路径或旧 `submitPrompt` fallback；
- 没有按 promptId 等待 completion 的 route；
- 没有与 SDK `respondInteraction` 对应的 Web route；
- route response 常带 `{ ok: true, ... }`，需要在 transport helper 内投影，不能泄漏到 SDK DTO。

`waitForPrompt` 是长等待查询。新增 REST 路径必须先执行现有 auth、client registration、workspace scope 和 prompt ownership 检查；浏览器中止 fetch 只停止等待，不取消 Prompt。

### JSON-RPC

JSON-RPC 已有 `submitPromptAccepted`、queue 方法、`waitForPrompt` 和 `respondInteraction`，也保留旧 `submitPrompt`。improve-2 的主要工作是让 client/route 直接依赖新的 SDK 能力，删除旧 method 和 `supportsPromptQueue()` 分支，而不是再加一套 `submitPromptAndWait` 运输执行路径。remote client 可组合 accepted + wait。

### 记录所有权

improve-1 已建立 `UiCommandRecorder`、有界结构化 recorder，以及 Agent host / Server REST / Server RPC 三个唯一 gateway。当前测试证明 raw backend 和 skill 内部接单不自记；improve-2 改 composition 时仍必须复验，防止新 façade 绕过或叠加 gateway。

daemon Server 持有的是 raw backend；本地 CLI/TUI 才通过 Agent host façade。若在 raw backend 自记，REST/RPC 会在 Server gateway 后再次记录。目标必须从 composition root 验证：

```text
Web → server-rest recorder → raw backend
RPC → server-rpc recorder → raw backend
TUI/CLI → agent-host recorder → raw backend
```

Server/Agent 各自有 recorder 实现不等于同一链路两者都执行。

## 1.5 当前 client 知识重复

`packages/ohbaby-sdk/src/rpc/types.ts` 的 `CoreAPI` / `SDKAPI`，`packages/ohbaby-agent/src/host/core-api-factory.ts` 的逐方法转发，以及 `packages/ohbaby-server/src/protocols/jsonrpc/client.ts` 后部的 host wrapper 共同复制 client 能力。

improve-1 先让这些类型从权威能力派生，保障 additive 迁移。improve-2 删除无独立语义的逐方法手抄/包装，但不预设名称必须消失：`CoreAPI` / `SDKAPI` 若仍表达 fake-RPC 的正向调用面与反向 callback seam，可以保留 derived alias。CLI host 若需要表达“SDK 能力 + host 生命周期”，使用权威能力与一个很薄的生命周期结构组合，不能再次逐方法抄签名。

## 1.6 当前测试资产

- Web client：`apps/ohbaby-web/src/api/daemon/client.integration.test.ts`、`server-client.integration.test.ts`、`workspace-switch.integration.test.ts`。
- Web reducer：`apps/ohbaby-web/src/api/daemon/eventReducer.unit.test.ts`。
- Web UI：`apps/ohbaby-web/src/ui/App.unit.test.tsx`，大量 fake 当前依赖 `OhbabyWebClient`。
- Server REST：`packages/ohbaby-server/src/app/create-app.unit.test.ts`。
- Server RPC：`packages/ohbaby-server/src/protocols/jsonrpc/{client.unit.test.ts,...}` 与 daemon integration。
- CLI run：`packages/ohbaby-cli/src/cli/commands/run.unit.test.ts` 及 root CLI integration。
- TUI：`packages/ohbaby-cli/src/tui/app.contract.test.tsx` 和 store unit tests。

这些测试覆盖了当前行为，但 fake 的旧类型本身也是迁移对象。不能为了少改测试而长期保留平行接口；应先提供 SDK contract fake/builder，再机械迁移测试夹具。

## 1.7 文档差异

`docs/ohbaby-web/architecture.md`、`docs/ohbaby-web/test.md`、`docs/ohbaby-server/architecture.md`、`docs/ohbaby-server/test.md`、`docs/ohbaby-sdk/{goals-duty,architecture,data-model,dfd-interface,test}.md` 都直接或间接描述 client、HTTP/SSE 和 Prompt 语义。

improve-1 更新底层合同后，本轮必须把“各 surface 如何采用”与删除结果同步进去。最终文档不得同时出现：

- `submitPrompt` 既表示 accepted 又表示 completed；
- `BrowserDaemonClient.getSnapshot()` 同时表示 store 与 backend；
- Web 有独立完整 client 合同；
- queue 在生产 backend 上既必选又 feature-detect；
- 一次写在 Server 与 Agent 两层都归属记录。

## 1.8 问题追踪

| 问题 | 主要解决 Phase | 主要验收 |
|------|----------------|----------|
| P1 CLI/TUI/Web Promise 时机 | 1、3 | T1–T9、T25 |
| P2 Web 手写 client 漂移 | 3、5 | T21–T32、静态删除检查 |
| P3 getSnapshot 冲突 | 3 | T23–T24 |
| P4 client/façade 职责混合 | 3 | T22、T28–T32 |
| P5 snapshot 与 SSE 双入口 | 4 | T33–T44 |
| P6 REST 能力缺口 | 2 | T12–T16、T20 |
| P7 queue fallback | 2、5 | T17、T19 |
| P8 Core/TUI 类型重复 | 1、5 | T10–T11、静态删除检查 |
| P9 记录所有权回退 | 1–4 | T45–T50 |
| P10 文档漂移 | 5 | G7 与完成判定 7 |
