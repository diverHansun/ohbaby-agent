# ohbaby-sdk 模块 architecture.md

本文档描述 `ohbaby-sdk` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

`ohbaby-sdk` 是 wire protocol 包，位于 frontend surface 和 backend adapter 之间：

```
┌─────────────────────────────────────────────────────────┐
│              ohbaby-sdk（wire protocol）                 │
│  DTOs · parseSlashInput · resolveCommand · filterCatalog │
│  UiCommandSpec · UiCommandInvocation · UiEvent namespaces│
│  零业务 runtime 依赖，可在 Node / Worker / WASM 中运行     │
└──────────────────────────┬──────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
┌─────────────────────┐          ┌─────────────────────┐
│ ohbaby-agent         │          │ ohbaby-cli           │
│ backend adapter      │          │ frontend surface     │
│ implements client    │          │ consumes client      │
└─────────────────────┘          └─────────────────────┘
```

SDK 内部由六类能力组成：

| 组件 | 职责 |
|------|------|
| DTO layer | 定义 snapshot、event、command、interaction 等传输结构 |
| Command grammar | 提供 slash command 词法解析和 argv 切分 |
| Catalog resolver | 基于 backend catalog 做匹配、alias 解析和补全过滤 |
| Client contracts | Query、Prompt Command、Queue Command 与完整 backend 能力组合 |
| In-process RPC seam | 在保留 JSON clone、异步、错误与 AbortSignal 边界的同时，把 connected implementation 作为 method receiver 调用 |
| Observation contract | `UiCommandRecord`、recorder 端口、脱敏 builder 与 fail-open helper |

Observation contract 只描述“记录什么”和“如何 best-effort 提交”，不决定“写到哪里”。默认 Agent/Server composition 注入本地 no-op；需要持久化或转发的集成者显式注入 recorder，并由创建者管理 drain/flush。任何低层 recorder 都不得隐式选择 stdout/stderr。

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Protocol Package

SDK 采用协议包模式，而不是业务 SDK 模式。它只定义两端如何通信，不实现任何 command 或 lifecycle 行为。

**理由**：
- UI 可以独立演进和测试。
- Backend 可以更换 in-process、HTTP、WebSocket 等 adapter。
- 非交互 CLI、TUI、remote UI 可共享同一协议。

### 2. Pure Parser + Resolver

Slash command 解析拆成纯词法解析和 catalog resolver。

**理由**：
- Parser 不需要知道命令目录。
- Resolver 只消费 backend 下发的 catalog。
- 补全和执行可以共享同一解析结果，但执行仍要求 exact catalog match。

### 3. Explicit Prompt Lifecycle + Event Stream

事件流负责连续增量；Prompt 方法负责表达调用方需要等待到哪个生命周期点：

- `submitPromptAccepted`：可靠接单后返回 receipt；
- `waitForPrompt`：按 promptId 等待严格终态；
- `submitPromptAndWait`：前两者的唯一组合实现。

**理由**：
- Web 可接单即返回，CLI 可等待完成后退出。
- 不用同一个方法名承载两个 Promise resolve 时机。
- completion 只描述状态和结构化错误，完整回答仍从 snapshot/event 数据流读取。

### 4. Thin Named Gateway + Uniform Record

业务代码继续调用具名方法；Agent/Server 最外层 gateway 为原子写生成统一 `UiCommandRecord`。record 不是 RPC envelope，raw backend 不自记，组合方法和 skill 内部再写也不重复记账。

### 5. 未使用的模式

**未使用 zod schema 执行**：schema 校验留给 backend command。SDK 不应承载 plugin/MCP/user command 的业务 schema。

**未使用全局 registry**：catalog 由 backend 下发，SDK 不维护静态命令表。

### 6. Receiver-safe In-process RPC

`createRPC()` 每次按 method name 从当前 connected implementation 动态取方法，并以该 implementation 作为 JavaScript receiver 调用。这样 object literal、closure、bound/arrow function 与 class prototype method 都遵守各自的标准调用语义；transport 不需要预绑定原型链或维护方法清单。

该 seam 只模拟传输边界：参数和结果继续跨 JSON clone，错误继续序列化重建，`AbortSignal` 继续 out-of-band 传递，callback API 继续直通。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-sdk/src/
├── index.ts                 # 对外出口
├── client.ts                # UiBackendClient 契约
├── prompt.ts                # receipt、队列实体与严格终态
├── command-record.ts        # 记录合同、脱敏与 fail-open helper
├── events.ts                # UiEvent union 与事件命名
├── snapshot.ts              # UiSnapshot / runtime state
├── rpc/
│   ├── types.ts             # CoreAPI / SDKAPI 正反向端口
│   └── proxy.ts             # receiver-safe in-process RPC seam
├── slash-command/
│   ├── types.ts             # UiCommandSpec / invocation / result metadata
│   ├── parse.ts             # parseSlashInput()
│   └── resolve.ts           # resolveCommand(), filterCommandCatalog()
└── interaction.ts           # UiInteractionRequest / response
```

### 对外稳定接口

- `UiBackendClient`
- `UiQueryClient` / `UiCommandClient`
- `UiPromptCommandClient` / `UiPromptQueueCommandClient`
- `UiPromptReceipt` / `UiPromptCompletion`
- `UiCommandRecord` / `UiCommandRecorder`
- `UiEvent`
- `UiSnapshot`
- `UiCommandSpec`
- `UiCommandInvocation`
- `CoreAPI` / `SDKAPI`
- `createRPC()`
- `parseSlashInput()`
- `resolveCommand()`
- `filterCommandCatalog()`

### 内部实现

- argv 切分实现。
- catalog filter 排序策略。
- suggestion 文本生成策略。

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 约束 1: SDK 不知道后端模块

**当前选择**：SDK 不 import backend 的 Bus、lifecycle、commands、session、message。

**代价**：一些类型需要在 SDK 中显式复制为 DTO，而不是直接复用 backend 内部类型。

**理由**：DTO 是协议，不应泄漏内部实现结构。

### 约束 2: Catalog 不常驻 snapshot

**当前选择**：catalog 通过 `listCommands(surface)` 按需拉取，变化时发 `command.catalog.updated`。

**代价**：UI 首次连接需要多一次 RPC。

**理由**：catalog 低频变化，不应膨胀高频 snapshot。

### 约束 3: 执行 exact match，补全可智能

**当前选择**：执行命令必须解析到明确 catalog item；输入 `/model xxx` 不自动推断为 `/model switch xxx`。

**代价**：熟练用户少一个快捷写法。

**理由**：命令可能改变状态，执行路径必须可预期。

### 约束 4: Connected implementation 保留 receiver

**当前选择**：fake-RPC 调用 method 时显式使用 connected implementation 作为 receiver。

**代价**：所有 implementation method 都获得标准对象方法语义；不支持依赖 `this === undefined` 的非标准实现。

**理由**：`CoreAPI` 的合法实现可以是持有连接状态的 class。transport 不能在抽取 method 后破坏其契约，也不应把绑定责任泄漏给每个 adapter。
