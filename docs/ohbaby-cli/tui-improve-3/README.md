# OHBABY CLI TUI Improve 3

本阶段采用方案 B：`committed transcript / live tail` 分层 + 历史用户消息淡色块。

目标不是先追求更复杂的滚动引擎，而是先把 TUI 的消息流边界拆清楚：

- 已提交 transcript 不应被每个 streaming delta 牵着全量重绘。
- 当前 live tail 负责 assistant/text/tool/reasoning 的流式变化。
- PromptDock 固定在底部，继续承担输入、状态栏、context window usage。
- 历史用户 prompt 需要比单竖线更容易定位，但不能抢当前输入框的视觉层级。
- active session 切换时不能显示其他 session 的旧 transcript。

文档结构：

- [01-problem-and-scope.md](./01-problem-and-scope.md)：问题、范围、参考项目结论。
- [02-design.md](./02-design.md)：核心设计、组件边界、数据流、颜色语义。
- [03-tests-and-acceptance.md](./03-tests-and-acceptance.md)：测试矩阵、验收标准、子代理检查点。
- [04-implementation-plan.md](./04-implementation-plan.md)：实施顺序、文件落点、风险处理。
