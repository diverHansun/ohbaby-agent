# 01 · 现有问题分析（agents 服务层视角）

分析对象：`packages/ohbaby-agent/src/agents`、`packages/ohbaby-agent/src/tools` 与装配层。结论基于当前代码，并按 2026-07-09 最新决策重新对齐。

---

## 一、问题总览

| 编号 | 问题 | 当前影响 | 本轮目标 |
|------|------|----------|----------|
| Q1 | 两套 subagent envelope 实现重复编排 | `AgentService.executeTask` 与 `AgentTaskManager.runTurn` 各自调 `runAgent(waitForCompletion)` | 收敛到 `SessionSubagentHost` |
| Q2 | 后台 subagent 调度态只在内存 | 进程重启后 `taskId -> sessionId`、队列、运行态丢失 | 新增 durable `subagent_instance` |
| Q3 | subagent context 隔离停留在 DB 字段与调用参数 | SQLite 有 `session.parent_id`，但运行时没有独立 context owner | 由 `AgentInstance + AgentContextScope` 承载 |
| Q4 | primary 与 subagent 归属模型不统一 | primary 也没有 root instance | 确认为后续阶段，不阻塞本轮 |
| Q5 | 面向主 agent 的工具语义割裂 | `task` 与 `agent_open/eval/status/close` 需要模型自行选择 | 改成 `subagent_run/status/close` |

---

## 二、Q1：两套并行 envelope 实现

### 2.1 当前同步路径

`AgentService.executeTask` 做了完整的一套 subagent 编排：

```typescript
async executeTask(params: SubagentExecuteParams): Promise<SubagentResult> {
  const runtimeAgent = await this.options.agentManager.getRuntimeAgent(
    params.role,
    { isSubagent: true },
  );
  const session = await this.resolveSession(params);
  const runPromise = runAgent({
    ...,
    sessionId: session.id,
    parentSessionId: params.parentSessionId,
    waitMode: "waitForCompletion",
  });
}
```

它负责并发计数、角色解析、child session 创建或校验、deadline、`runAgent` 调用、取消/超时 race、最终输出包装。当前语义是 foreground：父 agent 阻塞等待结果。

### 2.2 当前后台路径

`AgentTaskManager.runTurn` 又做了一套相似编排：

```typescript
private async runTurn(
  taskId: string,
  prompt: string,
  environment?: AgentTaskOpenInput["environment"],
): Promise<void> {
  const state = this.active.get(taskId);
  state.running = true;
  const runPromise = runAgent({
    ...,
    sessionId: state.session.id,
    parentSessionId: record.parentSessionId,
    waitMode: "waitForCompletion",
  });
}
```

它额外维护 `queue`、`running`、`AbortController`、retained capacity 与 parent capacity。当前语义是 background：先返回 handle，再由 `agent_eval/status/close` 继续管理。

### 2.3 真正差异只是前台/后台模式

| 编排环节 | 当前 foreground | 当前 background |
|----------|-----------------|------------------|
| 角色解析 | `AgentManager.getRuntimeAgent` | `AgentManager.getRuntimeAgent` |
| child session | `resolveSession` | `open` 时创建或复用 |
| 执行原语 | `runAgent(waitForCompletion)` | `runAgent(waitForCompletion)` |
| timeout/cancel | 本地 deadline + race | 本地 deadline + race |
| 结果收口 | `SubagentResult` | record `output/error/status` |
| 多轮 | `resumeSessionId` | queue + `sendInput` |

所以本轮不应继续保留两套 owner，而应由一个 `SessionSubagentHost.run()` 接住两种模式。

---

## 三、Q2：后台调度态缺少 durable owner

当前 `AgentTaskManager` 的关键状态都在内存：

```typescript
private readonly active = new Map<string, ActiveTaskState>();
```

- `ActiveTaskState` 持有 queue、running、abortController、session、runtimeAgent。
- 默认 store 是 `InMemoryAgentTaskStore`，重启后后台 handle 与 child session 的映射丢失。
- SQLite 已经持久化 child session 与 message，但只能证明“这个 session 是某个 parent 的 child”，不能证明“它是哪个可继续的后台 subagent 实例”。

这也是为什么只靠 `session.parent_id` 不够：数据库字段能做 durable 归属隔离，却不能替代运行时实例、并发状态、队列状态和显式恢复语义。

---

## 四、Q3：subagent context 隔离目前是逻辑隔离

当前 subagent context 隔离主要来自这些约定：

1. child session 写入 `parent_id`。
2. subagent 不加载 primary memory。
3. subagent 禁用部分工具。
4. `runAgent` 通过 `parentSessionId !== undefined` 推导 `isSubagent`。

这些约定是有价值的，但还不是 kimi-code 那种“每个 child agent 都有独立实例和 context memory”的运行时隔离。具体风险是：

- 没有对象校验 `sessionId`、`parentSessionId`、`role/name` 是否与已恢复实例一致。
- 每轮执行只是重新传参调用 `runAgent`，而不是对同一个 `AgentInstance` 发起 `turn()`。
- 压缩机制虽已在 `core/agents` 的 lifecycle 中存在，但 subagent 没有显式 context owner 来承诺“所有 turn 都经同一 scope 参数 prepare/compact”。

本轮要把“DB 字段隔离”升级为“`AgentInstance + AgentContextScope` 运行时隔离”，SQLite 继续作为 durable truth。

---

## 五、Q4：primary root instance 暂缓

primary 现状仍是：

- `AgentService.startSession` 调 `runAgent(stream)`。
- subagent foreground/background 分别由 `executeTask` 与 `AgentTaskManager` 触发。

架构上确实希望最终达到“primary 与 subagent 都是 `AgentInstance`”。但本轮确认的顺序是：先把 subagent 的 context/instance 化接入完成，再单独改 primary root instance，避免同时改 stream envelope、UI projection 与 subagent 调度。

因此 Q4 是后续架构债，不作为本轮验收门槛。

---

## 六、Q5：工具面需要按语义重命名

当前工具面：

- `tools/task.ts` 暴露 `task`，语义是同步阻塞 subagent。
- `tools/agent-task.ts` 暴露 `agent_open/eval/status/close`，语义是后台 subagent。

问题不是“能力太多”，而是“召唤 subagent 的入口有两个心智模型”。本轮确认：

- 只保留一个面向主 agent 的 subagent 召唤/继续入口：`subagent_run`。
- 辅助管理工具：`subagent_status`、`subagent_close`。
- `subagent_run` 通过 `mode: "foreground" | "background"` 表达阻塞或后台。
- `subagent_run` 通过 `subagent_id` 继续既有 child instance，不再使用 `agent_eval` 这个额外动词。

---

## 七、保留的正确边界

1. **agent 描述符子层保留**：`AgentRegistry`、`AgentManager.getRuntimeAgent`、`builtin/*`、`roles.ts` 仍负责“agent 是什么”。
2. **SQLite session/message 保留为真相源**：child session 与消息历史不迁移到另一套事件日志。
3. **依赖方向保留**：`agents -> core/agents`，`core/agents` 不反向依赖 `agents`。
4. **child session durable 归属保留**：`session.parent_id` 仍是 DB 层隔离依据，但不再被当作运行时隔离的全部。
5. **现有后台 store 端口可吸收或重命名**：旧 `AgentTaskStore` 可以作为迁移起点，但目标领域名应收敛到 `SubagentInstanceStore` / `SubagentInstanceRecord`。
