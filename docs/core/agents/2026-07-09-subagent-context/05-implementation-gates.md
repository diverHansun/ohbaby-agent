# 05 · 实施前决策与检查门禁（core/agents 视角）

本文把讨论中已经确认的点固化成编码前门禁。后续实现如果和这里冲突，优先回到这里重新讨论。

---

## 一、已经确认的设计决策

1. `AgentContextScope` 是有行为的身份对象，不是压缩执行器。
2. `sessionId` 是会话/线程容器；`contextScopeId` 才是 context/message 的隔离键。
3. `subagent_id` 是 subagent instance handle，通常也是该 subagent 的 `contextScopeId`；它不等于 child `session_id`。
4. 同一个 child session 可以承载多个 subagent instance，因此任何 context/message 查询只按 `sessionId` 过滤都不够。
5. primary root instance 后置，本轮只把 subagent instance/context scope 路径接上。

---

## 二、`AgentContextScope` 应该做什么

应该做：

- 校验 `type:"sub"` 必须有 `parentSessionId`，`type:"primary"` 不能有 `parentSessionId`。
- 校验恢复出来的 `sessionId/contextScopeId/instanceId/parentSessionId/agentName` 与 identity 一致。
- 生成 `toRunCreateOptions()`，让 `RunManager.create` 收到稳定的 `agentInstanceId/contextScopeId/isSubagent`。
- 让 `runAgent` 从 `AgentContextScope` 派生统一的 `sessionId + contextScopeId + isSubagent`，并把它传给 message 写入/读取、run 创建、lifecycle/context manager prepare/compact。

不应该做：

- 不直接持有 `ContextManager`。
- 不直接调用 `prepareTurn()` 或 `compact()`。
- 不决定压缩阈值、摘要策略、prune/mask 算法。
- 不承担 host 的并发、队列、重启恢复职责。

大白话：`AgentContextScope` 是“身份证 + 房间号 + 门禁卡”，不是“打扫房间的人”。打扫仍然是 context manager 的活。

---

## 三、AC-6 两段测试门禁

AC-6 不再写成“现状一定会溢出”。实施时必须拆成两段：

| 阶段 | 目的 | 结果解释 |
|------|------|----------|
| A：现状基线 | 用旧路径跑 50+ tool step，记录 `prepareTurn` 次数、token 规模、是否 overflow | 如果溢出，是缺陷复现；如果不溢出，是行为基线 |
| B：改造回归 | 用 `AgentInstance + AgentContextScope` 跑同场景 | 必须不比基线差，且 context/message 不串 scope |

这样做的好处是：不会为了证明方案正确而硬造一个未验证的前提，也不会漏掉当前代码其实已经局部解决的问题。

---

## 四、编码前检查

- [ ] `AgentInstanceIdentity` 同时包含 `instanceId`、`contextScopeId`、`sessionId`。
- [ ] `AgentContextScope` 暴露 `toRunCreateOptions()`；`runAgent` 不再手写散落的 scope 参数，而是优先从 `AgentContextScope` 派生。
- [ ] `runAgent` 的旧 `parentSessionId !== undefined` 推断只作为兼容 fallback。
- [ ] lifecycle/context manager 的 prepare 路径可以接收或派生 `contextScopeId`。
- [ ] `LifecycleEvent` / `RunWorker` stream payload 也带 `contextScopeId`，否则同 child session 下的实时事件仍然串来源。
- [ ] message 读写路径可以接收或派生 `contextScopeId`。
- [ ] `RunManager` 与 run ledger 的 active-run 判断使用 `sessionId + contextScopeId`，不能只按 `sessionId` 拒绝。
- [ ] 同一 `sessionId` 下两个不同 `contextScopeId` 的测试先写出来。
