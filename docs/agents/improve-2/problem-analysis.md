# agents improve-2 问题分析

> 状态：**前瞻性草案**。详细问题清单将在 improve-1 完成后基于实际代码状态更新。

本文档分析 agents improve-1 后留下的遗留问题、improve-2 必须解决的目标，以及不应在本轮处理的事项。改造方案见 [implementation-plan.md](./implementation-plan.md)。

---

## 一、improve-1 留下的"半切状态"

improve-1 在架构方向上是正确的，但出于范围控制保留了一些过渡形态。这些过渡形态在 improve-1 阶段无害，但**不能长期存在**：

### 1.1 primary 与 subagent 走不同代码路径

| 路径 | 当前（improve-1 完成后）| 目标 |
|------|----------------------|------|
| Primary | `composition.buildSessionPromptMessages` → `RunManager.create({ messages })` → `Lifecycle.runSession`（间接） | `AgentService.startSession` → `core/agents.runAgent({ waitMode: "stream" })` → `RunManager.create` → `Lifecycle.runSession` |
| Subagent | `AgentService.executeTask` → `core/agents.runAgent({ waitMode: "waitForCompletion" })` → `RunManager.create` → `Lifecycle.runSession`（间接，improve-2 才完整） | （不变） |

**问题**：improve-1 的统一化承诺只对 subagent 兑现。primary 仍然由 adapter 层手工编排 prompt 组装 + RunManager 调用。这与 improve-1 [decisions.md 决议](../improve-1/decisions.md#一决议一句话) "primary 与 subagent 共用一份机制"在产品事实上一致，但在代码层面只兑现了一半。

**违反原则**：

- **DRY**：两条路径维护两套编排代码。
- **决策一致性**：架构决策已经选择 `core/agents/` 作为统一底层，留 primary 走旧路径是延期偿还的债务。

### 1.2 兼容 shim 仍占据 `agents/` 模块表面

`agents/runner.ts`、`agents/executor.ts` 在 improve-1 GP3 改造为薄 shim：

```ts
// agents/executor.ts （improve-1 完成后）
export { AgentService as SubagentExecutor } from "./service.js";
export type { AgentServiceOptions as SubagentExecutorOptions } from "./service.js";

// agents/runner.ts （improve-1 完成后）
export function createSubagentRunner(options) {
  // 内部调用 core/agents.runAgent
  ...
}
```

**问题**：

- `agents/` 对外 API 表面携带 `SubagentExecutor / createSubagentRunner` 等"subagent 前缀"的命名。这些命名在 improve-1 的核心洞察"primary 与 subagent 都是 agent"下显得过时。
- shim 持续暗示"subagent 是独立概念"，与新架构方向反向暗示。
- 任何阅读 `agents/index.ts` 的新成员会困惑：到底 `SubagentExecutor` 和 `AgentService` 是什么关系？为什么有两个名字？

**违反原则**：命名应当反映本质。

### 1.3 运行时契约类型留在 `agents/types.ts`

improve-1 出于改造范围控制，把 `SubagentRunner / SubagentRunnerResult / SubagentToolCallSummary / SubagentExecuteParams / SubagentResult / TaskExecutor` 等运行时契约类型留在 `agents/types.ts`（[improve-1 problem-analysis.md 5.3 类型归属划分](../improve-1/problem-analysis.md#53-类型归属划分)）。

**问题**：

- `agents/` 应当是描述符层（improve-1 决议明确），但 `types.ts` 仍然混入运行时契约。
- `core/agents/types.ts` 与 `agents/types.ts` 的类型职责分界不清晰。
- 这些类型本质上是 `core/agents.runAgent` 的输入/输出契约的"subagent envelope 视图"，归属应在 `core/agents/`。

**违反原则**：单一职责、类型归属清晰。

### 1.4 调用方仍走兼容 import 路径

improve-1 期间，adapters / CLI / 外部代码仍以 `import { ... } from "agents"` 形式取到 `SubagentExecutor` 等。新调用方可以走 `import { runAgent } from "core/agents"` 或 `import { AgentService } from "agents/service"`，但旧调用方未迁移。

**问题**：

- 兼容 import 增加了认知负担："这个符号到底从哪个模块来？"
- 删除 shim 之前，所有兼容 import 必须先切换。

---

## 二、本轮目标

按"完成 improve-1 留下的另一半"为指导，本轮目标分为四类：

### 目标一：primary 路径切到 `core/agents.runAgent`

让 primary 与 subagent 真正走同一条底层路径。

**关键设计点**：

- `AgentService` 新增 `startSession(params): AsyncIterable<LifecycleEvent>` 方法（improve-1 已在类型层预留，本轮实现）。
- `startSession` 内部调用 `core/agents.runAgent({ waitMode: "stream", ... })`。
- `core/agents.runAgent` 的 `stream` 分支在 improve-1 仅做了类型预留，本轮实现完整。
- composition.ts:buildSessionPromptMessages 删除；调用方改为 `agentService.startSession`。

### 目标二：RunWorker / composition 完全消费 `AgentService.startSession`

让 adapter 层不再手工编排 prompt + RunManager。

**关键设计点**：

- composition.ts 中 primary 启动路径改为：调用 `agentService.startSession` → 消费事件流；RuntimeAgent 解析由 `AgentService` 负责，user message 写入由 `core/agents.runAgent` 负责。
- RunWorker 内部判断"是否为 subagent run"逻辑简化或删除（subagent 已在 improve-1 走 `executeTask`，primary 走 `startSession`，envelope 由 AgentService 决定）。
- composition.ts:buildSessionPromptMessages 与 buildPrimaryPromptMessages 函数删除。

### 目标三：删除兼容 shim

- 删除 `agents/runner.ts`。
- 删除 `agents/executor.ts`。
- 在删除前，所有内部调用方迁移到 `core/agents.runAgent` 或 `agents.AgentService`。

### 目标四：整理运行时契约类型

把 `SubagentRunner / SubagentRunnerResult / SubagentExecuteParams / SubagentResult / SubagentToolCallSummary / TaskExecutor` 等运行时契约类型从 `agents/types.ts` 移到 `core/agents/types.ts`。

**关键设计点**：

- 这些类型本质上是 `AgentRunInput / AgentRunResult` 的"subagent envelope 视图"。
- 应当以 `core/agents/` 的类型为基础，`agents/` 仅在 `service.ts` 内部使用别名。
- 或者更彻底：直接重命名（如 `SubagentRunner` → `AgentInvocation`、`SubagentExecuteParams` → `TaskInvocationParams`），命名去 "subagent" 前缀。重命名期间通过类型别名保留旧名兼容。

---

## 三、不在本轮范围

为防止 improve-2 范围漂移，明确以下事项**不在本轮处理**：

- **Session tree / branch / fork 数据模型**：需要 message / session 模块大改，独立大型重构。
- **多 provider 抽象层**：Anthropic / Google 支持，与 `core/llm-client` 改造绑定。
- **Agent 权限模型升级**：currently `PermissionConfig` 支持 allow/deny/ask，可以扩展但不在本轮。
- **Builtin agents 功能演进**：build / explore / plan / research 内置 agent 的功能调整。
- **Tools / permissions 模型重设计**：ToolScheduler wave 机制等。
- **子 agent 调度策略升级**：当前 `DEFAULT_MAX_CONCURRENCY = 3`，更精细的调度策略。

---

## 四、风险识别

### 4.1 primary 行为差异风险

primary 路径切换到新底层后，可能引入可观察行为差异：

- 事件顺序变化（特别是 `turn:start / turn:end` 在 stream envelope 下的发射时机）。
- 错误处理路径变化。
- 取消（abort）传播路径变化。

**缓解**：本轮验收必须包含 primary 端到端 e2e 测试，并与 improve-1 完成前的行为做对照。

### 4.2 调用方迁移遗漏风险

shim 删除前必须确认所有调用方已迁移。如有遗漏，删除时编译失败。

**缓解**：

- 删除 shim 前用 grep 全量扫描 `SubagentExecutor / createSubagentRunner` 等符号引用。
- 在删除 shim 的 PR 中包含 grep 结果作为证据。

### 4.3 与 lifecycle improve-2 的耦合

agents improve-2 假设 lifecycle improve-2 已经把 RunWorker 切到 `runSession`。如未完成，链路是：

```
primary → AgentService.startSession → core/agents.runAgent({ waitMode: "stream" })
  → RunManager.create  ← 仍走旧 Lifecycle.run？
```

**缓解**：

- 如果 lifecycle improve-2 推迟，agents improve-2 内部 `runAgent stream` 分支可以临时调用旧 `Lifecycle.run` 路径。
- 此为过渡方案，最终必须两者都切到 `runSession`。

---

## 五、关联文档

- 改造方案：[implementation-plan.md](./implementation-plan.md)
- 验收标准：[acceptance.md](./acceptance.md)
- 协同导航：[README.md](./README.md)
- 上游：[agents improve-1](../improve-1/README.md) 及其 [decisions.md](../improve-1/decisions.md)
