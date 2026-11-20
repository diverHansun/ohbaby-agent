# 1. 现状与问题分析

> 时间口径：2026-11-20，`main` 分支 `bdd2a74c`。行号是当时的快照，定位以符号为准。
>
> 路径缩写：`agent/` 指 `packages/ohbaby-agent/src/`，`sdk/` 指 `packages/ohbaby-sdk/src/`，`server/` 指 `packages/ohbaby-server/src/`，`web/` 指 `apps/ohbaby-web/src/`，`cli/` 指 `packages/ohbaby-cli/src/`。

## 1.1 问题陈述

1. **界面没说清 Default 是做什么的。** Default 只决定新会话和没选过模型的会话用什么，可 Models 页只显示一个 `Default` 标记，没有说明。用户在 prompt 框里选过模型后再改 Default，会话没反应，于是以为 Default 没用。session-model 议题的 D13 计划在列表顶部加一行说明，代码里没有落地。
2. **子代理只能继承父会话的模型。** 想让子代理用更便宜或更强的模型，现在做不到。
3. **没有地方放子代理的思考档位。** 子代理的档位也只能继承父会话，而父会话的档位是按父会话的模型选的，换了模型以后不一定能用。

## 1.2 Default 现在管什么

Default 就是 `model.json` 里的 `activeProfileId`（session-model D9）。核心解析函数是 `resolveModelEntry(document, modelEntryId?)`（`agent/config/llm/model-document.ts:525`）：

- 传了条目 id 且条目存在：用这个条目，`source: "explicit"`。
- 没传，或者传了但条目已被删除：用 `activeProfileId` 指向的条目，`source: "default"`；条目被删时还返回 `removedEntryId`。
- 要用的条目（显式的或 Default）不存在时抛 `No active model configured`，存在但不完整时抛 `MODEL_CONFIG_INCOMPLETE`。

各个用到模型的地方：

| 用途 | 用哪个模型 | 代码锚点 |
|---|---|---|
| 主对话的一轮 | 会话选过的模型；没选过就用当时的 Default，每轮重新读，不写进会话 | `resolveRunModel`，`agent/adapters/ui-inprocess.ts:3202` |
| 排队消息 | 提交时记下的选择 | `agent/adapters/ui-inprocess.ts:2245` |
| 会话标题 | 这一轮的 `runModel.client` | `scheduleSessionTitleGeneration`，`agent/adapters/ui-inprocess.ts:4108`；`agent/services/session/title-generator.ts` |
| 自动压缩 | 这一轮的 `runModel.summaryClient` | `agent/adapters/ui-runtime/run-model.ts:45` |
| 手动 `/compact` | 会话的模型，没有就用 Default | `agent/adapters/ui-runtime/composition.ts:1497` |
| 子代理 | 父会话这一轮的 `RunModel`（见 1.3） | `agent/agents/subagent-host.ts:576` |
| side chat（`/btw`） | 打开时复制主会话的 `modelEntryId` 和 reasoning；主会话没选过，side chat 也跟随 Default | `agent/services/session/copy-history.ts:316` |
| 会话模型被删 | 清掉会话的 `modelEntryId`，退回 Default，发 “Model removed” 提示 | `agent/adapters/ui-inprocess.ts:3214` |
| 草稿状态显示 | Default | `currentConnectModelFromOptions`，`agent/adapters/ui-inprocess.ts:3268` |

结论：Default 不是给标题或 side chat 专用的。所有用到模型的地方都按“这一轮实际用的模型”走，Default 只在会话没有自己的选择时才起作用。这和 session-model D1、D11 一致，代码与文档没有偏差，问题只在界面说明（问题 1）。

## 1.3 子代理怎么拿到模型

### 1.3.1 模型

- 子代理工具（`agent`）的参数有 `action`（spawn、send、list、monitor、stop、close）、`prompt`、`name`、`description`、`role` 等，没有 `model`（`agent/tools/subagent.ts:223`）。
- 新的一次执行只有一个入口：`launch` → `launchExecution`。这里调 `getParentRunModel(parentSessionId, parentContextScopeId)` 拿模型（`agent/agents/subagent-host.ts:576`），作为必填的 `runModel` 传给 `startExecution`（同文件 `:620`、`:1604`）。
- spawn 走这个入口。send 分两种情况（`sendMessage`，同文件 `:365` 至 `:373`、`:738` 至 `:757`）：
  - 子代理正在运行：消息经 `acceptExecutionMessage` 并入当前这次执行，模型不重新解析。
  - 子代理空闲：走 `launch`，和 spawn 是同一段代码。
