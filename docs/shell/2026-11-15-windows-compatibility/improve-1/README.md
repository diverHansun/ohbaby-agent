# improve-1：简版规划索引

开启日期：2026-11-15。基线：`6215c072b4402869ebfd3df6881e201c31411e52`。状态：第一批已实施，2026-11-16 完成 Windows 核心链路验收；完整双平台发布矩阵仍有缺项，见 05。

- [00 · 讨论决定](00-discussion.md)：哪些已确认，哪些还待选择。
- [01 · 问题分析](01-problem-analysis-and-current-state.md)：为什么 Windows 会连带阻塞文件工具。
- [02 · 方案与改动范围](02-optimization-plan-and-change-scope.md)：改哪里、保留什么、暂不做什么。
- [03 · 项目借鉴](03-reference-projects.md)：四个本地项目的实际做法与取舍。
- [04 · 测试与验收](04-test-and-acceptance.md)：如何证明修复有效。
- [05 · 实施验收](05-implementation-acceptance.md)：Windows 实机结果、本轮补修、审查意见与剩余验证。
- [详细证据](evidence-notes.md)：原日志、数据库观察、代码清单与实验结果；原始 JSON 位于 `evidence/`。

原生组件采用 Koffi 进程内调用，未增加独立服务。规划契约保留在 00–04，实际结果以 05 为准。[返回议题索引](../README.md)。
