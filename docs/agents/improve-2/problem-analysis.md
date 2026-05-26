# agents improve-2 问题分析

> 状态：**前瞻性草案**。本版已按 improve-1 实际结果收紧：旧 `agents/runner.ts` / `agents/executor.ts` API 已在 improve-1 删除，不再作为 improve-2 工作项。

本文档分析 agents improve-1 后留下的遗留问题、improve-2 必须解决的目标，以及不应在本轮处理的事项。改造方案见 [implementation-plan.md](./implementation-plan.md)。

---

## 一、improve-1 留下的"半切状态"

improve-1 在架构方向上是正确的，并且已把 subagent 路径切到 `core/agents.runAgent`。但 primary 路径仍未切换，类型命名也还带有一部分历史痕迹。这些过渡形态在 improve-1 阶段可接受，但**不能长期存在**：

### 1.1 primary 与 subagent 走不同代码路径

| 路径 | 当前（improve-1 完成后）| 目标 |
|------|----------------------|------|
| Primary | `composition.buildSessionPromptMessages` → `RunManager.create({ messages })` → `Lifecycle.runSession`（间接） | `AgentService.startSession` → `core/agents.runAgent({ waitMode: "stream" })` → `RunManager.create` → `Lifecycle.runSession` |
| Subagent | `AgentService.executeTask` → `core/agents.runAgent({ waitMode: "waitForCompletion" })` → `RunManager.create` → `Lifecycle.runSession`（间接，improve-2 才完整） | （不变） |