- 执行时还有一个兜底 `input.runModel ?? getParentRunModel(...)`（同文件 `:1832`），但 `startExecution` 总会传 `runModel`，旧版排队输入也已经被关掉（`:1651`），所以这个兜底实际走不到。
- `getParentRunModel` 在组装运行时时接好：先取父会话正在运行那一轮的 `RunModel`，父会话没在运行时再按父会话解析（会话的选择，或 Default）（`agent/adapters/ui-runtime/composition.ts:1134`）。

### 1.3.2 思考档位

- 档位走另一条路：`getParentReasoning` 读父会话正在运行那一轮的 `ReasoningIntent`（`agent/runtime/run-manager/manager.ts:372`），在 `launchExecution` 里合并后传进去（`subagent-host.ts:572`、`:614`）。spawn 和 send 到空闲子代理都会继承父会话的档位，`docs/agents/context-isolation.md` 写的也是这个行为。
- 主会话的档位要过两道处理：
  - 和条目默认档位合并：`mergeReasoningIntent(runModel.client.config.reasoning, params.reasoning)`（`agent/agents/service.ts:28`）。
  - 在提交路径上过滤一次（`filterReasoningPreference`，`agent/adapters/ui-inprocess.ts:3335`；兼容判断 `compatibleReasoning`，`:3351`）：不兼容就丢掉，改用模型默认档位，并发 `model:reasoning-fallback:<sessionId>` 提示。
- 子代理的档位不过滤：`subagent-host.ts:614` → `instance.turn` → `agent/core/lifecycle/lifecycle.ts:552` 直接用传进来的 intent，最后由 LLM 包的 `resolveRequestReasoning` 处理，遇到不兼容的档位会直接抛错。现在不出问题，是因为父会话的档位已经按同一个模型过滤过。

子代理一旦换了模型，父会话的档位就可能和新模型对不上，而子代理这条路上没有过滤。所以方案里模型和档位必须一起决定，换模型时还要补一次过滤（见 02 P4、P9）。

### 1.3.3 Agent 配置禁止写模型

`assertNoStaticModelConfig` 拒绝 Agent 配置里的 `model`、`maxTokens`、`temperature`、`topP`（`agent/agents/types.ts:46`），并在 Registry、AgentService 和 SubagentHost 里调用。Agent 配置的 zod schema 是 `.strict()`，没有 `model` 字段（`agent/config/agents/types.ts:111`）。这条限制本轮不动（00 §4）。

### 1.3.4 子代理内部的预算和压缩

`RunModel` 里带着这个模型的客户端、token 计数器和摘要客户端（`createRunModel`，`agent/adapters/ui-runtime/run-model.ts:9`）。子代理用哪个 `RunModel`，它的上下文预算和压缩就按哪个模型算。所以只要给子代理换一个 `RunModel`，上下文窗口和输出上限会自动跟着换，不需要额外处理（00 D6）。

### 1.3.5 已核实的边界情况

| 情况 | 现状 | 代码锚点 |
|---|---|---|
| side chat 起子代理 | 不允许 | `agent/adapters/ui-runtime/composition.ts:481` |
| 子代理再起子代理 | 不允许，带 `isSubagent` 或 `parentId` 的会话会被拒绝 | `composition.ts:1103` |
| goal 续跑、后台任务唤醒 | 都是主会话的轮次，子代理从同一个入口起 | 1.3.1 |
| 子代理会话的上下文用量显示 | 不显示 | `agent/adapters/ui-inprocess.ts:4489` |
| prompt cache 用量统计 | 跳过子代理 | `agent/adapters/ui-inprocess.ts:1300` |
| 请求实际发往哪个模型 | 消息上记录 `modelOrigin`；Web 的子代理面板不显示模型 | `agent/core/lifecycle/lifecycle.ts:1928` |

所以只要改 `launchExecution` 这一个入口，所有起子代理的场景都会覆盖到。

## 1.4 模型库数据

