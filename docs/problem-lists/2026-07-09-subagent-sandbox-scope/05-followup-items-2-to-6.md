# 5. 2～6 项后续决策文档

> 本文件只记录第一项 sandbox scope 之外的后续工作。它们不应混进 sandbox scope 第一批实现中，但需要在同一轮合并前或紧随其后处理。

## 5.1 总览

| 编号 | 项 | 当前判断 | 建议批次 |
|---:|---|---|---|
| 2 | `subagent_close` 终态 | 已实现并测试 | P0/P1 |
| 3 | host timeout 写 `timed_out` | 已实现并测试 | P0/P1 |
| 4 | `recoverInterrupted` 按 owner/parent 收窄 | 已实现；同 PID 多 owner 仍是后续扩展边界 | P0/P1 |
| 5 | 清理 `goals-duty.md` 中旧 task/AgentTaskManager 语义 | 已完成 | P0 |
| 6 | primary root `AgentInstance` 基础接入 | 已接入；物理 primary scope 另批 | P1/P2 |

## 5.2 项 2：`subagent_close` 必须是终态

### 原问题（已修复）

`SessionSubagentHost.close()` 会写：

- `status: "cancelled"`
- `closedAt`
- 清空 `pendingQueue`
- abort active controller

但 `getExisting()` / `run()` 没有拒绝 `closedAt` 或 `status === "cancelled"` 的记录。结果是同一个 `subagent_id` 关闭后仍可能被 `subagent_run` 复活。

涉及文件：

- `packages/ohbaby-agent/src/agents/subagent-host.ts`
- `packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts`

### 目标语义

- close 后该 `subagent_id` 不能再 run。
- close active run 时，active run 后续 completion 不得把状态覆盖回 `completed` / `failed`。
- close 是终态：重复继续 run 必须拒绝；close 会清空 pending queue。

### 验收

- `subagent_run({ subagent_id })` 对 closed subagent 返回明确错误。
- active close 后，run completion 不覆盖 `cancelled`。
- close 后 `subagent_status` 仍返回该 item，状态为 `cancelled`。

## 5.3 项 3：host timeout 与 `timed_out`

### 原问题（已修复）

`agents/deadline.ts` 已存在 `createDeadlineController()`，`SubagentInstanceStatus` 也有 `timed_out`，但 `SessionSubagentHost.runTurn()` 没有使用 deadline，`timed_out` 没有真实写入路径。

涉及文件：

- `packages/ohbaby-agent/src/agents/deadline.ts`
- `packages/ohbaby-agent/src/agents/subagent-host.ts`
- `packages/ohbaby-agent/src/agents/subagents/types.ts`

### 目标语义

- subagent host 默认 deadline 为 2h；`timeout_ms` 可覆盖。
- `timeout_ms` 只覆盖当前输入，不修改实例默认 deadline。
- `subagent_run` 把 timeout ownership 声明为 tool/host；scheduler 只负责 caller cancellation 与并发 admission，不再设置另一个固定墙钟 guard。background 调用持久化后立即返回，长任务 deadline 同样由 host 管理。
- timeout abort 当前 turn，并把 subagent instance 写成 `timed_out`。
- 用户主动 abort / 父 run abort 写成 `interrupted`，不伪装成 timeout。
- `failed` / `timed_out` / `interrupted` 都暂停 queue，不自动 drain；只有新的 `subagent_run(subagent_id, prompt)` 会恢复，且新 prompt 入队尾。

### 验收

- 使用 fake timers，不真实等待 2h 默认 deadline。
- timeout 后 `subagent_status.items[0].status === "timed_out"`。
- timeout 后保留 `lastRunId` / error / `pendingQueue`。
- timeout/failed/interrupt 收口时清空 `currentInput/currentRunId`；close 把 current run 转存为 last run。
- timeout 不影响 sibling subagent。

## 5.4 项 4：`recoverInterrupted` 按 owner/parent 收窄

### 现状

composition 启动时调用：

```typescript
await subagentHost.recoverInterrupted();
```

host 自动注入当前 `ownerId/ownerPid`；store 只处理当前 owner、同 PID 旧 owner或确认死亡的 owner。unknown-owner legacy 记录仅在显式 `recoverUnknownOwner:true` 时处理，默认不全表误伤。