**问题**：improve-1 的统一化承诺只对 subagent 兑现。primary 仍然由 adapter 层手工编排 prompt 组装 + RunManager 调用。这与 improve-1 [decisions.md 决议](../improve-1/decisions.md#一决议一句话) "primary 与 subagent 共用一份机制"在产品事实上一致，但在代码层面只兑现了一半。

**违反原则**：

- **DRY**：两条路径维护两套编排代码。
- **决策一致性**：架构决策已经选择 `core/agents/` 作为统一底层，留 primary 走旧路径是延期偿还的债务。

### 1.2 旧 runner / executor API 已删除，但需要防回归

improve-1 已直接删除：

- `agents/runner.ts`
- `agents/runner.unit.test.ts`
- `agents/executor.ts`
- `agents/executor.unit.test.ts`
- `SubagentExecutor / createSubagentRunner / SubagentRunner` 等旧 export

**剩余问题**：

- improve-2 在新增 `AgentService.startSession` 时，不能重新引入旧式 runner/executor 旁路。
- `toOpenAiTools` 等辅助能力仍暂存在 `core/agents/runner.ts` 并被 primary 旧路径复用；primary 切换后需要确认它的长期归属。
- 文档和测试命名必须继续以 `AgentService` / `core/agents.runAgent` 为唯一入口。

**原则**：旧 API 删除不是 improve-2 的工作项，而是 improve-2 的边界约束。

### 1.3 服务层 envelope 类型命名仍有历史痕迹

improve-1 已删除 `SubagentRunner / SubagentRunnerResult` 等旧 runner 类型，但仍保留 `SubagentToolCallSummary / SubagentExecuteParams / SubagentResult / TaskExecutor` 等 Task 工具 envelope 契约。

**问题**：

- `SubagentExecuteParams / SubagentResult` 从业务语义上描述 Task 工具的"以子代理执行" envelope，是否继续使用 subagent 前缀需要明确。
- `SubagentToolCallSummary` 当前由 `AgentService` 返回摘要使用，是否改为通用 `AgentToolCallSummary` 或直接复用 `core/agents.AgentToolCallSummary` 需要在 improve-2 决定。
- `agents/types.ts` 应保留描述符和服务层契约，纯运行底层契约归 `core/agents/types.ts`。

**违反原则**：单一职责、类型归属清晰。

### 1.4 primary 调用方仍在 adapter 层手工编排

improve-1 期间，primary 启动路径仍由 `composition.ts` 手工构造 messages 并调用 RunManager。新方向应该是：adapter 调 `AgentService.startSession`，service 再调 `core/agents.runAgent({ waitMode: "stream" })`。

**问题**：

- adapter 层仍承担了本应属于 core/service 的 agent 启动编排。
- primary 与 subagent 的 envelope 差异仍在代码路径层被放大。

### 1.5 `AgentRunRecord` 泄漏 RunManager 内部字段

`core/agents/types.ts` 当前定义的 `AgentRunRecord` 包含 `permissionProfileId / multitaskStrategy / disconnectMode / createdAt / startedAt / endedAt` 等字段。这些字段来自 runtime/run-manager 的内部 run 记录，不是 `core/agents` 启动和跟踪一个 agent run 所需的本质契约。

**问题**：

- `runAgent` 目前实际只消费 `runId`，最多需要 `sessionId` 做一致性核对。
- `core/agents` 复制 RunManager 内部记录形状，造成稳定层反向感知 runtime 的实现细节。
- 这违反接口隔离原则：port 应只暴露 consumer 真正使用的最小字段。

**目标方向**：在 Phase 1 将 `AgentRunRecord` 收窄为 `AgentRunHandle { runId, sessionId }`。RunManager adapter 负责把内部 run 记录转换为 handle，`core/agents` 不再知道权限 profile、多任务策略、断连策略等 runtime 内部概念。

### 1.6 `AgentRunResult` 不是可判别联合

当前 `AgentRunResult` 使用单个 interface 承载 `success / finalOutput / events / error`，这些字段大多 optional，真实语义依赖注释和调用方约定。

**问题**：

- `waitMode: "stream"` 时 `events` 必填，但类型不强制。
- `waitMode: "waitForCompletion"` 且成功时 `finalOutput` 必填，但类型不强制。
- 失败结果应强制携带 `error`，当前类型同样不保证。
- 调用方必须靠 `if (result.events)` 这类运行时判断来恢复语义，类型推断不够直接。

**目标方向**：在 Phase 1 实现 stream 分支时，把 `AgentRunResult` 改为以 `mode: "stream" | "waitForCompletion"` 为判别字段的 union。这样 stream、成功等待、失败等待三种结果在类型层面互斥。

### 1.7 `AgentPromptMessageBuilder` 是过渡期抽象

`AgentRunCreateOptions.messages` 当前仍为必填，导致 `core/agents.runAgent` 必须通过 `buildPromptMessages` 预组装模型消息后再交给 coordinator。这是 improve-1 的合理过渡形态，但它与 lifecycle improve-1/2 的长期方向不同：消息组装应由 `Lifecycle.runSession` 内部通过 `context.prepareTurn` 完成。

**问题**：

- `buildPromptMessages` 让 adapter/service 层继续持有一部分 prompt/context 组装职责。
- `AgentRunCreateOptions.messages` 必填，使 RunManager 的创建入口仍绑定"外部已组装 messages"的旧路径。
- 如果文档不承认这是过渡期产物，Phase 2 容易把它固化成长期抽象。

**目标方向**：

- Phase 2 完成前：`messages` 仍可必填，`runAgent` 继续调用 `buildPromptMessages`，作为兼容 RunManager 当前 create 契约的过渡。
- Phase 2 / lifecycle improve-2 接合完成后：`AgentRunCreateOptions.messages` 改为 optional 或删除；`runAgent` 不再调用 `buildPromptMessages`；`AgentPromptMessageBuilder` 标记为 `@deprecated` 并安排退场。

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

### 目标三：旧 API 删除状态防回归

- `agents/runner.ts / agents/executor.ts` 保持不存在。
- `agents/index.ts` 与包根 `index.ts` 不再导出旧 runner/executor 符号。
- improve-2 新增代码不得重新引入 `SubagentExecutor / createSubagentRunner / SubagentRunner` 等旧名。

### 目标四：整理服务层 envelope 类型

评估 `SubagentExecuteParams / SubagentResult / SubagentToolCallSummary / TaskExecutor` 等服务层契约是否继续保留现名，或重命名为 `TaskInvocationParams / TaskInvocationResult` 等更贴合 `AgentService` 的名字。

**关键设计点**：

- `core/agents/` 保留纯运行底层契约（`AgentRunInput / AgentRunResult / AgentToolCallSummary`）。
- `agents/` 保留服务/调度层契约（Task 工具同步 envelope、primary stream envelope）。
- 如果执行重命名，旧名是否保留 alias 需要单独评估；不再恢复已删除的 runner/executor 旧名。

### 目标五：收紧 `core/agents` 运行契约

把 Phase 1 的 stream 实现与类型边界收紧放在同一批处理：

- `AgentRunCoordinator.create` 返回 `AgentRunHandle`，不再返回含 RunManager 内部字段的 `AgentRunRecord`。
- `AgentRunResult` 改为 discriminated union，编码 stream / wait success / wait failure 的互斥语义。
- `core/agents` 只定义 agent 运行所需的最小 port，runtime 侧负责适配。

### 目标六：明确 prompt message builder 的退场路径

把 `AgentPromptMessageBuilder` 与 `AgentRunCreateOptions.messages` 明确标注为过渡期形态。Phase 2 切 primary 路径时先保证行为等价；与 lifecycle improve-2 完成接合后，再移除或废弃外部预组装 messages 的入口。

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

### 4.2 旧 API 回流风险

improve-2 新增 `startSession` 时，可能为了省事重新引入 service 外的 runner/executor 旁路。

**缓解**：

- 每个阶段用 grep 全量扫描 `SubagentExecutor / createSubagentRunner / SubagentRunner` 等旧符号引用。
- `agents/` 内所有"启动 + 等待/流式 + 收口"仍必须委托 `core/agents.runAgent`。

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
