# agents improve-1 实施计划

本文档定义本轮重构的分阶段方案。本文档只回答"怎么改 / 改什么顺序 / 怎么保证不破坏现有功能"。改造动机见 [problem-analysis.md](./problem-analysis.md)，架构决策见 [decisions.md](./decisions.md)，验收标准见 [acceptance.md](./acceptance.md)。

---

## 一、总体策略

### 1.1 五阶段递进

| 阶段 | 主题 | 主要解决 | 是否破坏现有 API |
|------|------|---------|----------------|
| GP1 | `services/session` 补 `ensureRoot` | PG-9 的底座 | 否（新增方法） |
| GP2 | 建立 `core/agents/` 作为运行底层 | PG-4、PG-5、G1 | 否（新增模块） |
| GP3 | 重构 `agents/` 为服务/调度层（subagent 路径切到 `core/agents`） | PG-1、PG-3、PG-5、PG-6、PG-7、PG-10、G2、G7 | 否（barrel 转发） |
| GP4 | 删除 `agents/session-manager.ts` | PG-9 | 否（GP1 完成后无活跃消费者） |
| GP5 | 删除 `agents/message-writer.ts` | PG-8 | 否（lifecycle P2 完成后无活跃消费者） |

每阶段独立可交付、独立可回滚。GP5 是唯一硬依赖 lifecycle improve-1 P2 的阶段。

### 1.2 时序与上游依赖

```
lifecycle improve-1 P1+P2  ──完成验收──┐
                                       │
context improve-1 CP1     ──完成验收──┤
                                       │
                                       ▼
                          agents improve-1 启动
                          ┌──> GP1 (independent)
                          ├──> GP2 (independent)
                          ├──> GP3 (depends on GP2)
                          ├──> GP4 (depends on GP1 + GP3)
                          └──> GP5 (depends on lifecycle P2 + GP3)
```

- **GP1 / GP2 技术上完全独立**于 lifecycle / context 改造。
- **GP3 依赖 GP2**：必须先有 `core/agents.runAgent` 才能删除旧 `agents/runner.ts` 并把 subagent 入口切到 `AgentService`。
- **GP4 依赖 GP1 + GP3**：`ensureRoot` 必须可用，且 `agents/` 不再消费 `SubagentSessionManager`。
- **GP5 依赖 lifecycle improve-1 P2 + GP3**：lifecycle.runSession 接管 assistant 持久化之后，`writeAssistantMessage` 才不必要。

### 1.3 API 收敛铁律

- `agents/index.ts` 在本轮完成后只保留新架构入口：`AgentService`、`AgentTaskManager`、registry / manager / builtin 等描述符能力。
- 旧 `SubagentExecutor` / `createSubagentRunner` / `SubagentRunner` 不做兼容 shim，直接删除。
- 本仓库内部调用方必须同批迁移到 `AgentService` 或 `core/agents.runAgent`。
- 需要表达 Task 工具 envelope 的类型（如 `SubagentExecuteParams / SubagentResult`）暂时保留，是否重命名留给 improve-2 的类型整理。

### 1.4 测试先行

每阶段先补/改单元测试覆盖期望行为，再改实现。任何阶段的 PR 若导致 `pnpm -F ohbaby-agent test` 红灯，必须立即回滚。

### 1.5 跨模块影响范围（硬约束）

| 模块 | 公共 API 是否变更 | 内部变化 |
|------|----------------|--------|
| `agents/` | **是（仅缩减）**：barrel 内部转发自新位置；不新增对外 API；新增内部 `service.ts` | 删除 2 个文件（session-manager.ts / message-writer.ts），refactor 3 个文件 |
| `core/agents/`（新建） | **是（新增）**：`runAgent / extractFinalOutput / AgentRunInput / AgentRunResult / AgentRunner` | 全新模块 |
| `services/session` | **是（新增）**：`SessionManager.ensureRoot(...)` 方法 | 内部添加幂等创建 |
| `runtime/` | **否** | 不变（坚守基础设施身份） |
| `core/lifecycle` | **否** | 被 `core/agents` 消费 |
| `core/context` | **否** | 被 `core/agents` 间接消费（通过 lifecycle.runSession） |
| `core/message` | **否** | 类型被 agents/ 引用；运行时调用统一在 `core/agents` 与 `AgentService` 内完成 |
| `adapters/` | **否** | composition.ts / RunWorker 不变（primary 路径切换留 improve-2） |

