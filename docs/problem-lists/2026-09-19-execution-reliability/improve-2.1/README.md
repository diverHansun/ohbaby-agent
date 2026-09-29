# improve-2.1：New session 回归与 Web 模块整理

> 开启日期：2026-09-27。状态：本地实施完成，自动化及编译客户端验收已记录；T14 人工仿真限制见 05。用户指定的规划路径保留为 improve-2.1；本次实施分支为 `codex/improve-2.2`，不复制方案。此阶段位于执行可靠性 improve-2 验收之后、中央 improve-3 开发之前。

本轮同时解决 New session 的完整复用链路、Web 功能模块拆分、必要的状态重构及重新接线。触发原因是 improve-2 验收后发现的漏网会话回归，以及实际 Web 代码的职责集中；不是因为预计需要多次实施而分轮。

## 文档职责

- 本目录是阶段级契约：为什么做、跨包如何配合、入口行为、顺序、风险与最终验收。
- [ohbaby-web 模块 improve-3](../../../ohbaby-web/improve-3/README.md)是本轮的 Web 投影：怎么拆、状态归谁、接口如何连接、关键文件去向。
- **Web 模块 improve-3 对应中央 improve-2.1**，不等于[中央 improve-3](../improve-3/README.md)的子代理可见性与交付阶段。
- New session 行为以本目录 02 为权威；Web 结构以模块 02 为权威；验收 ID 只在本目录 04 定义。发现冲突要修正文档，不能自行挑一份实现。

## 阅读顺序

1. [00 讨论与已确认边界](00-discussion.md)
2. [01 现状与问题](01-problem-analysis-and-current-state.md)
3. [02 阶段方案、接线与改动面](02-optimization-plan-and-change-scope.md)
4. [03 本地参考项目](03-reference-projects.md)
5. [04 测试与验收](04-test-and-acceptance.md)
6. [Web 模块拆分规格](../../../ohbaby-web/improve-3/02-change-spec.md)

7. [05 本地实施、验收证据与剩余限制](05-implementation-acceptance.md)

规划文件不作为实施进度表，实际结果以 05 为准。

## 基线与交接

已提交基线为 `3ac9a6b3880e1228b3d80f0ef63b379acf789650`，分支 `codex/improve-2-execution-progress`；[improve-2 验收](../improve-2/05-implementation-acceptance.md)不包含 New session 关闭结论。实施开始时（历史交接状态），工作树另有未提交的 New session、同步提示与相关 adapter/store 修改，详见 01；本轮已审查、保留并分批收纳，结果见 05，没有仅 checkout HEAD 后遗漏这些修复。未合并、未 push 不等于缺少实现，也不等于已进入开发分支。

本目录保留规划契约，实施结果由 05 单独记录。`codex/improve-2.2` 已分批提交，等待用户审查，未合并或 push；原路径仍是引用入口。
