# lifecycle improve-1 文档集

本目录是 `lifecycle` 模块第一轮架构优化的完整文档集。三份文档各司其职，构成"为什么改 — 怎么改 — 怎么算改完了"的闭环。

---

## 文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | 当前架构存在哪些违反软件工程原理的问题？为什么必须改？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 按什么顺序、改哪些文件、如何保证向后兼容？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 改完之后用什么标准判断已经达成目标？ |
| [../../improve-1-implementation-plan.md](../../improve-1-implementation-plan.md) | 跨模块执行计划 | context 与 lifecycle improve-1 按什么顺序实施、如何提交和验证？ |

---

## 阅读顺序

1. 先读 `problem-analysis.md`，理解为什么需要这次重构。
2. 再读 `implementation-plan.md`，理解分阶段的落地路径。
3. 最后用 `acceptance.md` 在每个阶段交付时核对验收。

---

## 文档约定

- 三份文档之间通过相对路径互相引用，不重复写同一件事。
- 问题分析只讲"问题与目标"，不讲"具体改什么文件"。
- 实施计划只讲"怎么做"，问题动机引用问题分析的编号（如 `PA-L1`）。
- 验收文档只讲"达成判定标准"，不重复实施步骤。
- 所有问题、阶段、验收项都有稳定编号，便于跨文档引用与跟踪。

---

## 范围声明

本轮（improve-1）只涉及 `core/lifecycle/` 和 `core/context/` 两个模块之间的协作关系归位。不包含：

- 多 provider（Anthropic/Google）抽象层
- Session tree / branch / fork 模型
- 增量摘要更新算法
- 子 agent 调度

上述能力在后续 improve-N 中单独立项。
