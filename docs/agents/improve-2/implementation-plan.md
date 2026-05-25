# agents improve-2 实施计划

> 状态：**前瞻性草案**。详细步骤在 improve-1 完成后基于实际代码状态再细化。

本文档定义本轮的分阶段方案。改造动机见 [problem-analysis.md](./problem-analysis.md)，验收见 [acceptance.md](./acceptance.md)。

---

## 一、总体策略

### 1.1 三阶段递进

| 阶段 | 主题 | 主要解决 | 是否破坏现有 API |
|------|------|---------|----------------|
| Phase 1 | 实现 `core/agents.runAgent` 的 `waitMode: "stream"` 分支 | 目标一前置 | 否（improve-1 已预留接口） |
| Phase 2 | `AgentService.startSession` 落地；composition / RunWorker 切到该入口 | 目标一、目标二 | 否（新增方法 + adapter 内部重构） |
| Phase 3 | 服务层 envelope 类型整理与旧 API 防回归 | 目标三、目标四 | 视命名策略而定 |

每阶段独立可交付、独立可回滚。旧 `agents/runner.ts` / `agents/executor.ts` 已在 improve-1 删除，本轮不再安排 shim 删除阶段；如 Phase 3 重命名公开类型，需要在 release 说明中显式标注。

### 1.2 依赖与时序

```
agents improve-1 完成验收
        │
        ▼
lifecycle improve-2 完成（推荐前置，不严格依赖）
        │
        ▼
Phase 1: 实现 runAgent 的 stream 分支
        │
        ▼
Phase 2: AgentService.startSession + adapter 切换
        │
        ▼
Phase 3: envelope 类型整理 + 旧 API 防回归
```

**为什么 Phase 2 后要灰度**：primary 路径是产品主流量，切换后必须确认无可观察行为差异，再做任何公开类型命名调整。

### 1.3 API 策略

- 旧 `SubagentExecutor / createSubagentRunner / SubagentRunner` 不恢复、不 alias。
- **Phase 1、Phase 2** 只新增 stream/startSession 能力，不改 Task 工具 envelope 公开类型。
- **Phase 3** 如果决定重命名 `SubagentExecuteParams / SubagentResult` 等公开类型，必须更新 CHANGELOG.md 与版本号；如果仅内部整理，则保持非破坏性。

---

## 二、Phase 1：实现 `runAgent` 的 stream 分支

### 2.1 目标

完成 `core/agents.runAgent` 在 `waitMode: "stream"` 时的行为实现。improve-1 期间该分支仅做了类型预留与 `NotImplementedError`，本阶段填实。

### 2.2 设计草案

```ts
// core/agents/runner.ts （improve-2 完成后）
export async function runAgent(deps, input): Promise<AgentRunResult> {
  // 公共前置：tools / sandbox env / initialUserPrompt
  // ...

  const record = await deps.runCoordinator.create({...});
  bindAbort(...);

  if (input.waitMode === "waitForCompletion") {
    // improve-1 已实现，不动
    const completion = await deps.runManager.waitForCompletion(record.runId);
    return { ... finalOutput, ... };
  }

  // improve-2 新增
  return {
    sessionId: input.sessionId,
    success: true,           // stream 模式下立即返回，success 由 caller 通过事件判定
    events: deps.runEventSource.subscribeRunEvents(record.runId),
  };
}

// AgentRunDeps 在 improve-2 新增 runEventSource 端口：
// runEventSource.subscribeRunEvents(runId): AsyncIterable<LifecycleEvent>
```

### 2.3 内部实现要点

- `subscribeRunEvents` 不应重复发明事件桥接 —— 通过 `core/agents` 的 `AgentRunEventSource` 端口复用 [`runtime/stream-bridge`](../../../packages/ohbaby-agent/src/runtime/stream-bridge/) 已有能力。
- abort 传播：caller 提供的 `signal` 必须能取消整个 stream（包括 RunManager 内部的 run 与事件订阅）。
- 错误传播：RunManager 内部错误通过事件流的最终事件（如 `run:error` 或 `step:complete` with `finishReason: "error"`）传递给 caller。

