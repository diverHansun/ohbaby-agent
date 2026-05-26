# agents improve-1 成果验收

本文档定义 `agents/` 模块本轮重构的验收标准。每条验收项均可独立判定"通过 / 不通过"。本文档只回答"怎么算改完了"。

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 架构决策：[decisions.md](./decisions.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)

---

## 一、验收原则

1. **可验证**：每条验收项必须能通过自动化测试、命令输出或代码审阅明确判定。
2. **可回溯**：每条验收项关联到 problem-analysis 中的具体问题编号（PG-N）。
3. **零回归**：运行时行为与现有测试套件保持全绿；旧 `runner/executor` 公共 API 在本轮明确删除并由 `AgentService` / `core/agents.runAgent` 取代。
4. **阶段独立**：AC-1 / AC-2 / AC-3 / AC-4 / AC-5 可分别独立验收。
5. **上游前置**：AC-5 的验收依赖 lifecycle improve-1 P2 已完成验收。

---

## 二、AC-1：`services/session.ensureRoot` 验收

对应实施阶段 [GP1](./implementation-plan.md#二阶段-gp1services-session-补-ensureroot)。

### AC-1.1 接口存在且类型正确

**判定**：

- `services/session/types.ts` 的 `SessionManager` 接口包含 `ensureRoot(input: { id, agentName, projectRoot, title? }): Promise<Session>`。
- `pnpm -F ohbaby-agent typecheck` 通过。

**关联**：G4、PG-9。

### AC-1.2 行为：首次创建

**判定**：单测覆盖 —— 调用 `ensureRoot({ id: "X", agentName: "build", projectRoot: "/r", title: "T" })` 当 `X` 不存在时：

- 创建新 session，字段对应正确。
- 返回的 session 与 `await sessionManager.get("X")` 结果一致。
- 发布 `SessionEvent.Created`（与现有 `create` 行为一致）。

**关联**：G4、PG-9。

### AC-1.3 行为：幂等

**判定**：单测覆盖 —— 第二/三次以同 `id` 调用 `ensureRoot`：

- 返回值与首次完全相同（`deep.equal`）。
- 不创建新 session，`list()` 不增长。
- 不发布 `SessionEvent.Created`。
- 不修改已有字段（即使传入不同 `agentName / title`，已有 session 保持原值）。

**关联**：G4、PG-9。

### AC-1.4 行为：与 `create` 共存

**判定**：

- 现有 `create / get / list / update / remove` 等方法行为完全不变。
- 现有 `manager.unit.test.ts` 全部用例不修改且全绿。

**关联**：G6。

---

## 三、AC-2：`core/agents/` 建立验收

对应实施阶段 [GP2](./implementation-plan.md#三阶段-gp2建立-coreagents)。

### AC-2.1 目录结构存在

**判定**：

- 存在 `core/agents/` 目录，含 `runner.ts / output.ts / types.ts / runner.unit.test.ts / output.unit.test.ts / index.ts`。
- `core/agents/index.ts` 导出 `runAgent / extractFinalOutput` 与相关类型。

**关联**：G1。

### AC-2.2 接口类型正确

**判定**：

- `core/agents/types.ts` 导出 `AgentRunInput / AgentRunResult / AgentRunner / AgentRunDeps / AgentToolCallSummary`。
- `AgentRunInput` 字段包含 `sessionId / parentSessionId? / agentName / projectRoot / initialUserPrompt? / parentMessageId? / signal? / environment? / maxSteps? / waitMode / buildPromptMessages`。
- `core/agents/types.ts` 导出 `AgentRunCoordinator` 端口；`agents/` 消费该端口，不直接 import `runtime/run-manager`。
- `waitMode` 联合类型 `"stream" | "waitForCompletion"`。
- `AgentRunResult` 字段满足 [implementation-plan.md 3.3](./implementation-plan.md#33-runagent-契约设计)。
- `pnpm -F ohbaby-agent typecheck` 通过。

**关联**：G1、PG-4。

### AC-2.3 `runAgent` 行为：waitForCompletion 模式

**判定**：单测构造 mock `RunManager + MessageManager + ToolScheduler`：

- 调用 `runAgent(deps, { waitMode: "waitForCompletion", ... })`：
  - 内部按序调用 `toolScheduler.getAvailableTools → sandboxManager.setSessionEnvironment → messageManager.createMessage/appendPart（仅当 initialUserPrompt 存在） → buildPromptMessages → runCoordinator.create → runCoordinator.waitForCompletion → messageManager.listBySession`。
  - 返回 `AgentRunResult { success: true, finalOutput: <last assistant text>, events: undefined }`。
- 调用时 `initialUserPrompt` 存在 → 内部先写入 user message。
- 调用时 `initialUserPrompt` 缺省 → 不写 user message。
- 调用时 `parentSessionId` 存在 → `runManager.create({ isSubagent: true, ... })`。
- 调用时 `parentSessionId` 缺省 → `runManager.create({ isSubagent: false, ... })`。

**关联**：G1、G7、PG-4。

### AC-2.4 `runAgent` 行为：异常路径

**判定**：单测覆盖：

- `runManager.create` 抛错 → `runAgent` 抛同样错；sandbox 环境被清理（finally 触发）。
- `runManager.waitForCompletion` 返回 `status: "failed"` → 返回 `AgentRunResult { success: false, error: ... }`。
- `signal.aborted === true` → 调用 `runManager.cancel(runId)`；返回 `success: false`。

**关联**：G1。

### AC-2.5 `extractFinalOutput` 行为

**判定**：单测覆盖：

- 空 history → 返回 `""`。
- history 末尾为 user message → 向前查找最近的 assistant text，返回。
- history 末尾为 assistant 但 text 为空 → 向前查找下一条非空 assistant。
- 行为与原 `agents/runner.ts:64-69` 的 `lastAssistantText` 在等价输入下结果相同。

**关联**：G1。

### AC-2.6 `core/agents/` 依赖卫生

**判定**：grep 验证：

- `core/agents/` 不 import `agents/` 任何文件。
- `core/agents/` 不 import `adapters/` 任何文件。
- `core/agents/` 不 import `agents/` 或 `adapters/`；如需要兼容当前 RunManager 形态，可在 `core/agents/types.ts` 内定义与 `RunManager.create / cancel / waitForCompletion` 结构兼容的 `AgentRunCoordinator` 端口。

**关联**：G3。

### AC-2.7 `core/agents/` 测试套件

**判定**：

- `runner.unit.test.ts` 与 `output.unit.test.ts` 全绿。
- 覆盖率涵盖 AC-2.3 / AC-2.4 / AC-2.5 所列全部场景。

**关联**：G1。

### AC-2.8 现有调用方零变化

**判定**：本阶段**不**切换任何现有调用方：

- `agents/runner.ts / executor.ts / tasks/manager.ts` 内容不变。
- 现有所有测试不修改且全绿。

**关联**：G6。

---

## 四、AC-3：`agents/` 收敛与 subagent 切到 `core/agents` 验收

对应实施阶段 [GP3](./implementation-plan.md#四阶段-gp3重构-agents-为服务调度层)。

### AC-3.1 `AgentService` 存在

**判定**：

- 存在 `agents/service.ts`，导出 class `AgentService`。
- `AgentService` 实现 `TaskExecutor` 接口。
- `AgentService.executeTask(params)` 公共方法签名与原 `SubagentExecutor.execute(params)` 完全一致。
- `AgentServiceOptions` deps 包含 `agentManager / sessionManager(SessionManager) / runCoordinator(AgentRunCoordinator) / messageManager / toolScheduler / sandboxManager? / maxConcurrency? / now? / buildPromptMessages`。

**关联**：G2。

### AC-3.2 旧 `agents/executor.ts` API 删除

**判定**：

- `agents/executor.ts` 不存在。
- `agents/executor.unit.test.ts` 已迁移为 `agents/service.unit.test.ts`。
- `agents/index.ts` 与包根 `index.ts` 不再导出 `SubagentExecutor / SubagentExecutorOptions`。
- 类型/集成测试覆盖旧 export 不存在，新入口 `AgentService` 可用。

**关联**：G6。

### AC-3.3 旧 `agents/runner.ts` API 删除

**判定**：

- `agents/runner.ts` 不存在。
- `agents/runner.unit.test.ts` 不存在。
- `createSubagentRunner / SubagentRunner / CreateSubagentRunnerOptions / SubagentPromptMessageBuilder / SubagentSandboxEnvironmentManager` 不再从 `agents/index.ts` 或包根导出。
- 所有 subagent 启动路径改为 `AgentService.executeTask` 或 `AgentTaskManager` 内部调用 `core/agents.runAgent({ waitMode: "waitForCompletion" })`。

**关联**：G2、G3、G7。

### AC-3.4 `agents/tasks/manager.ts` 切到 `core/agents`

**判定**：

- `AgentTaskManager` 的 options 类型不再包含 `SubagentRunner / SubagentMessageWriter / SubagentSessionManager`；改为 `AgentRunCoordinator / MessageManager / ToolScheduler / SessionManager / SandboxEnvironmentManager? / buildPromptMessages`。
- 内部所有 `runner.run(...)` 改为 `runAgent(deps, input)`。
- 内部所有 `messageWriter.writeUserMessage(...)` 改为给 `runAgent` 传 `initialUserPrompt`，由 `runAgent` 统一写入。
- 现有 `tasks/manager.unit.test.ts` 用例语义保持不变，mock 形状调整为新 deps。

**关联**：G2、G3、G7。

### AC-3.5 依赖方向归正

**判定**：grep 验证：

- `agents/` 目录下所有源文件**不**直接 import `runtime/run-manager / runtime/run-ledger / runtime/stream-bridge / runtime/interaction-broker / runtime/daemon` 的实现或类型。
- `agents/` 通过构造参数接收 `AgentRunCoordinator` 端口，但不持有运行时编排逻辑。
- `agents/` 内的所有"启动 + 等待 + 收口"序列编排均委托 `core/agents.runAgent`。

**关联**：G3、PG-2。

### AC-3.6 公共 API 形态收敛

**判定**：

- `agents/index.ts` 导出 `AgentService / AgentServiceOptions / AgentTaskManager / InMemoryAgentTaskStore` 等新架构入口。
- `agents/index.ts` 不再导出旧 `runner/executor` 兼容符号。
- 类型测试：旧 import `SubagentExecutor / createSubagentRunner / SubagentRunner` 应失败或运行期 export 不存在；新 import `AgentService` 可用。

**关联**：G6。

### AC-3.7 adapters / CLI 切换到原生底座

**判定**：

- 仓库中构造 `SubagentExecutor / AgentService / AgentTaskManager` 的地点，全部传入 `SessionManager / AgentRunCoordinator / MessageManager / ToolScheduler / buildPromptMessages` 等底座，不再传入 `SubagentSessionManager / SubagentRunner / SubagentMessageWriter`。
- 至少存在一份集成测试或合约测试，覆盖 adapter 通过新 deps 构造 `AgentService` 并执行一次 Task 调用、读到 child assistant 输出的端到端路径。

**关联**：G6、与上游验收衔接。

### AC-3.8 primary 路径未受影响

**判定**：

- `composition.ts:buildSessionPromptMessages` 不变。
- RunWorker 不变。
- Primary 启动路径仍走 composition → RunWorker → Lifecycle.run（旧路径），不调用 `core/agents.runAgent`。
- 现有 primary 相关测试（`ui-inprocess.contract.test.ts` 等）不修改且全绿。

**关联**：G7。

### AC-3.9 测试套件全绿

**判定**：`pnpm -F ohbaby-agent test` 一次性通过。

**关联**：G6。

---

## 五、AC-4：`session-manager.ts` 删除验收

对应实施阶段 [GP4](./implementation-plan.md#五阶段-gp4删除-agentssession-managerts)。

### AC-4.1 文件删除

**判定**：

- `agents/session-manager.ts` 不存在。
- `agents/session-manager.unit.test.ts` 不存在。

**关联**：G4、PG-9。

### AC-4.2 类型删除

**判定**：

- `agents/types.ts` 不再导出 `SubagentSession / SubagentSessionManager / RuntimeSubagentSessionManager`。
- `agents/index.ts` 不再 re-export `InMemorySubagentSessionManager / PersistentSubagentSessionManager / createRuntimeSubagentSessionManager`。
- grep 验证以上标识符在仓库中**零引用**（除本验收文档外）。

**关联**：G4。

### AC-4.3 调用方切换到 `SessionManager`

**判定**：

- `agents/service.ts` 的 sessionManager 类型为 `SessionManager`。
- `agents/tasks/manager.ts` 同上。
- adapter / CLI 初始化代码中，构造 session manager 的调用为 `createSessionManager(...)`，不再出现 `createRuntimeSubagentSessionManager(...)`。

**关联**：G4。

### AC-4.4 ensureRoot 调用方迁移完毕

**判定**：

- 所有原 `RuntimeSubagentSessionManager.ensureRoot` 的调用点均切换到 `SessionManager.ensureRoot`。
- grep 验证仓库中不再存在对 `RuntimeSubagentSessionManager` 的引用。

**关联**：G4。

### AC-4.5 测试套件全绿

**判定**：`pnpm -F ohbaby-agent test` 一次性通过。

**关联**：G6。

---

## 六、AC-5：`message-writer.ts` 删除验收

对应实施阶段 [GP5](./implementation-plan.md#六阶段-gp5删除-agentsmessage-writerts)。

**前置条件**：[lifecycle improve-1 A2 系列](../../core/lifecycle/improve-1/acceptance.md#三a2-系列lifecycle-runsession-入口验收) 全部通过验收。

### AC-5.1 文件删除

**判定**：

- `agents/message-writer.ts` 不存在。
- `agents/message-writer.unit.test.ts` 不存在。

**关联**：G5、PG-8。

### AC-5.2 类型删除

**判定**：

- `agents/types.ts` 不再导出 `SubagentMessageWriter`。
- `agents/index.ts` 不再 re-export `createSubagentMessageWriter / SubagentMessageWriter`。
- grep 验证以上标识符在仓库中**零引用**（除本验收文档外）。

**关联**：G5。

### AC-5.3 `AgentService` 与 `AgentTaskManager` 内联 user message

**判定**：

- `agents/service.ts` 与 `agents/tasks/manager.ts` 不再写 user message；二者通过 `runAgent({ initialUserPrompt })` 触发统一写入。
- `core/agents.runAgent` 内直接调用 `messageManager.createMessage + messageManager.appendPart` 写入 user message；或者（替代方案）调用 `createUserTextMessage(messageManager, ...)`，且该助手定义在 `core/message/writers.ts`。
- 二者不再接收 `messageWriter` 构造参数。

**关联**：G5。

### AC-5.4 错误路径不再依赖 writeAssistantMessage

**判定**：

- `AgentService.executeTask` 的 catch 分支直接返回 `SubagentResult { success: false, output: errorMessage }`，不调用兜底 assistant 写入。
- `AgentTaskManager` 同上。
- lifecycle.runSession 在错误时由其自身的 finish handling 持久化 assistant 错误状态（由 lifecycle improve-1 P2 验收保证）。
- 单测覆盖 —— 工具执行失败时，错误消息正确通过 `SubagentResult` 返回，且 `MessageManager` 中存在由 lifecycle 写入的 error finish assistant message（不是 service 写入的兜底 message）。

**关联**：G5、与 lifecycle improve-1 接合面。

### AC-5.5 测试套件全绿

**判定**：`pnpm -F ohbaby-agent test` 一次性通过。

**关联**：G6。

---

## 七、AC-6：最终形态核对

本节是所有阶段完成后的最终核对。

### AC-6.1 `agents/` 文件清单

**判定**：`agents/` 目录下源文件清单为：

```
agents/
├── types.ts
├── registry.ts
├── registry.unit.test.ts
├── manager.ts
├── manager.unit.test.ts
├── service.ts                  ← 新（GP3）
├── service.unit.test.ts        ← 新
├── tasks/
│   ├── manager.ts              ← refactored（GP3）
│   ├── manager.unit.test.ts
│   ├── in-memory-store.ts
│   ├── in-memory-store.unit.test.ts
│   ├── types.ts
│   └── index.ts
├── builtin/...
└── index.ts
```

不应出现：

- `session-manager.ts`（GP4 删除）
- `session-manager.unit.test.ts`
- `message-writer.ts`（GP5 删除）
- `message-writer.unit.test.ts`
- `runner.ts`（旧 API，本轮直接删除）
- `runner.unit.test.ts`
- `executor.ts`（旧 API，本轮直接删除）
- `executor.unit.test.ts`

**关联**：G1、G2、G4、G5。

### AC-6.2 `core/agents/` 文件清单

**判定**：

```
core/agents/
├── runner.ts
├── runner.unit.test.ts
├── output.ts
├── output.unit.test.ts
├── types.ts
└── index.ts
```

**关联**：G1。

### AC-6.3 依赖图反向规则

**判定**：在仓库根执行 grep / 静态依赖检查：

| 规则 | 验证 |
|------|------|
| `agents/` 不依赖 `runtime/run-manager` 等实现 | `agents/` 文件中无直接 import `runtime/run-manager/index.js` 或相关类型（仅通过构造参数接收 `AgentRunCoordinator` 端口） |
| `agents/` 不依赖 `services/session` 实现细节 | `agents/` 不再持有 session 实现，仅消费 `SessionManager` 接口 |
| `agents/` 不绕过 `core/agents` 自行编排 RunManager | `agents/service.ts` / `tasks/manager.ts` 中所有"启动 + 等待 + 收口"序列均委托 `runAgent` |
| `core/agents/` 不依赖 `agents/` | grep 验证 |
| `core/agents/` 不依赖 `adapters/` | grep 验证 |
| `runtime/` 不依赖 `agents/` / `core/agents/` | grep 验证 |

**关联**：G3、PG-2。

### AC-6.4 `agents/index.ts` 导出列表

**判定**：

- 导出 `AgentConfig / AgentMode / PermissionConfig / PermissionValue / ToolsConfig / AgentsConfig / RuntimeAgent` 等描述符类型。
- 导出 `AgentManager / toolsConfigToRecord / AgentRegistry`。
- 导出 `BUILTIN_AGENTS / BUILTIN_AGENT_NAMES / buildAgent / exploreAgent / planAgent / researchAgent`。
- 导出 `AgentService / AgentServiceOptions`；session 依赖直接消费 `services/session.SessionManager` 的 `create/get` 契约，不再定义 agents 专属的窄 session 包装。
- 导出 `SubagentToolCallSummary / SubagentExecuteParams / SubagentResult / TaskExecutor`（Task 工具 envelope 契约，名称在 improve-2 再评估）。
- 导出 `AgentTaskManager / InMemoryAgentTaskStore / AgentTaskRecord` 等。
- **不**再导出 `SubagentExecutor / SubagentExecutorOptions / createSubagentRunner / SubagentRunner / CreateSubagentRunnerOptions / SubagentPromptMessageBuilder / SubagentSandboxEnvironmentManager`。
- **不**再导出 `createSubagentMessageWriter / SubagentMessageWriter`。
- **不**再导出 `createRuntimeSubagentSessionManager / InMemorySubagentSessionManager / PersistentSubagentSessionManager / SubagentSessionManager / RuntimeSubagentSessionManager / SubagentSession`。

**关联**：G2、G4、G5、G6。

---

## 八、全局验收（跨阶段）

### AG-1 类型与编译

`pnpm -F ohbaby-agent typecheck` 一次性通过。

### AG-2 测试套件

`pnpm -F ohbaby-agent test` 一次性通过。

### AG-3 静态检查

`pnpm -F ohbaby-agent lint` 一次性通过。无新增 warning。

### AG-4 公共 API 变更声明

在 `packages/ohbaby-agent/CHANGELOG.md` 记录：

**新增**：

- `SessionManager.ensureRoot(input)` 方法。
- `core/agents/` 模块（`runAgent / extractFinalOutput / AgentRunInput / AgentRunResult / AgentRunner / AgentRunDeps / AgentToolCallSummary`）。
- `agents.AgentService / AgentServiceOptions`。

**移除（破坏性，本仓库内部消费者均已迁移）**：

- `agents/session-manager.ts` 及其导出（`createRuntimeSubagentSessionManager / InMemorySubagentSessionManager / PersistentSubagentSessionManager / RuntimeSubagentSessionManager`）。
- `agents/message-writer.ts` 及其导出（`createSubagentMessageWriter`）。
- `agents/types.ts` 中 `SubagentSessionManager / RuntimeSubagentSessionManager / SubagentSession / SubagentMessageWriter` 类型。
- `agents/runner.ts` 及其导出（`createSubagentRunner / SubagentRunner / CreateSubagentRunnerOptions` 等）。
- `agents/executor.ts` 及其导出（`SubagentExecutor / SubagentExecutorOptions`）。

### AG-5 文档同步

- `docs/agents/architecture.md` 更新，反映改造结果与新分层（`core/agents` + `agents/`）。
- `docs/agents/goals-duty.md` 更新职责声明：`agents/` 是服务/调度层。
- `docs/agents/dfd-interface.md` 更新数据流图。
- `docs/agents/context-isolation.md` 涉及 session 管理段落更新引用为 `services/session.SessionManager`。
- `docs/core/` 下新增 `agents/` 子目录（与 lifecycle / context 同级），至少含 `goals-duty.md` 与 `architecture.md`。

### AG-6 与 lifecycle improve-1 / context improve-1 接合面验收

- lifecycle improve-1 A2 系列全部通过，作为 GP5 启动的前置条件。
- context improve-1 AC-1 系列全部通过，作为 lifecycle improve-1 P2 的前置条件，本轮间接依赖。
- 三份 docset 对接合面（`prepareTurn / runSession / assistant 持久化 / runAgent`）的描述无矛盾，由人工 review 确认。

### AG-7 兼容性回归

以下场景在 improve-1 全部阶段完成后，无可观察行为差异：

- CLI / TUI 普通会话（多步 + 含工具）—— primary 路径未切换，行为完全等价。
- 通过 Task 工具触发 subagent 执行（含成功与失败两条路径）—— subagent 路径已切到 `core/agents.runAgent`，行为应与改造前等价。
- 通过多轮 subagent 任务（agents/tasks）启动并持续交互 —— 同上。
- 主动 `/compact` 命令（如已实现）。

### AG-8 反向规则的持续保护

**判定**：在仓库根追加（或更新）静态规则文件（如 `dependency-cruiser.config.js`、ESLint `import/no-restricted-paths` 规则、或等价机制），禁止：

- `packages/ohbaby-agent/src/agents/**/*.ts` 直接 import `packages/ohbaby-agent/src/runtime/run-manager` 等实现。
- `agents/` 绕过 `core/agents/runAgent` 自行编排 RunManager 调用。
- `core/agents/**/*.ts` import `packages/ohbaby-agent/src/agents/` / `adapters/`。
- `runtime/**/*.ts` import `agents/` / `core/agents/`。

无现成依赖图检查工具时，至少在 `docs/agents/architecture.md`、`docs/agents/goals-duty.md`、`docs/core/agents/goals-duty.md`（新建）中明确写入并以代码评审保障。

**关联**：G3、PG-2 的长期保护。

### AG-9 子代理审查与 e2e 验收（实施时执行）

按本仓库工作流，本轮改造接受时至少触发：

- **子代理审查 1**：架构边界与依赖方向检查 —— 给出文件级 grep 结果与具体行号。
- **子代理审查 2**：行为兼容、测试缺口、e2e 数据流检查 —— 给出可复现命令。
- **e2e**：按 `ohbaby-e2e-test.md` 跑真实 primary → task/subagent → child session → tool/message/run ledger 数据流；并检查 resume / cancel / error 路径。

---

## 九、验收会议清单

每个阶段交付时按以下顺序逐项核对：

| 序号 | 检查项 | 通过条件 |
|------|-------|---------|
| 1 | 阶段对应 AC 系列条目逐项核对 | 全部"通过" |
| 2 | 现有测试套件全绿 | `test / typecheck / lint` 三命令零失败 |
| 3 | 旧 API 是否清理干净 | `SubagentExecutor / createSubagentRunner / SubagentRunner` 等旧 export 命中数为 0 |
| 4 | grep 反向规则核对 | AG-8 中所有禁止项命中数为 0 |
| 5 | CHANGELOG 与架构文档同步 | 文档 PR 与代码 PR 同批合并 |
| 6 | 与 lifecycle / context improve-1 接合面 review | AG-6 通过 |
| 7 | 子代理 + e2e 审查 | AG-9 通过 |
| 8 | 回滚方案演练（可选） | 在分支上 revert 测试，确认回滚后仍全绿 |

---

## 十、不在验收范围内

- primary agent 路径切换到 `core/agents.runAgent`（improve-2）。
- Task 工具 envelope 类型命名整理（如 `SubagentExecuteParams` 是否重命名为 `TaskInvocationParams`，improve-2 决定）。
- AgentManager / AgentRegistry / builtin 功能演进。
- primary 流式 envelope 进一步切换到 `Lifecycle.runSession` 完整路径（依赖 improve-2 RunManager 改造）。
- 新增 agent 类型或权限模型升级。

---

## 十一、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 架构决策：[decisions.md](./decisions.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)
- 协同导航：[README.md](./README.md)
- 上游依赖：[lifecycle improve-1](../../core/lifecycle/improve-1/)、[context improve-1](../../core/context/improve-1/)
