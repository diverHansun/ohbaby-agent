# Windows / macOS 兼容性改进

当前处于讨论规划阶段，尚未修改生产代码。范围是原生 Windows 与 macOS 上的本地 TUI、remote TUI 和终端启动 Web；未来 App、独立进程服务和通用 OS 抽象层不在本轮。

## 轮次与文档地图

| 轮次 | 开启日期 | 触发原因 | 状态 |
| --- | --- | --- | --- |
| improve-1 | 2026-11-15 | Windows 命令退出后清理误判，连带阻塞文件工具 | 选型已确认（Koffi 进程内 Job），第一批范围已定，未实施 |

| 文档 | 内容 |
| --- | --- |
| [00 · 讨论决定](improve-1/00-discussion.md) | 已确认边界与未决项 |
| [01 · 问题分析](improve-1/01-problem-analysis-and-current-state.md) | 故障链路、现有结构、证据等级 |
| [02 · 方案与改动范围](improve-1/02-optimization-plan-and-change-scope.md) | 最小改动、主要文件、兼容边界 |
| [03 · 参考项目](improve-1/03-reference-projects.md) | codex、ZCode、dsh、Kimi Code 的取舍（OpenCode 见证据附件） |
| [04 · 测试与验收](improve-1/04-test-and-acceptance.md) | 关键场景与实验覆盖限制 |
| 05 · 实施验收（预留） | 实施完成后创建 `05-implementation-acceptance.md`，当前不存在 |

02/04 已按确认的选型与第一批范围更新，可作为后续开发的契约；文档完善不等于批准实施。详细日志与实验保留在 [证据附件](improve-1/evidence-notes.md)，不必从头阅读。
