# 模型偏爱用 bash 查看文件

2026-11-27 立项。ohbaby 的模型查看文件和搜索代码时，常常不用内置的 read/list/glob/grep，而是用 bash 跑 `cat`、`ls`、`grep`、`find`。默认权限下 bash 每次都要用户审批，用起来很麻烦。

调查结论：工具注册和传给模型的链路没有 bug。问题主要出在我们给模型的引导文案不到位，原生工具也有几处能力缺口，模型本身又偏爱 shell。三者叠加，就成了现在的样子。详见 [improve-1 现状分析](improve-1/01-problem-analysis-and-current-state.md)。

## 轮次地图

用户在规划时就决定把议题切成三轮，按顺序实施。三轮的方案都已在 2026-11-27 逐条讨论定稿。

| 轮次 | 主题 | 开启日期 | 状态 |
| --- | --- | --- | --- |
| [improve-1](improve-1/) | 工具描述和系统提示词优化；外加一个小修复：原生工具路径展开 `~`（Stage 0） | 2026-11-27 | 方案已定（2026-11-27） |
| [improve-2](improve-2/) | 内置工具能力升级（grep 为主，glob 默认遵守 ignore） | 2026-11-27 | 方案已定（2026-11-27） |
| [improve-3](improve-3/) | POSIX 狭义明确只读 bash 免审批（复用已合入的 POSIX 解析器路径事实，仅放行常用固定形态与初始工作区根精确 `git status`，其余走原审批）；bash 能力不做 | 2026-11-27 | 方案已定（2026-11-27，最新收紧稿） |

三轮之间的依赖：

- improve-2 给 grep、glob 加了新参数后，要同步更新 improve-1 写好的工具描述。
- improve-3 放开常见只读 bash 后，"bash 要审批"这条理由对放行的命令就不成立了。所以 improve-1 写引导理由时，不能只靠审批成本，要写放开后依然成立的理由。

## 文档地图

每轮各有一套 00–04，实施完成后由验收模式补写 05。

| 文档 | improve-1 | improve-2 | improve-3 |
| --- | --- | --- | --- |
| 00 讨论结论 | [链接](improve-1/00-discussion.md) | [链接](improve-2/00-discussion.md) | [链接](improve-3/00-discussion.md) |
| 01 现状与问题 | [链接](improve-1/01-problem-analysis-and-current-state.md) | [链接](improve-2/01-problem-analysis-and-current-state.md) | [链接](improve-3/01-problem-analysis-and-current-state.md) |
| 02 方案与改动面 | [链接](improve-1/02-optimization-plan-and-change-scope.md)（含关键改动清单） | [链接](improve-2/02-optimization-plan-and-change-scope.md) | [链接](improve-3/02-optimization-plan-and-change-scope.md) |
| 03 参考项目 | [链接](improve-1/03-reference-projects.md) | [链接](improve-2/03-reference-projects.md) | [链接](improve-3/03-reference-projects.md) |
| 04 测试与验收 | [链接](improve-1/04-test-and-acceptance.md) | [链接](improve-2/04-test-and-acceptance.md) | [链接](improve-3/04-test-and-acceptance.md) |
| 05 实施验收 | 实施后写入 | 实施后写入 | 实施后写入 |

[tool-choice-stats.py](tool-choice-stats.py) 是三轮共用的统计脚本。它从本机 `ohbaby.db` 里统计每个模型"原生工具"和"用 bash 做查看"的次数，改动前后各跑一次来对比效果。说明：improve-3 中 [01](improve-3/01-problem-analysis-and-current-state.md) 的历史模拟与历史对比仅作背景观察，不作为最新收紧方案的新预期或验收指标。

## 实施契约

- 实施在新会话里进行，按各轮的 02 改、按 04 验。
- 规划会话不写代码。

## 相关议题

- [一条 bash 命令连续弹出多次审批](../2026-11-23-bash-double-approval/README.md)：improve-3 放开只读 bash 时，要和这里的外部路径审批一起考虑。
- [shell-and-glob improve-2](../2026-10-11-shell-and-glob/improve-2/02-optimization-plan-and-change-scope.md)：当初有意让 glob 不读 ignore 文件，improve-2 要重新讨论这个决定。
