# agents improve-1 问题分析

本文档分析 `packages/ohbaby-agent/src/agents/` 模块当前的职责越界与模块边界问题，并定义本轮重构目标。本文档只回答"为什么改、借鉴什么、保留什么"。改动方案见 [implementation-plan.md](./implementation-plan.md)；架构决策过程见 [decisions.md](./decisions.md)。

---

## 一、分析对象与范围

| 对象 | 路径 |
|------|------|
| Agent 类型与配置 | [packages/ohbaby-agent/src/agents/types.ts](../../../packages/ohbaby-agent/src/agents/types.ts) |
| Agent 注册表 | [packages/ohbaby-agent/src/agents/registry.ts](../../../packages/ohbaby-agent/src/agents/registry.ts) |
| Agent 解析器 | [packages/ohbaby-agent/src/agents/manager.ts](../../../packages/ohbaby-agent/src/agents/manager.ts) |
| 内置 agent | [packages/ohbaby-agent/src/agents/builtin/](../../../packages/ohbaby-agent/src/agents/builtin/) |
| **Subagent 运行器** | [packages/ohbaby-agent/src/agents/runner.ts](../../../packages/ohbaby-agent/src/agents/runner.ts) |
| **Subagent 执行编排** | [packages/ohbaby-agent/src/agents/executor.ts](../../../packages/ohbaby-agent/src/agents/executor.ts) |
| **Subagent 消息写入** | [packages/ohbaby-agent/src/agents/message-writer.ts](../../../packages/ohbaby-agent/src/agents/message-writer.ts) |
| **Subagent session 管理** | [packages/ohbaby-agent/src/agents/session-manager.ts](../../../packages/ohbaby-agent/src/agents/session-manager.ts) |
| **Subagent 多轮任务管理** | [packages/ohbaby-agent/src/agents/tasks/](../../../packages/ohbaby-agent/src/agents/tasks/) |
| Lifecycle 模块 | [packages/ohbaby-agent/src/core/lifecycle/](../../../packages/ohbaby-agent/src/core/lifecycle/) |
| Context 模块 | [packages/ohbaby-agent/src/core/context/](../../../packages/ohbaby-agent/src/core/context/) |
| Session 服务 | [packages/ohbaby-agent/src/services/session/](../../../packages/ohbaby-agent/src/services/session/) |
| 运行时层 | [packages/ohbaby-agent/src/runtime/](../../../packages/ohbaby-agent/src/runtime/) |

加粗五项是本轮判定为**职责越界**的对象。

---

## 二、核心洞察：primary 与 subagent 共享底层

在分析具体问题前，必须先确立一个事实，这是本轮所有决策的基础。

### 2.1 差异对照表

| 维度 | Primary agent | Subagent | 是否真有差异 |
|------|--------------|----------|------------|
| Turn loop | `Lifecycle.runSession` | `Lifecycle.runSession` | **同一套** |
| Context 准备 | `context.prepareTurn` | `context.prepareTurn` | **同一套** |
| Tool 执行 | `ToolScheduler` | `ToolScheduler`（受限工具集） | 同机制，**配置**不同 |
| System prompt | identity + task + tools + env + customInstructions | subagent base + task + tools + env | 同模块，**模式**不同 |
| Memory | 加载 | 跳过加载 | 同 `MemoryReader`，**flag** 不同 |
| Message 持久化 | `MessageManager` | `MessageManager` | **同一套** |
| Session | 顶层 | `parentId !== undefined` | **同一套** |
| LLM | 同一个 | 同一个 | **同一套** |
| **结果交付** | 事件流到 UI | 同步返回最后一条 assistant text | **真正不同：envelope** |
| **终止方式** | UI 持续消费 | `waitForCompletion` 后读 last assistant | **真正不同：envelope** |

→ **真正的差异只在"envelope（信封）"——结果怎么交付、什么时候算结束。核心机制完全相同。**

### 2.2 参考项目验证

