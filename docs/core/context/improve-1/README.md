# context improve-1 文档集

本目录是 `core/context/` 模块第一轮架构优化的完整文档集。文档间各司其职，与 [`docs/core/lifecycle/improve-1/`](../../lifecycle/improve-1/README.md) 协同推进同一轮重构。

---

## 文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | 当前 context 模块存在哪些设计缺陷？借鉴 pi 的设计哲学应当达成什么目标？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 分几个阶段改造，如何与 lifecycle improve-1 协调？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 改完之后用什么标准判断已经达成目标？ |
| [../../improve-1-implementation-plan.md](../../improve-1-implementation-plan.md) | 跨模块执行计划 | context 与 lifecycle improve-1 按什么顺序实施、如何提交和验证？ |

---

## 阅读顺序

1. 先读 `problem-analysis.md`，理解为什么改、借鉴什么、保留什么。
2. 再读 `implementation-plan.md`，理解分阶段路径与依赖关系。
3. 用 `acceptance.md` 在每个阶段交付时核对验收。

---

## 与 lifecycle improve-1 的协同关系

本轮 context 改造与 lifecycle 改造紧密关联，但归属清晰：

| 工作项 | 归属 | 跨文档引用 |
|--------|------|----------|
| `prepareTurn` 公开契约的设计与实现 | **context improve-1** | lifecycle improve-1 引用本目录 |
| `prepareTurn` 内部算法（切点、token、摘要） | **context improve-1** | 仅本目录 |
| `Lifecycle.runSession` 入口的设计与实现 | **lifecycle improve-1** | 本目录引用 lifecycle 目录 |
| 旧 `compact / assemble / prune` 公共方法的稳定保留 | 双方共同保证 | 双方验收都包含 |

简言之：**context 拥有"对外契约 + 内部算法"，lifecycle 拥有"如何按轮消费契约"**。两份文档集都以"prepareTurn"为接合面，双方在该接合面的契约必须一致。

---

## 文档约定

- 问题编号体系：`PC-N`（Problem Context）。和 lifecycle improve-1 的 `PA-C-N` 编号存在重叠的部分，本目录会明确标注对应关系。
- 阶段编号体系：`CP1 / CP2 / CP3`（Context Phase）。和 lifecycle improve-1 的 `P1 / P2 / P3` 独立。
- 验收编号体系：`AC-N`。和 lifecycle 的 `A-N` 独立。
- 所有文档之间通过相对路径互相引用，不重复同一内容。

---

## 范围声明

本轮（improve-1）只覆盖以下内容：

- `prepareTurn` 对外契约
- 智能切点、turn 边界保护、split-turn 处理
- Token 估算引入 provider usage 锚点
- 压缩 prompt 结构升级
- 压缩区间文件操作追踪
- 内部 `assemble` 调用复用、决策路径合并

**不在本轮范围**：

- 增量摘要更新（incremental summary）
- Session tree / branch / fork 模型
- Branch summarization（子分支独立摘要）
- 多 provider 抽象层
- Compaction hooks 接口暴露（仅在需要时再立项）

上述能力在 context improve-2 / improve-N 中按需立项。

---

## 设计哲学借鉴

本轮重构借鉴 pi 项目的 context 设计哲学，但**保留 ohbaby 已有的核心优势**。详见 [problem-analysis.md 第五节](./problem-analysis.md#五pi-的设计哲学借鉴与边界)。

---

## 跨模块协作面

context 模块在本轮改造中需要与以下三个对内模块协作。**所有这些模块在本轮均不暴露新 API**；本轮工作严格遵守模块职责边界。

| 协作模块 | 角色 | 是否修改 API |
|---------|------|------------|
| [`services/llm-model`](../../../../packages/ohbaby-agent/src/services/llm-model/) | 提供文本级 token 估算与模型 budget | 否 |
| [`core/system-prompt`](../../../../packages/ohbaby-agent/src/core/system-prompt/) | 提供已组装的 system prompt 字符串 | 否 |
| [`core/memory`](../../../../packages/ohbaby-agent/src/core/memory/) | 提供合并后的 memory 内容 | 否 |
| [`core/message`](../../../../packages/ohbaby-agent/src/core/message/) | 持久化事实源；Part metadata 扩展 `tokenUsage` 字段 | 仅向后兼容字段新增 |
| [`core/lifecycle`](../../../../packages/ohbaby-agent/src/core/lifecycle/) | 流式完成时写入 `tokenUsage`；P2 起消费 `prepareTurn` | 见 [lifecycle improve-1](../../lifecycle/improve-1/README.md) |

详细边界、归属决策与验收条件分别见：

- [problem-analysis.md 第三节](./problem-analysis.md#三跨模块协作面)
- [implementation-plan.md 1.5](./implementation-plan.md#15-跨模块影响范围硬约束) 与 [第九节附录](./implementation-plan.md#九跨模块接合面附录)
- [acceptance.md AG-8](./acceptance.md#ag-8-跨模块边界核对)
