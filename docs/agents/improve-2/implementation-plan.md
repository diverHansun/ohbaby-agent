# agents improve-2 实施计划

> 状态：**前瞻性草案**。详细步骤在 improve-1 完成后基于实际代码状态再细化。

本文档定义本轮的分阶段方案。改造动机见 [problem-analysis.md](./problem-analysis.md)，验收见 [acceptance.md](./acceptance.md)。

---

## 一、总体策略

### 1.1 四阶段递进

| 阶段 | 主题 | 主要解决 | 是否破坏现有 API |
|------|------|---------|----------------|
| Phase 1 | 实现 `core/agents.runAgent` 的 `waitMode: "stream"` 分支 | 目标一前置 | 否（improve-1 已预留接口） |
| Phase 2 | `AgentService.startSession` 落地；composition / RunWorker 切到该入口 | 目标一、目标二 | 否（新增方法 + adapter 内部重构） |
| Phase 3 | 删除兼容 shim（`agents/runner.ts` / `agents/executor.ts`），调用方迁移 | 目标三、目标四 | **是**：移除 `SubagentExecutor` / `createSubagentRunner` 等公共导出 |
| Phase 4 | 运行时契约类型整理（`agents/types.ts` → `core/agents/types.ts`） | 目标四 | **是**：类型 import 路径变更 |

每阶段独立可交付、独立可回滚。Phase 1、2 是非破坏性的；Phase 3、4 引入破坏性变更，应在一个 release 窗口内集中完成。

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
        ▼ (灰度运行至少 1 个迭代)
        │
Phase 3: 删除 shim
        │
        ▼
Phase 4: 类型搬迁
```

**为什么 Phase 2 后要灰度**：primary 路径是产品主流量，切换后必须确认无可观察行为差异，再删除 shim 等不可逆动作。

### 1.3 向后兼容策略

- **Phase 1、Phase 2** 完成期间，shim 仍然存在，调用方可继续使用旧 import。
- **Phase 3 启动前**：所有内部调用方迁移到 `agents.AgentService` 或 `core/agents.runAgent`。grep 验证零遗漏。
- **Phase 3、Phase 4** 是破坏性变更，必须更新 CHANGELOG.md 与版本号。

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

## 四、Phase 3：删除兼容 shim

### 4.1 前置条件

- Phase 1、Phase 2 完成并通过灰度（至少 1 个迭代周期）。
- grep 验证：所有内部调用方已迁移，shim 已无活跃消费者。

### 4.2 改动顺序

1. **验证调用方零依赖**：

   ```bash
   grep -r "SubagentExecutor" packages/ohbaby-agent/src/
   grep -r "createSubagentRunner" packages/ohbaby-agent/src/
   grep -r "SubagentExecutorOptions" packages/ohbaby-agent/src/
   ```

   除 shim 自身外，命中数应为 0。

2. **删除 shim 文件**：

   - `agents/runner.ts`
   - `agents/executor.ts`
   - `agents/runner.unit.test.ts`（如还存在）

3. **`agents/index.ts`** 移除 re-export：

   - `createSubagentRunner / SubagentRunner / CreateSubagentRunnerOptions / SubagentPromptMessageBuilder / SubagentSandboxEnvironmentManager / toOpenAiTools`（如适用）
   - `SubagentExecutor / SubagentExecutorOptions`

4. **重新评估** `AgentTaskManager` 的对外形态：

   - 是否需要更名为更通用的概念？（如 `TaskManager`）
   - 本轮可仅做评估，不动名称。

### 4.3 代码改动清单

| 文件 | 改动 |
|------|------|
| `agents/runner.ts` | 删除 |
| `agents/executor.ts` | 删除 |
| `agents/runner.unit.test.ts` | 删除（若存在） |
| `agents/index.ts` | 移除相关 re-export |
| `CHANGELOG.md` | 标注 breaking change |

### 4.4 验收衔接

详见 [acceptance.md AC-3](./acceptance.md#四ac-3兼容-shim-删除验收)。

---

## 五、Phase 4：运行时契约类型整理

### 5.1 目标

把 `agents/types.ts` 中混入的运行时契约类型搬到 `core/agents/types.ts`。最终 `agents/types.ts` 只剩描述符类型。

### 5.2 类型搬迁映射

| 类型 | 当前位置 | 改后位置 | 备注 |
|------|---------|---------|------|
| `AgentConfig / AgentMode / AgentsConfig / PermissionConfig / PermissionValue / ToolsConfig / RuntimeAgent` | `agents/types.ts` | **不动**（描述符） | |
| `SubagentRunner / SubagentRunnerResult / SubagentToolCallSummary` | `agents/types.ts` | `core/agents/types.ts` 或删除 | 由 `AgentRunResult` 覆盖；评估是否需要保留 |
| `SubagentExecuteParams / SubagentResult` | `agents/types.ts` | `agents/types.ts` | Task tool envelope 契约，仍属服务/调度层 |
| `TaskExecutor` | `agents/types.ts` | `agents/types.ts` | 同上 |
| `StartSessionParams` | `agents/types.ts`（Phase 2 新增） | `agents/types.ts` | 服务/调度层契约 |
| `SystemPromptProvider`（agents 模块内部用） | `agents/types.ts` | **重命名为** `AgentPromptProvider` 避免与 `core/context.SystemPromptProvider` 冲突 | 命名清理 |

### 5.3 重命名（可选）

如果团队认为 `SubagentRunner / SubagentExecuteParams` 等名称在新架构下过时，可以重命名：

- `SubagentRunner` → `AgentInvocation` 或 `AgentRunHandle`
- `SubagentExecuteParams` → `TaskInvocationParams`
- `SubagentResult` → `TaskInvocationResult`

重命名期间保留旧名为 `@deprecated` alias，improve-3 删除。

### 5.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/agents/types.ts` | 新增搬迁过来的运行时契约类型 |
| `agents/types.ts` | 删除已搬迁的类型 |
| `core/agents/index.ts` | 导出新增类型 |
| `agents/index.ts` | 移除已搬迁类型的 re-export，或保留 re-export 作为兼容 |
| 所有调用方 | 视情况更新 import 路径（兼容 re-export 存在则不强制） |

