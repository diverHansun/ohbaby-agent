# 4. 测试与验收

## 4.1 测试策略

- **渲染结构**写单测，放在 `apps/ohbaby-web/src/ui/shared/MarkdownBlock.unit.test.tsx`。
- **布局**用 `.claude/launch.json` 里的 `ohbaby-web-mock` 启动，在浏览器里读元素宽度并截图。mock 数据里没有表格时，给 `apps/ohbaby-web/src/dev/mock-scenarios.ts` 加 3 列、8 列和原始 HTML 三张样例表。

## 4.2 单元测试

| 编号 | 场景 | 通过标准 |
|---|---|---|
| U-1 | 3 列表格 | 外层有 `ohb-table-scroll`，没有 `is-wide` 和 `tabindex` |
| U-2 | 4 列表格 | 外层有 `is-wide`、`tabindex="0"`、`role="region"` 和 `aria-label` |
| U-3 | 单元格里有加粗、行内代码、链接 | 都正常渲染。这条防止误用 `defaults.table` 导致抛错 |
| U-4 | `:--`、`--:`、`:-:` 三种对齐 | `align` 属性保留 |
| U-5 | 单元格里有 `<img src=x onerror=...>` | 事件属性被清洗掉 |
| U-6 | 模型直接输出 `<table>` | 没有被包上 `ohb-table-scroll`，内容仍显示 |

## 4.3 布局验收

| 编号 | 场景 | 通过标准 |
|---|---|---|
| T-1 | 3 列表格，720px 消息宽度 | 表格宽度等于消息宽度，没有横向滚动 |
| T-2 | 8 列表格，720px 消息宽度 | 容器内横向滚动，页面本身不滚动 |
| T-3 | 8 列表格的长文单元格和长 URL | 在 320px 处换行，没有一字一行。Chrome 和 Safari 都看 |
| T-4 | 3 列和 8 列表格，375px 手机宽度 | 都不撑破页面，3 列不出现滚动 |
| T-5 | 用户气泡里的 8 列表格 | 气泡不超过最大宽度，表格在气泡内滚动 |
| T-6 | 原始 HTML 长表格 | 不撑破消息，可以横向滚动 |
| T-7 | 左、中、右对齐的列 | 表头和内容都按语法对齐，没写对齐的表头靠左 |
| T-8 | 首列和正文 | 首列文字和段落文字左边对齐 |
| T-9 | Tab 键聚焦宽表，按左右方向键 | 有焦点样式，表格能滚动 |
| T-10 | 文件预览和命令结果弹窗里的表格 | 和聊天显示一致 |

## 4.4 对抗性审查要点

- `.ohb-markdown table` 的 `display: block` 还在吗？它是原始 HTML 表格的唯一防线。
- `.ohb-table-scroll table` 有没有改回 `display: table`，并清掉 `max-width` 和 `margin`？漏了的话窄表铺不满，或者宽表被压回容器宽度。
- 行内代码的 `0.93em` 在 13px 表格里约 12px，看起来是否还清楚。
- `shared/markdown.css` 和文件预览里的 `text-align: left` 都删干净了吗？否则右对齐还是不生效。

## 4.5 完成定义

U 组和 T 组全部通过；Web 的类型检查、lint 和单测通过；设计文档已同步。
