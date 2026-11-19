# 脚本安装（curl 与 PowerShell）

本议题于 2026-11-17 开启，从 [CLI 升级](../2026-11-16-cli-upgrade/README.md) 议题里拆出来。目前只能用 `npm install -g ohbaby-cli` 安装，用户得先自己装好 Node.js 24 或更高版本。本议题提供一条不需要事先装 Node 的安装路径：

- macOS 和 Linux：`curl -fsSL <脚本地址> | sh`
- Windows：`irm <脚本地址> | iex`

本议题还要处理已经用 npm 安装的用户怎么切换过来，以及新增 `ohbaby uninstall` 命令（npm 安装和脚本安装都能卸载）。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-17 | 首轮 | 安装脚本、安装目录布局、`ohbaby update` 对脚本安装的处理、从 npm 安装切换过来、`ohbaby uninstall` | 规划文档已完成；实施前探针 P1–P10 已于 2026-11-18 在 Windows 和树莓派上完成，结论并入 00 的 5.11 节和 02。2026-11-19 用户确认 Windows 只装 `ohbaby.cmd` |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 问题 P1–P4、发布物与安装现状、CLI 程序侧现状、跨模块一致性 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 4 个 Stage、启动脚本内容、安装流程、跨语言契约、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | pi、codex、Step-Code、opencode、claude-code 的做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 单元和集成测试、实施前真机探针、真机验收、发布门 |
| 05 实施与验收 | 本轮实施完成后，由验收模式写入 |

## 相关议题

| 议题 | 关系 |
|---|---|
| [daemon 停止残留与诊断日志](../2026-11-19-daemon-lifecycle-cleanup/README.md) | 前置议题，先实施。修好 daemon 状态目录的残留文件、异常退出记录，以及 `serve-awareness.ts` 的目录（原本在本议题 Stage 1） |
| [CLI 升级](../2026-11-16-cli-upgrade/README.md) | `ohbaby update` 在那边实现。它识别出脚本安装后，按本议题定的方式升级。`ohbaby uninstall` 在本议题，与 update 共用"判断安装方式"的代码 |
| App 端适配（尚未开题） | 那边会做独立可执行文件（Node SEA）。到时安装脚本可以改成下载可执行文件，安装目录布局和升级入口保持不变 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 02 里要写关键改动清单，沿用 CLI 升级议题的约定。