---

## 二、阶段 GP1：`services/session` 补 `ensureRoot`

### 2.1 目标

把 `agents/session-manager.ts` 的唯一新增能力 `ensureRoot` 下沉到 `services/session.SessionManager`，为 GP4 删除 `session-manager.ts` 准备底座。

### 2.2 接口设计

在 [services/session/types.ts](../../../packages/ohbaby-agent/src/services/session/types.ts) 的 `SessionManager` 接口新增：

```ts
export interface SessionManager {
  // 现有方法保留
  create(...): Promise<Session>;
  get(sessionId: string): Promise<Session | null>;
  // ... 其它现有方法

  // 新增
  ensureRoot(input: {
    readonly id: string;
    readonly agentName: string;
    readonly projectRoot: string;
    readonly title?: string;
  }): Promise<Session>;
}
```

### 2.3 语义

- 如果 `id` 对应的 session 已存在：返回该 session，不修改任何字段。
- 如果不存在：调用现有 `create(projectRoot, { id, agentName, title })` 创建。
- 幂等：多次调用同一 `id` 必须产出相同结果且不抛错。
- 返回类型与 `create` 一致（`Session`）。

### 2.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `services/session/types.ts` | `SessionManager` 接口新增 `ensureRoot` 签名 |
| `services/session/manager.ts` | `createSessionManager` 实现新增 `ensureRoot` 函数 |
| `services/session/manager.unit.test.ts` | 新增 ensureRoot 单测（首次创建 / 幂等 / 不覆盖） |
| `services/session/index.ts` | 不需修改 |
| `agents/session-manager.ts` | **本阶段不动**；GP4 才删除 |

### 2.5 验收衔接

