# Markdown 表格

本议题于 2026-11-23 开启，让 ohbaby Web 里的 Markdown 表格好读：列少时铺满正文宽度，列多时横向滚动，线条轻，数字能对齐。只做 Web，不做 TUI。

## 相关议题

| 议题 | 内容 |
|---|---|
| [统一排版](../2026-11-23-markdown-typography/README.md) | 字号阶梯、间距、代码、列表、中文加粗。**本议题依赖它建立的 `shared/markdown.css`** |
| 表格（本议题） | 表格的宽度、滚动和样式 |
| [流式 Markdown](../2026-11-23-markdown-streaming/README.md) | 输出过程中也按 Markdown 显示 |
| [Mermaid 图表](../../ohbaby-web/markdown-mermaid/goals-duty.md) | 把 Mermaid 代码块画成图 |
| [LaTeX 公式](../../ohbaby-web/markdown-math/goals-duty.md) | 把公式排版显示 |

## 范围

| 本轮做 | 本轮不做 |
|---|---|
| 3 列及以下铺满，4 列及以上自然宽度加横向滚动 | 复制表格、导出 CSV、全屏、排序 |
| 13px、等宽数字、细横线，不加外框和底色 | 表格突破消息列宽 |
| 支持 Markdown 的左、中、右对齐语法 | 表格的流式显示（归流式议题） |
| 宽表可以用键盘聚焦和滚动 | TUI 表格 |

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-23 | 首轮 | 表格渲染器、表格样式、设计文档同步 | 规划中 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | 已确认的决定和边界 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 现在的表格怎么显示、问题在哪 |
| [02 优化方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 交给实施会话的方案和改动范围 |
| [03 参考项目借鉴](improve-1/03-reference-projects.md) | deepseek-harness、opencode、ZCode 的做法 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 测试场景和验收标准 |
| 05 实施验收 | 本轮实施完成后，由验收模式写入 `05-implementation-acceptance.md` |

## 实施约定

02 和 04 是交给实施会话的契约：开发者按 02 改代码，按 04 自测。规划会话本身不写代码。
