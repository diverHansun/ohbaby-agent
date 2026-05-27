# ohbaby-agent 工作区包架构设计

本文档定义 `ohbaby-agent` 工作区最终的五包结构、跨包依赖规则、以及每个模块的归属。

> **当前状态**：三包（`ohbaby-agent` / `ohbaby-cli` / `ohbaby-sdk`）。
> **目标状态**：五包（`ohbaby-llm` / `ohbaby-host` / `ohbaby-agent` / `ohbaby-cli` / `ohbaby-sdk`）。
> **执行时点**：`ohbaby-cli` 重命名见 [rename-tui-to-cli.md](rename-tui-to-cli.md)；`ohbaby-llm` / `ohbaby-host` 推迟到 MVP 之后（触发条件见 §10）。

本文档不是动作清单——它是**未来拆分的命名规范、归属规范、原则规范**。具体执行计划在拆分启动那一刻再出。

---

## 一、五包总览

```
                         ┌─────────────────────┐
                         │   ohbaby-sdk        │  纯协议层
                         │   (零运行时依赖)      │
                         └──────────┬──────────┘
                                    │ 类型 / DTO / 解析
                ┌───────────────────┼───────────────────┐
                │                   │                   │
       ┌────────▼────────┐  ┌───────▼────────┐  ┌──────▼──────┐
       │  ohbaby-llm     │  │  ohbaby-host   │  │  ohbaby-cli │
       │  LLM 抽象层      │  │  宿主访问层     │  │  前端应用    │
       └────────┬────────┘  └───────┬────────┘  └──────┬──────┘
                │                   │                   │
                └───────┬───────────┘                   │
                        │                               │
                ┌───────▼───────────────────────────────┘
                │
        ┌───────▼───────────────────────────┐
        │   ohbaby-agent                     │
        │   会话编排 / 工具调度 / 命令服务等   │
        └────────────────────────────────────┘
```

依赖方向**严格单向**：

| 包 | 允许依赖 |
|---|---|
| `ohbaby-sdk` | （无 workspace 依赖） |
| `ohbaby-llm` | `ohbaby-sdk` |
| `ohbaby-host` | `ohbaby-sdk` |
| `ohbaby-agent` | `ohbaby-sdk` / `ohbaby-llm` / `ohbaby-host` |
| `ohbaby-cli` | `ohbaby-sdk` |

**禁止**：

- `ohbaby-llm` 与 `ohbaby-host` 互相依赖
- `ohbaby-cli` 直接依赖 `ohbaby-agent`、`ohbaby-llm`、`ohbaby-host`（必须通过 SDK 协议）
- 任何反向边（如 `ohbaby-llm` 引用 `ohbaby-agent`）

---

## 二、设计原则（提炼自 kimi-code 与 pi）

### P1. 协议包零运行时依赖

`ohbaby-sdk` 的唯一职责是定义**两端如何通信**：DTO、interface、纯解析函数。它不实现任何业务行为，也不依赖任何 vendor SDK。这条原则让协议可以在浏览器 / WASM / 远端 entry 复用。

> 对应 kimi 决策：kimi 走相反路线（其 SDK `@moonshot-ai/kimi-code-sdk` 是"库 SDK"，含 `KimiHarness` 等业务）。ohbaby 沿用 opencode 风格的"协议 SDK"，因为我们已经为未来 remote UI 预埋了 adapter pattern（详见 §6）。

### P2. 叶子包只依赖 vendor，不依赖 workspace 兄弟

LLM 抽象与宿主抽象都是**叶子层**。它们各自管自己的 vendor 依赖（`@anthropic-ai/sdk` 进 `ohbaby-llm`、`ssh2` 进 `ohbaby-host` 等），但**不互相依赖**。

> 对应 kimi 决策：kosong（LLM）与 kaos（host）相互独立，agent-core 同时消费两者。ohbaby 完全复用这个拓扑。

### P3. 一个核心 interface + 多个实现

每个叶子层的核心价值在于**单一接口的多实现**。如果只有一个实现，这层抽象不值得拆包。

- `ohbaby-llm` 的核心 interface 是 `LLMClientInstance`（当前已存在），实现是 Anthropic / OpenAI-compatible（后续可加 Gemini / Bedrock / Kimi 等）。
- `ohbaby-host` 的核心 interface 是 `SandboxAdapter`（当前已存在 `host-local.ts`），实现可扩展为远端、容器等。

