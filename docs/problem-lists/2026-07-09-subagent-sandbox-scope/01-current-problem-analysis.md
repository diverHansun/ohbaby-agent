# 1. 现有问题分析：sandbox 与 context / agent instance 错位

## 1.1 背景结论

subagent context 改造后，系统已经接受一个核心模型：

> child session 是会话容器，subagent instance 才是上下文身份。一个 child session 可以包含多个 subagent instance，每个 instance 用自己的 `contextScopeId` 隔离 message/context/run。

这个模型在 message、context、run-manager 中已经基本落地，但 sandbox 仍停留在 session 级 context。于是同一个 child session 下多个 subagent 并发时，run/context 是 scope 并发，sandbox 却是 session 单例，生命周期会互相踩踏。

## 1.2 现有代码事实

### Run / context 已按 scope 并发

`RunManager` 的 active key 已经把 `contextScopeId` 纳入并发身份：

- `packages/ohbaby-agent/src/runtime/run-manager/manager.ts`
  - `activeKey({ sessionId, contextScopeId })` 返回 `sessionId::contextScopeId`
  - `create()` 查询 active run 时传入 `options.contextScopeId`

现有单测也明确允许同一 session 下不同 scope 并发：

- `packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts`
  - `allows concurrent runs in the same session when context scopes differ`

subagent e2e 也验证了同一个 child session 内两个 foreground subagent 并发：

- `packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts`

### Subagent id 不是 child session id

`SessionSubagentHost.createRecord()` 会复用 parent 下第一个 child session，但每次创建新的 subagent id，并把 `contextScopeId` 设为该 subagent id：

- `packages/ohbaby-agent/src/agents/subagent-host.ts`
  - `existing.length === 0 ? createChildSession(...) : getSession(existing[0].sessionId)`
  - `contextScopeId: subagentId`

这说明当前产品语义不是“一个 subagent 一个 child session”，而是“一个 child session 多个 subagent instance”。

### Sandbox 仍按 sessionId 单 key

当前 sandbox 对外接口只接受 `sessionId`：

- `packages/ohbaby-agent/src/sandbox/types.ts`
  - `SandboxManagerPort.acquire(sessionId: string)`

`SandboxManager` 内部 context 注册表也是：

- `packages/ohbaby-agent/src/sandbox/manager.ts`
  - `private readonly contexts = new Map<string, InternalSandboxContext>()`

`RunManager.startRun()` 也只用 `record.sessionId` 获取 sandbox lease：

- `packages/ohbaby-agent/src/runtime/run-manager/manager.ts`
  - `const sandboxLease = await sandboxManager.acquire(record.sessionId)`

因此，两个不同 `contextScopeId` 的 run 虽然可以并发，但实际拿到的是同一个 session 级 sandbox context。

### runAgent 拥有越权销毁 sandbox 的能力

`runAgent()` 在创建 run 前调用：

- `deps.sandboxManager?.setSessionEnvironment(scope.sessionId, input.environment)`

然后在 completion / stream finally / catch 中调用：

- `setSessionEnvironment(sessionId, undefined)`

而 `HostLocalSandboxManager.setSessionEnvironment(sessionId, undefined)` 会调用：

- `manager.destroyContext(sessionId)`

对应文件：

- `packages/ohbaby-agent/src/core/agents/runner.ts`
- `packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`

这造成一个双重 owner 问题：

| 职责 | 当前 owner | 问题 |
|---|---|---|
| run 生命周期 | `RunManager` | 已有 acquire/release，但只按 session acquire |
| sandbox workdir 设置 | `runAgent` / `HostLocalSandboxManager` | 在 core runner 层设置 adapter 运行环境 |
| sandbox 销毁 | `runAgent` finally 间接触发 | 单个 run 能销毁整个 session sandbox |

## 1.3 典型失败时序

并发场景：

1. Subagent A、B 属于同一个 child session，但 `contextScopeId` 不同。
2. A、B 各自进入 `runAgent()`，`RunManager` 允许它们并发。
3. `RunManager.startRun()` 对二者都调用 `sandboxManager.acquire(sessionId)`，同一个 session sandbox 上 `leaseCount = 2`。
4. A 先完成，`runAgent` finally 调 `setSessionEnvironment(sessionId, undefined)`。
5. `HostLocalSandboxManager` 调 `destroyContext(sessionId)`。
6. `SandboxManager.destroyContext()` 等待 drain，超过 `drainTimeoutMs` 后强制销毁 context。
7. B 仍在运行，但其 sandbox context 可能已被销毁。

这不是“没有引用计数”。`SandboxManager` 已经有 `leaseCount`。真正的问题是：

- lease 的 context key 是 session 级。
- run/context 的执行身份是 scope 级。
- destroy 权限在 `runAgent`，不是 `RunManager` 或 sandbox owner。

## 1.4 与现有文档的冲突

`docs/sandbox/goals-duty.md` 当前把 sandbox 定义为 “Session 级基础设施”，并写明：

- 同一 session 的后续 Run 复用同一个 context。
- `getContext(sessionId)` 供 run-manager 查询。

这在 primary-only 或一个 session 一个 agent 的模型下成立，但和当前 subagent instance model 冲突。

需要修正为：

> sandbox 是 session/scope 执行上下文。primary scope 可以退化为 session；subagent scope 必须可由 `sessionId + contextScopeId` 定位。lease 是 per run 的短期访问凭证。

## 1.5 问题边界

本问题不要求推翻 child session 多 subagent 的设计。

不推荐的修法：

- 禁止同 child session 下多个 subagent 并发。
- 改回 “1 subagent = 1 child session”。
- 只删除 `runAgent` cleanup，不调整 sandbox key 和 workdir ensure。

原因：

- 禁止并发会违背现有测试与产品意图。
- 1:1 child session 会绕过已经投入的 `contextScopeId` 全链路隔离。
- 只删 cleanup 可以缓解同 workdir 并发，但无法处理同 session 不同 workdir 或未来 worktree/container adapter。

## 1.6 设计检查要点

按模块设计文档的检查顺序，本问题需要回答：

| 检查点 | 当前答案 |
|---|---|
| Why | 防止 scope 并发 run 互相销毁 sandbox，修正执行环境身份错位 |
| Duty | sandbox 负责根据 run scope 提供 lease 与路径边界 |
| Non-Duty | sandbox 不负责 run 调度、subagent 状态机、message/context 压缩 |
| Architecture | `RunManager` 是 run 生命周期 owner；`SandboxManager` 是 physical context/lease owner；`runAgent` 不拥有 sandbox 生命周期 |
| Data flow | run create options 携带 `sessionId + contextScopeId? + directory`，RunManager ensure/acquire lease 后传给 Lifecycle |
| Test | 必须有双 scope 并发 + 先完成者不能 destroy 后完成者 sandbox 的回归测试 |

