# ohbaby-web 模块 improve-3（对应中央 improve-2.1）

> 开启日期：2026-09-27。状态：规划已获实施授权，实施与验收尚待完成。规划路径保持不变，本次实施分支为 `codex/improve-2.2`；模块编号独立于中央阶段编号。

本目录说明 Web 具体如何拆分、各模块的职责与状态、接口接线、关键文件去向和测试位置。阶段级 New session 行为、跨包协调、实施顺序与最终验收只定义在[中央 improve-2.1](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/README.md)。

本目录**不是**[中央 improve-3](../../problem-lists/2026-09-19-execution-reliability/improve-3/README.md)的子代理功能设计，也不实现其只读子会话页面或 Steer。

- [01 模块现状与设计差距](01-current-state.md)
- [02 模块职责、接口与关键改动](02-change-spec.md)
- [03 测试归属与中央验收映射](03-test-criteria.md)

本目录不另建00–04全套阶段规划，不重复中央 New session 状态机，不另设验收编号。实际实施验收记录集中在中央未来的05；不能把当前规格当作已经实现。

上层依据：[Web 架构](../architecture.md)、[UI 组件约定](../ui/components.md)、[当前会话恢复模块](../improve-2/README.md)。本轮实施时更新前两者对应的实际结构，保留仍有效的产品语义。