当前实现还依赖一个运行时约束：同一 OS 进程内只存在一个 active runtime composition。热重建先 dispose 旧 runtime，再创建新 owner，因此“同 PID 旧 owner”可判定为残留记录。未来若支持同 PID 多 backend owner 并存，必须引入 owner registry/heartbeat，不能沿用此判定。

backend/client dispose 必须 await runtime reset；reset 使用串行 barrier，旧 host/RunManager/sandbox 未退出前不得创建 replacement runtime。另一个 active owner 正在执行同一 subagent 时，新 prompt 明确拒绝并重试，不写入当前实现无法跨进程消费的 queue。

涉及文件：

- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- `packages/ohbaby-agent/src/agents/subagents/database-store.ts`
- `packages/ohbaby-agent/src/agents/subagents/in-memory-store.ts`

### 目标语义

- backend 启动时只恢复当前 owner 或确认已死亡 owner 的 pending/running subagent。
- unknown-owner legacy 记录的恢复应有明确迁移边界，不默认长期全局开启。
- 重启后状态变为 `interrupted`，不自动续跑。

### 验收

- 当前 owner 的 pending/running -> `interrupted`。
- 活着的其他 owner 不变。
- dead pid owner -> `interrupted`。
- unknown owner 只有在显式 legacy 模式下才恢复。

## 5.5 项 5：更新 goals-duty 与旧语义

### 现状

部分文档仍写旧模型：

- `AgentService.executeTask`
- `AgentTaskManager`
- `task / agent_open / agent_eval`

这些内容和当前 `subagent_run/status/close` 单一工具面冲突。

涉及文档：

- `docs/agents/goals-duty.md`
- `docs/core/agents/goals-duty.md`
- 可能还有 `docs/agents/dfd-interface.md`

### 目标语义

`agents` 服务层：

- `SessionSubagentHost` 是 subagent lifecycle owner。
- `subagent_run` 是唯一召唤/继续入口。
- `subagent_status` 统一返回 `items[]`。
- `subagent_close` 是终态关闭。

`core/agents`：

- `AgentInstance` / `AgentContextScope` 是 subagent run scope 的身份门面。
- `runAgent` 是 run facade，不拥有 sandbox 生命周期。

### 验收

- 文档中不再把已删除的 `executeTask` / `AgentTaskManager` 当当前实现。
- 如保留历史文档，必须标注为历史方案或 deprecated。
- 新设计文档能指向本目录 sandbox scope 方案。

## 5.6 项 6：primary root `AgentInstance` 基础接入

### 当前决策

primary `startSession` 已通过 `AgentInstanceFactory.create({ type:"primary" })` 进入 `AgentInstance.turn({ waitMode:"stream" })`，但 primary 仍保持 message/context scope 为 `NULL`，不写 `contextScopeId`。

原因：

- 先统一 primary/sub 的 instance turn 边界。
- 不立即给 primary 加物理 `contextScopeId`，避免过滤掉既有 `context_scope_id IS NULL` 的 primary 历史消息。
- primary 物理 scope 迁移需要单独数据迁移与兼容测试。

### 后续要求

- primary root 物理 `contextScopeId` 必须另开 ticket / 文档 TODO。
- 不把 primary 无物理 scope 的状态误认为最终形态。
- sandbox 改造必须兼容 primary：无 `contextScopeId` 时 scope key 退化为 `sessionId`。

### 验收

- primary startSession 现有测试保持通过，并断言 `RunManager.create` 不带 `contextScopeId`。
- `AgentContextScope` 拒绝 primary identity 携带 `contextScopeId`，防止误启用半迁移。
- 文档明确 “primary root 物理 scope 是后续批次”，不是遗漏。

## 5.7 建议执行顺序

1. 先完成 sandbox scope P0。
2. 做 close 终态，避免 subagent 被关闭后复活。
3. 接 host deadline，写 `timed_out`。
4. 收窄 recoverInterrupted。
5. 更新 goals-duty 和旧语义文档。
6. primary 已接 `AgentInstance`；给 primary 物理 scope 开后续任务。

## 5.8 自检清单

- 每一项是否有当前代码证据？
- 每一项是否有可自动化的验收场景？
- 是否避免把 primary 物理 scope 迁移塞进 sandbox 修复批次？
- 是否避免文档继续教后续实现者修改已删除的旧路径？
