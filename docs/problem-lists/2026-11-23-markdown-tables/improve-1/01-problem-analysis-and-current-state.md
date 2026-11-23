# 1. 现状与问题分析

> 路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。行号是 2026-11-23 的快照。

## 1.1 现状

表格由 `marked` 的默认渲染器输出，没有外层容器。样式分在两处：

| 位置 | 规则 | 效果 |
|---|---|---|
| `conversation/messages.css:140-155` | `.ohb-markdown table` 设 `display: block`、`max-width: 100%`、`overflow-x: auto` | 防止表格撑破消息，但表格不再按表格布局 |
| `side-panel/files/files-page.css:313-328` | `.ohb-file-markdown` 下的表格字号、横线和内边距 | 只有文件预览能用 |

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 高 | 聊天里的表格基本没有样式 | 实测单元格字号 15px，内边距 1px，没有边框 |
| P2 | 高 | 表格不能铺满正文 | `display: block` 让 `<table>` 变成滚动盒子，列少时缩在左边 |
| P3 | 中 | 列多时没有规则 | 没有单元格宽度上下限，一格长文能把整张表拉得很宽 |
| P4 | 中 | 对齐语法不生效 | `marked` 输出 `align="right"`，但文件预览的 `text-align: left`（`files-page.css:323`）优先级更高，把它盖掉了 |
| P5 | 低 | 数字不对齐 | 没有 `font-variant-numeric: tabular-nums` |
| P6 | 低 | 键盘不一定能滚动宽表 | 容器没有 `tabindex`，只有部分浏览器会自动让滚动区域可聚焦 |

## 1.3 根因

`<table>` 同时承担了"表格布局"和"滚动容器"两个职责，而 CSS 里这两件事互相冲突：要滚动就得 `display: block`，一旦 `display: block` 就没法 `width: 100%` 铺满。把滚动交给外层容器，这个矛盾就没了。

## 1.4 分维度诊断

| 维度 | 现状 | 差距 |
|---|---|---|
| 职责 | 表格的样式挂在场景上 | 应归 `shared/markdown.css` |
| 结构 | 渲染器只定制了代码块 | 表格也需要一个外层容器 |
| 数据流 | `marked` 的表格 token 自带列数 | 不用测量 DOM，渲染时就能决定宽窄 |
| 安全 | 输出经过 `DOMPurify` | 新容器的 `class`、`tabindex`、`role`、`aria-label` 实测都能保留 |
| 无障碍 | 宽表滚动没有键盘入口 | 宽表容器要能聚焦 |

## 1.5 改动时要注意的现有行为

1. **不能用 `defaults.table(token)`。** 现有代码块写法是 `defaults.code(token)`，但表格单元格要解析行内语法，需要 `this.parser`。实测模块级的 `new Renderer()` 没有 parser，会抛 `Cannot read properties of undefined (reading 'parseInline')`。必须写成 `Renderer.prototype.table.call(this, token)`。
2. **模型可能直接输出 HTML 表格。** `MarkdownBlock` 的注释说明原始 HTML 可以通过清洗，这种表格不经过表格渲染器，没有外层容器。`.ohb-markdown table` 的 `display: block` 兜底必须留着，否则它会撑破消息。
3. **用户气泡是 `width: fit-content`。** 宽表必须在气泡内滚动，不能把气泡撑开。原型实测气泡停在 76% 宽度，表格在里面滚动。
