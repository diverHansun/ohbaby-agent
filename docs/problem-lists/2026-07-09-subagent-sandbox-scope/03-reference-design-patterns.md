# 3. 优秀项目借鉴的设计模式

## 3.1 借鉴原则

本轮不是照搬 kimi-code 的数据结构，而是借鉴它的 owner 模型：

> 资源 owner 要和执行身份一致；尝试/运行的取消、timeout、cleanup 应作用在当前 attempt/run，而不是扫掉共享容器。

ohbaby 当前产品模型是：

- child session 可以包含多个 subagent instance。
- subagent instance 用 `contextScopeId` 隔离 context/message/run。

因此 ohbaby 的正确 adaptation 是 scope-keyed sandbox，而不是改成 kimi 的 one-agent-one-session。

## 3.2 kimi-code：Agent 实例拥有自己的 ContextMemory

kimi-code 的 `Session.createAgent()` 会为每个 agent 创建独立 id 与 homedir：

- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/session/index.ts`
  - `createAgent()`
  - `instantiateAgent()`

`Agent` 构造时拥有自己的：

- `AgentRecords`
- `FullCompaction`
- `MicroCompaction`
- `ContextMemory`
- `TurnFlow`
- `BackgroundManager`

参考：

- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/agent/index.ts`

可借鉴点：

- context owner 是 agent instance，而不是 session 字段。
- resume 通过 agent id 恢复 agent 实例，而不是重新拼装零散参数。
- compaction 是 agent context 的行为，不是全局 session 的行为。

对 ohbaby 的映射：

| kimi-code | ohbaby 对应 |
|---|---|
| `agentId` | `subagentId / AgentInstanceIdentity.instanceId` |
| `ContextMemory` | 当前由 DB message/context + `contextScopeId` 表达 |
| agent homedir | 当前暂不直接对应；sandbox scope 可作为 execution context identity |
| `SessionSubagentHost.activeChildren` | `SessionSubagentHost.active` + `RunManager.activeBySession(scope)` |

## 3.3 kimi-code：子代理运行按 child agent / attempt 管理

kimi-code 的 `SessionSubagentHost`：

- `activeChildren` keyed by child `agentId`。
- `ensureIdleSubagent(agentId)` 拒绝同一个 child agent 重入。
- 多个子代理任务通过 `SubagentBatch` 控制并发。

参考：

- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/session/subagent-host.ts`
- `/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core/src/session/subagent-batch.ts`

可借鉴点：

- 并发上限和 active tracking 按 agent/attempt 身份，不按 parent session 粗粒度处理。
- timeout abort 只影响当前 attempt。
- 一个 attempt 完成后只清理自己的 active entry，不销毁 sibling agent 的上下文。

对 ohbaby 的映射：

- `RunManager` 已按 `sessionId + contextScopeId` 管 active run。
- sandbox 也应按相同 identity 取 lease。
- `subagent_close` 应关闭一个 subagent instance，而不是影响同 child session 其他 subagent。

## 3.4 kimi-code：重启不自动续跑

kimi-code 的 background task resume 会把丢失的任务标记为 lost / terminated，并提示用户使用 agent id 恢复，不自动重新执行 in-flight attempt。

可借鉴点：

- 重启后不要自动 drain queue。
- 恢复语义应区分 agent identity 与 task/attempt identity。
- 用户显式 resume 时才追加新 turn。

对 ohbaby 的映射：

- `recoverInterrupted()` 只把 `pending/running` subagent instance 标记为 `interrupted`。
- 不自动调用 `AgentInstance.turn()`。
- `subagent_status` 暴露统一 `items[]`，由主 agent 决定是否 `subagent_run(subagent_id, ...)`。

## 3.5 可采用的设计模式

### Scope Identity Object

把 `sessionId + contextScopeId?` 封装为窄对象，而不是在调用链里传裸字符串。

收益：

- 降低把 `sessionId` 当 context 边界的误用概率。
- 让 primary 退化规则显式化。
- 方便测试和日志观察。

### Lease / Ref-count

保留现有 `SandboxLease` / `leaseCount` 思路，但把 context key 从 session 升级到 scope。

收益：

- 不从零重写引用计数。
- 每个 run release 自己的 lease。
- destroy 只作用于对应 scope context。

### Owner Handoff

`RunManager` 是 run 生命周期 owner，`SandboxManager` 是 sandbox context owner，`runAgent` 是 agent run facade。

收益：

- 消除 `runAgent` 和 `RunManager` 两套 sandbox 生命周期 owner。
- workdir ensure 与 run record 使用同一份 `directory`。
- 后续 timeout / cancellation 更容易按 run 归属处理。

### Strategy + Registry 保留

当前 `SandboxAdapter` + `AdapterRegistry` 仍合理。scope-keyed 改造不应破坏 adapter strategy，只改变 manager 层的 context key 与 acquire input。

收益：

- host-local / worktree / container 后端继续通过 adapter 扩展。
- 不把 scope 逻辑散落到每个 adapter。

## 3.6 不直接照搬的设计

| kimi-code 设计 | ohbaby 不照搬原因 |
|---|---|
| 1 agent = 1 homedir | ohbaby 已选择 DB message/context + `contextScopeId`，不应临时引入文件系统 memory store |
| 1 child agent 一个 active turn | ohbaby 的 active run 已由 `RunManager` 管理，不需要在 sandbox 层重复调度 |
| background manager ghost task 体系 | 本轮只解决 sandbox 生命周期；background 状态机另见 2～6 项文档 |

## 3.7 对当前实现的最小设计启发

一句话：

> 不要让共享容器的生命周期盖过具体执行身份。

落到代码：

- child session 是共享容器。
- subagent `contextScopeId` 是具体执行身份。
- sandbox context 应按执行身份定位。
- sandbox lease 应按 run 持有。
- cleanup 应释放 run lease，不应销毁 session 容器。

