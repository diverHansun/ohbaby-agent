# 2. sandbox scope-keyed 实施方案

## 2.1 设计目标

### G1. sandbox 身份与 run/context 身份对齐

primary run 可以继续用 `sessionId` 作为 sandbox scope。subagent run 必须能用 `sessionId + contextScopeId` 定位 sandbox context。

### G2. RunManager 成为 run 期间 sandbox lease 的唯一 owner

一次 run 的 sandbox 生命周期应为：

```text
RunManager.startRun
  -> ensure sandbox context for run scope
  -> acquire run lease
  -> RunWorker / Lifecycle / ToolScheduler 使用 lease
  -> RunManager.finalizeRun release lease
```

`core/agents.runAgent` 不再设置或销毁 sandbox environment。

### G3. workdir ensure 必须跟随 run create options

`RunManager.create({ directory })` 已经拿到本轮 run 的项目目录。sandbox context 的 `workdir` 应从这里建立，而不是由 `runAgent` 先调用 `setSessionEnvironment()`。

### G4. 不改变 subagent 的 child session 语义

一个 parent 下多个 subagent 可以共享 child session。隔离边界通过 `contextScopeId` 和 sandbox scope key 表达，不通过强制拆 session 表达。

## 2.2 职责边界

| 模块 | 新职责 | 明确不做 |
|---|---|---|
| `core/agents` | 解析 `AgentContextScope`，把 `contextScopeId` 传给 `RunManager.create` | 不设置 workdir，不销毁 sandbox |
| `runtime/run-manager` | 按 run scope ensure/acquire/release sandbox lease | 不实现 adapter 细节，不决定 subagent 状态 |
| `sandbox` | 用 scope key 管理 context 与 lease；提供路径边界和 command context | 不调度 run，不写 run ledger，不处理 message/context |
| `agents/subagent-host` | 创建/恢复 `AgentInstance`，提供 subagent 状态机 | 不直接 acquire/destroy sandbox |
| `adapters/ui-runtime` | 装配 host-local sandbox manager；保留 session workdir 设置入口 | 不绕过 RunManager 做 run 级 sandbox cleanup |

## 2.3 核心数据模型

建议新增窄类型，而不是继续到处传裸字符串：

```typescript
export interface SandboxScopeIdentity {
  readonly sessionId: string;
  readonly contextScopeId?: string;
}

export interface SandboxAcquireInput extends SandboxScopeIdentity {
  readonly workdir: string;
}
```

scope key 规则：

```typescript
function sandboxScopeKey(input: SandboxScopeIdentity): string {
  return input.contextScopeId === undefined
    ? input.sessionId
    : `${input.sessionId}::${input.contextScopeId}`;
}
```

`SandboxContext` / `SandboxLease` 建议补充：

- `scopeKey`
- `contextScopeId?`
- 保留 `sessionId`

这样 debug / event / 测试中可以同时看见会话容器与实例上下文。

## 2.4 接口调整建议

### SandboxManagerPort

从：

```typescript
interface SandboxManagerPort {
  acquire(sessionId: string): Promise<SandboxLease>;
  release(lease: SandboxLease): Promise<void>;
}
```

调整为：

```typescript
interface SandboxManagerPort {
  ensureContext(input: SandboxAcquireInput): Promise<SandboxContext>;
  acquire(input: SandboxAcquireInput): Promise<SandboxLease>;
  release(lease: SandboxLease): Promise<void>;
}
```

说明：

- `acquire(input)` 可以内部调用 `ensureContext(input)`，便于 RunManager 一步完成。
- 若继续保留显式 `ensureContext`，需要保证它是 scope-keyed，而不是 session-keyed。
- `destroyContext` 也应接受 `SandboxScopeIdentity` 或 scope key，不能只接受 `sessionId`。

### HostLocalSandboxManager

当前 `setSessionEnvironment(sessionId, env)` 是 session 级可变 setter，容易误用为 run 生命周期 API。

建议替换为：

```typescript
interface HostLocalSandboxManager extends SandboxManagerPort {
  setSessionWorkdir(sessionId: string, workdir: string): Promise<void>;
  destroyScope(input: SandboxScopeIdentity): Promise<void>;
}
```

`setSessionWorkdir()` 用于 UI / composition 层的 session 默认目录，不用于单个 run cleanup。

### AgentSandboxEnvironmentManager

`core/agents/types.ts` 中的 `AgentSandboxEnvironmentManager` 建议删除或降级为已废弃类型。

`AgentRunInput.environment` 可先保留兼容，但 `runAgent` 不再消费它设置 sandbox。后续如果需要 per-run environment，应通过 `RunManager.create` 的 run scope / directory / environment 字段统一传递。

## 2.5 RunManager 改造路径

`RunManager.startRun(record)` 当前：

```typescript
const sandboxLease = await sandboxManager.acquire(record.sessionId);
```

目标：

```typescript
const sandboxLease = await sandboxManager.acquire({
  sessionId: record.sessionId,
  contextScopeId: record.options.contextScopeId,
  workdir: record.options.directory,
});
```

