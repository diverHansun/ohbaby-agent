# 长会话流式输出时，消息区停在开头

SixCoder 会话的 Chrome 页面已经收到了后续工具消息，用户却仍看到最初的问题。第一轮已于 2026-11-26 修复两种自动跟随误判，并通过 Chrome 端到端验收。现场记录、实验数据和临时改动的对照都在[问题分析](improve-1/01-problem-analysis-and-current-state.md)。

| 第一轮文档 | 内容 |
| --- | --- |
| [讨论记录](improve-1/00-discussion.md) | 现场诉求与实施边界 |
| [问题分析](improve-1/01-problem-analysis-and-current-state.md) | 会话、服务端记录、两种复现及证据边界 |
| [前端交互与改动范围](improve-1/02-optimization-plan-and-change-scope.md) | 用户何时离开和恢复跟随 |
| [参考实现](improve-1/03-reference-projects.md) | OpenCode 如何识别滚动意图 |
| [验收标准](improve-1/04-test-and-acceptance.md) | 旧版失败条件及修复后的预期 |
| [实施验收](improve-1/05-implementation-acceptance.md) | 代码审查、组件回放和端到端结果 |
