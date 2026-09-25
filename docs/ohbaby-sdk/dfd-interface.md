# ohbaby-sdk 模块 dfd-interface.md

本文档描述 `ohbaby-sdk` 在 UI surface 与 backend adapter 之间的数据流和接口定义。

---

## 一、Context & Scope（上下文与范围）

SDK 位于 `ohbaby-agent` 和 `ohbaby-cli` 之间：

```
ohbaby-cli / stdout renderer / remote UI
        │
        │ UiBackendClient
        ▼
ohbaby-sdk DTO + parser + resolver
        ▲
        │ implements
ohbaby-agent adapter
```

本文档只描述 SDK 协议层的数据如何流动，不描述 backend 内部 Bus 或 TUI 组件实现。

---

## 二、Data Flow Description（数据流描述）

### 2.1 初始连接

1. UI surface 持有 `UiBackendClient`。
2. UI 调用 `getSnapshot()` 获取聊天首屏状态；审批并行安装独立订阅并读取轻量基线，不等待历史/model。
3. UI 调用 `listCommands({ surface })` 获取当前 surface 可见 catalog。
4. UI 调用 `subscribeEvents(handler)` 接收增量事件。
5. UI 使用 snapshot 和 catalog 构建本地 store。

### 2.2 Prompt 提交

1. UI 收集用户输入。
2. UI 调用 `submitPromptAccepted(text, options)`，接单成功后立即获得 `UiPromptReceipt` 和 `promptId`。
3. Backend adapter 持久化接单并按 session FIFO 调度 run。
4. Backend 通过单一 `UiEvent` 流发布 prompt、run、message、runtime 增量。
5. 需要明确终态的调用方使用 `waitForPrompt(promptId, { signal? })`；四种业务终态均 resolve `UiPromptCompletion`。
6. 只想一次调用完成上述两步的调用方使用 `submitPromptAndWait`；它只是 accepted + wait 的共享组合，不是第三条执行路径。

### 2.3 Slash command 提交

1. UI 使用 `parseSlashInput()` 判断输入是否为 slash command。
2. UI 使用 `resolveCommand(catalog, parsed)` 做 exact match。
3. 若无法匹配，TUI surface 显示本地错误和 suggestion；IM/channel surface 可按策略转为普通 chat。
4. 匹配成功后 UI 构造 `UiCommandInvocation`。
5. UI 调用 `executeCommand(invocation)`。
6. Backend 通过 `command.started`、`command.result.delivered` 或 `command.failed` 回流结果。

### 2.4 Interaction round-trip

1. Command 执行中需要用户选择或确认。
2. Backend 发布 `interaction.requested`，包含 `interactionId`、`kind`、`subject` 和 options。
3. UI 根据语义渲染自己的 picker/dialog。
4. 用户完成选择后，UI 调用 `respondInteraction(interactionId, response)`。
5. Backend resume command，并继续通过事件回流结果。

### 2.5 Catalog 更新

1. Backend 因用户命令、MCP、plugin 或配置 reload 更新 catalog。
2. Backend 发布 `command.catalog.updated`，包含新版本号和原因。
3. UI 调用 `listCommands({ surface })` 拉取最新 catalog。
4. UI 替换本地 catalog，补全和提示立即使用新版本。

---

## 三、Interface Definition（接口定义）

### Client 能力

| 接口                                                | 数据流位置              | 语义                                                 |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| `getSnapshot()`                                     | 初始连接                | 获取 UI 首屏状态                                     |
| `subscribeEvents(handler)`                          | 所有异步回流            | 订阅 SDK 事件                                        |
| `listCommands(query)`                               | 初始连接 / catalog 更新 | 获取指定 surface 的命令目录                          |
| `submitPromptAccepted(text, options)`               | Prompt 接单             | 接受并持久化后立即返回 receipt                       |
| `waitForPrompt(promptId, options)`                  | Prompt 查询             | 等待严格的四种终态；signal 只中止等待                |
| `submitPromptAndWait(text, options)`                | Prompt 便利组合         | 唯一实现为 accepted + wait                           |
| queue edit/cancel/lease                             | Prompt 队列写           | 编辑、取消和并发租约，生产 backend 必选              |
| `executeCommand(invocation)`                        | Command 提交            | 提交已解析命令                                       |
| `respondPermission(id, response, context)`          | Permission 回填         | 带 epoch/root/generation 回答指定 ID                 |
| `subscribePermissionEvents(handler, onDisconnect?)` | Permission 增量         | 同步订阅，返回取消订阅函数                           |
| `getPermissionSnapshot(query)`                      | Permission 基线         | 独立健康检查及每根 revision；支持 signal             |
| `getSessionIndex()` / `getSelectedSessionId()`      | 轻量元数据              | 不读取完整历史/model                                 |
| `createSession()` / `selectSession(id)`             | 会话绑定                | 创建/选择主会话元数据，返回绑定所需状态              |
| `respondInteraction(id, response)`                  | Interaction 回填        | 响应语义化交互                                       |
| `abortRun(runId)`                                   | 用户中断                | 按明确的 `UiRun.id` 中断运行；不用于取消 interaction |

