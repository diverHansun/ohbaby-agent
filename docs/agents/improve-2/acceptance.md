# agents improve-2 成果验收

> 状态：**前瞻性草案**。详细验收项在 improve-1 完成后基于实际代码状态再细化。

本文档定义本轮重构的验收标准。每条验收项均可独立判定"通过 / 不通过"。

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)
- 协同导航：[README.md](./README.md)

---

## 一、验收原则

1. **可验证**：每条验收项可通过自动化测试、命令输出或代码审阅明确判定。
2. **零回归**：Phase 1、Phase 2 完成期间，所有现有 e2e 行为保持等价（特别是 primary 路径）。
3. **阶段独立**：AC-1 / AC-2 / AC-3 分别独立验收。
4. **改造破坏性显式**：如 Phase 3 重命名公开类型，必须在 CHANGELOG.md 显式声明。
5. **灰度门槛**：公开类型命名调整前必须有 Phase 2 落地稳定运行的证据。

---

## 二、AC-1：`core/agents.runAgent` stream 分支验收

对应实施阶段 [Phase 1](./implementation-plan.md#二phase-1实现-runagent-的-stream-分支)。

### AC-1.1 stream 分支可调用

**判定**：

- `runAgent(deps, { ..., waitMode: "stream" })` 不再抛 `NotImplementedError`。
- 返回 `AgentRunResult { events: AsyncIterable<LifecycleEvent>, ... }`。
- `result.events` 可以被 `for await` 消费。

### AC-1.2 事件桥接正确

**判定**：单测构造 mock RunManager：

- RunManager 内部产生 `llm:start / llm:delta / llm:complete / tool:start / tool:result / step:complete / turn:start / turn:end` 等事件。
- `result.events` 按序产出等价事件。
- 事件 payload 完整（不丢失字段）。

### AC-1.3 abort 传播

**判定**：单测覆盖：

- caller 触发 `signal.abort()`：
  - `result.events` 迭代终止。
  - `RunManager.cancel(runId)` 被调用。
- caller 中途停止消费 `result.events`：
  - 后续 RunManager 事件不再产出（资源不泄漏）。

### AC-1.4 错误传播

**判定**：单测覆盖：

- RunManager 内部错误时，最终事件包含错误信息（`step:complete` with `finishReason: "error"` 或等价形式）。
- caller 通过事件流即可感知错误，不需要单独的错误回调。

### AC-1.5 stream 分支不影响 waitForCompletion 分支

**判定**：

- `runAgent(..., { waitMode: "waitForCompletion" })` 行为与 improve-1 完全一致。
- improve-1 的 `core/agents/runner.unit.test.ts` 全部用例不修改且全绿。

---

## 三、AC-2：`AgentService.startSession` 与 adapter 切换验收

对应实施阶段 [Phase 2](./implementation-plan.md#三phase-2agentservicestartsession-与-adapter-切换)。

### AC-2.1 `startSession` 接口存在

**判定**：

- `agents/service.ts` 的 `AgentService` 类暴露 `startSession(params: StartSessionParams): AsyncIterable<LifecycleEvent>`。
- `agents/types.ts`（或 `agents/service.ts`）导出 `StartSessionParams` 类型。
- `agents/index.ts` 导出 `StartSessionParams`。
- `pnpm -F ohbaby-agent typecheck` 通过。

### AC-2.2 `startSession` 行为正确

**判定**：集成测试构造完整依赖（`AgentService` + mock 或真实 `RunManager / MessageManager / ToolScheduler` 等）：

- 调用 `startSession({ sessionId, agentName, prompt, ... })`：
  - 内部解析 RuntimeAgent。
  - 通过 `runAgent({ initialUserPrompt: prompt })` 写入 user message。
  - 调用 `core/agents.runAgent({ waitMode: "stream", ... })`。
  - 产出事件流，事件序列与 improve-1 完成前的 primary 路径**等价**。

### AC-2.3 composition.ts 不再预组装 messages

**判定**：

- `composition.ts:buildSessionPromptMessages` 与 `composition.ts:buildPrimaryPromptMessages` 已删除（或 grep 命中数为 0）。
- CLI / TUI primary 启动路径改为调 `agentService.startSession(...)`。

### AC-2.4 RunManager 调用方式收敛

**判定**：

- 仓库中 `runManager.create(...)` 的调用点全部在 `core/agents/runner.ts` 内部。
- `adapters/`、`agents/` 不再直接调 `runManager.create`。
- grep 验证：`grep -r "runManager.create" packages/ohbaby-agent/src/` 命中位置仅在 `core/agents/` 与 `runtime/run-manager/` 内部。

### AC-2.5 primary 行为零回归

**判定**：

- 现有 primary 相关 e2e / contract 测试不修改且全绿。
- 包括但不限于：`ui-inprocess.contract.test.ts`、`worker.unit.test.ts`（如存在）、其它 adapter 集成测试。
- 手动 / 自动 e2e 验证以下场景行为与 improve-1 完成前等价：
  - CLI / TUI 普通会话（多步 + 含工具）
  - 主动 `/compact` 命令
  - 中途取消（abort）
  - 错误恢复（如工具执行失败、LLM 报错）

### AC-2.6 灰度稳定

**判定**：

- Phase 2 落地后**至少运行 1 个迭代周期**。
- 期间无 primary 路径相关的回归报告。
- 此项为 Phase 3 启动的硬门槛。

---

## 四、AC-3：服务层 envelope 类型整理与旧 API 防回归验收

对应实施阶段 [Phase 3](./implementation-plan.md#四phase-3服务层-envelope-类型整理与旧-api-防回归)。

### AC-3.1 旧 runner / executor API 保持删除

**判定**：

- `agents/runner.ts` 不存在。
- `agents/executor.ts` 不存在。
- `agents/runner.unit.test.ts` 不存在。
- `agents/executor.unit.test.ts` 不存在。

### AC-3.2 旧符号零回流

**判定**：每阶段 PR 包含 grep 证据：

- `grep -r "SubagentExecutor" packages/ohbaby-agent/src/` 命中数为 0。
- `grep -r "createSubagentRunner" packages/ohbaby-agent/src/` 命中数为 0。
- `grep -r "SubagentRunner" packages/ohbaby-agent/src/` 命中数为 0（测试中断言旧 export 不存在的字符串除外）。
- `grep -r "SubagentExecutorOptions" packages/ohbaby-agent/src/` 命中数为 0。
- `grep -r "CreateSubagentRunnerOptions" packages/ohbaby-agent/src/` 命中数为 0。
- `grep -r "SubagentPromptMessageBuilder" packages/ohbaby-agent/src/` 命中数为 0。

### AC-3.3 `agents/index.ts` 不再导出旧 runner / executor 符号

**判定**：

- `agents/index.ts` 不导出 `SubagentExecutor / SubagentExecutorOptions / createSubagentRunner / CreateSubagentRunnerOptions / SubagentPromptMessageBuilder / SubagentSandboxEnvironmentManager / toOpenAiTools`（视哪些属 shim）。
- 类型测试：旧 import `import { SubagentExecutor } from "agents"` **失败**（编译错误）。
- 当前调用方全部走 `import { AgentService } from "agents"` 或 `import { runAgent } from "core/agents"`。

### AC-3.4 Task envelope 类型命名决议

**判定**：

- 明确决议 `SubagentExecuteParams / SubagentResult / SubagentToolCallSummary / TaskExecutor` 是否保留现名。
- 如重命名，提供新名、迁移映射与类型测试。
- 如不重命名，文档说明这些类型属于 Task 工具同步 envelope，而非底层运行机制。

### AC-3.5 CHANGELOG 记录破坏性变更（如有）

**判定**：若 Phase 3 重命名公开类型，`packages/ohbaby-agent/CHANGELOG.md` 在本 release 条目下：

- 标记 `[BREAKING]` 标签。
- 列出移除或重命名的类型清单。
- 给出迁移指引（旧名 → 新名映射）。

### AC-3.6 测试套件全绿

**判定**：`pnpm -F ohbaby-agent test / typecheck / lint` 一次性通过。

---

## 五、AC-4：最终形态核对

本节是所有阶段完成后的最终核对。

### AC-4.1 `agents/` 文件清单

**判定**：

```
agents/
├── types.ts            ← 描述符 + 服务层契约
├── registry.ts
├── registry.unit.test.ts
├── manager.ts
├── manager.unit.test.ts
├── service.ts          ← AgentService（executeTask + startSession）
├── service.unit.test.ts
├── tasks/
│   ├── manager.ts
│   ├── manager.unit.test.ts
│   ├── in-memory-store.ts
│   ├── in-memory-store.unit.test.ts
│   ├── types.ts
│   └── index.ts
├── builtin/...
└── index.ts
```

不应出现：

- `runner.ts`（Phase 3 删除）
- `executor.ts`（Phase 3 删除）
- `runner.unit.test.ts`（如 improve-1 还保留）
- `session-manager.ts`（improve-1 删除）
- `message-writer.ts`（improve-1 删除）

### AC-4.2 `core/agents/` 文件清单

**判定**：

```
core/agents/
├── runner.ts           ← runAgent（含 waitForCompletion + stream 两个分支）
├── runner.unit.test.ts
├── output.ts
├── output.unit.test.ts
├── types.ts            ← AgentRunInput / AgentRunResult / AgentRunDeps 等纯运行底层契约
└── index.ts
```

### AC-4.3 依赖图与反向规则

**判定**：

- `agents/` 不直接 import `runtime/run-manager` 实现或类型（继续 improve-1 的约束）。
- `agents/` 不绕过 `core/agents.runAgent` 自行编排 RunManager 调用。
- `core/agents/` 不 import `agents/` 或 `adapters/`。
- `runtime/` 不 import `agents/` 或 `core/agents/`。
- `composition.ts` 不持有 prompt 组装与 RunManager 编排逻辑。

### AC-4.4 命名一致性

**判定**：

- `agents/service.ts` 与 `core/agents/runner.ts` 的命名风格统一（如都不带 "subagent" 前缀）。
- 公共 API 中"subagent" 前缀仅保留在确实需要表达"作为子代理的特定调用"的类型上（如 `SubagentExecuteParams` 强调 Task 工具的 envelope）。

---

## 六、全局验收

### AG-1 类型与编译

`pnpm -F ohbaby-agent typecheck` 一次性通过。

### AG-2 测试套件

`pnpm -F ohbaby-agent test` 一次性通过。

### AG-3 静态检查

`pnpm -F ohbaby-agent lint` 一次性通过。

### AG-4 CHANGELOG 与文档同步

- `CHANGELOG.md` 记录 Phase 3 中发生的破坏性类型变更（如有）。
- `docs/agents/architecture.md` 更新最终架构。
- `docs/agents/goals-duty.md` 更新最终职责声明。
- `docs/agents/dfd-interface.md` 更新数据流图。

### AG-5 与 lifecycle / context improve-2 接合面

- 与 lifecycle improve-2 完成的 `runSession` RunWorker 切换协调一致。
- 与 context improve-2 完成的增量摘要等优化协调一致（如有）。

### AG-6 e2e 与子代理审查

- 触发至少两个子代理独立审查：架构边界 + 行为兼容。
- e2e 测试覆盖 primary 与 subagent 完整数据流。

### AG-7 反向规则持续保护

更新 `dependency-cruiser.config.js` 或等价机制：

- 禁止 `agents/**/*.ts` 直接 import `runtime/run-manager` 实现或类型。
- 禁止 `agents/**/*.ts` 绕过 `core/agents.runAgent` 自行编排。
- 禁止 `composition.ts` 直接调 `runManager.create`。

---

## 七、验收会议清单

| 序号 | 检查项 | 通过条件 |
|------|-------|---------|
| 1 | 阶段对应 AC 系列条目逐项核对 | 全部"通过" |
| 2 | 现有测试套件全绿 | `test / typecheck / lint` 三命令零失败 |
| 3 | Phase 3 启动前的灰度证据 | 至少 1 个迭代周期无回归报告 |
| 4 | grep 反向规则核对 | AG-7 中所有禁止项命中数为 0 |
| 5 | CHANGELOG 与架构文档同步 | 文档 PR 与代码 PR 同批合并 |
| 6 | 与 lifecycle / context improve-2 接合面 review | AG-5 通过 |
| 7 | 子代理 + e2e 审查 | AG-6 通过 |

---

## 八、不在验收范围内

- Session tree / branch / fork 数据模型（improve-3 或专项）
- 多 provider 抽象层
- Agent 权限模型升级
- Builtin agents 功能演进
- Tools / permissions 模型重设计
- 子 agent 调度策略升级

---

## 九、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 实施步骤：[implementation-plan.md](./implementation-plan.md)
- 协同导航：[README.md](./README.md)
- 上游：[agents improve-1](../improve-1/) 全套
