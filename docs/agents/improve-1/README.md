# agents improve-1 文档集

本目录是 `agents/` 模块第一轮架构整理的完整文档集。本轮目标：

1. **承认产品事实**：primary agent 与 subagent 共享同一套底层运行机制，差异仅在 envelope（结果交付方式）。
2. **新建 `core/agents/`** 作为 agent 运行底层（与 `core/lifecycle / core/context / core/message` 同级）。
3. **`agents/` 收敛为服务/调度层**（与 `services/` 风格对齐）：保留描述符 + AgentManager；新增 AgentService；`tasks/` 改为消费 `core/agents`。
4. **`runtime/`** 严格保持基础设施身份，不接受任何 agent-specific 子模块。

---

## 文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [decisions.md](./decisions.md) | 架构决策记录（ADR） | 为什么选 `core/agents/` 而不是 `runtime/subagent-*` 或顶层 `subagents/`？三个方案各自的依据是什么？ |
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | 当前 `agents/` 有哪些越界问题？借鉴什么、保留什么？目标是什么？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 按什么阶段拆分？如何与 lifecycle / context improve-1 协调？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 拆完之后用什么标准判定到位？ |

---

## 阅读顺序

1. 先读 `decisions.md` 理解架构决策与其背后的三方案对比。
2. 再读 `problem-analysis.md` 理解当前的越界与目标。
3. 然后读 `implementation-plan.md` 理解分阶段路径。
4. 最后用 `acceptance.md` 在每个阶段交付时核对验收。

---

## 与 lifecycle improve-1 / context improve-1 的关系

本轮工作是 lifecycle improve-1 的**下游收益**。`agents/` 模块当前的体积膨胀，是 `Lifecycle` 与 `RunManager` 现行 API 形态促成的副产品。

**时序前置条件**：

```
lifecycle improve-1 P1+P2  →  context improve-1 CP1  →  agents improve-1（本轮）
        （完成并验收）              （完成并验收）            （开始实施）
```

各轮 docset 协同关系：

| docset | 拥有 | 与本轮关系 |
|--------|------|----------|
| [lifecycle improve-1](../../core/lifecycle/improve-1/README.md) | `Lifecycle.runSession`，事实源归位 | `core/agents.runAgent` 内部消费 `Lifecycle.runSession`；GP5 删除 `message-writer.ts` 依赖 lifecycle P2 |
| [context improve-1](../../core/context/improve-1/README.md) | `ContextManager.prepareTurn` 契约 | `Lifecycle.runSession` 已消费它，本轮无须直接交互 |
| **agents improve-1（本轮）** | `core/agents/` 建立、`agents/` 收敛 | 本轮所有阶段 |

**部分阶段不强依赖前两轮**：`services/session.ensureRoot`（GP1）与 `core/agents/` 基础建立（GP2）可独立完成；但按工作流统一在前两轮验收后启动。

---

## 文档约定

- 问题编号：`PG-N`（Problem aGents）
- 阶段编号：`GP1 / GP2 / GP3 / GP4 / GP5`（aGents Phase）
- 验收编号：`AC-N`（Acceptance），仅本目录内有效
- 跨文档引用使用相对路径

---

## 范围声明

本轮 improve-1 覆盖：

- 建立 `core/agents/`（最小可用形态：`runAgent` + `extractFinalOutput`）
- `agents/` 收敛为服务/调度层（types / registry / manager / service / tasks / builtin / index）
- `services/session` 补 `ensureRoot`
- 删除 `agents/session-manager.ts` 与 `agents/message-writer.ts`
- **subagent 路径**切换到 `core/agents.runAgent`

**不在本轮范围**（留 improve-2 / improve-N）：

- **primary agent 路径**切换到 `core/agents.runAgent`（composition / RunWorker 改造）
- Task 工具 envelope 类型命名整理（如是否把 `SubagentExecuteParams` 改为 `TaskInvocationParams`）
- 多 provider 抽象
- AgentManager / AgentRegistry / builtin 功能演进
- 新增 agent 类型或权限模型升级

---

## 设计原则

本轮严格遵循三条核心原则：

1. **单一职责（SRP）**：`core/agents/` 只回答"怎么跑一个 agent"，`agents/` 只回答"有哪些 agent、谁来跑、什么时候跑"，`runtime/` 只回答"run 基础设施"。
2. **DRY（机制层面）**：primary 与 subagent 共享 `core/agents.runAgent`，不再有两套并行实现。
3. **稳定依赖原则（SDP）**：依赖方向从外向内单调收敛 —— `agents/` → `core/agents/` → `core/lifecycle / context / message / tool-scheduler / system-prompt`。

详细推导见 [decisions.md 第四节](./decisions.md#四决议依据)。