然后将 lease 放入 `RunContext`，现有 `RunWorker.lifecycleSessionParams()` 继续通过 `toToolExecutionEnvironment(sandboxLease)` 给 lifecycle/tool-scheduler 使用。

关键点：

- `RunManager` 在 start 阶段失败时，应把 run 标记为 failed，不进入 running。
- `finalizeRun()` 仍负责 release lease。
- release 失败不影响 completion contract，但需要保留现有吞错策略或记录 warning。

## 2.6 runAgent 改造路径

删除以下行为：

- `setSessionEnvironment(scope.sessionId, input.environment)`
- `cleanupSessionEnvironment(...)`
- stream completion finally 中的 sandbox cleanup
- waitForCompletion finally 中的 sandbox cleanup
- catch 中重复 cleanup

`runAgent` 保留职责：

- 获取可用工具。
- 写入 initial user message。
- 调 `runCoordinator.create(...)`。
- 绑定外部 signal 到 run cancel。
- 等待/订阅 completion。
- 从 message history 提取最终输出。

这让 `core/agents` 回到纯 agent run 原语，不再拥有 adapter runtime state。

## 2.7 HostLocal 与 workdir 策略

`HostLocalSandboxManager` 当前有 fallback workdir。如果删掉 `runAgent.setSessionEnvironment` 但不迁移 workdir ensure，run 会退回 fallback cwd，造成 workdir 回归。

因此必须把 workdir ensure 放到 acquire 路径：

```text
RunManager.startRun(record)
  -> sandboxManager.acquire({
       sessionId,
       contextScopeId,
       workdir: record.options.directory
     })
  -> HostLocalSandboxManager ensure scope context uses this workdir
```

workdir 粒度建议：

| 场景 | scope key | workdir 来源 |
|---|---|---|
| primary run | `sessionId` | root session projectRoot / run options directory |
| subagent run | `sessionId::contextScopeId` | child session projectRoot / run options directory |
| `setSessionWorkdir(sessionId, workdir)` | session default | 仅更新后续 fallback/default，不销毁 active scoped run |

如同一个 session 下两个 subagent 传入不同 workdir，scope-keyed context 可并存，不互相 destroy。

## 2.8 销毁与资源回收策略

本轮必须做到：

- 单个 run 结束只 release 自己的 lease。
- 不在 `runAgent` finally 中 destroy sandbox context。
- `subagent_close` 或 session cleanup 后续可以显式 destroy 对应 scope，但不应影响其他 scope。

本轮可以暂缓：

- 完整 session close 时批量销毁所有 scope 的 API。
- 长时间 idle scope 的 LRU 回收。
- worktree/container adapter 的真实资源清理策略。

建议补充最小 API：

```typescript
destroyContext(input: SandboxScopeIdentity): Promise<void>;
destroySession(sessionId: string): Promise<void>; // 后续可选
```

`destroySession` 必须只用于 session 结束或显式 reset，不用于单个 run completion。

## 2.9 分批实施建议

### Phase A：文档与接口契约

- 更新本目录文档。
- 后续同步更新 `docs/sandbox/goals-duty.md` / `architecture.md` / `test.md`。
- 在 `runtime/run-manager` 文档中把 sandbox acquire 输入从 session 改为 run scope。

### Phase B：sandbox scope key 基础设施

- 新增 `SandboxScopeIdentity` / `SandboxAcquireInput`。
- `SandboxManager` 内部 `contexts` 改为 `Map<scopeKey, Context>`。
- `SandboxContext` / `SandboxLease` 携带 `scopeKey` 与 `contextScopeId?`。
- `HostLocalSandboxManager.acquire(input)` 按 scope ensure workdir。

### Phase C：RunManager 接管 sandbox

- `CreateRunOptions.directory` 成为 sandbox ensure 的 workdir 来源。
- `RunManager.startRun()` 使用 scope-aware acquire。
- 单测验证同 session 不同 scope acquire 的 key 不同。

### Phase D：删除 runAgent sandbox setter/cleanup

- 删除 `AgentSandboxEnvironmentManager` 或标记 deprecated。
- 更新 `AgentService` / `AgentInstance` 相关测试。
- 保证 primary stream 仍能拿到正确 workdir。

### Phase E：回归测试与后续债务

- 增加双 subagent 并发集成测试。
- 再处理 close 终态、timeout、recover、goals-duty 等 2～6 项。

## 2.10 不采用的方案

| 方案 | 不采用原因 |
|---|---|
| 禁止同 child session 并发 | 与现有 run/context 模型、单测和 e2e 意图冲突 |
| 1 subagent = 1 child session | 绕过而不是修正 `contextScopeId` 模型；扩大 session 数量和迁移成本 |
| 只删 `runAgent` cleanup | 只能避免 destroy 竞态，不能解决 workdir ensure 与 session 单 key |
| 在 `setSessionEnvironment` 上补引用计数 | 保留了错误的 session 级 mutable setter，仍让 core runner 拥有 adapter 生命周期 |

