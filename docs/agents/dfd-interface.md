# agents 模块 dfd-interface.md

本文档描述当前 primary/subagent 的真实数据流与接口。旧 `task`、`agent_open`、`agent_eval`、`AgentService.executeTask`、`AgentTaskManager` 已退役，不是兼容入口。

---

## 一、Context & Scope

```text
primary prompt                           subagent_run/status/close
      |                                           |
      v                                           v
AgentService.startSession              SessionSubagentHost
      |                                  |-- SubagentInstanceStore
      |                                  |-- SessionManager
      |                                  `-- AgentInstanceFactory
      |                                           |
      `---------------------> AgentInstance <-----'
                                      |
                                      v
                              AgentContextScope
                                      |
                                      v
                              core/agents.runAgent
                                      |
                    +-----------------+-----------------+
                    |                 |                 |
                    v                 v                 v
             core/message      core/lifecycle    RunManager
                                                     |
                                                     v
                                           scoped SandboxLease
```

ID 语义：

| ID | 含义 | 隔离/所有权用途 |
|---|---|---|
| `sessionId` | primary/child 会话容器 | durable session 与 parent 关系 |
| `subagentId` | 主 agent 可见的实例 handle | run/status/close/continue |
| `contextScopeId` | subagent context/message 隔离键 | 与 `sessionId` 共同过滤消息、压缩上下文和申请 sandbox |
| `runId` | 单次 turn 的运行标识 | ledger、取消、CAS 收口 |

一个 child session 可以承载多个 subagent；`subagentId` 不等于 `sessionId`。当前实现令 subagent 的 `contextScopeId = subagentId`，但两者仍是不同语义。

---

## 二、Data Flow

### 2.1 primary prompt

```text
1. AgentService.startSession 解析 primary RuntimeAgent
2. 创建或读取 root Session
3. AgentInstanceFactory.create({ type: "primary", instanceId: sessionId })
4. AgentInstance.turn({ waitMode: "stream", prompt })
5. AgentContextScope 校验 primary identity；当前不生成物理 contextScopeId
6. runAgent 写消息、构造 prompt、创建 RunManager run 并返回 stream handle
```

primary 已进入 `AgentInstance` 边界，但 primary 历史消息仍按 `context_scope_id IS NULL` 读取。物理 primary scope 是后续迁移，不在当前数据流里假装完成。

### 2.2 创建或继续 subagent

```text
1. subagent_run 调 SessionSubagentHost.run
2. 新建时按 parent 串行选择/创建共享 child Session，并创建独立 SubagentInstanceRecord
3. 首个 prompt 与 pendingQueue 一起持久化；继续时校验 subagentId 的 parent 归属
4. foreground/background 都进入同一 durable FIFO queue；mode 只决定调用方是否等待自己的队列项
5. store.claim 用条件 UPDATE + RETURNING 原子完成：队首 -> currentInput/currentRunId/status=running/owner
6. Host 创建 AgentInstance({
     type: "sub",
     instanceId: subagentId,
     contextScopeId,
     sessionId: childSessionId,
     parentSessionId,
     agentName: role
   })
7. AgentInstance.turn(waitForCompletion) 进入 runAgent/lifecycle/context/message
8. RunManager 按 { sessionId, contextScopeId, workdir } 获取 scoped sandbox lease
9. store.finishRun(expectedCurrentRunId) 以 CAS 写 completed/failed/timed_out/interrupted
10. completed 继续 drain；failed/timed_out/interrupted 暂停，等待下一次显式 subagent_run
```

`interrupt:true` 只取消当前 turn并保留 queue。旧 turn 已 settle 时可继续；旧执行体不响应取消时实例停在 `interrupted`，不得同时启动 replacement。

暂停时，排队 foreground 的调用方会拿到当前失败 item，避免主 agent 死锁；该 prompt 只解除 waiter/signal，仍保留在 durable queue。另一个 runtime 已持有 active run 时，新输入明确失败并要求重试，不做无消费者的跨 owner 追加。

### 2.3 status、close 与 runtime reset

```text
subagent_status -> 始终返回 { items: [...] }
subagent_close  -> cancelled + closedAt，清空 queue/currentInput，close 后不可复活
backend dispose -> runtimeController.resetRuntime() 串行 barrier
runtime reset   -> host.dispose() abort active + owner-aware interrupted
                -> RunManager.cancelAll() 释放 scoped lease
                -> 创建新 runtime；不自动续跑 pendingQueue
```

`subagent_status/close` 使用 scheduler control-plane 类别，不与长时间 `subagent_run` 共用容量槽。`subagent_run` 的墙钟 deadline 只由 host 拥有，scheduler 仍负责 caller cancellation。