> 对应 kimi 决策：`ChatProvider` 接口 + 5 个实现（anthropic / openai-legacy / openai-responses / google-genai / kimi）；`Kaos` 接口 + 2 个实现（LocalKaos / SSHKaos）。

### P4. 工具直接消费 host 抽象，不再包装

文件/进程工具（`read` / `write` / `bash` / `glob`）应该把 `ohbaby-host` 暴露的接口**作为参数**接收，不要再加一层"FileSystem"或"Process"抽象。多一层抽象 = 多一层维护成本，没有第二个消费者。

> 对应 kimi 决策：agent-core 的 `tools/builtin/file/*.ts` 直接 `import type { Kaos } from '@moonshot-ai/kaos'` 并把 `Kaos` 作为参数传入。无中间层。

### P5. 标准化跨 vendor 类型

LLM 包的真正 value-add 是**跨 vendor 标准化的类型**——`FinishReason`、`ThinkingEffort`、`TokenUsage`、`ContentPart`。每个 vendor 的原始值通过 `raw*` 字段保留作 escape hatch。

> 对应 kimi 决策：kosong 的 `FinishReason` 有 `'completed' | 'tool_calls' | 'truncated' | 'filtered' | 'paused' | 'other'`，每个 finish event 同时携带 `rawFinishReason: string | null`。ohbaby 当前 `ProviderFinishReason` 已经走这条路，继续保持。

### P6. CLI / UI 不进入核心包

`ohbaby-agent` 是 library-style，不包含任何 CLI 入口或 UI 渲染。bin 入口由 `ohbaby-cli` 或 `ohbaby-agent/bin.ts`（注意 bin.ts 是 composition root 而非业务）承担。

> 对应 kimi 决策：agent-core 完全不知道 CLI 存在；CLI 在 `apps/kimi-code/`。

### P7. 应用层是 composition root

CLI 应用是**唯一**装配前后端的位置。它实例化 backend adapter 拿到 `UiBackendClient`，再注入 TUI 渲染。CLI 不应感知 backend 的内部模块。

> 对应 docs/cli/architecture.md 现状：`packages/ohbaby-agent/src/bin.ts` 是 composition root。`ohbaby-cli` 包是 TUI 渲染消费者。

### P8. Subpath exports 支持 tree-shaking

每个 provider / impl 提供独立的 subpath export，让消费者只为用到的 vendor SDK 付出包体积。

> 对应 kimi 决策：
> ```json
> "exports": {
>   ".": "./src/index.ts",
>   "./providers/*": "./src/providers/*.ts"
> }
> ```
> ohbaby-llm 应采用同样模式：`"./anthropic"`、`"./openai-compatible"` 等。

---

## 三、各包详述

### 3.1 `ohbaby-sdk`（不变）

**职责**：协议包。定义前后端如何通信，不持有业务实现。

**包含**：

- `UiBackendClient` interface — 前端调用后端的契约
- `UiEvent` / `UiSnapshot` / `UiMessage` / `UiRun` / `UiSession` 等 DTO
- `UiCommandSpec` / `UiCommandCatalog` / `UiCommandInvocation` 协议
- `parseSlashInput()` / `resolveCommand()` / `filterCommandCatalog()` 纯解析函数
- `UiInteractionRequest` / `UiInteractionResponse` / `UiPermissionResponse` 等交互协议

**禁止**：任何 LLM SDK 依赖、任何 Node 内置（`fs` / `child_process`）使用、任何 React 依赖。

**依赖**：无 workspace 依赖。仅 `zod` 可作为 schema 校验。

---

### 3.2 `ohbaby-cli`（Phase 0 完成后存在）

**职责**：用户交互入口的应用包。包含 Ink TUI 渲染，未来包含非交互 stdout 渲染。

**包含**（Phase 0 完成后）：

- `src/index.ts` — 薄壳 re-export
- `src/tui/` — Ink + React 组件、store、dialog、command 路由层

**依赖**：仅 `ohbaby-sdk`（消费协议）。

**不依赖**：`ohbaby-agent`、`ohbaby-llm`、`ohbaby-host`。这条边界保证未来可以把 CLI 拿到远端、连真实 backend over RPC，而不改任何代码。

