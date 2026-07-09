# agents — SessionSubagentHost 与 Subagent 工具面收敛（2026-07-09）

> 本轮改造的**服务/调度层**文档。执行原语层（`AgentInstance`、有行为的 `AgentContextScope`、per-step 压缩契约）见对侧文档
> [`docs/core/agents/2026-07-09-subagent-context`](../../core/agents/2026-07-09-subagent-context/README.md)。

---

## 一、本轮目标（一句话）

把当前按「短任务 `task` vs 长任务 `agent_open`」切分的两套 subagent 调用与执行编排，收敛为一个 `SessionSubagentHost` + 一个面向主 agent 的 `subagent_run` 调用入口；所有 subagent 都以独立 `AgentInstance` 运行，由实例而不是数据库字段承载上下文隔离，并把后台 subagent 状态持久化到 SQLite。

---

## 二、已确认决策（贯穿本轮）

1. **`AgentContextScope` 是有行为的对象**：调用方不再手写/推断 `isSubagent`；subagent 身份、父子关系、context/message scope 参数都由实例绑定。
2. **primary root instance 延后迁移**：本轮先完成 subagent 的 context/instance 化与工具面收敛；primary `startSession` 在基础设施稳定后单独改造。
3. **工具面重新命名**：主 agent 只通过 `subagent_run` 召唤或继续 subagent；辅助工具为 `subagent_status` / `subagent_close`。不再保留 `task` 与 `agent_open` 两套心智模型。
4. **后台 subagent 重启后不自动续跑**：进程重启按 owner 语义发现应恢复的 `running`/`pending` 时，状态转为 `interrupted`，由主 agent 显式 `subagent_run({ subagent_id, ... })` 继续；活着的其他 owner 不被误中断。
5. **上下文隔离从 DB 逻辑字段升级为实例隔离**：SQLite `session.parent_id` 仍是持久真相源，但运行时隔离必须由 `AgentInstance + AgentContextScope` 强制保证。
6. **`subagent_id` 不等于 child `session_id`**：`subagent_id` 是 agent instance handle；同一 child session 下可以有多个 subagent，context/message 需要用 `session_id + context_scope_id` 隔离。

---

## 三、与对侧模块的分工

| 关注点 | 本文档（`agents`） | 对侧（`core/agents`） |
|--------|--------------------|------------------------|
| `SessionSubagentHost`（spawn/resume/run/status/close） | ✅ | — |
| 前台/后台统一（同一 `subagent_run`，两种 mode） | ✅ | — |
| 容量、并发、队列、超时、重启恢复状态机 | ✅ | — |
| `subagent_instance` 表 + `DatabaseSubagentInstanceStore` | ✅ | — |
| 工具面（`subagent_run/status/close`） | ✅ | — |
| primary `startSession` 迁移 | ⏳ 后续阶段 | 提供可复用能力 |
| `AgentInstance` / `AgentContextScope` / 单实例压缩契约 | 消费 | ✅ |

---

## 四、文档索引

| 文件 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 现有问题：双 envelope 重复、内存态丢失、DB 字段隔离不足、工具面冗余 |
| [02-implementation-plan.md](./02-implementation-plan.md) | 实施方案 + 改动面调查（文件级 + DB 迁移 + 装配 + 工具） |
| [03-kimi-code-references.md](./03-kimi-code-references.md) | kimi-code / codex 的 subagent host、实例隔离、lazy resume 借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收标准 |
| [05-implementation-gates.md](./05-implementation-gates.md) | 实施前决策固化与检查门禁 |
