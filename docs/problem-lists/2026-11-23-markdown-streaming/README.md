# 流式 Markdown

本议题于 2026-11-23 开启，让 ohbaby Web 在模型输出过程中就按 Markdown 显示，去掉"先显示等宽纯文本、结束后突然变样"的跳动。只做 Web，不做 TUI。

## 相关议题

| 议题 | 内容 |
|---|---|
| [统一排版](../2026-11-23-markdown-typography/README.md) | 字号阶梯、间距、代码、列表、中文加粗。**本议题依赖它** |
| [表格](../2026-11-23-markdown-tables/README.md) | 表格的宽度、滚动和样式。**建议先于本议题完成** |
| 流式 Markdown（本议题） | 输出过程中也按 Markdown 显示 |
| [Mermaid 图表](../../ohbaby-web/markdown-mermaid/goals-duty.md) | 把 Mermaid 代码块画成图，依赖本议题的 Stage 1 和 Stage 4 |
| [LaTeX 公式](../../ohbaby-web/markdown-math/goals-duty.md) | 把公式排版显示，依赖本议题的增量渲染和 Stage 4 |

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 助手文字在输出过程中按 Markdown 显示 | 换解析器、写自己的 Markdown 解析器 |
| 写完的内容块不再重算，只重算结尾两块 | Worker、按帧合并更新 |
| 未闭合的代码块照常显示成代码块 | 逐字淡入等动画 |
| 临时补全结尾半截的 `**` 和行内代码反引号 | 补全半截的链接、图片、斜体和表格 |
| 输出结束后用全文再渲染一次 | 思考内容（reasoning）和工具输出的显示方式 |
| 长回答里的阅读位置按内容块保持 | 重写滚动系统 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-23 | 首轮 | 增量渲染、半截标记补全、消息接入、块级阅读位置 | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 现在流式文字怎么显示、问题在哪 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 交给实施会话的方案和改动范围 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | deepseek-harness、opencode、ZCode 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 测试场景和验收标准 |
| 05 实施验收 | 本轮实施完成后，由验收模式写入 `05-implementation-acceptance.md` |

## 实施约定

02 和 04 是交给实施会话的契约：开发者按 02 改代码，按 04 自测。规划会话本身不写代码。