同一进程启动多个 local daemon 且共享 SQLite 时，数据库关闭采用 daemon runtime 引用计数：每个 backend 先 await 自己的 runtime dispose，只有最后一个 daemon 退出后才关闭共享连接。

---

## 三、Interfaces

### 3.1 AgentService

```typescript
interface AgentService {
  startSession(params: StartSessionParams): Promise<AgentSessionStartResult>
}
```

`AgentService` 只承载 primary 启动入口，不编排 subagent。

### 3.2 SessionSubagentHost

```typescript
interface SessionSubagentHost {
  run(input: SubagentRunInput): Promise<SubagentRunResult>
  status(input: SubagentStatusInput): Promise<{ items: SubagentInstanceRecord[] }>
  close(input: SubagentLookupInput): Promise<SubagentCloseResult>
  recoverInterrupted(input?: MarkSubagentsInterruptedInput): Promise<SubagentInstanceRecord[]>
  dispose(): Promise<void>
}
```

### 3.3 SubagentInstanceStore

```typescript
interface SubagentInstanceStore {
  create(record: SubagentInstanceRecord): Promise<void>
  claim(subagentId: string, update: SubagentInstanceUpdate): Promise<SubagentInstanceRecord | null>
  finishRun(
    subagentId: string,
    currentRunId: string,
    update: SubagentInstanceUpdate,
  ): Promise<SubagentInstanceRecord>
  get(input: SubagentLookupInput): Promise<SubagentInstanceRecord | null>
  update(subagentId: string, update: SubagentInstanceUpdate): Promise<SubagentInstanceRecord>
  listByParent(parentSessionId: string): Promise<SubagentInstanceRecord[]>
  markInterrupted(input?: MarkSubagentsInterruptedInput): Promise<SubagentInstanceRecord[]>
}
```

`claim` 和 `finishRun` 是行为契约，不是普通 update 的别名：前者防双 owner 执行，后者防 close/恢复后迟到结果覆盖新状态。SQLite 必须在同一条条件写语句中 `RETURNING` 结果，不能 update 后再 select。

---

## 四、Data Ownership

| 数据 | 创建者 | durable 真相源 | 说明 |
|---|---|---|---|
| AgentConfig / RuntimeAgent | `AgentRegistry` / `AgentManager` | 配置文件/registry | role、tools、maxSteps |
| root/child Session | `SessionManager` | session 表 | child 可承载多个 subagent |
| SubagentInstanceRecord | `SessionSubagentHost` | subagent_instance 表 | 状态、owner、queue、current/last run |
| message/context history | `core/message` / `core/context` | message 表 | subagent 按 `sessionId + contextScopeId` 过滤 |
| RunRecord | `RunManager` | run ledger | 每 turn 的运行台账 |
| SandboxContext | `SandboxManager` | runtime resource | 由 scoped lease 引用；不是 subagent 状态真相源 |
| 内存 active state | `SessionSubagentHost` | 无 | 只保存 AbortController、foreground waiter、不可序列化 environment |

---

## 五、Error & Recovery

| 场景 | 行为 |
|---|---|
| role/parent/subagent 不存在或归属不匹配 | 明确拒绝，不创建隐式 session |
| claim 冲突 | 当前 host 不执行该 turn |
| 其他 active owner | 明确拒绝新 prompt，不留下 orphan queue |
| turn 普通失败 | `failed`，保留 background queue，等待显式继续 |
| host deadline | `timed_out`，不由 scheduler 伪装 |
| caller/interrupt/runtime dispose | `interrupted`；只有确认旧 turn settle 才可安全自动续排 |
| close | `cancelled + closedAt` 终态；迟到 finish CAS 不生效 |
| 进程恢复 | owner-aware `pending/running -> interrupted`，不创建 AgentInstance，不自动 drain |

当前 owner recovery 假设同一 OS 进程只有一个 active runtime composition。若未来允许同 PID 多 owner，必须增加 owner registry/heartbeat。

取消采用 cooperative contract：同一 scope replacement 必须等旧 lifecycle settle；RunManager 的 lock 只覆盖该 scope，不阻塞 sibling。ToolScheduler 可先向调用方返回 cancelled，但写/危险工具的槽位要等实际 promise settle 才释放。

---

## 六、文档自检

- [x] 只描述当前 `subagent_run/status/close` 工具面。
- [x] `SessionSubagentHost` 是 subagent 状态机 owner，`AgentService` 只负责 primary。
- [x] context/message/sandbox 都显式区分 `sessionId` 与 `contextScopeId`。
- [x] queue、claim、finish、close、timeout、interrupt、runtime reset 与重启恢复语义完整。