详见 [acceptance.md AC-1](./acceptance.md#二ac-1services-session-ensureroot-验收)。

---

## 三、阶段 GP2：建立 `core/agents/`

### 3.1 目标

新建 `core/agents/` 作为 primary 与 subagent 共用的运行底层。本阶段**只建立 + 单测**，不切换任何现有调用方。

### 3.2 目标目录结构

```
core/agents/
├── runner.ts            ← runAgent(input)：启动 + 等终态
├── output.ts            ← extractFinalOutput(messages)：抽取最终 assistant 文本
├── types.ts             ← AgentRunInput / AgentRunResult / AgentRunner
├── runner.unit.test.ts
├── output.unit.test.ts
└── index.ts
```

### 3.3 `runAgent` 契约设计

```ts
// core/agents/types.ts
export interface AgentRunInput {
  readonly sessionId: string;
  readonly parentSessionId?: string;          // 有 → subagent；无 → primary
  readonly agentName: string;
  readonly projectRoot: string;
  readonly initialUserPrompt?: string;        // 若有，在启动前写入 user message
  readonly parentMessageId?: string;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly maxSteps?: number;
  readonly waitMode: "stream" | "waitForCompletion";
  readonly buildPromptMessages: AgentPromptMessageBuilder;
  // stream:           返回 events 流，由 caller 消费
  // waitForCompletion: 阻塞等待终态，返回 finalOutput
}

export type AgentPromptMessageBuilder = (input: {
  readonly agentName: string;
  readonly isSubagent: boolean;
  readonly projectRoot: string;
  readonly sessionId: string;
}) => Promise<readonly ChatCompletionMessage[]>;

export interface AgentRunResult {
  readonly sessionId: string;
  readonly success: boolean;
  readonly finishReason?: "stop" | "tool_calls" | "error";
  readonly finalOutput?: string;              // waitForCompletion 模式填
  readonly events?: AsyncIterable<LifecycleEvent>;  // stream 模式填
  readonly steps?: number;
  readonly toolCalls?: readonly AgentToolCallSummary[];
  readonly error?: string;
}

export interface AgentRunDeps {
  readonly runCoordinator: AgentRunCoordinator;
  readonly messageManager: MessageManager;
  readonly toolScheduler: ToolSchedulerInstance;
  readonly sandboxManager?: SandboxEnvironmentManager;
}

export interface AgentRunCoordinator {
  create(options: AgentRunCreateOptions): Promise<AgentRunRecord>;
  cancel(runId: string, reason?: string): void;
  waitForCompletion(runId: string): Promise<AgentRunCompletion>;
}

export type AgentRunner = (
  deps: AgentRunDeps,
  input: AgentRunInput,
) => Promise<AgentRunResult>;
```

> 注：`waitMode` 字段是承认 envelope 差异的核心抽象。primary 用 `stream`，subagent 用 `waitForCompletion`。

### 3.4 内部实现要点

`runAgent` 内部流程（伪码）：

```
async function runAgent(deps, input):
  // 1. 工具集
  const tools = await deps.toolScheduler.getAvailableTools({
    agentName: input.agentName,
    isSubagent: input.parentSessionId !== undefined,
  })

  // 2. sandbox env（如有）
  deps.sandboxManager?.setSessionEnvironment(input.sessionId, input.environment)

  try {
    // 3. 初始 user message（如有）
    let writtenUserMessageId: string | undefined
    if (input.initialUserPrompt) {
      writtenUserMessageId = await writeUserMessage(deps.messageManager, {
        sessionId: input.sessionId,
        agentName: input.agentName,
        prompt: input.initialUserPrompt,
      })
    }

    // 4. 构建当前 turn 的 model messages
    const messages = await input.buildPromptMessages({
      agentName: input.agentName,
      isSubagent: input.parentSessionId !== undefined,
      projectRoot: input.projectRoot,
      sessionId: input.sessionId,
    })

    // 5. 启动 run（通过 AgentRunCoordinator）
    const record = await deps.runCoordinator.create({
      sessionId: input.sessionId,
      parentMessageId: writtenUserMessageId ?? input.parentMessageId,
      agent: input.agentName,
      isSubagent: input.parentSessionId !== undefined,
      maxSteps: input.maxSteps,
      tools: toOpenAiTools(tools),
      triggerSource: "user",
      messages,
    })

    // 6. abort 绑定
    const unbindAbort = bindAbort({
      cancel: deps.runCoordinator.cancel.bind(deps.runCoordinator),
      runId: record.runId,
      signal: input.signal,
    })

    try {
      if (input.waitMode === "waitForCompletion") {
        const completion = await deps.runCoordinator.waitForCompletion(record.runId)
        const messages = await deps.messageManager.listBySession(input.sessionId)
        const finalOutput = extractFinalOutput(messages)
        return { sessionId, success: completion.status === "succeeded", finalOutput, ... }
      }
      // stream 模式 (primary 切换在 improve-2 才用到)
      return { sessionId, events: subscribeToRun(record.runId) }
    } finally {
      unbindAbort()
    }
  } finally {
    deps.sandboxManager?.setSessionEnvironment(input.sessionId, undefined)
  }
```

> 注：`buildPromptMessages` 是 improve-1 的明确过渡策略。当前 `RunManager.create` 仍接受预组装的 messages，所以 `runAgent` 通过注入的 builder 取得 prompt；improve-2 阶段当 `RunManager` 切到 `runSession` 完整路径后，此处改为只传 `sessionId / modelId`，由 `Lifecycle.runSession` 内部调 `prepareTurn`。这里不得留下不可执行的 messages 占位。

### 3.5 `extractFinalOutput` 实现

```ts
// core/agents/output.ts
export function extractFinalOutput(
  messages: readonly MessageWithParts[],
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message.info.role !== "assistant") continue
    const text = message.parts
      .map((part) => (part.type === "text" || part.type === "reasoning") ? part.text : "")
      .join("")
    if (text.trim().length > 0) return text
  }
  return ""
}
```

等价于 `agents/runner.ts:64-69` 的 `lastAssistantText`，搬入新位置。

### 3.6 代码改动清单

| 文件 | 改动 |
|------|------|
| `core/agents/types.ts` | 新建（AgentRunInput / AgentRunResult / AgentRunner / AgentRunDeps / AgentToolCallSummary） |
| `core/agents/runner.ts` | 新建（runAgent 实现） |
| `core/agents/output.ts` | 新建（extractFinalOutput） |
| `core/agents/runner.unit.test.ts` | 新建（mock RunManager + MessageManager） |
| `core/agents/output.unit.test.ts` | 新建 |
| `core/agents/index.ts` | 新建 barrel |
| `agents/runner.ts` | **本阶段不动**；GP3 才改 |
| `agents/executor.ts` | **本阶段不动**；GP3 才改 |
| `agents/tasks/manager.ts` | **本阶段不动**；GP3 才改 |

### 3.7 验收衔接

详见 [acceptance.md AC-2](./acceptance.md#三ac-2coreagents-建立验收)。

---

## 四、阶段 GP3：重构 `agents/` 为服务/调度层

### 4.1 目标

删除旧 `agents/runner.ts / executor.ts`，新增 `agents/service.ts`，并把 `tasks/` 改为内部消费 `core/agents.runAgent`。完成后 `agents/` 真正成为服务/调度层，旧 subagent 专用入口不再存在。

### 4.2 改动顺序与映射

| 当前对象 | 改造方式 | 对外签名 |
|---------|---------|---------|
| `createSubagentRunner` | 删除；调用方迁移到 `AgentService.executeTask` 或直接消费 `core/agents.runAgent` | 旧签名移除 |
| `SubagentExecutor` (executor.ts) | 删除；新增 `AgentService`，内部消费 `services/session.SessionManager` + `core/agents.runAgent` | 旧名移除，新名可用 |
| `AgentTaskManager` (tasks/manager.ts) | 内部 deps 从 `SubagentRunner + SubagentMessageWriter + SubagentSessionManager` 改为 `SessionManager + core/agents.runAgent`；行为不变 | 对外保留 `AgentTaskManager`，但构造 deps 切到新底座 |

### 4.3 `agents/service.ts` 内容

新建 `agents/service.ts`，承载原 `executor.ts` 的内容：

```ts
// agents/service.ts
export class AgentService implements TaskExecutor {
  constructor(private readonly options: AgentServiceOptions) {...}

  async executeTask(params: SubagentExecuteParams): Promise<SubagentResult> {
    // 1. agentManager.getRuntimeAgent
    // 2. sessionManager.ensureRoot / create
    // 3. 调 core/agents.runAgent({ waitMode: "waitForCompletion", initialUserPrompt: params.prompt })
    // 4. 整理返回为 SubagentResult
  }

  // improve-2 才接入
  // async startSession(params): AsyncIterable<LifecycleEvent> { ... }
}

export interface AgentServiceOptions {
  readonly agentManager: AgentManager;
  readonly sessionManager: SessionManager;             // ← 直接消费 services/session
  readonly runCoordinator: AgentRunCoordinator;         // ← 来自 core/agents 的端口，不 import runtime
  readonly messageManager: MessageManager;
  readonly toolScheduler: ToolSchedulerInstance;
  readonly sandboxManager?: SandboxEnvironmentManager;
  readonly maxConcurrency?: number;
  readonly now?: () => number;
}
```

`executor.ts` 与 `runner.ts` 不再保留兼容壳子；旧测试同步删除或迁移到 `service.unit.test.ts` / `core/agents/runner.unit.test.ts`。

### 4.4 旧 `agents/runner.ts` 删除

`createSubagentRunner` 不再作为公共 API 暴露。需要同步验收：

- `agents/runner.ts` 与 `agents/runner.unit.test.ts` 不存在。
- `agents/index.ts` 不导出 `createSubagentRunner / SubagentRunner / CreateSubagentRunnerOptions`。
- subagent 的同步 envelope 由 `AgentService.executeTask` 承担。
- 长生命周期任务由 `AgentTaskManager` 内部调用 `core/agents.runAgent`。

### 4.5 `agents/tasks/manager.ts` 改造

把 `AgentTaskManager` 的 deps 从私有抽象切到原生底座：

```ts
// 改造前
constructor(private readonly options: {
  readonly agentManager: AgentManager;
  readonly sessionManager: SubagentSessionManager;
  readonly runner: SubagentRunner;
  readonly messageWriter: SubagentMessageWriter;
  ...
})

// 改造后
constructor(private readonly options: {
  readonly agentManager: AgentManager;
  readonly sessionManager: SessionManager;              // ← services/session
  readonly runCoordinator: AgentRunCoordinator;
  readonly messageManager: MessageManager;
  readonly toolScheduler: ToolSchedulerInstance;
  readonly sandboxManager?: SandboxEnvironmentManager;
  ...
})
```

内部所有 `runner.run(...)` 调用改为 `runAgent(deps, input)`；初始 user prompt 由 `runAgent({ initialUserPrompt })` 统一写入，`AgentTaskManager` 不再自行调用 `messageWriter.writeUserMessage(...)`；所有 `sessionManager.create / get` 调用照旧。

### 4.6 代码改动清单（GP3 汇总）

| 文件 | 改动 |
|------|------|
| `agents/service.ts` | 新建（承载原 executor.ts 内容；deps 切到原生底座） |
| `agents/executor.ts` | 删除 |
| `agents/executor.unit.test.ts` | 迁移为 `agents/service.unit.test.ts` |
| `agents/runner.ts` | 删除 |
| `agents/runner.unit.test.ts` | 删除 |
| `agents/tasks/manager.ts` | deps 切到原生底座；内部消费 `core/agents.runAgent` |
| `agents/types.ts` | 删除纯旧 runner 类型；Task 工具 envelope 类型保留至 improve-2 后整理 |
| `agents/index.ts` | 导出 `AgentService`，移除旧 runner/executor re-export |
| 所有现有测试 | 调整 mock 形状以适配新 deps |
| `adapters/`、CLI 初始化 | 构造 `AgentService / AgentTaskManager` 时传入新 deps（`SessionManager / AgentRunCoordinator / MessageManager / ToolScheduler / buildPromptMessages` 而非 `SubagentSessionManager / SubagentRunner / SubagentMessageWriter`） |

### 4.7 验收衔接

详见 [acceptance.md AC-3](./acceptance.md#四ac-3agents-收敛与-subagent-切到-coreagents-验收)。

---

## 五、阶段 GP4：删除 `agents/session-manager.ts`

### 5.1 前置条件

- GP1 完成：`SessionManager.ensureRoot` 可用。
- GP3 完成：`AgentService / AgentTaskManager` 都消费 `SessionManager`，不再消费 `SubagentSessionManager`；`createSubagentRunner` 已删除。

### 5.2 改动顺序

1. **确认调用方已切换**：grep 验证仓库中无任何代码导入 `SubagentSessionManager / RuntimeSubagentSessionManager / createRuntimeSubagentSessionManager`（除 `agents/session-manager.ts` 本身）。
2. **删除文件**：`agents/session-manager.ts` 与 `agents/session-manager.unit.test.ts`。
3. **删除类型**：`agents/types.ts` 中 `SubagentSession / SubagentSessionManager / RuntimeSubagentSessionManager`。
4. **`agents/index.ts`** 移除对应 re-export。
5. **adapters / CLI**：构造 session manager 的位置从 `createRuntimeSubagentSessionManager(...)` 换成 `createSessionManager(...)`。

### 5.3 兼容性细节

`SubagentSessionManager` 在本仓库内无外部 npm 消费者，可一次性切换。如未来出现外部消费者，第一步改为别名 + `@deprecated`，第二步在 improve-2 删除。

### 5.4 代码改动清单

| 文件 | 改动 |
|------|------|
| `agents/session-manager.ts` | 删除 |
| `agents/session-manager.unit.test.ts` | 删除 |
| `agents/types.ts` | 删除 SubagentSession / SubagentSessionManager / RuntimeSubagentSessionManager |
| `agents/index.ts` | 移除相关 re-export |
| `adapters/` 与 CLI 初始化 | 构造调用切换到 `createSessionManager` |
| `services/session/manager.ts` | 不动（GP1 已完成） |

### 5.5 验收衔接

详见 [acceptance.md AC-4](./acceptance.md#五ac-4session-manager-删除验收)。

---

## 六、阶段 GP5：删除 `agents/message-writer.ts`

### 6.1 前置条件

- **lifecycle improve-1 P2 已完成验收**：`Lifecycle.runSession` 内部已接管 assistant message 的持久化。详见 [lifecycle improve-1 acceptance.md A2 系列](../../core/lifecycle/improve-1/acceptance.md)。
- GP3 完成：`AgentService` 已位于 `agents/service.ts`，且消费 `MessageManager`。

### 6.2 改动判断

`createSubagentMessageWriter` 提供两个方法：

| 方法 | lifecycle P2 后是否仍需要 |
|------|------------------------|
| `writeUserMessage` | **需要**：subagent 启动时写入 user prompt。归并到 `core/agents.runAgent({ initialUserPrompt })`，由同一个入口统一写入。 |
| `writeAssistantMessage` | **不需要**：原为 runner 抛错且 lifecycle 未持久化时的兜底。lifecycle runSession 接管后失效。 |

### 6.3 改动顺序

1. `AgentService.executeTask` 中删除 `messageWriter.writeUserMessage`，改为给 `runAgent` 传 `initialUserPrompt`。
2. `AgentTaskManager.open / sendInput` 同上，所有 turn 的 user prompt 都由 `runAgent` 写入。
3. 错误处理路径**移除** `writeAssistantMessage` 调用；改为直接返回 `SubagentResult { success: false, output: errorMessage }`。
4. **删除** `agents/message-writer.ts / message-writer.unit.test.ts`。
5. **删除** `SubagentMessageWriter` 接口从 `agents/types.ts`。
6. **`agents/index.ts`** 移除对应 re-export。
7. **adapters/** 中构造 `AgentService / AgentTaskManager` 时移除 `messageWriter` 参数。

### 6.4 替代方案（保守路线）

如果 `runAgent` 内部写 user message 的逻辑超过 5 行或后续被其他模块复用，改为：

- 在 `core/message/writers.ts` 新增 `createUserTextMessage(messageManager, input)` 助手。
- `core/agents.runAgent` 调用该助手。

判定阈值：仅 `runAgent` 使用且逻辑很短 → 私有函数；≥ 2 个模块复用 → 提到 `core/message/`。

### 6.5 代码改动清单

| 文件 | 改动 |
|------|------|
| `agents/message-writer.ts` | 删除 |
| `agents/message-writer.unit.test.ts` | 删除 |
| `agents/types.ts` | 删除 SubagentMessageWriter |
| `agents/index.ts` | 移除相关 re-export |
| `agents/service.ts` | 传 `initialUserPrompt` 给 `runAgent`；移除 writeAssistantMessage 调用 |
| `agents/tasks/manager.ts` | 同上 |
| `agents/service.ts` 与 `tasks/manager.ts` 的单测 | 调整 mock（不再注入 messageWriter） |
| `adapters/...` | 移除 messageWriter 注入 |
| `core/message/writers.ts`（仅替代方案） | 新增 `createUserTextMessage` |

### 6.6 验收衔接

详见 [acceptance.md AC-5](./acceptance.md#六ac-5message-writer-删除验收)。

---

## 七、最终 `agents/` 形态

改造完成后：

```
agents/
├── types.ts            ← AgentConfig / RuntimeAgent / PermissionConfig / ToolsConfig
│                         + SubagentExecuteParams / SubagentResult / TaskExecutor 等 Task envelope 契约
├── registry.ts         ← AgentRegistry
├── manager.ts          ← AgentManager
├── service.ts          ← AgentService（核心调度入口）
├── tasks/
│   ├── manager.ts      ← AgentTaskManager（内部消费 core/agents）
│   ├── in-memory-store.ts
│   ├── types.ts
│   └── index.ts
├── builtin/            ← 内置 agent
└── index.ts            ← barrel
```

**反向规则**（必须长期维护）：

- `agents/` 不得直接 import `runtime/run-manager` 的实现或类型；只能消费 `core/agents` 暴露的 `AgentRunCoordinator` 端口。
- `agents/` 不得绕过 `core/agents.runAgent` 自行编排 RunManager 调用。
- `agents/` 内部任何 PR 若新增对 `runtime/` 实现的 import，必须在 PR 描述中说明理由并触发架构评审。

```
core/agents/            ← agent 运行底层（primary & subagent 共用）
├── runner.ts           ← runAgent
├── output.ts           ← extractFinalOutput
├── types.ts
└── index.ts

runtime/                ← 严格基础设施（不动）
└── ...

services/session/       ← + ensureRoot
└── ...
```

---

## 八、回滚方案

| 阶段 | 回滚方式 |
|------|---------|
| GP1 | revert `ensureRoot` 相关 commit。无现有消费者依赖。 |
| GP2 | revert `core/agents/` 目录。无现有消费者（GP3 才接入）。 |
| GP3 | revert refactor commit；恢复旧 `agents/runner.ts / executor.ts` 与旧 tasks 编排。 |
| GP4 | 恢复 `session-manager.ts` + types；调用方类型回退。 |
| GP5 | 恢复 `message-writer.ts`；service/tasks 重新注入 messageWriter。 |

各阶段独立 commit，分阶段 revert 互不影响。

---

## 九、跨模块接合面附录

### 9.1 `agents/` 改造后**消费**的对外接口

| 模块 | 接口 | 用途 |
|------|------|------|
| `core/agents` | `runAgent / extractFinalOutput / AgentRunInput / AgentRunResult` | 由 `service.ts` 与 `tasks/manager.ts` 消费 |
| `core/system-prompt` | `SystemPrompt.assemble / getAgentPrompt / getSubagentBase` | 由 `AgentManager` 在解析 runtime agent 时拼接 prompt addon |
| `core/tool-scheduler` | `SUBAGENT_DISABLED_TOOLS / AgentToolConfigProvider` 类型 | 工具裁剪规则 |
| `services/session` | `SessionManager`（含 `ensureRoot`） | session 创建与查询 |
| `config/agents` | `loadAgentConfig` | 用户 agent 配置加载 |
| `core/message` | `MessageManager`（类型 + 实例） | 写 user message |

### 9.2 `core/agents/` **消费**的对外接口

| 模块 | 接口 | 用途 |
|------|------|------|
| `runtime/run-manager` | `RunManager.create / cancel / waitForCompletion` | 仅由 `core/agents.AgentRunCoordinator` 端口适配，run 启动与等待 |
| `core/message` | `MessageManager` | 持久化 + 读取最终输出 |
| `core/tool-scheduler` | `ToolSchedulerInstance.getAvailableTools` | 工具集解析 |
| `core/lifecycle`（通过 RunManager 间接） | `Lifecycle.run` 或 `Lifecycle.runSession` | turn loop |
| `core/context`（通过 lifecycle 间接） | `prepareTurn` | LLM 输入呈现 |

> 注：improve-2 阶段当 RunManager 切到 `runSession` 完整路径后，`core/agents.runAgent` 与 `core/lifecycle` 的耦合点会更清晰直接。

### 9.3 与 lifecycle / context improve-1 接合

| 来自 | 本轮如何消费 |
|------|----------|
| `Lifecycle.runSession`（lifecycle P2 产物） | 通过 RunManager 间接消费。本轮不直接调用。 |
| `ContextManager.prepareTurn`（context CP1 产物） | 同上间接消费。 |
| Assistant 持久化由 lifecycle 接管（lifecycle P2 产物） | 本轮 GP5 删除 `writeAssistantMessage` 的前提 |

---

## 十、后续文档

- 改造动机：[problem-analysis.md](./problem-analysis.md)
- 架构决策：[decisions.md](./decisions.md)
- 验收标准：[acceptance.md](./acceptance.md)
- 协同关系：[README.md](./README.md)
- 上游依赖：[lifecycle improve-1](../../core/lifecycle/improve-1/)、[context improve-1](../../core/context/improve-1/)
