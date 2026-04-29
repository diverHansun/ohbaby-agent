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
│ ohbaby-agent         │          │ ohbaby-tui           │
│ backend adapter      │          │ frontend surface     │
│ implements client    │          │ consumes client      │
└─────────────────────┘          └─────────────────────┘
```

SDK 内部由三类能力组成：

| 组件 | 职责 |
|------|------|
| DTO layer | 定义 snapshot、event、command、interaction 等传输结构 |
| Command grammar | 提供 slash command 词法解析和 argv 切分 |
| Catalog resolver | 基于 backend catalog 做匹配、alias 解析和补全过滤 |

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

### 3. Event-Only Result Flow

Client 方法提交请求后返回 `Promise<void>`，业务结果通过事件回流。

**理由**：
- 与 permission/interaction 的异步等待模型一致。
- 避免同步返回、pending token 和事件混用。
- UI hook 只需要处理一种数据回流模型。

### 4. 未使用的模式

**未使用 zod schema 执行**：schema 校验留给 backend command。SDK 不应承载 plugin/MCP/user command 的业务 schema。

**未使用全局 registry**：catalog 由 backend 下发，SDK 不维护静态命令表。

---

## 三、Module Structure & File Layout（模块结构与文件组织）

建议结构：

```
packages/ohbaby-sdk/src/
├── index.ts                 # 对外出口
├── client.ts                # UiBackendClient 契约
├── events.ts                # UiEvent union 与事件命名
├── snapshot.ts              # UiSnapshot / runtime state
├── command/
│   ├── types.ts             # UiCommandSpec / invocation / result metadata
│   ├── parse.ts             # parseSlashInput()
│   └── resolve.ts           # resolveCommand(), filterCommandCatalog()
└── interaction.ts           # UiInteractionRequest / response
```

### 对外稳定接口

- `UiBackendClient`
- `UiEvent`
- `UiSnapshot`
- `UiCommandSpec`
- `UiCommandInvocation`
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