- 磁盘格式只有 `schemaVersion`、`activeProfileId`、`models`（`ModelDocument`，`agent/config/llm/model-document.ts:46`）。
- `normalizeModelDocument` 按已知字段重建文档（`model-document.ts:279`），不认识的顶层字段读进来就丢掉，写回时也不保留，但不会报错。新增顶层字段时要把它加进这个函数。
- 条目“不完整”（`configurationComplete`，`model-document.ts:83`）只看 `needsConfiguration`、`baseUrl` 和 `interfaceProvider`，不看 API key。`needsConfiguration` 只在迁移旧文件时设置，patch 接口也不能清空 `baseUrl` 和 `interfaceProvider`。所以条目不完整只会出现在手改文件或迁移来的旧条目上；清掉 key 不会让条目变成不完整，只会让请求鉴权失败。
- 设默认：`selectModelEntry` 要求条目完整，写 `activeProfileId`，再启动一次后台能力探测（`agent/config/llm/writer.ts:468`）。
- 删除：`deleteEntries` 删到默认条目时，按顺序把下一个完整条目设为默认（`writer.ts:506`）。它返回的是内存里的文档投影，不是重新 normalize 后的结果。
- 写入都在 `coordinateModelConfig` 里串行执行。

## 1.5 接口、SDK 与提示

- `UiSettingsModels` 只有 `active` 和 `models`（`sdk/contract/settings.ts:192`）。每个 `UiSettingsModel` 带 `reasoning` 能力视图和 `reasoningDefault`（同文件 `:178`），Web 可以直接用它们画档位选项。
- 设默认的接口是 `POST /v1/settings/models/active`（`server/protocols/web/routes/global-settings.ts:109`），写完后 `ctx.notify(["model"])`。路由同时登记在 `server/app/openapi.ts`，`server/app/create-app.unit.test.ts` 精确列出了所有路由。
- Web 客户端：`settings.selectModel(id)`（`web/api/daemon/settings-client.ts:97`）。
- TUI 走另一条路：`UiBackendClient.selectDefaultModel(entryId)`（`sdk/contract/client.ts:285`），经 JSON-RPC（`server/protocols/jsonrpc/protocol.ts`、`rpc-route.ts`、`client.ts`）和 `agent/host/ui-command-gateway.ts` 到 `ui-inprocess.ts` 里的实现。Web 端的 `web/api/daemon/client.ts`、`client-commands.ts` 也实现了 `UiBackendClient`，新增方法时要一起补。
- `/models` 的行数据类型是 `CommandModelSummary`（`agent/commands/types.ts:59`），输出前经过白名单 `sanitizeModelSummary`（`agent/commands/builtin.ts:129`），新字段不加进白名单会被过滤掉。
- 提示（notice）：后端每次 `publishNotice` 都发一条新事件，不按 key 去重（`agent/adapters/ui-inprocess.ts:722`、`:2360`）。TUI 的 store 按 key 替换同名提示（`cli/tui/store/events.ts:1538`）。Web 直接忽略 `notice.emitted`（`web/api/daemon/eventReducer.ts:454`），所以后端提示在 Web 上看不到。

## 1.6 Web 的 Models 面板

`web/ui/settings/ModelsSection.tsx`：

- 标题栏只有 “Models” 和 “Add model”（`:171`），没有任何说明文字。
- 模型按 provider 分组。默认那一行显示 `Default` 标记；不完整的显示 “Needs setup”。
- 每行的 “…” 菜单里有 “Set as default”（只对完整且不是默认的条目显示）和 Delete（`:285`）。
- 有两个删除确认框：删单个模型的文案在 `web/ui/settings/model-form.ts:264`（“Chats using this model will switch to the default model.”，删的是默认模型时另外说明谁会顶上）；删整个 provider 的在 `ModelsSection.tsx:381`。

现在没有任何子代理相关的入口。

## 1.7 TUI 的 `/models` 面板

`cli/tui/components/dialog/models-panel.tsx`：

- 第一行是 “This chat” 或 “Next chat”，后面跟当前模型的摘要（`:178`）。
- 每行显示模型名，当前会话用的打 ` ✓`，默认的后面加暗色的 ` · default`（`:198`）。
- 按键：Enter 给这个会话换模型（`:124`），`d` 设为默认（`:136`）。Esc 由 `cli/tui/components/dialog/command-panel-manager.tsx:128` 统一处理，按下直接关掉整个面板。
- 行数据来自 `/models` 展示命令，后端是 `listModelsFromOptions`，每行带 `active` 和 `default` 两个标记（`agent/adapters/ui-inprocess.ts:3476`）。
- `getCurrentModel({ modelEntryId })` 不带 `sessionId` 时，能拿到这个条目的档位能力视图（`agent/adapters/ui-inprocess.ts:3268`）；带了 `sessionId` 就以会话为准，忽略 `modelEntryId`（`sdk/contract/client.ts:204`）。
- 选档位用的是 `effort-panel.tsx`。它的 `choicesFor`（`:27`）把能力视图转成档位选项，但没有导出；能力还在探测（`detecting`）时，它会轮询（`:99`）。

