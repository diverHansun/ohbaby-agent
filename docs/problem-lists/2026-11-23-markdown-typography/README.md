# Markdown 统一排版

本议题于 2026-11-23 开启，解决 ohbaby Web 里 Markdown 字号不整齐的问题：聊天、文件预览、命令结果弹窗共用一套排版，并修好中文加粗。只做 Web，不做 TUI。

## 相关议题

Markdown 渲染优化拆成五个议题，本议题是其他四个的基础：

| 议题 | 内容 |
|---|---|
| 统一排版（本议题） | 字号阶梯、间距、代码、列表、中文加粗 |
| [表格](../2026-11-23-markdown-tables/README.md) | 表格的宽度、滚动和样式 |
| [流式 Markdown](../2026-11-23-markdown-streaming/README.md) | 输出过程中也按 Markdown 显示 |
| [Mermaid 图表](../../ohbaby-web/markdown-mermaid/goals-duty.md) | 把 Mermaid 代码块画成图 |
| [LaTeX 公式](../../ohbaby-web/markdown-math/goals-duty.md) | 把公式排版显示 |

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 一份共用的 Markdown 样式，聊天、文件预览、命令弹窗都用它 | 表格的宽度和滚动规则（归表格议题） |
| 正文回到设计文档规定的 14px，标题用 20/17/15/14 | 输出过程中的显示方式（归流式议题） |
| 行内代码、代码块、列表、引用、分隔线统一 | 换 Markdown 解析器、引入 Streamdown |
| 修复中文加粗（如 `**注意：**内容`） | TUI、会话导出页的样式 |
| 同步 `docs/ohbaby-web/redesign-2026-10/` 里相关的设计文档 | 用户可调字号 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-23 | 首轮 | 共用样式、字号阶梯、中文加粗、设计文档同步 | 已实施，待用户审核 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 现在的样式怎么来的、问题在哪 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 交给实施会话的方案和改动范围 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | opencode、deepseek-harness、ZCode 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 测试场景和验收标准 |
| [05 实施验收](improve-1/05-implementation-acceptance.md) | 实际交付、commit、测试和浏览器验收结果 |

## 实施约定

02 和 04 是交给实施会话的契约：开发者按 02 改代码，按 04 自测。规划会话本身不写代码。