> bin 命令 `ohbaby` 仍由 `ohbaby-agent` 包提供（其 `bin.ts` 是 composition root），dynamic import `ohbaby-cli` 来渲染 TUI。

---

### 3.3 `ohbaby-agent`（拆分后保留下来的核心）

**职责**：会话编排、工具调度、命令服务、生命周期、持久化、Adapter 装配。

**包含**：

| 子目录 | 当前位置 | 说明 |
|---|---|---|
| `agents/` | 现有 | Agent 定义与运行 |
| `bus/` | 现有 | 事件总线 |
| `commands/` | 现有 | CommandService（catalog + 执行） |
| `config/` | 现有（部分） | 除 `config/llm/` 外都保留（见 §7.1） |
| `core/agents/` | 现有 | runAgent 入口 |
| `core/context/` | 现有 | prepareTurn 上下文组装 |
| `core/lifecycle/` | 现有 | runSession 生命周期 |
| `core/memory/` | 现有 | 持久记忆 |
| `core/message/` | 现有 | MessageManager |
| `core/system-prompt/` | 现有 | 系统提示拼装 |
| `core/tool-scheduler/` | 现有 | 工具调度 |
| `mcp/` | 现有 | MCP 集成 |
| `permission/` | 现有 | 权限管理 |
| `policy/` | 现有 | 策略 |
| `project/` | 现有 | 项目上下文 |
| `runtime/` | 现有 | RunManager / interaction-broker / run-ledger / stream-bridge / daemon |
| `adapters/` | 现有 | **UI 后端 adapter**（ui-inprocess / ui-persistent / ui-state / ui-runtime）—— 注意：与 sandbox/adapters 和 services/providers 同名不同物，见 §6 |
| `services/database/` | 现有 | SQLite/持久化 |
| `services/session/` | 现有 | 会话 store |
| `services/storage/` | 现有 | 文件存储 |
| `services/search-providers/` | 现有 | Tavily/Exa 等搜索工具 provider |
| `skill/` | 现有 | Skill 注册 |
| `snapshot/` | 现有 | Snapshot 服务 |
| `tools/` | 现有 | 工具实现（`bash` 等） |
| `cli/` | 现有 | CLI args / stdin / stdout-renderer / exit-codes（**注意这是 ohbaby-agent 内部的 CLI bootstrap 子模块，与 `ohbaby-cli` 包不同**） |
| `bin.ts` | 现有 | CLI composition root |
| `utils/` | 现有（部分） | 除被 ohbaby-host 用到的部分外都保留（见 §7.2） |

**依赖**：`ohbaby-sdk`、`ohbaby-llm`、`ohbaby-host`。

**关键澄清**：`adapters/` 留在 `ohbaby-agent`，**不进 `ohbaby-llm`**。它装配的是后端 UI 服务（bus + commands + lifecycle + permission + snapshot + session + …），逻辑上属于编排层。`adapter` 这个词在本仓库有三种含义，详见 §6。

---

### 3.4 `ohbaby-llm`（post-MVP 拆出）

**职责**：LLM provider 抽象。一个统一接口包多个 vendor SDK，对外提供标准化的流式消息、token usage、finish reason。

**包含**：

| 来源模块 | 目标位置 | 说明 |
|---|---|---|
| `packages/ohbaby-agent/src/core/llm-client/` | `packages/ohbaby-llm/src/client/` | `createLLMClient`、`streamChatCompletion`、`LLMClientInstance` |
| `packages/ohbaby-agent/src/services/providers/` | `packages/ohbaby-llm/src/providers/` | Anthropic + OpenAI-compatible 实现，未来加 Gemini / Bedrock / Kimi |
| `packages/ohbaby-agent/src/services/llm-model/` | `packages/ohbaby-llm/src/model/` | `modelProfiles` + `tokenCounting` |
| `packages/ohbaby-agent/src/config/llm/` | `packages/ohbaby-llm/src/config/` | `LLMConfig` / `getLLMConfig` 及相关 schema（见 §7.1 决策） |

**依赖**：

- workspace: `ohbaby-sdk`
- vendor: `@anthropic-ai/sdk`、`openai`、（未来 `@google/genai` 等）

**对外 exports**：

```json
{
  ".":          "src/index.ts",
  "./anthropic": "src/providers/anthropic.ts",
  "./openai":    "src/providers/openai-compatible.ts",
  "./model":     "src/model/index.ts"
}
```