| 项目 | 底层 | envelope |
|------|------|---------|
| pi | `agentLoop()` 纯函数，一份代码 | `pi-coding-agent`（交互式）与 Task 工具各自包装 |
| opencode | session service 提供 run | TaskTool 包装 session service 创建 child session |
| claude-code | 同一套 conversation loop | `AgentTool` / `LocalAgentTask` 提供同步 envelope |

→ 三者**全部**是"一份底层 + 多个 envelope"。没有任何主流项目把"subagent 怎么跑"做成与"primary 怎么跑"完全独立的两套代码。

### 2.3 推论

任何把"subagent 执行"独立成模块的方案（无论是 `runtime/subagent-*` 还是顶层 `subagents/`）都在**复制核心机制**，违反 DRY。正确的方向是**新建 `core/agents/` 作为 primary 与 subagent 共用的运行底层**。

---

## 三、`agents/` 模块应有的职责（服务/调度层）

`agents/` 在本次重构后应当是**服务/调度层**（与 `services/session` 风格对齐）：

| 应留下的对象 | 职责 |
|------------|------|
| `types.ts` | `AgentConfig / AgentMode / PermissionConfig / ToolsConfig / RuntimeAgent` 等**描述符** |
| `registry.ts` | 加载、校验、注册内置 + 用户 agent |
| `manager.ts` | 按名字解析 `RuntimeAgent`（带 system prompt addon、工具集裁剪、权限合成） |
| `service.ts`（新） | `AgentService`：调度 + 并发上限 + Task 工具执行入口 |
| `tasks/` | 长生命周期多轮任务状态机（**消费 `core/agents`**） |
| `builtin/` | 内置 agent 定义 |
| `index.ts` | barrel |

理想 `agents/` 模块特征：

- **高抽象**：暴露"调度一个 agent 跑起来"，不暴露"怎么跑"。
- **依赖方向单向**：依赖 `core/agents`（运行底层）、`core/system-prompt`（提示组装）、`config/agents`（加载配置）、`services/session`（事实源）。不依赖 `runtime/run-manager` 等基础设施实现细节。
- **被 adapter / Task 工具消费**：Task 工具调用进入 `AgentService.executeTask`；adapter 启动 primary 进入 `AgentService.startSession`（improve-2 才接入此 API）。

---

## 四、关键问题清单

每条问题给出稳定编号、严重度、代码定位、违反的软件工程原理。

### PG-1：`agents/` 模块违反单一职责原则

**严重度**：高（架构性）

**证据**：[agents/index.ts:1-57](../../../packages/ohbaby-agent/src/agents/index.ts) 同时导出 `AgentManager / AgentRegistry`（描述符层）与 `SubagentExecutor / createSubagentRunner / AgentTaskManager`（运行时编排层）。

**描述**：模块对外同时承担"我是什么"与"我怎么跑"两个独立责任。

**违反原则**：单一职责（SRP）。

---

### PG-2：稳定性反转 —— 稳定层依赖不稳定层

**严重度**：高（架构性）

**证据**：

