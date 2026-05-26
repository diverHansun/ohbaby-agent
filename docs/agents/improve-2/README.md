# agents improve-2 文档集

> 状态：**前瞻性草案（forward-looking draft）**。详细设计在 agents improve-1 全部完成验收之后、改造启动前再细化。当前用途是给 codex 在实施 improve-1 时提供方向参照，避免做出会让 improve-2 难以落地的局部决策。

本目录是 `agents/` 模块第二轮架构改造的文档集。本轮主题：**完成 improve-1 留下的统一化承诺，让 primary 与 subagent 在代码层面真正走同一条路径**。

---

## 一、与 improve-1 的关系

[improve-1](../improve-1/README.md) 的核心成果：

- 建立 `core/agents/runner.ts`（`runAgent` 原语）
- 把 **subagent 路径**切到 `core/agents.runAgent`
- `agents/` 收敛为服务/调度层
- 删除 `agents/session-manager.ts`、`agents/message-writer.ts`
- 直接删除旧 `agents/runner.ts`、`agents/executor.ts` API

improve-1 验收明确不在范围内的事项（[improve-1 acceptance.md 第十节](../improve-1/acceptance.md#十不在验收范围内)），全部是 improve-2 的工作：

- **primary 路径**切到 `core/agents.runAgent`（`waitMode: "stream"`）
- primary 启动调用方迁移到 `AgentService.startSession`
- 运行时契约类型整理（例如评估 `SubagentExecuteParams` 是否重命名为 `TaskInvocationParams`）

improve-2 完成后：

- 不再有"primary 走旧路径、subagent 走新路径"的过渡状态。
- `agents/` 继续保持服务/调度层身份，不新增旧式 runner/executor 旁路。
- `agents/types.ts` 只保留描述符与服务层 envelope 契约；纯运行底层契约归 `core/agents/`。

---

## 二、文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | improve-1 留下了哪些问题？为什么必须在 improve-2 收口？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 按什么阶段推进？如何与 lifecycle / context improve-2 协调？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 改完之后用什么标准判定到位？ |

架构决策延续 [improve-1 decisions.md](../improve-1/decisions.md)，本轮不引入新的架构决策。如改造期间发现需要回溯 improve-1 决策，再新建 ADR。

---

## 三、阅读顺序

1. 先回顾 [improve-1 decisions.md](../improve-1/decisions.md) 与 [improve-1 README](../improve-1/README.md) 理解架构方向。
2. 读 `problem-analysis.md` 理解 improve-2 的目标与遗留问题。
3. 读 `implementation-plan.md` 理解分阶段路径。
4. 用 `acceptance.md` 在每个阶段交付时核对验收。

---

## 四、跨模块协同

improve-2 阶段，三个模块的协同关系：

```
agents improve-1 完成验收
        │
        ▼
lifecycle improve-2（RunWorker 切到 runSession）  ────┐
                                                    │
context improve-2（增量摘要等内部优化）            ──┤
                                                    │
                                                    ▼
                              agents improve-2（本轮）
                                primary 路径切到 core/agents.runAgent
                                接入 AgentService.startSession
                                类型命名整理
```

**强依赖**：

- agents improve-2 依赖 lifecycle improve-2 完成的 `Lifecycle.runSession` 在 RunWorker 路径稳定运行（因为 primary 切到 `runAgent` 后会通过 RunManager 间接调用 `runSession`）。
- 若 lifecycle improve-2 未完成，agents improve-2 仍可推进，但 primary 切换的内部链路要小心绕过 `runSession`（不推荐）。

---

## 五、文档约定

- 问题、阶段、验收用简洁 prose 描述，不引入新编号体系。
- 跨文档引用使用相对路径。
- improve-2 期间发现需要回溯 improve-1 决策，记入 [improve-1 decisions.md](../improve-1/decisions.md) 或新建 ADR。

---

## 六、范围声明

**本轮包含**：

- primary 路径切到 `core/agents.runAgent`
- composition.ts / RunWorker 重构为消费 `AgentService.startSession`
- 整理 `agents/types.ts` 中的运行时契约类型（保留描述符与服务层 envelope；纯运行契约移到 `core/agents/`）
- 内部调用方完全迁移到新 import 路径

**本轮不包含**（留 improve-3 / improve-N）：

- Session tree / branch / fork 数据模型
- 多 provider 抽象层
- Agent 权限模型升级
- Builtin agents 功能演进
- Tools / permissions 模型重设计
- 子 agent 调度策略升级

---

## 七、关联文档

**improve-1（上游）**：

- [docs/agents/improve-1/README.md](../improve-1/README.md)
- [docs/agents/improve-1/decisions.md](../improve-1/decisions.md)
- [docs/agents/improve-1/problem-analysis.md](../improve-1/problem-analysis.md)
- [docs/agents/improve-1/implementation-plan.md](../improve-1/implementation-plan.md)
- [docs/agents/improve-1/acceptance.md](../improve-1/acceptance.md)

**lifecycle / context 上下游**：

- [docs/core/lifecycle/improve-1/](../../core/lifecycle/improve-1/)
- [docs/core/context/improve-1/](../../core/context/improve-1/)

**架构基础**：

- [docs/agents/architecture.md](../architecture.md)
- [docs/agents/goals-duty.md](../goals-duty.md)
- [docs/agents/dfd-interface.md](../dfd-interface.md)
