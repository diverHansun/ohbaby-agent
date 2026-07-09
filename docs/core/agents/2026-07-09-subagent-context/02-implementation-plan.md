# 02 · 实施方案与改动面（core/agents 视角）

本文给出 `core/agents` 的目标结构、新增/修改的类型与函数，并逐文件列出改动面。目标是让 subagent 的 context 隔离由运行时实例强制保证，而不是依赖调用方临时传对 DB/session 字段。

---

## 一、目标结构

```
core/agents/
├── runner.ts        （保留）runAgent —— 单轮执行原语；被 AgentInstance.turn() 复用
├── output.ts        （保留）extractFinalOutput —— 收口原语
├── instance.ts      （新增）AgentInstance —— subagent context 运行时 owner
├── context-scope.ts （新增）AgentContextScope —— 绑定身份的 run scope 参数门面
├── types.ts         （修改）新增 AgentInstance / AgentContextScope 相关类型
└── index.ts         （修改）导出新原语
```

**分层关系**

```
上层（agents）：SessionSubagentHost —— 调度 / 持久化 / 容量 / 队列 / 工具语义
        │  持有并驱动
        ▼
core/agents：AgentInstance —— 持有稳定身份与 AgentContextScope，turn() 驱动一轮
        │  每轮必须复用
        ▼
core/agents：runAgent —— 写 prompt → 创建 run → stream/wait → extractFinalOutput
        │  委托
        ▼
runtime：RunManager → RunWorker → core/lifecycle：Lifecycle.run
        │
        ▼
core/context：prepareTurn → runCompaction（scope 过滤后 prune / mask / summary）
```

---

## 二、新增类型与接口（草案）

### 2.1 `AgentInstance`

```typescript
// core/agents/instance.ts
export type AgentInstanceType = "primary" | "sub";
export type AgentWaitMode = "stream" | "waitForCompletion";

export interface AgentInstanceIdentity {
  readonly instanceId: string;          // primary 可为 sessionId；sub 为 subagentId
  readonly contextScopeId: string;      // context/message 隔离键；sub 默认等于 instanceId
  readonly sessionId: string;
  readonly type: AgentInstanceType;
  readonly agentName: string;
  readonly parentSessionId?: string;   // type:"sub" 必须有；primary 必须没有
  readonly projectRoot: string;
  readonly modelId: string;
  readonly maxSteps?: number;
}

export interface AgentTurnInput {
  readonly prompt: string;
  readonly waitMode: AgentWaitMode;
  readonly signal?: AbortSignal;
  readonly environment?: ToolExecutionEnvironment;
  readonly runId?: string;             // 为后续 primary stream 迁移预留
}

export interface AgentInstance {
  readonly identity: AgentInstanceIdentity;
  readonly contextScope: AgentContextScope;
  turn(input: AgentTurnInput): Promise<AgentRunResult>;
}
```

- `turn()` 内部只负责把稳定身份与本轮输入合并，然后调用现有 `runAgent`。
- 多轮：同一 `AgentInstance` 反复 `turn()`，`instanceId/contextScopeId/sessionId` 稳定持有；上层不再每轮重新推断 subagent 身份。
- `sessionId` 是会话/线程容器；`instanceId` 是 agent 实例身份。subagent 的 `instanceId` 不等于 child `sessionId`，同一 child session 可以包含多个 subagent instance。
- `contextScopeId` 是 context/message 查询与压缩的隔离键。若实现允许同一 `sessionId` 下多个 subagent，所有 context 读取/写入必须至少按 `sessionId + contextScopeId` 过滤。
- 本轮优先验收 `type:"sub"` 路径；`type:"primary"` 是后续 primary root instance 迁移的兼容能力，不要求立即替换 `startSession`。

### 2.2 `AgentContextScope`

`AgentContextScope` 是有行为的上下文身份门面，不是字段集合。它绑定 `AgentInstanceIdentity`，负责把身份转换为 `runAgent` / `RunManager.create` 需要的稳定 run scope 参数，并提供一致性断言。context/message 的读写范围不再由调用方手拼，而是由 `runAgent.resolveRunScope()` 从同一个 scope 派生出的 `sessionId + contextScopeId` 继续传给 message、run manager、lifecycle/context manager。

```typescript
// core/agents/context-scope.ts
export interface AgentContextScope {
  readonly identity: AgentInstanceIdentity;

  readonly instanceId: string;
  readonly contextScopeId: string;
  readonly sessionId: string;
  readonly isSubagent: boolean;
  readonly parentSessionId?: string;

  assertSession(input: {
    readonly sessionId: string;
    readonly instanceId?: string;
    readonly contextScopeId?: string;
    readonly parentSessionId?: string;
    readonly agentName?: string;
  }): void;

  toRunCreateOptions(): {
    readonly agentInstanceId: string;
    readonly contextScopeId: string;
    readonly sessionId: string;
    readonly isSubagent: boolean;
    readonly parentSessionId?: string;
  };
}
```

**约束**

- `type:"sub"` 必须有 `parentSessionId`；`type:"primary"` 必须没有。
- `isSubagent` 只能由 `identity.type` 推导，不允许调用方覆盖。
- `toRunCreateOptions()` 始终使用 scope 绑定的 `sessionId`、`contextScopeId`、`instanceId` 与 `isSubagent`。
- `runAgent` 消费 `AgentContextScope` 后，所有 message 写入/读取、run 创建、lifecycle prepare/compact 都必须使用这组派生值；禁止在下游重新根据 parent/session 临时推断 subagent scope。
- `assertSession` 用于从持久化恢复时校验 DB session 与实例身份一致，防止跨 parent/role/context scope 复用。
- `AgentContextScope` 不持有 `contextManager`，也不直接调用 `prepareTurn` / `compact`。这样可以避免 scope 变成第二个压缩 owner，也避免 `core/context` 与 `core/agents` 互相缠绕。

