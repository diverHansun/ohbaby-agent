# ohbaby-web 模块 improve-3（对应中央 improve-2.1）

> 开启日期：2026-09-27。状态：模块拆分、runtime 独立和功能接线已在实施分支落地；实际验收与剩余限制见[中央05](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/05-implementation-acceptance.md)，等待用户审查。规划路径保持不变，本次实施分支为 `codex/improve-2.2`；模块编号独立于中央阶段编号。

本目录说明 Web 具体如何拆分、各模块的职责与状态、接口接线、关键文件去向和测试位置。阶段级 New session 行为、跨包协调、实施顺序与最终验收只定义在[中央 improve-2.1](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/README.md)。

本目录**不是**[中央 improve-3](../../problem-lists/2026-09-19-execution-reliability/improve-3/README.md)的子代理功能设计，也不实现其只读子会话页面或 Steer。

- [01 模块现状与设计差距](01-current-state.md)
- [02 模块职责、接口与关键改动](02-change-spec.md)
- [03 测试归属与中央验收映射](03-test-criteria.md)

本目录不另建00–04全套阶段规划，不重复中央 New session 状态机，不另设验收编号。实际实施验收记录集中在中央的 [05-implementation-acceptance.md](../../problem-lists/2026-09-19-execution-reliability/improve-2.1/05-implementation-acceptance.md)；本目录的规划规格不充当测试通过证据。

上层依据：[Web 架构](../architecture.md)、[UI 组件约定](../ui/components.md)、[当前会话恢复模块](../improve-2/README.md)。实际模块结构、状态归属、接线与测试位置分别同步在 [architecture](../architecture.md)、[data-model](../data-model.md)、[dfd-interface](../dfd-interface.md)、[components](../ui/components.md) 与 [test](../test.md)，保留仍有效的产品语义。
