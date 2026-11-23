# 5. 实施与验收记录

> 状态：2026-11-23 已实施并完成浏览器验收。所有 commit 都在本地分支 `feat/web-markdown`，没有 push，也没有合进 `main`。

## 5.1 实际交付

按 02 的方案做完，没有改范围：

1. 渲染器给 Markdown 表格外面包一层 `div.ohb-table-scroll`。少于 4 列的表格铺满消息宽度；4 列及以上加 `is-wide`、`tabindex="0"`、`role="region"` 和 `aria-label="Scrollable table"`，按内容撑开，在自己的框里横向滚动。
2. 单元格设了最小宽度，长文字和长 URL 会换行，不会一字一行。
3. 模型直接写的 `<table>` 不包外层，靠 CSS 让它显示成块级元素，可以横向滚动。
4. 单元格内容走 `marked` 自己的行内解析，没有用 `defaults.table`，加粗、行内代码和链接都正常。

## 5.2 Commit

| Commit | 内容 |
|---|---|
| `07c59c60` | `feat(web): give Markdown tables a scroll wrapper` |

## 5.3 自动化验证

U-1 到 U-6 都写成了单测，放在 `MarkdownBlock.unit.test.tsx`，全部通过。全部分支完成后，Web 单测 100 个文件、1,280 个用例通过，类型检查和 lint 也通过。

## 5.4 浏览器验收

在 `ohbaby-web-mock` 的 `?mock=markdown` 里用 Chrome 测。

| 编号 | 结果 |
|---|---|
| T-1 | 3 列表格宽 707px，等于消息宽度，没有滚动 |
| T-2 | 8 列表格内容宽 1,194px，在 707px 的框里滚动，页面本身不滚动 |
| T-3 | 长文单元格 272px、长 URL 单元格 320px，正常换行，没有一字一行 |
| T-4 | 375px 手机宽度下消息宽 327px：3 列表格不滚动，8 列表格在框内滚动，页面不撑破 |
| T-5 | 用户气泡里的 8 列表格：气泡 572px，没超过 76% 的最大宽度，表格在 540px 的框里滚动，页面不撑破 |
| T-6 | 原始 HTML 表格显示成块级元素，宽度不超过消息 |
| T-7 | 三列分别是左、右、居中对齐，没写对齐的表头靠左 |
| T-8 | 首列文字和段落文字左边对齐，都在 293px 的位置 |
| T-9 | 按 Tab 能聚焦宽表格，`:focus-visible` 下有 2px 焦点框；按 5 次右方向键，表格滚动 200px，页面不动 |
| T-10 | 文件预览里的表格和聊天里一样；命令弹窗用的是同一个 `MarkdownBlock` 和同一份 CSS |

## 5.5 没有验证的部分

- T-3 要求 Chrome 和 Safari 都看，这次只看了 Chrome。
- Firefox 和 Edge 也没测。
