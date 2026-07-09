# 5. 2～6 项后续决策文档

> 本文件只记录第一项 sandbox scope 之外的后续工作。它们不应混进 sandbox scope 第一批实现中，但需要在同一轮合并前或紧随其后处理。

## 5.1 总览

| 编号 | 项 | 当前判断 | 建议批次 |
|---:|---|---|---|
| 2 | `subagent_close` 终态 | 必须修 | P0/P1 |
| 3 | host timeout 写 `timed_out` | 必须修 | P0/P1 |
| 4 | `recoverInterrupted` 按 owner/parent 收窄 | 必须修 | P0/P1 |
| 5 | 清理 `goals-duty.md` 中旧 task/AgentTaskManager 语义 | 必须修 | P0 |
| 6 | primary root `AgentInstance` 延后并留 ticket | 明确延期 | P2 |

## 5.2 项 2：`subagent_close` 必须是终态

### 现状

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
- close 幂等：重复 close 返回当前 cancelled item，不抛非预期错误。

### 验收

- `subagent_run({ subagent_id })` 对 closed subagent 返回明确错误。
- active close 后，run completion 不覆盖 `cancelled`。
- close 后 `subagent_status` 仍返回该 item，状态为 `cancelled`。

## 5.3 项 3：host timeout 与 `timed_out`

### 现状

`agents/deadline.ts` 已存在 `createDeadlineController()`，`SubagentInstanceStatus` 也有 `timed_out`，但 `SessionSubagentHost.runTurn()` 没有使用 deadline，`timed_out` 没有真实写入路径。

涉及文件：

- `packages/ohbaby-agent/src/agents/deadline.ts`
- `packages/ohbaby-agent/src/agents/subagent-host.ts`
- `packages/ohbaby-agent/src/agents/subagents/types.ts`

### 目标语义

- foreground subagent 有短 deadline。
- background subagent 有长 deadline。
- timeout abort 当前 turn，并把 subagent instance 写成 `timed_out`。
- 用户主动 abort 仍应是 `cancelled` 或 failed/cancelled 的明确语义，不伪装成 timeout。

### 验收

- 使用 fake timers，不真实等待 5min/30min。
- timeout 后 `subagent_status.items[0].status === "timed_out"`。
- timeout 后保留 `lastRunId` / error。
- timeout 不影响 sibling subagent。

## 5.4 项 4：`recoverInterrupted` 按 owner/parent 收窄

### 现状

composition 启动时仍调用：

```typescript
await subagentHost.recoverInterrupted({ recoverUnknownOwner: true });
```

这会让恢复行为偏全局。虽然 store 内已经有 owner 判断，但 composition 层没有 parent/session 边界，未来多 parent 或多进程时容易误伤。

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

## 5.6 项 6：primary root `AgentInstance` 延后

### 当前决策

primary root instance 迁移暂不放入本批。

原因：

- primary stream 是 UI 关键路径。
- 本批重点是 subagent context/sandbox 基础设施可靠。
- 先把 subagent 的 run scope / sandbox scope 对齐，再迁 primary，可降低风险。

### 延后要求

- 必须留明确 ticket / 文档 TODO。
- 不把 primary 无 scope 的状态误认为最终形态。
- sandbox 改造必须兼容 primary：无 `contextScopeId` 时 scope key 退化为 `sessionId`。

### 验收

- primary startSession 现有测试保持通过。
- 文档明确 “primary root AgentInstance 是后续批次”，不是遗漏。

## 5.7 建议执行顺序

1. 先完成 sandbox scope P0。
2. 做 close 终态，避免 subagent 被关闭后复活。
3. 接 host deadline，写 `timed_out`。
4. 收窄 recoverInterrupted。
5. 更新 goals-duty 和旧语义文档。
6. 给 primary root instance 开后续任务。

## 5.8 自检清单

- 每一项是否有当前代码证据？
- 每一项是否有可自动化的验收场景？
- 是否避免把 primary 迁移塞进 sandbox 修复批次？
- 是否避免文档继续教后续实现者修改已删除的旧路径？