**核心 interface 示例**（保持现有 `LLMClientInstance` 形状，加 vendor-neutral fields）：

```ts
export interface LLMClientInstance {
  streamChatCompletion(options: StreamingOptions): AsyncIterable<StreamingResponse>;
  getProvider(): ProviderInstance;
  getModel(): string;
}
```

---

### 3.5 `ohbaby-host`（post-MVP 拆出）

**职责**：宿主访问抽象。封装进程执行、shell 解析、沙箱隔离。一个统一接口包多个执行环境。

**包含**：

| 来源模块 | 目标位置 | 说明 |
|---|---|---|
| `packages/ohbaby-agent/src/shell/` | `packages/ohbaby-host/src/shell/` | shell 检测 / `killTree` / `preflightShellCommand` |
| `packages/ohbaby-agent/src/sandbox/` | `packages/ohbaby-host/src/sandbox/` | `SandboxManager` / `SandboxAdapter` / `host-local` 实现 / lease |
| 部分 `packages/ohbaby-agent/src/utils/` | `packages/ohbaby-host/src/utils/` | 仅 shell + sandbox 用到的：`parseCommand` / `CommandDetail` / `ParsedCommand` / `containsOrEqual` / `lazy`（见 §7.2 决策） |

**依赖**：

- workspace: `ohbaby-sdk`（仅类型）
- vendor: 仅 Node 内置 + 未来按需的 `ssh2` 等

**对外 exports**：

```json
{
  ".":         "src/index.ts",
  "./sandbox": "src/sandbox/index.ts",
  "./shell":   "src/shell/index.ts"
}
```

**演进方向**（参考 kimi 的 kaos）：当 ohbaby 支持 remote / SSH 沙箱时，`SandboxAdapter` 已经预留多实现位置，新增 `sandbox/adapters/ssh.ts` 即可，**接口不变**。这正是 P3 的回报。

---

## 四、模块 → 包 完整映射表

下表列出当前 `packages/ohbaby-agent/src/` 下每个直接子目录最终归属。

| 当前路径 | 目标包 | 备注 |
|---|---|---|
| `adapters/` | `ohbaby-agent` | UI 后端 adapter，**不是 LLM adapter** |
| `agents/` | `ohbaby-agent` | |
| `bin.ts` | `ohbaby-agent` | composition root |
| `bus/` | `ohbaby-agent` | |
| `cli/` | `ohbaby-agent` | CLI bootstrap，**与 `ohbaby-cli` 包不同** |
| `commands/` | `ohbaby-agent` | catalog + 执行 |
| `config/agents/` | `ohbaby-agent` | agent config schema |
| `config/llm/` | `ohbaby-llm` | LLM provider config 与 LLM 同包（§7.1） |
| `config/mcp/` | `ohbaby-agent` | MCP config schema |
| `core/agents/` | `ohbaby-agent` | |
| `core/context/` | `ohbaby-agent` | |
| `core/lifecycle/` | `ohbaby-agent` | |
| `core/llm-client/` | **`ohbaby-llm`** | LLMClientInstance + streamChatCompletion |
| `core/memory/` | `ohbaby-agent` | |
| `core/message/` | `ohbaby-agent` | |
| `core/system-prompt/` | `ohbaby-agent` | |
| `core/tool-scheduler/` | `ohbaby-agent` | |
| `index.ts` | `ohbaby-agent` | barrel |
| `mcp/` | `ohbaby-agent` | |
| `permission/` | `ohbaby-agent` | |
| `policy/` | `ohbaby-agent` | |
| `project/` | `ohbaby-agent` | |
| `runtime/daemon/` | `ohbaby-agent` | |
| `runtime/interaction-broker/` | `ohbaby-agent` | |
| `runtime/run-ledger/` | `ohbaby-agent` | |
| `runtime/run-manager/` | `ohbaby-agent` | |
| `runtime/stream-bridge/` | `ohbaby-agent` | |
| `sandbox/` | **`ohbaby-host`** | 含其内部 `adapters/`（sandbox adapter） |
| `services/database/` | `ohbaby-agent` | |
| `services/llm-model/` | **`ohbaby-llm`** | model profiles + token counting |
| `services/providers/` | **`ohbaby-llm`** | Anthropic + OpenAI-compatible |
| `services/search-providers/` | `ohbaby-agent` | Tavily / Exa（工具用，不是对话） |
| `services/session/` | `ohbaby-agent` | |
| `services/storage/` | `ohbaby-agent` | |
| `shell/` | **`ohbaby-host`** | |
| `skill/` | `ohbaby-agent` | |
| `snapshot/` | `ohbaby-agent` | |
| `tools/` | `ohbaby-agent` | bash 工具会 import 自 `ohbaby-host/shell` |
| `utils/` | 拆 | 见 §7.2 |