## 1.8 测试现状

- session-model 的 T11 覆盖了子代理继承：父会话用条目 X，子代理请求发给 X；父会话中途切到 Y 后，新起的子代理用 Y（`agent/adapters/ui-runtime/session-model.integration.test.ts`）。这个测试的搭建代码只提供了 `resolveRunModel`（`:106` 至 `:121`）。
- 用 `llmClient` 选项注入假客户端时，客户端池对所有条目返回同一个客户端（`agent/adapters/ui-inprocess/model-client-pool.ts:92`），分辨不出请求发往哪个条目。要区分条目，得用 `createLLMClient` 工厂为每个条目注入不同的客户端。
- `model.json` 读写、Settings 接口有现成的集成测试（`agent/config/llm/__tests__/model-settings.integration.test.ts`、`model-document.integration.test.ts`、`server/app/settings-global.integration.test.ts`）。
- Web 有 `SettingsDialog.integration.test.tsx`。TUI 的 models 面板没有单独的测试文件，`effort-panel.unit.test.tsx` 可以作为写法参考。

## 1.9 改动影响面

| 位置 | 为什么会动 |
|---|---|
| `agent/config/llm/`（文档、写入、投影） | 新增子代理设置字段，读写、删除联动 |
| `agent/agents/subagent-host.ts`、`agent/adapters/ui-runtime/composition.ts` | 起子代理时先看设置 |
| `agent/adapters/ui-inprocess.ts`、`agent/adapters/ui-inprocess/` | 解析子代理设置；TUI 用的后端命令；`/models` 数据 |
| `agent/commands/`、`agent/host/` | `CommandModelSummary` 和白名单；命令记录与网关 |
| `sdk/contract/` | `UiSettingsModels` 加字段；新增接口类型和 `UiBackendClient` 方法 |
| `server/` | 新路由、OpenAPI 登记、JSON-RPC 透传 |
| `web/` | Default 说明、子代理设置入口、两个删除确认框、`UiBackendClient` 实现、mock |
| `cli/tui/components/dialog/` | Default 说明、子代理设置入口、Esc 处理 |

不涉及会话表结构，不涉及 LLM 包。

## 1.10 SWE 原则审视

- **改动集中。** 所有起子代理的场景都经过 `launchExecution` 这一个入口（1.3.5），在这里加一步“先看设置，再继承”就够了。
- **模型和档位要一起决定。** 现在是两个独立的回调。只换模型、不换档位，会出现“子代理用 B 模型、却拿着为 A 模型选的档位”的错配；子代理这条路上又没有档位过滤，错配会直接让请求报错。
- **不要提前抽象。** 本轮只有一个全局设置。不要为了以后“按角色配”先做成角色到模型的映射表，以后真要做时再加一层。
- **数据放在它所属的地方。** 子代理设置引用的是模型条目，和 `activeProfileId` 同属模型库，放进 `model.json` 最自然。删除条目时，引用要在同一次写入里一起清掉，避免留下悬空的 id。
- **`ui-inprocess.ts` 已经约 6400 行。** 新逻辑放进 `agent/adapters/ui-inprocess/` 下的独立文件，和 `model-client-pool.ts` 放在一起。

## 1.11 与既有文档关系

| 文档 | 关系 |
|---|---|
| `docs/problem-lists/2026-10-25-session-model/improve-1/00-discussion.md` | D1、D9、D10、D11 沿用；D14 的“子代理继承”变成“跟随会话”时的行为；D13 的说明行由本议题补上 |
| `docs/config/llm/data-model.md`、`dfd-interface.md` | 描述 `model.json` 格式和设置接口，新增字段和接口后要同步 |
| `docs/agents/context-isolation.md` | 写着“空闲实例的新执行重新解析当前会话模型”，要补上子代理设置 |
| `docs/agents/test.md` 开头的说明 | 写着“子代理继承 host 模型”，要补一句“未设置子代理模型时” |
