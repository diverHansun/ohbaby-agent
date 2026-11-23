# 3. 参考项目借鉴

> 参考项目都在 `code-cli/` 下，结论来自 2026-11-23 读到的源码。

## 3.1 三个项目的做法

| 项目 | 宽度策略 | 视觉 | 附加功能 | 来源 |
|---|---|---|---|---|
| deepseek-harness（dsh） | 少于 4 列铺满，4 列及以上自然宽度并滚动，可突破消息列 | 细线，无外框，13px，单元格 100 到 320px | 无 | `packages/client/ui-primitives/src/markdown/render.tsx`、`MarkdownText.module.css` |
| opencode | 外层框内滚动 | 圆角外框加底色，13px，等宽数字 | 无 | `packages/session-ui/src/components/markdown.css` |
| ZCode | 组件内滚动 | Streamdown 主题 | 复制、CSV 导出（含公式注入转义和 BOM） | `packages/ui/src/components/ai-elements/markdown-table.tsx`（1455 行） |

## 3.2 借鉴了什么

| 来源 | 做法 | 我们怎么用 |
|---|---|---|
| dsh | 按列数决定宽窄，在渲染器里静态判断 | B3 直接采用 |
| dsh | 单元格 100 到 320px，首末列不留外侧内边距 | 宽表采用，窄表不设最小宽度 |
| dsh | 宽表容器可聚焦 | B8 采用 |
| opencode | `tabular-nums` | 采用 |

## 3.3 没有照搬的地方

| 做法 | 为什么不用 |
|---|---|
| opencode 的圆角外框和底色 | ohbaby 的 Web 风格不用卡片容器 |
| dsh 让宽表突破消息列 | 需要转录区配合容器查询，本轮收益不够 |
| dsh 所有单元格都设最小 100px | ohbaby 手机宽度实测 3 列会溢出，所以只给宽表设 |
| dsh 宽表滚动条悬停才出现 | 为绕开 Chromium 的重绘问题写了不少 CSS，用系统默认滚动条更简单 |
| ZCode 的复制、导出组件 | 1455 行换一个低频功能，不值得 |
| 弹窗查看宽表 | dsh 实现过，评审后否决，见其 `.agents/notes/archived/feature/2026-08-19-web-markdown-wide-table-view.zh.md` |
