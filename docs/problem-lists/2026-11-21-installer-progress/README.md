# 安装器进度显示

本议题于 2026-11-21 开启。v0.1.19 加入了 macOS、Linux 的 `curl | sh` 安装和 Windows 的 `irm | iex` 安装，但安装过程几乎没有输出：下载 Node.js 时没有进度条，`npm install` 前后没有任何提示，终端会停几十秒。本议题给安装脚本加上分阶段提示和下载进度条，并统一安装完成后的摘要。

脚本安装的方案本身见 [脚本安装](../2026-11-17-script-install/README.md) 议题。本议题只改"用户在终端里看到什么"，不改安装目录布局、锁和版本切换逻辑。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-21 | 首轮 | `install.sh`、`install.ps1` 的阶段提示、下载进度条和完成摘要；`ohbaby uninstall` 的过程提示 | 已实施，本机离线验收完成，三平台发布验收待补齐 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 问题 P1–P5、两份安装脚本和 update、uninstall 的输出现状、npm 的显示行为、测试缺口 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 3 个 Stage（`install.sh`、`install.ps1`、`ohbaby uninstall`）、设计决策、改动面、风险与回滚。不写关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | opencode、codex、Step-Code 的安装脚本，以及 npm、PowerShell 源码的取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 四层测试、关键用例、Windows 和 macOS/Linux 真机清单、发布门 |
| [05 实施与验收](improve-1/05-implementation-and-acceptance.md) | 本机验收证据、发现的问题和待完成的发布验证 |

## 相关议题

| 议题 | 关系 |
|---|---|
| [脚本安装](../2026-11-17-script-install/README.md) | 前置议题。本议题在它实现的两份安装脚本上改输出 |
| [CLI 升级](../2026-11-16-cli-upgrade/README.md) | `ohbaby update` 走脚本安装时，会下载目标版本的安装脚本并继承终端运行，所以本议题的改动会自动出现在 update 里 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 02 不写关键改动清单（2026-11-21 用户确认）。
