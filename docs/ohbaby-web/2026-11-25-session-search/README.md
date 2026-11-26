# 会话搜索卡片与正文定位

2026-11-25。点击侧栏 Search 打开搜索卡片。输入关键词查会话标题和对话正文，点击正文结果可以在主聊天中读到那条原话。

| 第一轮文档 | 用途 |
|---|---|
| [讨论记录](improve-1/00-discussion.md) | 用户决定、分工和验证过的例子 |
| [现状与问题](improve-1/01-problem-analysis-and-current-state.md) | 哪些能力已经具备，哪些地方要改 |
| [技术方案](improve-1/02-optimization-plan-and-change-scope.md) | 查询、历史读取和前后端交互约定 |
| [验收标准](improve-1/04-test-and-acceptance.md) | 按真实输入、接口调用和页面操作验收 |

Pi 与 OpenCode 的本地实现对照已收在讨论记录。原侧栏内展开输入框的设计见[此前的 Web 改版方案](../redesign-2026-10/improve-3/02-plan-and-change-scope.md)。本轮以居中弹窗取代该交互。后端由用户实现，前端由 Claude 实现，分工见技术方案第 4 节。
