# TUI 优化总领文档

> 2026-10-03 接续：用户已明确要求提前规划 [improve-3](../improve-3/README.md)。D 现落实为工具内联输出与 Ctrl+O，加入 pi Markdown/文本能力和取消 Ctrl+R 的自动恢复；前两轮仍未验收。下文旧阶段建议按这一接续关系阅读。

2026-10-02 更新。**improve-1 的 00–04 已整理完成，尚未实施；用户本次另行确认提前编写 improve-2。**保留 React/Ink、按需复用 pi-tui 的共同方向不变。

当前增量入口：[improve-3 文档地图](../improve-3/README.md)。improve-2 覆盖 C，improve-3 接续 D 并加入自动恢复；实现须按实际前轮验收基线推进，不假设前轮已经完成。

## 阅读顺序

1. [00-discussion](00-discussion.md)：用户原话、既有共识和本轮新输入。
2. [01-stage-roadmap](01-stage-roadmap.md)：按实际痛点调整的候选批次与首轮建议。
3. [02-frontend-review-notes](02-frontend-review-notes.md)：终端设计边界、六个区域已确认方向与待细化布局。
4. [improve-1/00](../improve-1/00-discussion.md)：首轮规划的已确认输入。
5. [improve-1/01](../improve-1/01-problem-analysis-and-current-state.md)：问题编号、源码和隔离验证证据。

## 当前建议

首轮优先恢复 Ghostty 阅读稳定、补齐内部消息显示规则、修正历史失效逻辑并移除其 TUI 提示，并做直接相关的基础视觉降噪。纯业务大拆分不再作为前置；pi 复用验证按实际问题穿插进行，不能阻塞修复已有缺陷。

| 批次 | 核心职责 |
| --- | --- |
| A | 阅读稳定、无意义刷新、内容来源、历史一致性 |
| B | 用户消息、工具、活动提示与底栏的信息层级 |
| C | 输入、审批、队列编辑、Tasks 的局部交互改善 |
| D | 工具分类预览、真实数据和原位展开 |
| E | 跨场景真机验收与维护收尾 |

批次 A/B 构成 improve-1 的整理范围，具体边界见 [02](../improve-1/02-optimization-plan-and-change-scope.md)，不等于批准产品实施。用户已分别确认提前规划 improve-2（C）和 improve-3（D＋自动恢复）。E 的组合验收分别落入各轮收尾，不据此预建更多轮次。

## 文档状态与下一步

本轮已具备 [02 实施契约](../improve-1/02-optimization-plan-and-change-scope.md)、[03 参考取舍](../improve-1/03-reference-projects.md)、[04 测试验收](../improve-1/04-test-and-acceptance.md)。02 按用户要求列关键文件和符号；Ghostty 验收条件见 04。05 在实施完成后独立验收时创建。

前端文档依次覆盖目标/用户任务、架构、线框、状态、组件、数据与验收。终端使用行列、焦点、原生历史和 ANSI，不能照搬浏览器 CSS 或 DOM 滚动方案。已确认布局与状态/数据约束集中在 improve-1/02 §2.5、§2.10；plan 中的早期提案不能覆盖用户最新确认。
