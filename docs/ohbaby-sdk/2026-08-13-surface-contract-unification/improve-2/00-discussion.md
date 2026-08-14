# 讨论记录与已确认要点

> 本文承接 [`improve-1/00-discussion.md`](../improve-1/00-discussion.md)。底层 Prompt、接口、ID 和记录语义不在本轮重新讨论。

## 1. 轮次边界

用户确认只使用两个 improve 轮次。improve-2 不是另起架构，而是把 improve-1 的权威合同真正铺到 CLI、TUI、Web 和 Server，再删除旧路径。

本轮顺序固定为：

```text
确认 improve-1 通过
  → 迁移 CLI/TUI 调用语义
  → 补齐 Server transport
  → Web 采用 SDK client + runtime façade
  → 统一事件分发
  → 删除兼容层并更新权威文档
```

## 2. 已确认：BrowserDaemonClient 与 OhbabyWebRuntime

### 2.1 它们不是两个 client

- `BrowserDaemonClient`：一个有状态的 SDK `UiBackendClient` 实现，负责某个活动 workspace 的 HTTP 命令、SSE 生命周期、重连缓冲和 resync。
- `OhbabyWebRuntime`：浏览器应用 façade 接口，负责 workspace 选择、目录浏览、导航持久化、共享 store，以及活动 client 的创建、切换、关闭；没有选中 workspace 时 client 明确为 `null`。
- `DaemonHttpClient`：无业务状态的 HTTP transport helper，只负责 URL、headers、JSON 和 wire DTO，不是第二个 business client。

因此结构是“一个业务 client 被一个应用 runtime 管理”，不是“外面又套一个同能力 client”。`OhbabyWebRuntime.client` 应暴露为 SDK `UiBackendClient`，浏览器专有动作留在 runtime。

### 2.2 为什么 BrowserDaemonClient 保留为 class

它持有连接和并发状态：`connectPromise`、buffer、resync、closed generation、subscriber 集合。这些状态有必须共同维护的不变量，使用 class 合理。此次不为追求函数式或语法统一改写它。

但 class 的额外职责要受控：workspace 列表、目录选择、URL hash、`createSession`/`selectSession` 等应用编排不属于 SDK backend 合同，应由 runtime façade 承担。

## 3. 已确认：消除 getSnapshot 冲突

当前 Web 手写 client 的 `getSnapshot(): StoreSnapshot` 与 SDK 的 `getSnapshot(): Promise<UiSnapshot>` 同名不同义，必须消除。

目标固定为：

```ts
runtime.client?.getSnapshot(): Promise<UiSnapshot> | undefined; // 有活动 workspace 时的后端查询
runtime.store.getSnapshot(): StoreSnapshot;       // 本地同步状态
```

组件要观察渲染状态时只订阅 `runtime.store`；业务代码确认存在活动 workspace、需要权威后端快照时才调用非空 client 的 `getSnapshot()`。不再给 client 增加“同步读 store”的同名捷径，也不靠 getter 抛错表达 empty state。

## 4. 已确认：一条 SSE、一次解包、一个 UiEvent 数据流

准确表述是：**每个活动 workspace 在任一时刻只有一个逻辑 SSE 订阅**。

- 网络重连可以关闭旧物理连接并建立新连接；这仍是同一逻辑订阅。
- workspace 切换必须先使旧 client/旧 generation 失效，再为新 workspace 建立订阅。
- `hello`、transport `error`、`resync-required` 是连接控制消息，不伪装成 SDK `UiEvent`。
- `ui.event` 只在 BrowserDaemonClient 解包一次。
- 初始 snapshot 与 resync snapshot 构造已有的 `snapshot.replaced`，进入同一个 `dispatchUiEvent`。
- 分发顺序固定为：先按 sequence 更新 store，再通知 SDK `subscribeEvents` 的 subscriber；失败或过期事件不得通知。

这里的“一个数据流”不是要求 snapshot HTTP 响应也来自 SSE，而是要求进入应用后的状态事实都通过同一个 `UiEvent` 分发点，避免 store 和 subscriber 看见不同世界。

## 5. 已确认：Web façade 的职责

浏览器专有的具名动作继续存在，但不污染 SDK：

| 浏览器动作 | 归属 | 对 SDK 的委托 |
|------------|------|---------------|
| `openWorkspace` / `switchWorkspace` / `hideWorkspace` | runtime | 控制面 HTTP + client 生命周期 |
| `getDirectoryPickerRoots` / `listDirectoryPicker` | runtime | 控制面 HTTP |
| `createSession` | runtime | 生成/选择会话的 Web 编排，可委托具名 command |
| `selectSession` | runtime | Web 导航/活动会话编排 |
| `abortSession` | runtime 或 UI helper | 从 store/输入解析 `runId` 后调用 `client.abortRun(runId)` |
| `executeSlashCommand(text)` | runtime 或 UI helper | 解析文本后调用 `client.executeCommand(invocation)` |

是否把少量 helper 放在 runtime 实现文件或邻近模块属于可逆细节；关键约束是它们不能重新组成一份与 `UiBackendClient` 平行的完整接口。

## 6. 已确认：各端 Prompt 用法

- 非交互 `run` 命令需要等任务结束后再销毁 host，使用 `submitPromptAndWait`，并显式解释 completion status。
- TUI 需要快速接单、继续响应输入和观察事件，使用 `submitPromptAccepted`；最终状态由 `prompt.updated` 等 SDK 事件进入 store，不再把旧 Promise rejection 当作业务失败通知。
- Web 继续接单即返回，但改用 SDK 名称和参数：`submitPromptAccepted(text, options)`。
- 需要按 ID 等待的调用方使用 `waitForPrompt`；等待中止不等于取消 Prompt。

## 7. 已确认：Server 与审计不重复

记录所有权沿用 improve-1：

- REST 写：Server REST gateway 记录；
- JSON-RPC 写：Server RPC gateway 记录；
- 本地 in-process 写：Agent host gateway 记录；
- BrowserDaemonClient、scheduler、persistent/in-process raw backend 不记录。

Server 包与 Agent 包都可以提供 recorder 实现，但同一请求链只能经过一个开启记录的外部 gateway。Server 持有的 raw Agent backend 不再经过 Agent host gateway，因此不会双记。集成测试必须验证真实 composition root，而不是只验证 mock。

记录继续 fail-open：recording 失败不改变业务返回；诊断有界、不递归、不无限重试。

## 8. 已确认：删除而非永久兼容

完成迁移后删除：

- `submitPrompt(...): Promise<void>` 及 JSON-RPC `submitPrompt` method；
- 混合职责的 `UiPromptQueueClient`；
- `supportsPromptQueue()` 和旧 fallback；
- 手写 `OhbabyWebClient` 完整业务合同；
- `CoreAPI` / `SDKAPI` 的手抄方法列表和无价值逐方法 wrapper；若它们仍表达 fake-RPC 正向调用/反向 callback seam，则保留由权威能力 `Pick/Omit` 派生的薄 alias，不为“少两个名字”牺牲边界语义；
- TUI 对 SDK event 的重复联合和 `Partial<UiPromptQueueClient>`。

不通过保留旧名字的 alias 假装收口。若外部发布兼容要求阻止删除，应停止本轮发布并重新确认版本策略，而不是暗中长期双轨。

## 9. 未决项

没有会改变本轮架构的未决项。HTTP route 具体路径、错误类名称、helper 文件位置与 commit 划分可以在实施时按现有代码风格决定，但必须满足 02 的数据流和 04 的可观察验收。
