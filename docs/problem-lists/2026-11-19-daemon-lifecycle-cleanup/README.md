# daemon 停止残留与诊断日志

本议题于 2026-11-19 开启。用户本机 `~/.ohbaby/server/` 下堆了 72 个文件：除了正常的 `daemon-state.json`，还有 68 个 `daemon-state.json.shutdown-<token>.json` 和 3 个 `daemon-state.json.<pid>.tmp`。daemon 每停一次就多一个文件，没有任何代码删除它们。同时，serve 日志里有 2 次 daemon 没有正常退出，却没有留下任何记录。

[CLI 升级](../2026-11-16-cli-upgrade/README.md)和[脚本安装](../2026-11-17-script-install/README.md)两个议题都依赖 daemon 的状态文件和停止流程：`ohbaby update` 要读状态、停 daemon、看清理结果，安装脚本要读状态判断 daemon 是否还在跑。所以本议题是这两个议题的前置，要先于它们实施。

## 范围

- **在本议题内**：shutdown 报告不再越积越多；状态文件的临时文件不再残留；清理已有的残留；daemon 上次没有正常退出时，在日志里留下记录；`serve-awareness.ts` 读状态文件的路径跟随 `OHBABY_HOME`。
- **不在本议题内**：TUI 退出日志；`ohbaby doctor` 之类的诊断报告命令；升级、安装、卸载本身。

逐项范围以 [00 讨论](improve-1/00-discussion.md) 为准。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-19 | 首轮 | 见上 | 实施与发布验收通过 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界，A–D 四项逐项结论 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 问题 P1–P4、现场数据、状态目录和停止流程现状、跨模块一致性 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 3 个 Stage、设计决策、新旧版本兼容、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | codex 的 daemon 停止标记与诊断事件 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 单元和集成测试、真机验收、发布门 |
| [05 实施与验收](improve-1/05-implementation-acceptance.md) | 实施结果、自动化测试、终端走查和审查记录 |

## 相关议题

| 议题 | 关系 |
|---|---|
| [CLI 升级](../2026-11-16-cli-upgrade/README.md) | 后续议题。`ohbaby update` 的升级前检查要读 `daemon-state.json`，并调用 `stopDaemonFromState` 停 daemon |
| [脚本安装](../2026-11-17-script-install/README.md) | 后续议题。安装脚本读 `daemon-state.json`；`ohbaby uninstall` 要清楚 `server/` 下有哪些文件 |
| [执行可靠性 improve-4](../2026-09-19-execution-reliability/improve-4/02-optimization-plan-and-change-scope.md) | shutdown 报告是那一轮 §2.5 引入的。本议题保留它的规则：客户端只采用与目标 token 匹配的报告 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 用户要求在 02 里写关键改动清单（2026-11-19 确认）。
