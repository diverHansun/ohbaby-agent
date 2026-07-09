# core/agents — AgentInstance 与有行为的 ContextScope（2026-07-09）

> 本轮改造的**执行原语层**文档。服务/调度层（`SessionSubagentHost`、subagent 持久化、工具面）见对侧文档
> [`docs/agents/2026-07-09-subagent-context`](../../../agents/2026-07-09-subagent-context/README.md)。

---

## 一、本轮目标（一句话）

把 subagent 的 **context 归属**从「运行时临时传 `sessionId` / `parentSessionId` / `isSubagent`，持久层用 DB 字段做逻辑隔离」升级为「由显式 `AgentInstance` 与有行为的 `AgentContextScope` 持有」，让每个 subagent 的每一轮执行都不可绕过同一条 lifecycle per-step 压缩管线。

---

## 二、已确认决策

1. **`AgentContextScope` 做成有行为的对象**：它绑定实例身份，负责校验身份并生成 run/context/message 的 scope 参数；它不亲自执行压缩。
2. **不重复实现压缩算法**：压缩仍复用 `core/context` 的 `prepareTurn` / `runCompaction`；本轮只把 scope 身份稳定传进现有 lifecycle。
3. **先接入 subagent，再迁移 primary**：`AgentInstanceIdentity` 可以表达 `primary`，但本轮实施门禁只要求 subagent 路径先通过；primary root instance 作为后续独立阶段。
4. **实例隔离优先于 DB 字段隔离**：DB session 仍是消息真相源，运行时不得依赖调用方临时推断 `isSubagent` 来保证隔离。

---

## 三、与另一模块的分工

| 关注点 | 本文档（`core/agents`） | 对侧文档（`agents`） |
|--------|------------------------|----------------------|
| context 归属原语 | ✅ `AgentInstance` / `AgentContextScope` | 消费 |
| 单轮执行 | ✅ `AgentInstance.turn()` 复用 `runAgent` | 委托 |
| per-step 压缩集成 | ✅ 契约与透传 | — |
| handoff 收口（`extractFinalOutput`） | ✅ 原语保留 | 消费结果 |
| spawn / run / status / close / 容量 / 队列 | — | ✅ `SessionSubagentHost` |
| 持久化（`subagent_instance` 表 / DB store） | — | ✅ |
| 工具面（`subagent_run/status/close`） | — | ✅ |
| primary `startSession` 迁移 | ⏳ 后续阶段能力 | ⏳ 后续装配 |

---

## 四、文档索引

| 文件 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 现有问题：无 runtime context owner、DB 字段隔离不足、一次性 run 缺实例延续 |
| [02-implementation-plan.md](./02-implementation-plan.md) | 实施方案 + 改动面调查（文件级） |
| [03-kimi-code-references.md](./03-kimi-code-references.md) | kimi-code / codex 的 context owner、context window、压缩契约借鉴 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 测试与验收标准 |
| [05-implementation-gates.md](./05-implementation-gates.md) | 实施前决策固化与检查门禁 |

---

## 五、范围与非范围

**范围**
- 引入 `AgentInstance` 作为 subagent 的运行时 owner。
- 引入有行为的 `AgentContextScope`，收口「身份校验 + context/message 查询边界 + run create 身份参数」。
- 保证 `AgentInstance.turn()` 始终经由 `runAgent → RunManager → RunWorker → Lifecycle.run`。
- 明确 subagent 长任务继承 context improve-2 P0 的 per-step `prepareTurn` 与 overflow 强制压缩。

**非范围（属对侧或后续）**
- `SessionSubagentHost`、`subagent_instance` 持久化、工具命名收敛 → 对侧文档。
- primary `startSession` 切 root `AgentInstance` → 后续阶段，不阻塞本轮 subagent 上线。
- 压缩算法本身的改动（阈值、prune/mask/summary 策略）→ 复用 `core/context` 现状，不在本轮重写。
- `PromptOrigin` 消息来源追踪 → 记为后续可选增强。