Phase 0 已将 `packages/ohbaby-tui/src/` 全部内容迁移到 `packages/ohbaby-cli/src/tui/`（详见 [rename-tui-to-cli.md](rename-tui-to-cli.md)）。

`packages/ohbaby-sdk/src/` 不变。

---

## 五、跨包依赖规则（lint 级强制）

后端拆分启动时，应通过 eslint 或 dependency-cruiser 强制以下规则：

1. **`ohbaby-sdk` 不能 import 任何其它 ohbaby-\*。**
2. **`ohbaby-llm` 不能 import `ohbaby-host` / `ohbaby-agent` / `ohbaby-cli`。**
3. **`ohbaby-host` 不能 import `ohbaby-llm` / `ohbaby-agent` / `ohbaby-cli`。**
4. **`ohbaby-cli` 不能 import `ohbaby-agent` / `ohbaby-llm` / `ohbaby-host`。**（只能通过 `ohbaby-sdk` 协议通信）
5. **`ohbaby-agent` 的 core/services/adapters 不能 import `ohbaby-cli`；唯一例外是 `src/bin.ts` 作为 composition root 可以 dynamic import `ohbaby-cli`。**

第 4 条是最容易被破坏的——TUI 代码自身不能直接调后端 API。第 5 条的 lint 规则必须显式排除 `packages/ohbaby-agent/src/bin.ts`，因为它是合法的 composition root。

---

## 六、`adapter` 一词在本仓库的三种含义

由于"adapter"在不同上下文中所指对象不同，新人极易混淆。明确定义：

### 6.1 UI 后端 adapter — `packages/ohbaby-agent/src/adapters/`

**对象**：`UiBackendClient`（SDK 定义的协议接口）的实现。
**当前内容**：`ui-inprocess.ts`（进程内实现）、`ui-persistent.ts`（DB 持久化实现）、`ui-runtime/`（组合 helper）、`ui-state/`（state store）。
**目的**：让前端通过同一个协议消费任意后端形态（in-process / remote / fake）。
**归属**：`ohbaby-agent`，**不进** `ohbaby-llm` 或 `ohbaby-host`。
**类比 kimi**：kimi 没有这一层，因其 SDK 走"库 SDK"路线；最接近的概念是 `apps/kimi-code/src/tui/reverse-rpc/`。

### 6.2 Sandbox adapter — `packages/ohbaby-agent/src/sandbox/adapters/`

**对象**：`SandboxAdapter` interface 的实现。
**当前内容**：`host-local.ts`（宿主直接执行）。
**目的**：让 SandboxManager 在不同执行环境（local / remote / container）切换。
**归属**：`ohbaby-host`。
**类比 kimi**：等价于 kimi 的 `LocalKaos` / `SSHKaos`——同一个 `Kaos` interface 的多个实现。

### 6.3 Provider adapter — `packages/ohbaby-agent/src/services/providers/`

**对象**：`ProviderInstance` interface 的实现（LLM vendor 包装）。
**当前内容**：`anthropic.ts`、`openai-compatible.ts`。
**目的**：把不同 vendor SDK 包成统一接口。
**归属**：`ohbaby-llm`。
**类比 kimi**：kosong 的 `providers/anthropic.ts`、`providers/openai-legacy.ts` 等。

> **不要把这三种 adapter 互相混淆。** 它们都是"端口-适配器"模式的具体应用，但适配的端口不同：UI 协议端口、沙箱执行端口、LLM 调用端口。

---

## 七、已知边界耦合点与处理方案

实际审计发现，从当前结构走向五包目标，有两处耦合需要明确处理。

### 7.1 `config/llm/` 归属

**现状**：

- `core/llm-client/client.ts` 调 `getLLMConfig()`（from `config/llm/`）
- `core/llm-client/types.ts` 引用 `LLMConfig` 类型（from `config/llm/`）