### 5.5 验收衔接

详见 [acceptance.md AC-4](./acceptance.md#五ac-4运行时契约类型整理验收)。

---

## 六、最终 `agents/` 形态

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

## 七、回滚方案

| 阶段 | 回滚方式 |
|------|---------|
| Phase 1 | revert `runAgent` stream 分支 commit。无现有消费者依赖。 |
| Phase 2 | revert composition.ts 切换 commit；保留 `buildSessionPromptMessages`。 |
| Phase 3 | 恢复 shim 文件（git revert）。 |
| Phase 4 | revert 类型搬迁 commit；类型回到 `agents/types.ts`。 |

各阶段独立 commit。Phase 3、4 由于是破坏性变更，回滚成本最高，应在 Phase 2 灰度稳定后再启动。

---

## 八、给 improve-1 实施者的前瞻提示

**这些前瞻提示已经在 [improve-1 实施计划](../improve-1/implementation-plan.md) 中体现，此处汇总以加强**：

### 8.1 `core/agents.runAgent` 的 stream 分支接口必须 improve-1 就位

improve-1 GP2 实现 `runAgent` 时，**stream 分支可以抛 `NotImplementedError`，但接口形状必须固定**：

```ts
// improve-1 期间，stream 分支
if (input.waitMode === "stream") {
  throw new Error("stream mode not implemented until improve-2");
}
```

类型层面 `AgentRunResult.events: AsyncIterable<LifecycleEvent>` 字段必须存在。这样 improve-2 只需要填实现，不改接口。

### 8.2 `AgentService` 的方法形状预留

improve-1 GP3 实现 `AgentService` 时：

- 类签名上**预留** `startSession` 方法（注释标 improve-2）。
- 内部 `executeTask` 实现要为 `startSession` 预留共用 helper（如解析 RuntimeAgent、计算 maxSteps、调 runAgent 等），improve-2 落地时直接复用。user message 写入仍由 `runAgent({ initialUserPrompt })` 统一负责。

### 8.3 不要在 improve-1 引入更多"subagent"前缀

improve-1 期间新增的代码（如 `AgentService` 等）**避免使用 "subagent" 前缀命名**。improve-2 的命名清理就不需要回头改这些新代码。

例外：improve-1 必须保留的兼容 alias（`SubagentExecutor = AgentService` 等）允许保留旧名。

### 8.4 composition.ts 的 `buildSubagentPromptMessages` 在 improve-1 可以不删

improve-1 GP3 改造时，`buildSubagentPromptMessages` 仍被 `createSubagentRunner` shim 使用。improve-2 删除 shim 时同步删除 `buildSubagentPromptMessages`。无需在 improve-1 强行删除。

---

## 九、关联文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 验收标准：[acceptance.md](./acceptance.md)
- 协同导航：[README.md](./README.md)
- 上游：[agents improve-1](../improve-1/) 全套