> 说明：当前 `Lifecycle.run` 直接调用 `contextManager.prepareTurn`。本轮目标不是搬走压缩算法，而是让 lifecycle/context manager 拿到 `AgentContextScope` 派生出的 scope 参数。验收重点是“身份从实例来，context/message 按 scope 过滤”，不是一次性重写压缩算法。

### 2.3 `AgentInstanceFactory`

创建实例的工厂（端口化，便于测试与被 `SessionSubagentHost` 注入）：

```typescript
export interface AgentInstanceFactory {
  create(identity: AgentInstanceIdentity): AgentInstance;
}
```

工厂持有 `AgentRunDeps`（`runCoordinator` / `messageManager` / `toolScheduler` / `sandboxManager` / 可选 `runEventSource`），`turn()` 时组装 `runAgent` 调用。

---

## 三、per-step 压缩集成契约

- **现状（保留）**：`Lifecycle.run` 已在每个 model step 前调用 `prepareTurn`，并在 context overflow 时强制 `prepareTurn({ force:true })`。
- **本轮契约**：`AgentInstance.turn()` 必须始终经由 `runAgent → RunManager → RunWorker → Lifecycle.run`，从而继承 per-step 压缩。禁止任何绕过 lifecycle 的直连 LLM 路径。
- **身份契约**：`runAgent` 不再只用 `parentSessionId !== undefined` 推断 subagent，而应接受显式 `isSubagent`/scope 派生身份；旧推断仅作兼容 fallback。
- **scope 契约**：message 与 context 的读写都必须能携带 `sessionId + contextScopeId`。`sessionId` 是会话容器，不等于 context 边界。
- **验证点**：AC-6 改成两段测试：先在改造前跑一次 50+ tool step 基线，确认现状是否已溢出或只是风险；改造后再跑同场景，验证多次 `prepareTurn`、至少一次 prune/summary、且不串 scope。

---

## 四、改动面（逐文件，基于代码调查）

### 4.1 `core/agents` 内部

| 文件 | 改动 | 说明 |
|------|------|------|
| `core/agents/instance.ts` | **新增** | `AgentInstance` / `AgentInstanceFactory` 实现；优先支持 subagent waitForCompletion |
| `core/agents/context-scope.ts` | **新增** | 有行为的 `AgentContextScope`，绑定身份并封装 context/message/run scope 参数 |
| `core/agents/runner.ts` | **修改** | `runAgent` 保留；`isSubagent` 由实例/scope 显式携带，`parentSessionId` 推断仅兼容旧调用 |
| `core/agents/output.ts` | 不变 | `extractFinalOutput` 复用；handoff 增强留待服务层 |
| `core/agents/types.ts` | **修改** | 新增 `AgentInstance*` / `AgentContextScope*` 类型；`AgentRunInput` 增显式 `isSubagent?` |
| `core/agents/index.ts` | **修改** | 导出 `AgentInstance` / `AgentInstanceFactory` / `AgentContextScope` |

### 4.2 依赖方

| 文件 | 关系 | 本轮是否改 |
|------|------|-----------|
| `core/lifecycle/lifecycle.ts` | 消费 `isSubagent/contextScopeId` 并调用 `contextManager.prepareTurn` | 不改算法；参数来自 scope 派生身份 |
| `core/context/context-manager.ts` | 执行 assemble/measure/reduce/compaction | 不改算法；增加或消费 scope filter |
| `runtime/run-manager/*` | `RunManager.create({ isSubagent })`、`RunWorker` 透传身份 | 不改生命周期，只校验显式身份透传 |

---

## 五、依赖约束复核（不得破坏）

- `core/agents` 允许依赖 `core/message`、`core/tool-scheduler`、`core/lifecycle`（事件/参数类型）、`core/context` 的端口类型、`core/llm-client`（message 类型）。
- **禁止**依赖 `src/agents`、`src/adapters`、`src/runtime` 的具体实现。
- `AgentInstanceFactory` 通过端口（`AgentRunDeps` / context port）拿依赖，不 import 具体 RunManager 类。

---

## 六、分步落地建议（core/agents 部分）

| 步骤 | 内容 | 可独立验证 |
|------|------|-----------|
| S1 | 新增有行为的 `AgentContextScope` + 身份/scope filter 不变量单测 | ✅ |
| S2 | `runAgent` 支持显式 `isSubagent`，保留旧推断 fallback | ✅ |
| S3 | 新增 `AgentInstance` + `AgentInstanceFactory`，`turn(waitForCompletion)` 复用 `runAgent` | ✅ 与旧 `runAgent(waitForCompletion)` 等价性测试 |
| S4 | subagent 长任务 per-step 压缩集成测试 | ✅ |
| S5 | 导出 + 对侧 `SessionSubagentHost` 装配 | 由对侧 e2e 覆盖 |
| S6 | 后续：`turn(stream)` 与 primary `startSession` 迁移 | 后续独立阶段 |

> S6 故意后置。primary stream 是 UI 契约关键路径，不与本轮 subagent context/instance 化混在同一个风险包里。

---

## 七、`goals-duty.md` 增量（需同步更新）

`docs/core/agents/goals-duty.md` 应在本轮后补充：

- G1 增补：`core/agents` 除 `runAgent` 单轮原语外，提供 `AgentInstance` 作为 subagent **context 运行时 owner**。
- Duty 新增：`AgentContextScope` 负责实例身份到 context/message/run scope 参数的绑定与校验。
- Duty 新增：subagent `turn()` 必须经 lifecycle per-step 压缩路径。
- Non-Duty 明确：spawn/持久化/容量/工具语义属 `agents`；primary stream 迁移属后续阶段。