**两种处理方案**：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 移到 `ohbaby-llm` | `config/llm/` 整片搬进 `ohbaby-llm/src/config/` | 配置与消费者同包；ohbaby-llm 自洽 | 配置加载逻辑离 `config/` 集中点远 |
| B. 在 `ohbaby-llm` 定义最小 interface | `ohbaby-llm` 只声明 `LLMClientConfig` 接口；`ohbaby-agent` 在 `config/` 实现并注入 | 配置仍统一在 `config/` | 多一层 paper interface；ohbaby-llm 不能自启动测试 |

**决策**：采用 **方案 A**。理由：

- `config/llm/` 内容是**纯 LLM 配置**（model alias、API key、endpoint），与 LLM 强绑定，没有跨域共享。
- ohbaby-llm 是叶子包，应当能独立测试——把配置加载放进来，测试自包含。
- kimi 的 kosong 内部也带 `ProviderConfig` 类型与 vendor schema，是同样的处理。

### 7.2 `utils/` 共享问题

**现状**（实测）：

- `shell/preflight.ts` 用到 `utils/` 的 `parseCommand`、`CommandDetail`、`ParsedCommand`、`containsOrEqual`
- `shell/command-classifier.ts` 用到 `utils/` 的 `CommandDetail`、`ParsedCommand`
- `shell/index.ts` 用到 `utils/` 的 `lazy`
- `sandbox/errors.ts` 用到 `utils/` 的 `IrisError`
- `sandbox/lease.ts` 用到 `utils/` 的 `containsOrEqual`

**三种处理方案**：

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 拆专属 utils 进 ohbaby-host | `ohbaby-host/src/utils/` 收纳上述 6 个 helper | host 包自洽 | 与 `ohbaby-agent/utils/` 可能有少量重复 |
| B. 新增 `ohbaby-utils` 包 | 第六个包，专放共享 helper | 复用最大化 | 多一个包；helper 数量太少（< 10 个），不值得 |
| C. 复制 helper | 在 `ohbaby-host` 内复制需要的 helper 函数 | 零依赖、最干净 | 后续维护两份 |

**决策**：采用 **方案 A**。理由：

- 这些 helper 在功能上就是 shell/sandbox 范畴：`parseCommand` 解析 shell 命令；`containsOrEqual` 用于路径包含判断；`lazy` 是惰性初始化（被 shell 探测器用）。它们本来就更"属于" host 层。
- 仍留在 `ohbaby-agent/utils/` 的 helper（应用层用的字符串/对象/异步 helper）不受影响。
- `IrisError` 是 ohbaby 的领域错误基类，被多模块用——它**应当移到 `ohbaby-sdk`**（与协议层错误一致），而非塞进 host。

**配套动作**：

1. 把 `IrisError` 提到 `ohbaby-sdk`
2. `parseCommand` / `CommandDetail` / `ParsedCommand` / `containsOrEqual` / `lazy` → `ohbaby-host/src/utils/`
3. `ohbaby-agent/utils/` 保留剩余 helper，并 re-export `IrisError` from sdk 以兼容老 import

### 7.3 `openai` 类型泄漏

**现状**：`core/llm-client/types.ts` 把 `ChatCompletionMessageParam` re-export 为 `ChatCompletionMessage`——这是 OpenAI vendor 类型直接对外暴露。

**评估**：可接受，但有改进空间。

- kimi 的 kosong 也是类似做法（直接 re-export vendor 类型作为内部消息类型），但它**进一步**有自己的 `Message` / `ContentPart` 类型。
- ohbaby 当前为了对接 OpenAI 协议（chat completions wire format），直接用 OpenAI 类型作 internal message 形态，是务实选择。
- post-MVP 可以引入 ohbaby 自己的标准化 `Message` 类型（参考 kosong 的 `Message` / `ContentPart` / `ToolCall`），作为 vendor 类型的中间层。

**决策**：本次拆包**不做**类型重构。`openai` 依赖随 `ohbaby-llm` 一起迁过去即可。

---

## 八、对照 kimi-code 与 pi 的设计取舍

本节记录 ohbaby 在哪些点上选择跟 kimi 一致，哪些点上有意分歧。

