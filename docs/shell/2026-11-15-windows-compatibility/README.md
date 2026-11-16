# Windows / macOS 兼容性改进

第一批生产适配已在 `feat/windows-job-cleanup` 实施，Windows 核心执行链已实机验收；完整双平台发布矩阵仍有缺项，见 05。范围是原生 Windows 与 macOS 上的本地 TUI、remote TUI 和终端启动 Web；未来 App、独立进程服务和通用 OS 抽象层不在本轮。

## 轮次与文档地图

| 轮次 | 开启日期 | 触发原因 | 状态 |
| --- | --- | --- | --- |
| improve-1 | 2026-11-15 | Windows 命令退出后清理误判，连带阻塞文件工具 | 已实施并补修，Windows 核心链通过，完整发布矩阵部分通过 |

| 文档 | 内容 |
| --- | --- |
| [00 · 讨论决定](improve-1/00-discussion.md) | 已确认边界与未决项 |
| [01 · 问题分析](improve-1/01-problem-analysis-and-current-state.md) | 故障链路、现有结构、证据等级 |
| [02 · 方案与改动范围](improve-1/02-optimization-plan-and-change-scope.md) | 最小改动、主要文件、兼容边界 |
| [03 · 参考项目](improve-1/03-reference-projects.md) | codex、ZCode、dsh、Kimi Code 的取舍（OpenCode 见证据附件） |
| [04 · 测试与验收](improve-1/04-test-and-acceptance.md) | 关键场景与实验覆盖限制 |
| [05 · 实施验收](improve-1/05-implementation-acceptance.md) | Windows 实机结果、补修、Pi 审查取舍与未覆盖项 |

02/04 保留规划契约及当时证据，实施后的当前结论以 05 为准。详细日志与早期实验保留在 [证据附件](improve-1/evidence-notes.md)，不必从头阅读。
