# CLI 升级

本议题于 2026-11-16 开启。项目马上要做 App 端适配，做完才轮到内置浏览器。在这之前，先给 npm 版 CLI 补上升级机制：用户可以用一条命令手动升级，也可以打开自动升级。

npm 版 CLI 负责 TUI 和 Web，升级入口只有 CLI 命令 `ohbaby update`（2026-11-17 由 `upgrade` 改名），TUI 和 Web 里都不提供升级按钮。App 是单独的安装包，它的更新放到 App 适配议题里做。

不用 npm 的安装方式（curl 和 PowerShell 脚本）放在独立议题[脚本安装](../2026-11-17-script-install/README.md)。`ohbaby update` 要认得两种安装方式，两个议题互相链接。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-16 | 首轮 | npm 版 CLI 的手动升级、新版本提示、自动升级开关，以及升级带出来的数据库版本保护、daemon 重启和 Web 刷新 | 规划文档已完成，02 中标 ★ 的 6 项细节和 D2 已于 2026-11-19 逐项确认；Windows 实施前探针 P1、P2 已于 2026-11-18 完成，方案不变；2026-11-19 审查后补了代码锚点，并确认 daemon 议题为前置 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 问题 P1–P6、七个维度的现状、数据库保护现状、跨模块一致性 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 6 个 Stage、设计决策（★ 项已确认）、接口与兼容、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | claude-code、codex、opencode、kimi-code、pi、Step-Code 的升级做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 单元和集成测试、Windows 实施前探针、真机验收、发布门 |
| 05 实施与验收 | 本轮实施完成后，由验收模式写入 |

原计划把升级模块的设计文档单独放在 `docs/cli/upgrade/`，目前没有建。升级功能代码量不大，2026-11-19 确认不单独建，改为实施后更新 [docs/cli/](../../cli/) 的现有设计文档（02 的 D2）。

## 相关议题

| 议题 | 关系 |
|---|---|
| [daemon 停止残留与诊断日志](../2026-11-19-daemon-lifecycle-cleanup/README.md) | 前置议题，先实施。`ohbaby update` 的升级前检查要读 `daemon-state.json` 并调用 `stopDaemonFromState`，那边修好状态目录的残留文件和异常退出记录，并让新 CLI 停旧版 daemon 时能拿到清理结果 |
| [脚本安装](../2026-11-17-script-install/README.md) | `ohbaby update` 识别出脚本安装后，按那边定的方式升级 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 用户要求在 02 里写关键改动清单（2026-11-16 确认）。