| 议题 | kimi-code | pi | ohbaby（目标） | 取舍说明 |
|---|---|---|---|---|
| SDK 是协议还是库？ | 库 SDK（含 KimiHarness） | 无（agent-core 直接消费） | 协议 SDK | 为远端 UI 留出协议端口 |
| LLM 包 | kosong（leaf） | pi-ai（leaf，含 bin） | ohbaby-llm（leaf） | 同 |
| Host/FS 抽象 | 有（kaos：fs+process+ssh） | 无（散在 coding-agent） | 部分有（仅 process+sandbox） | MVP 不抽 FS；post-MVP 评估是否引入 |
| Agent 核心规模 | 大（compaction / hooks / mcp / profile / loop / tools / session 全在 agent-core） | 小（只有 agent-loop / harness / types；其他在 coding-agent） | 大（接近 kimi） | 单核心便于演进，拆得太细过早上锁 |
| 工具消费 Host | tools 直接拿 `Kaos` 作参数 | tools 直接调 fs/exec | tools 直接调 sandbox/shell | 一致：不再加抽象层 |
| Telemetry | 独立包 `@moonshot-ai/kimi-telemetry` | 无 | 暂无；post-MVP 评估 | 数据量大或多 entry 时再拆 |
| OAuth | 独立包 `kimi-code-oauth` | 无 | 暂无；按需 | 同上 |
| 命令注册表 | 硬编码在 TUI（`apps/kimi-code/src/tui/commands/registry.ts`） | 散在 coding-agent | 后端 catalog（`UiCommandCatalog` 协议推送给前端） | ohbaby 更灵活，支持 MCP / 远端注册 |
| TUI 包结构 | 应用内目录（`apps/kimi-code/src/tui/`） | 独立 TUI 原语库 + 应用包 | 应用包内目录（`ohbaby-cli/src/tui/`） | 与 kimi 一致 |
| CLI args/options | `cli/options.ts` + Commander | `coding-agent/cli/args.ts` | `ohbaby-agent/cli/args.ts`（未来可挪 ohbaby-cli） | 同 |
| 模型清单 | 各 provider 自查（capability-registry） | 生成式（`models.generated.ts`） | `services/llm-model/modelProfiles` | 同 kimi 风格，避免编译期生成成本 |
| 配置 | `agent-core/config/` 内 schema 化 | `coding-agent/config.ts` 单文件 | `config/` 分子模块（llm / agents / mcp） | 与 kimi 接近 |

**ohbaby 的几个独特选择**：

1. **协议 SDK + 后端 catalog**：相比 kimi 把命令硬编码在 TUI，ohbaby 让后端通过 `UiCommandCatalog` 协议推送命令清单。代价是更复杂，回报是 MCP / plugin / skill 动态注册可以无缝接入。
2. **Sandbox 独立模块**：kimi 完全没有 sandbox 概念，靠 `Kaos` 切换 local/ssh 隐式实现"隔离"。ohbaby 显式建模沙箱（lease、boundary 检查、adapter registry），为未来 worktree / container 隔离打基础。
3. **runtime 与 lifecycle 分离**：kimi 把 turn 循环和 session 编排都放 `agent-core/loop` 和 `agent-core/agent`。ohbaby 进一步拆 `core/lifecycle/` (runSession) 与 `runtime/run-manager/` (RunManager 调度并发) 两层。

---

## 九、反模式（不要做的事）

记录将来 contributor 容易犯的错误，集中提示。

### A1. 不要把 `adapters/` 塞进 `ohbaby-llm`

`adapters/` 是 UI 后端 adapter（§6.1），不是 LLM adapter。把它塞进 `ohbaby-llm` 会让 `ohbaby-llm` 反向依赖 bus / commands / lifecycle / snapshot / session 等几乎整个 `ohbaby-agent`，造成循环。

### A2. 不要把 `runtime/` 塞进 `ohbaby-host`

`runtime/` 是**高层会话编排**，不是基础设施。它消费 `sandbox/` 的 lease、消费 SDK 的 `UiInteractionRequest`、被 `core/lifecycle/` 调用。把它塞进"基础包"等于让基础包反过来依赖 SDK 和 lifecycle，分层倒挂。

### A3. 不要给 `ohbaby-cli` 加 `ohbaby-agent` 依赖

哪怕只是为了图方便 `import { someType } from "ohbaby-agent"`。CLI 与 backend 的边界是 `UiBackendClient` 协议（在 SDK 里），加这个依赖等于把这层契约掀掉，未来 remote UI 直接做不了。

