# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。
>
> 前置：[统一排版](../../2026-11-23-markdown-typography/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 1 已完成，`shared/markdown.css` 已存在。

## 2.1 方案总览

渲染时给每张表包一层滚动容器，由容器负责滚动，`<table>` 只负责表格布局。列数从 `marked` 的 token 里直接读，4 列及以上加 `is-wide`。

```
3 列及以下                         4 列及以上
┌──────────────────────────┐      ┌──────────────────────────┐
│ 方案      体积      说明   │      │ 项目  语言  解析器  表格策…│→ 滚动
│ ──────────────────────── │      │ ──────────────────────── │
│ Pele    2.25 MB   按需   │      │ dsh   TS    micromark ... │
└──────────────────────────┘      └──────────────────────────┘
  width: 100%                       width: max-content
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| B1 滚动放哪 | 外层 `<div class="ohb-table-scroll">` | 表格才能保持表格布局并铺满 | 继续让 `<table>` 自己 `display: block`：无法铺满 | HTML 多一层 |
| B2 怎么调默认渲染 | `Renderer.prototype.table.call(this, token)` | 单元格解析需要运行中的 parser（见 01 §1.5） | `defaults.table(token)`：实测抛错 | 写法和代码块不同，要留一行注释 |
| B3 宽窄判断 | `token.header.length >= 4` | 解析时就知道，不用测量 DOM，不会闪动 | `ResizeObserver` 按实际溢出判断：多状态、多闪动。CSS `:has()` 数列：渲染器本来就有列数 | 3 列长文表也只能换行 |
| B4 窄表 | `width: 100%`，单元格不设最小宽度 | 手机上 3 列加内边距放不下 3 × 100px，设了反而出现滚动 | 全部单元格最小 100px：343px 宽时会溢出 | 手机上"2.25 MB"这类短内容可能折行 |
| B5 宽表 | `width: max-content`，单元格 `min-width: 100px`、`max-width: 320px`、`overflow-wrap: break-word` | 长文在 320px 处换行，不会把表拉到无限宽；`break-word` 不影响最小宽度计算，列不会被挤成一字一行 | `overflow-wrap: anywhere`：列会被压到一个字宽 | 宽表总要滚动 |
| B6 原始 HTML 表格 | 保留 `.ohb-markdown table` 的 `display: block`、`max-width: 100%` 和下边距；`.ohb-table-scroll table` 改回 `display: table; max-width: none; margin: 0` | 模型直接输出的 `<table>` 不走渲染器，仍不能撑破消息；走渲染器的表格由容器负责滚动和间距 | 删除兜底：这类表格会溢出 | 多一组覆盖规则 |
| B7 对齐 | 删除写死的 `text-align: left`，只给 `th:not([align])` 设 `text-align: start` | `align` 属性才能生效；没写对齐的表头不会被浏览器默认居中 | 把 `align` 转成 class：多一层转换 | 无 |
| B8 键盘 | 宽表容器加 `tabindex="0"`、`role="region"`、`aria-label="Scrollable table"` | 键盘和读屏用户能进入并滚动 | 所有表都加：窄表多一个没用的 Tab 停留点 | 窄表极端溢出时依赖浏览器默认行为 |
| B9 列宽突破消息区 | 不做 | dsh 需要转录区容器查询配合，ohbaby 当前没有这个结构 | 让宽表跨出消息列 | 宽表在消息列内滚动 |

## 2.3 样式数值

| 元素 | 规则 |
|---|---|
| 表格 | `border-collapse: collapse`，字号 `calc(1em - 1px)`（14px 基准下 13px），`font-variant-numeric: tabular-nums` |
| 滚动容器 | `margin: 0 0 12px`，`max-width: 100%`，`overflow-x: auto`，`overscroll-behavior-x: none` |
| 容器里的表格 | `display: table`，`max-width: none`，`margin: 0`；窄表 `width: 100%`，宽表 `width: max-content` |
| 宽表单元格 | `min-width: 100px`，`max-width: 320px`，`overflow-wrap: break-word` |
| 单元格 | 内边距 `8px 12px`，首列 `padding-left: 0`，末列 `padding-right: 0` |
| 表头 | 字重 600，下边线 1px `--border-strong` |
| 表体 | 行间 1px `--border`，最后一行无下边线 |
| 背景、外框、斑马纹 | 都没有 |

## 2.4 分阶段实施

### Stage 1：渲染器与样式

- 目标：所有 Markdown 表格按 2.2 显示。
- 改动：
  - `shared/MarkdownBlock.tsx`：`Marked` 实例加 `table` 渲染器。
  - `shared/markdown.css`：写入 2.3 的规则，包括窄表、宽表和原始 HTML 兜底；删除统一排版搬来的 `th`、`td` 上的 `text-align: left`。
  - `side-panel/files/files-page.css`：确认统一排版议题已删除表格规则，这里也没有 `text-align: left`。
  - `shared/MarkdownBlock.unit.test.tsx`：按 04 补用例。
- 渲染器原型（已在 `marked` 15.0.12 和 `DOMPurify` 上跑通）：

```ts
table(token): string {
  const wide = token.header.length >= 4;
  const attrs = wide
    ? ' class="ohb-table-scroll is-wide" tabindex="0" role="region" aria-label="Scrollable table"'
    : ' class="ohb-table-scroll"';
  // The cells need this render's parser, which `defaults` does not have.
  return `<div${attrs}>${Renderer.prototype.table.call(this, token)}</div>`;
},
```

- 完成定义：04 的 T 组和 U 组通过。

### Stage 2：同步设计文档

- `docs/ohbaby-web/redesign-2026-10/05-components.md`：在 `MarkdownBlock` 的说明里补表格的外层容器和宽窄规则。
- 完成定义：文档和代码一致。

## 2.5 兼容与迁移

没有数据和接口变化。HTML 结构多一层 `.ohb-table-scroll`，代码里没有依赖表格结构的选择器。

## 2.6 风险与回滚

| 风险 | 应对 |
|---|---|
| 模型输出的 HTML 伪造 `ohb-table-scroll` 这个 class | 只影响样式，不带行为，没有安全问题 |
| 宽表滚动在触屏上不明显 | 单元格被裁切本身就是提示，本轮不加额外指示器 |
| Safari 对单元格 `max-width` 的表现 | 原型只在 Chrome 上验证过，实施时按 04 的 T-3 在 Safari 上再看一次 |

改动集中在一个渲染器和一段 CSS，可以单独回退。

## 2.7 与其他议题的关系

流式议题完成后，正在输出的表格也走这个渲染器。未闭合的表格行怎么显示，由流式议题决定。

## 2.8 留到以后

复制表格和导出 CSV 暂不做。如果用户确实经常要把表格拿去别处用，再单独开议题，导出时要注意 CSV 公式注入（ZCode 已有处理可参考）。