### Parser / Resolver

| 函数                                     | 输入                    | 输出                    |
| ---------------------------------------- | ----------------------- | ----------------------- |
| `parseSlashInput(input)`                 | 原始输入文本            | slash 词法结果或 null   |
| `resolveCommand(catalog, parsed)`        | catalog + 词法结果      | resolved command 或错误 |
| `filterCommandCatalog(catalog, partial)` | catalog + partial input | 补全候选                |

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据                 | 创建者                      | 责任                                                                                                                                                      |
| -------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Snapshot             | backend adapter             | 保证反映当前 backend 状态                                                                                                                                 |
| Catalog              | backend CommandService      | 保证分类、可见性、alias 唯一性                                                                                                                            |
| Parsed slash input   | SDK parser                  | 保留输入结构，不判断业务合法性                                                                                                                            |
| Resolved command     | SDK resolver                | 按 catalog 做确定匹配                                                                                                                                     |
| Command result event | backend adapter             | 将 command 输出转为 SDK 事件                                                                                                                              |
| Interaction response | UI surface                  | 只表达用户选择，不执行业务                                                                                                                                |
| UiCommandRecord      | 最外层 Agent/Server gateway | 对 started/completed 分别 best-effort 提交并复用 operationId；raw backend 不记录；默认 composition 提交给本地 no-op，只有显式 recorder 集成才产生外部 I/O |

显式 recorder 是借入端口：Agent/Server 不探测或调用 `flush()` 等端口外方法。创建带队列 recorder 的集成者负责其 sink、diagnostic 与完整生命周期。

---

## 五、错误处理策略

| 场景                                | 处理                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Unknown command                     | TUI 严格报错并给 suggestion；IM/channel 可 unknown-as-chat                |
| Ambiguous alias                     | Backend catalog 构建失败，不下发歧义 alias                                |
| Invalid args                        | Backend command 发布 `command.failed`，code 为 `INVALID_ARGS`             |
| Interaction canceled                | UI 调用 `respondInteraction` 表示 cancel，backend 决定取消或降级          |
| Prompt failed/cancelled/interrupted | 作为 `UiPromptCompletion` 正常 resolve；failed/interrupted 带结构化 error |
| wait 被中止或存储/传输失败          | Promise reject；不改写已接单 prompt 的业务终态                            |

---

## 六、文档自检

- [x] 先描述了数据流，再描述接口。
- [x] 每个接口都能映射到具体数据流。
- [x] Catalog、interaction、command result 的所有权明确。

## 审批同步契约

`UiPermissionSnapshot` 包含 permissionEpoch、rootSessionId、permissionRevision、requests 及可选 bindingGeneration；requested/resolved 每次同步关键提交推进对应 root revision。`permission.unavailable` 表示权威不可用，不能视为正常空列表；`permission.resync-required` 请求重建基线，可携带实际连接代次。

`createPermissionSync` 为 Web/TUI 提供独立 ready 和有界恢复：先订阅后基线，重放连续增量、忽略已覆盖版本，缺口/乱序/溢出重新查询。每周期最多4次、每次10秒、100/250/500ms退避，buffer至多1024条/2MiB。重复hello/gap不重置同一周期预算；实际新连接/新范围/显式重试才重置。严重 unavailable 不自动重试。旧 scope 的查询、事件与应答均不得污染新绑定。全量 `getSnapshot` 形状保留，其 permissions 不覆盖独立同步状态。