### A4. 不要在 `ohbaby-sdk` 加任何 runtime 依赖

不要 import `node:fs`、`node:child_process`、`react`、`@anthropic-ai/sdk`、`openai`、`zod`（仅 schema 校验例外）。SDK 必须能在 browser / WASM 里跑——它是"长什么样"的定义，不是"怎么干"。

### A5. 不要在 `ohbaby-llm` 与 `ohbaby-host` 之间画边

LLM 和 host 没有任何业务关系。如果将来发现某个 helper 两边都要用，那个 helper 应该在 `ohbaby-sdk` 或上层 `ohbaby-agent`，不能让两个叶子互相 import。

### A6. 不要给 `services/` 一个统一含义

ohbaby 的 `services/` 是历史命名，实际上塞了三类东西：

- LLM 子层（`providers/`、`llm-model/`）→ 拆到 `ohbaby-llm`
- 持久化（`database/`、`session/`、`storage/`）→ 留 `ohbaby-agent`
- 工具用 provider（`search-providers/`）→ 留 `ohbaby-agent`

拆包后，"services" 这个名字可以淡化或在 `ohbaby-agent` 内部重组，不必维持现有平铺。

---

## 十、演进方向（post-MVP）

拆包不是一次性动作。下列触发条件出现之一时再启动对应阶段。

### 阶段 A — `ohbaby-llm` 拆出

**触发条件**（任一）：

- 出现第二个 entry 需要复用 LLM 抽象（如 web playground、独立 eval 工具）
- LLM provider 数量增加到 4+ 个，vendor SDK 体积变成考虑因素
- `core/llm-client` 与 `core/lifecycle` 协同稳定 3 个月以上无大改

### 阶段 B — `ohbaby-host` 拆出

**触发条件**（任一）：

- 出现远端执行需求（SSH / 容器 / 远端 worker）
- 出现第二个 entry 需要复用 sandbox（如 CLI 之外的 batch runner）
- `sandbox/` 与 `shell/` 已稳定，3 个月以上无大改

阶段 A 和阶段 B 可以独立推进，无依赖。

### 阶段 C — 可选的更细拆分

只在量级真的上来才考虑：

- `ohbaby-telemetry`：当上报渠道、隐私合规变成横切关注点
- `ohbaby-oauth`：当多 vendor 鉴权 + token 刷新变成复杂模块
- `ohbaby-protocol-mcp`：当 MCP 内嵌 server / client 数量增加，需要独立维护

### 阶段 D — Host 抽象升级（参考 kimi 的 Kaos）

当 ohbaby 需要 SSH/远端执行时，可以考虑把 host 抽象升级为"完整宿主接口"——包括文件 I/O。届时把当前 ohbaby 工具里直接调 `node:fs/promises` 的代码统一替换为 `host.readText(...)` 等。这是 kimi 早就做的事，但 MVP 不需要。

---

## 十一、参考

**内部文档**：

- [rename-tui-to-cli.md](rename-tui-to-cli.md) — Phase 0 重命名
- [ohbaby-cli-roadmap.md](ohbaby-cli-roadmap.md) — CLI 阶段路线
- [tui-design.md](tui-design.md) — TUI 职责、样式/布局原则、验收标准与测试标准
- [docs/cli/architecture.md](../../cli/architecture.md) — 当前 CLI composition root
- [docs/ohbaby-sdk/architecture.md](../../ohbaby-sdk/architecture.md) — SDK 协议层职责

**外部参考实现**：

- kimi-code（`D:/Projects/Code-cli/kimi-code/`）
  - `packages/kosong/` — LLM 抽象层参考
  - `packages/kaos/` — Host 抽象层参考（filesystem + process 统一）
  - `packages/agent-core/` — agent 核心包参考（runtime-types / RuntimeConfig 注入模式）
  - `apps/kimi-code/` — CLI 应用结构参考
- pi（`D:/Projects/Code-cli/ohbaby-agent/pi/`）
  - `packages/ai/` — 多 provider + subpath exports 参考
  - `packages/agent/` — 极简 agent-core 参考（与 kimi 对照）
  - `packages/coding-agent/` — 应用包"什么都装"反面案例（不要学）
  - `packages/tui/` — TUI 原语库参考（与 pi-ai 同样是 leaf 库）