### 2.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/agents/runner.ts` | 实现 stream 分支并消费 `AgentRunEventSource.subscribeRunEvents` |
| `core/agents/runner.unit.test.ts` | 新增 stream 模式测试（mock RunManager 事件流） |
| `core/agents/types.ts` | 不变（improve-1 已预留） |

### 2.5 验收衔接

详见 [acceptance.md AC-1](./acceptance.md#二ac-1coreagents-stream-分支验收)。

---

## 三、Phase 2：`AgentService.startSession` 与 adapter 切换

### 3.1 目标

让 primary 启动路径完全消费 `AgentService.startSession`，composition.ts 不再手工编排 prompt + RunManager。

### 3.2 设计草案

#### 3.2.1 `AgentService.startSession`

```ts
// agents/service.ts （improve-2 完成后）
export class AgentService {
  // improve-1 已有
  async executeTask(params: SubagentExecuteParams): Promise<SubagentResult> { ... }

  // improve-2 新增
  startSession(params: StartSessionParams): AsyncIterable<LifecycleEvent> {
    return this.startSessionInner(params);
  }

  private async *startSessionInner(params: StartSessionParams): AsyncIterable<LifecycleEvent> {
    // 1. agentManager.getRuntimeAgent(params.agentName, { isSubagent: false })
    // 2. sessionManager.ensureRoot or get
    // 3. 调用 core/agents.runAgent({
    //      ...,
    //      parentSessionId: undefined,         // primary
    //      waitMode: "stream",
    //      initialUserPrompt: params.prompt,    // 由 runAgent 统一写 user message
    //    })
    // 4. yield* result.events
  }
}

export interface StartSessionParams {
  readonly sessionId: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly directory: string;
  readonly modelId: string;
  readonly signal?: AbortSignal;
  readonly tools?: readonly string[];
  readonly maxSteps?: number;
}
```

#### 3.2.2 composition.ts 改造

```ts
// 改造前
async function buildSessionPromptMessages(...): Promise<ChatCompletionMessage[]> {
  const compactResult = await contextManager.compact(...);
  const context = await contextManager.assemble(...);
  // ... 组装 system prompt + memory + history
}
// CLI / TUI → buildSessionPromptMessages → RunWorker.create({ messages, ... })

// 改造后
// CLI / TUI → agentService.startSession({ sessionId, agentName, prompt, ... })
//          → 内部走 core/agents.runAgent({ waitMode: "stream" })
//          → 内部走 RunManager.create → Lifecycle.runSession → prepareTurn
```

composition.ts 的 `buildSessionPromptMessages / buildPrimaryPromptMessages / buildSubagentPromptMessages` 整体删除（subagent 的 buildSubagentPromptMessages 在 agents improve-1 GP3 已经被 service.ts 使用，本轮一并删除）。

#### 3.2.3 RunWorker 改造

RunWorker 在 lifecycle improve-2 阶段已经切换到 `Lifecycle.runSession`。本阶段：

- 如果 RunWorker 已经统一调 `runSession`，agents improve-2 的 `runAgent stream` 分支可以直接通过 RunManager 触发，无需 RunWorker 再变化。
- 如果 lifecycle improve-2 未完成，RunWorker 需要根据 `RunManager.create` 是否传入 `messages` 来选择走 `run` 或 `runSession` —— 这是过渡形态。

### 3.3 代码改动清单

| 文件 | 改动 |
|------|------|
| `agents/service.ts` | 新增 `startSession` 方法 |
| `agents/service.unit.test.ts` | 新增 startSession 测试 |
| `agents/types.ts` | 新增 `StartSessionParams` |
| `agents/index.ts` | 导出 `StartSessionParams` |
| `adapters/ui-runtime/composition.ts` | 删除 `buildSessionPromptMessages` 等函数；CLI / TUI 启动路径改为调 `agentService.startSession` |
| `runtime/run-manager/worker.ts` | 视 lifecycle improve-2 进度，可能需要适配 |

### 3.4 验收衔接

详见 [acceptance.md AC-2](./acceptance.md#三ac-2agentservicestartsession-与-adapter-切换验收)。

---

## 四、Phase 3：服务层 envelope 类型整理与旧 API 防回归

### 4.1 前置条件

- Phase 1、Phase 2 完成并通过灰度（至少 1 个迭代周期）。
- grep 验证：旧 runner/executor API 未重新出现。

### 4.2 改动顺序

1. **旧 API 防回归扫描**：

   ```bash
   grep -r "SubagentExecutor" packages/ohbaby-agent/src/
   grep -r "createSubagentRunner" packages/ohbaby-agent/src/
   grep -r "SubagentRunner" packages/ohbaby-agent/src/
   grep -r "SubagentExecutorOptions" packages/ohbaby-agent/src/
   ```

   命中数应为 0（测试中用于断言旧 export 不存在的字符串除外）。

2. **评估 Task envelope 类型命名**：

   - `SubagentExecuteParams` 是否改为 `TaskInvocationParams`。
   - `SubagentResult` 是否改为 `TaskInvocationResult`。
   - `SubagentToolCallSummary` 是否改为 `AgentToolCallSummary` 或复用 `core/agents.AgentToolCallSummary`。

3. **重新评估** `AgentTaskManager` 的对外形态：

   - 是否需要更名为更通用的概念？（如 `TaskManager`）
   - 本轮可仅做评估，不动名称。

### 4.3 代码改动清单

| 文件 | 改动 |
|------|------|
| `agents/types.ts` | 视决议重命名 Task envelope 类型，或保留现状并补充注释 |
| `agents/service.ts` | 如类型重命名，更新方法签名 |
| `tools/task.ts` 与相关测试 | 如类型重命名，更新 import |
| `agents/index.ts` | 导出新类型；旧类型 alias 是否保留由本阶段决议决定 |
| `CHANGELOG.md` | 如有破坏性类型重命名，标注 breaking change |

### 4.4 验收衔接

详见 [acceptance.md AC-3](./acceptance.md#四ac-3服务层-envelope-类型整理与旧-api-防回归验收)。

---

## 五、最终 `agents/` 形态

### 5.1 目标

`agents/types.ts` 只保留描述符类型与服务层契约；纯运行底层契约保留在 `core/agents/types.ts`。

### 5.2 类型搬迁映射

| 类型 | 当前位置 | 改后位置 | 备注 |
|------|---------|---------|------|
| `AgentConfig / AgentMode / AgentsConfig / PermissionConfig / PermissionValue / ToolsConfig / RuntimeAgent` | `agents/types.ts` | **不动**（描述符） | |
| `SubagentToolCallSummary` | `agents/types.ts` | `agents/types.ts` 或复用 `core/agents.AgentToolCallSummary` | 服务层返回摘要；Phase 3 决定 |
| `SubagentExecuteParams / SubagentResult` | `agents/types.ts` | `agents/types.ts` | Task tool envelope 契约，仍属服务/调度层 |
| `TaskExecutor` | `agents/types.ts` | `agents/types.ts` | 同上 |
| `StartSessionParams` | `agents/types.ts`（Phase 2 新增） | `agents/types.ts` | 服务/调度层契约 |
| `SystemPromptProvider`（agents 模块内部用） | `agents/types.ts` | **重命名为** `AgentPromptProvider` 避免与 `core/context.SystemPromptProvider` 冲突 | 命名清理 |

### 5.3 重命名（可选）

如果团队认为 `SubagentExecuteParams` 等名称在新架构下过时，可以重命名：

- `SubagentExecuteParams` → `TaskInvocationParams`
- `SubagentResult` → `TaskInvocationResult`

重命名期间是否保留旧名为 `@deprecated` alias 由 release 兼容策略决定。

### 5.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/agents/types.ts` | 保持纯运行底层契约 |
| `agents/types.ts` | 保持描述符 + 服务层 envelope 契约，视决议重命名 |
| `agents/index.ts` | 导出最终服务层类型 |
| 所有调用方 | 如类型重命名，更新 import 与类型名 |

### 5.5 验收衔接

详见 [acceptance.md AC-3](./acceptance.md#四ac-3服务层-envelope-类型整理与旧-api-防回归验收)。

### 5.6 目录形态

```
agents/
├── types.ts            ← 只剩描述符 + 服务层契约（AgentConfig / RuntimeAgent /
│                          SubagentExecuteParams / SubagentResult / TaskExecutor /
│                          StartSessionParams / AgentPromptProvider 等）
├── registry.ts
├── manager.ts
├── service.ts          ← 唯一的核心调度入口；含 executeTask + startSession
├── tasks/              ← 长任务状态机
├── builtin/
└── index.ts
```

不再有 `runner.ts / executor.ts / message-writer.ts / session-manager.ts`。

---

## 六、回滚方案

| 阶段 | 回滚方式 |
|------|---------|
| Phase 1 | revert `runAgent` stream 分支 commit。无现有消费者依赖。 |
| Phase 2 | revert composition.ts 切换 commit；保留 `buildSessionPromptMessages`。 |
| Phase 3 | revert 类型命名/导出调整；旧 runner/executor 文件不恢复。 |

各阶段独立 commit。Phase 3 如果涉及破坏性类型重命名，回滚成本最高，应在 Phase 2 灰度稳定后再启动。

---

## 七、给 improve-1 实施者的前瞻提示

**这些前瞻提示已经在 [improve-1 实施计划](../improve-1/implementation-plan.md) 中体现，此处汇总以加强**：

### 7.1 `core/agents.runAgent` 的 stream 分支接口必须 improve-1 就位

improve-1 GP2 实现 `runAgent` 时，**stream 分支可以抛 `NotImplementedError`，但接口形状必须固定**：

```ts
// improve-1 期间，stream 分支
if (input.waitMode === "stream") {
  throw new Error("stream mode not implemented until improve-2");
}
```

类型层面 `AgentRunResult.events: AsyncIterable<LifecycleEvent>` 字段必须存在。这样 improve-2 只需要填实现，不改接口。

### 7.2 `AgentService` 的方法形状预留

improve-1 GP3 实现 `AgentService` 时：

- 类签名上**预留** `startSession` 方法（注释标 improve-2）。
- 内部 `executeTask` 实现要为 `startSession` 预留共用 helper（如解析 RuntimeAgent、计算 maxSteps、调 runAgent 等），improve-2 落地时直接复用。user message 写入仍由 `runAgent({ initialUserPrompt })` 统一负责。

### 7.3 不要在 improve-1 引入更多"subagent"前缀

improve-1 期间新增的代码（如 `AgentService` 等）**避免使用 "subagent" 前缀命名**。improve-2 的命名清理就不需要回头改这些新代码。

旧 runner/executor API 已在 improve-1 删除，不再保留兼容 alias。

### 7.4 composition.ts 的 prompt builder 后续处理

improve-1 后 subagent 已由 `AgentService` 调 `buildPromptMessages`。improve-2 切 primary 时，应把 composition.ts 中 primary 专用 prompt builder 收敛到 `AgentService.startSession` 所需的 `AgentPromptMessageBuilder`，避免 adapter 层继续持有 agent 运行编排。

---

## 八、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 验收标准：[acceptance.md](./acceptance.md)
- 协同导航：[README.md](./README.md)
- 上游：[agents improve-1](../improve-1/) 全套