- [runner.ts:12](../../../packages/ohbaby-agent/src/agents/runner.ts#L12) `import type { RunManager } from "../runtime/run-manager/index.js";`
- [executor.ts](../../../packages/ohbaby-agent/src/agents/executor.ts) 间接依赖 runner → RunManager
- [tasks/manager.ts:1-9](../../../packages/ohbaby-agent/src/agents/tasks/manager.ts#L1-L9) 依赖 `SubagentRunner` 等

**描述**：`agents/` 应当是低频稳定层，但当前依赖 `runtime/run-manager`（高频变更层）。`runtime/` 的任何 API 变化都反向波及 agent 模块。

**违反原则**：稳定依赖原则（SDP）。依赖应当指向稳定方向。

---

### PG-3：偶然内聚（Coincidental Cohesion）

**严重度**：高

**证据**：runner.ts / executor.ts / message-writer.ts / session-manager.ts / tasks/ 五个对象的共同点只是"和 subagent 有关"，而非"它们一起构成 agent 概念"。

**描述**：模块边界由"话题"而非"职责"划定。这是 Constantine 七类内聚的最低形态。

**违反原则**：内聚度（Cohesion）。

---

### PG-4：primary 与 subagent 的"运行底层"被错误地分裂成两套实现

**严重度**：高（本轮新识别）

**证据**：

- Primary 路径：[`adapters/ui-runtime/composition.ts:279-320`](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts#L279-L320) `buildSessionPromptMessages` → `RunManager.create` → `Lifecycle.run`
- Subagent 路径：[`agents/runner.ts:103-163`](../../../packages/ohbaby-agent/src/agents/runner.ts#L103-L163) `createSubagentRunner` → `RunManager.create` → `Lifecycle.run`

两条路径除了"是否注入 memory / 工具集裁剪 / 结果如何交付"以外，**底层调用序列完全相同**，却各自维护一份编排代码。

**描述**：见 [第二节核心洞察](#二核心洞察primary-与-subagent-共享底层)。当前架构把 envelope 差异错误地放大成机制分裂。

**违反原则**：DRY（在机制层面）。

---

### PG-5：`runner.ts` 是运行时编排错置在 agents/

**严重度**：高

**证据**：[runner.ts:103-163](../../../packages/ohbaby-agent/src/agents/runner.ts#L103-L163) 的 `createSubagentRunner` 编排 6 个组件：

```
toolScheduler.getAvailableTools
  + sandboxManager.setSessionEnvironment
  + buildSubagentPromptMessages
  + runManager.create / waitForCompletion / cancel
  + messageManager.listBySession
  + signal/abort 绑定
```

**描述**：纯运行时编排逻辑，零 agent-specific 决策。

**违反原则**：分层错位。

---

### PG-6：`executor.ts` 同为运行时编排错置

**严重度**：高

**证据**：[executor.ts:27-149](../../../packages/ohbaby-agent/src/agents/executor.ts#L27-L149) 的 `SubagentExecutor.execute` 编排 agentManager + sessionManager + messageWriter + runner，含并发上限管理。

**描述**：Task 工具的执行实现。消费 `agents/` 但本身不是 agent 定义的一部分。

**违反原则**：分层错位 + SRP。

---

### PG-7：`tasks/` 是长生命周期任务管理错置

**严重度**：高

**证据**：[tasks/manager.ts:73-90](../../../packages/ohbaby-agent/src/agents/tasks/manager.ts#L73-L90) 的 `AgentTaskManager` 持有 `active = new Map<string, ActiveTaskState>()` 状态，实现 `open / sendInput / get / close` 状态机。

**描述**：长任务的生命周期状态机。形态上消费"agent 运行底层"，与"agent 描述符"无关。

**违反原则**：分层错位 + SRP。

> **本轮处置**：`tasks/` 保留在 `agents/` 下（作为服务/调度层的一部分），但**内部消费 `core/agents.runAgent`**，不再持有自己的"runner / sessionManager / messageWriter"私有抽象。

---

### PG-8：`message-writer.ts` 零 agent 特定逻辑

**严重度**：中

**证据**：[message-writer.ts:1-44](../../../packages/ohbaby-agent/src/agents/message-writer.ts) 全部内容是 4 次 `messageManager.createMessage / appendPart / updateMessage` 调用。`agentName` 字段只作 metadata 透传。

**描述**：函数体内没有任何 agent 概念。当 `core/message` schema 变化时该文件被迫连带变更。

**违反原则**：高内聚反例。

---

### PG-9：`session-manager.ts` 与 `services/session` 重复抽象

**严重度**：高

**证据**：

- [session-manager.ts:13-71](../../../packages/ohbaby-agent/src/agents/session-manager.ts#L13-L71) `InMemorySubagentSessionManager` 完整重写了一份内存 session 数据结构。
- [session-manager.ts:73-109](../../../packages/ohbaby-agent/src/agents/session-manager.ts#L73-L109) `PersistentSubagentSessionManager` 仅薄包装 [`services/session.SessionManager`](../../../packages/ohbaby-agent/src/services/session/manager.ts) 并新增 `ensureRoot`。
- `Session.parentId` 已在 [`services/session/types.ts:20`](../../../packages/ohbaby-agent/src/services/session/types.ts#L20) 存在。

**描述**：内存 session 存储有两份独立实现；`SubagentSessionManager` 是 `SessionManager` 的窄子集 + 一个 `ensureRoot` 扩展。

**违反原则**：DRY（在抽象层面）；ISP 的反向应用。

---

### PG-10：`agents/index.ts` 形成"扩散点"

**严重度**：中

**证据**：[agents/index.ts:1-57](../../../packages/ohbaby-agent/src/agents/index.ts) 把 12 个不同性质的导出聚成一个 barrel。

**描述**：任何 `import * from "agents"` 都会拉入 RunManager、session 存储、message 持久化依赖。

**违反原则**：最小知识（Law of Demeter 的模块层应用）。

---

## 五、跨模块协作面

本轮重构涉及多个模块。明确各方接合面，作为后续所有改动的硬约束。

### 5.1 改造后的依赖方向

```
agents/         ──消费──>  core/agents/  (新建)
agents/         ──消费──>  core/system-prompt
agents/         ──消费──>  services/session
agents/         ──消费──>  core/message (类型 only)
agents/         ──不依赖──> runtime/

core/agents/    ──消费──>  core/lifecycle (runSession)
core/agents/    ──消费──>  core/context (prepareTurn 通过 lifecycle 间接)
core/agents/    ──消费──>  core/message
core/agents/    ──消费──>  core/tool-scheduler
core/agents/    ──消费──>  runtime/run-manager (基础设施)

runtime/        ──无 agents 特定依赖──
```

### 5.2 改造后各模块归属

| 模块 | 改造后职责 | 与本轮的关系 |
|------|----------|------------|
| `core/agents/`（新建） | "agent 运行底层" —— `runAgent(input)` 统一原语 | GP2 新建；subagent 路径在 GP3 切换；primary 路径切换留 improve-2 |
| `agents/` | 描述符 + 服务/调度层 | GP3、GP4、GP5 改造 |
| `runtime/` | 通用 run 基础设施（不变） | 保持基础设施身份 |
| `services/session` | session 唯一抽象 | GP1 新增 `ensureRoot` |
| `core/lifecycle` | turn loop | 不变（被 `core/agents` 消费） |
| `core/context` | LLM 输入呈现 | 不变 |
| `core/message` | 持久化事实源 | 不变 |

### 5.3 类型归属划分

| 类型 | 改后归属 | 理由 |
|------|--------|------|
| `AgentConfig / AgentMode / AgentsConfig / PermissionConfig / PermissionValue / ToolsConfig / RuntimeAgent` | `agents/types.ts` | 真正的描述符 |
| `AgentRunInput / AgentRunResult / AgentRunner` | `core/agents/types.ts`（新） | 运行底层契约 |
| `SubagentRunner / SubagentRunnerResult / SubagentToolCallSummary` | `agents/types.ts`（兼容期）→ improve-2 删除并改用 `AgentRunResult` | 当前 subagent envelope 契约 |
| `SubagentExecuteParams / SubagentResult / TaskExecutor` | `agents/types.ts` | Task 工具 envelope 契约 |
| `SubagentSession / SubagentSessionManager` | 删除 | 由 `services/session.Session / SessionManager` 替代 |
| `SubagentMessageWriter` | 删除 | GP5 阶段一起删 |

---

## 六、根因归纳

上述 10 条问题归并为三条根因：

### RC-1：Lifecycle / RunManager 旧 API 形态促成的副产物

`Lifecycle.run` 要求**调用方预先组装 messages**；`Lifecycle` 不负责持久化 user message；`RunManager` 是 `runtime/` 层的工厂。为了让 subagent 跑起来，必须有人做：

- "subagent 怎么组装 prompt 并启动 RunManager" → `runner.ts`
- "subagent 用户消息谁写入" → `message-writer.ts`
- "subagent 怎么挑 session" → `session-manager.ts`
- "subagent 跑完怎么返回结果给 Task 工具" → `executor.ts`
- "subagent 多轮交互怎么管理" → `tasks/`

这些补丁因为"都和 subagent 有关"被聚到 `agents/`。

### RC-2：模块边界由"话题"而非"职责"划定

"subagent" 是一个**话题**，不是一个**职责**。"运行一个 agent"、"写一条 message"、"创建一个 session"是三个独立职责。按"subagent 话题"聚集制造了偶然内聚。

### RC-3：缺少"agent 运行底层"的明确归属

`runtime/` 是基础设施层，不该承担 agent 特定逻辑。`agents/` 是服务/调度层，也不该承担运行机制。当前 `agents/` 自然成为补漏点。**本轮在 `core/agents/` 新建这个缺失的层**，把 primary 与 subagent 共享的运行底层一次性归位。

---

## 七、本轮重构目标

### G1：建立 `core/agents/` 作为"agent 运行底层"

对应 RC-3、PG-4、PG-5、PG-6、PG-7。

`core/agents/` 暴露：

- `runAgent(input): Promise<AgentRunResult>` —— primary 与 subagent 共用的运行原语
- `extractFinalOutput(messages): string` —— 同步 envelope 的输出抽取

`core/agents/` 在 core 内层，与 `core/lifecycle / context / message / tool-scheduler` 同级，反映"agent 运行底层"是真正的底层能力。

### G2：`agents/` 收敛为服务/调度层

对应 PG-1、PG-3、PG-10。

`agents/` 保留 `types / registry / manager / builtin / index`；新增 `service.ts`（`AgentService`）；`tasks/` 内部改为消费 `core/agents`；旧 `runner.ts / executor.ts` API 直接删除。

### G3：依赖方向归正

对应 PG-2。

`agents/` 不再依赖 `runtime/` 实现；改为消费 `core/agents` 与 `services/session`。`runtime/` 不接受任何 agent-specific 子模块。

### G4：`services/session` 成为 session 唯一抽象

对应 PG-9。

`ensureRoot` 能力补入 `services/session.SessionManager`。`SubagentSessionManager` 接口删除。

### G5：删除偶然内聚的辅助文件

对应 PG-8。

`message-writer.ts` 删除。`writeUserMessage` 内联到 `AgentService.executeTask`。

### G6：行为零回归

运行时行为在本轮改造前后**无差异**；源码调用方同批迁移到 `AgentService` 或 `core/agents.runAgent`，不再通过旧 `runner/executor` 壳子共存。

### G7：subagent 切换到 `core/agents.runAgent`；primary 不动

本轮**只**把 subagent 路径切到新底层。primary 路径切换留 improve-2。这样保证：

- 改造范围可控。
- improve-1 验收明确。
- 不同时改 composition / RunWorker / agents 三处。

---

## 八、非目标

- primary agent 路径切换到 `core/agents.runAgent`（留 improve-2）
- composition / RunWorker 改造（留 improve-2）
- Task 工具 envelope 类型命名整理（如 `SubagentExecuteParams` 是否重命名，留 improve-2）
- 多 provider 抽象
- AgentManager / AgentRegistry / builtin 功能演进
- Task tool 协议升级
- Tools / permissions 模型重设计

---

## 九、后续文档

- 架构决策记录：[decisions.md](./decisions.md)
- 具体改造步骤：[implementation-plan.md](./implementation-plan.md)
- 验收标准：[acceptance.md](./acceptance.md)
- 协同关系：[README.md](./README.md)
- 上游依赖：[lifecycle improve-1](../../core/lifecycle/improve-1/README.md)、[context improve-1](../../core/context/improve-1/README.md)
