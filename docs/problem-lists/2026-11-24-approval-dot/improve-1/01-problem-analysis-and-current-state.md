# 1. 现状与问题分析

> 路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。行号是 2026-11-24 的快照。

## 1.1 现状

侧边栏的会话行由 `sidebar/SessionRow.tsx` 渲染，从左到右分成三块：

```
┌─ .ohb-session-row ───────────────────────────────────────┐
│ [前导列] 标题……………………………… [行尾 meta]   [hover 按钮]      │
│  left:10px                    时间或圆点     absolute      │
│  宽 15px                                    right:4px     │
└──────────────────────────────────────────────────────────┘
```

| 区域 | 代码 | 现在显示什么 |
|---|---|---|
| 前导列 `.ohb-session-lead` | `SessionRow.tsx:115-123`，`sidebar.css:299-309` | 移动中显示 spinner，运行中显示点阵，其他时候为空。绝对定位，`top: 0; bottom: 0` 加 `align-items: center`，在行内上下居中 |
| 行尾 `.ohb-session-meta` | `SessionRow.tsx:124-133`，`sidebar.css:353-391` | 等待审批时显示圆点 `.ohb-session-awaiting`，否则显示相对时间 |
| hover 按钮 `.ohb-session-hover-actions` | `SessionRow.tsx:185-219`，`sidebar.css:393-404` | 置顶行有 pin 按钮，所有行都有「…」。平时透明，hover、菜单打开或获得焦点时显示 |

圆点颜色来自 `styles/tokens.css:47` 的 `--warning: #d97706`。子代理列表的"等待审批"圆点（`shared/StatusGlyph.tsx`，样式在 `shared/shared.css:665-680`）也用 `--warning`，注释里写明要和侧边栏同色。

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 高 | hover 时「…」盖住圆点 | 圆点在 meta 里贴着行尾，hover 按钮绝对定位在 `right: 4px`，两者重叠。`sidebar.css:387-391` 只在 hover 时隐藏时间（`> small`），不处理圆点 |
| P2 | 中 | 圆点颜色偏橙偏深 | `#d97706` 是 amber-600，用户要偏黄的橙黄 |
| P3 | 低 | 圆点和"运行中"标记不在同一位置 | 一个会话从运行切到等待审批再切回运行，标记在行首和行尾之间来回跳 |

## 1.3 根因

P1 和 P3 是同一个原因：**状态标记放在了行尾，而行尾在 hover 时要让给操作按钮。** 前导列本来就是给状态用的，"运行中"已经放在那里，"等待审批"却放到了行尾。

P2 是因为圆点借用了全局的 `--warning`，没有自己的颜色。

## 1.4 分维度诊断

| 维度 | 文档怎么说 | 代码怎么做 | 差距 |
|---|---|---|---|
| 职责 | 前导列是"状态位"（`03-ui-layout-and-style.md` 会话行一节） | 只放运行中和移动中 | 等待审批也是状态，应该放进去 |
| 状态互斥 | `activity` 只能是 `idle`、`running`、`awaiting` 之一（`store/sidebar-groups.ts:14`） | 一致 | 无差距，三种标记放同一列不会冲突 |
| 交互 | `04-interaction-and-states.md`：hover 按钮不改变行高和标题宽度 | 一致 | 圆点挪走后，行尾 hover 规则不变 |
| 颜色 | `--warning` 用于"等待审批的圆点、运行中可插话的描边"（`03` 色板表） | 一致 | 需要拆出专用 token，否则改色会连带改掉插话描边和警告横幅 |
| 可访问性 | 状态要有文字名称（`05-components.md` SessionRow 一节） | 圆点有 `role="status"` 和 `aria-label` | 挪到前导列后保留，另加 `title` |
| 测试 | `Sidebar.unit.test.tsx:457-489` 断言圆点在 meta 里 | 一致 | 测试要改成断言圆点在前导列 |

## 1.5 改动时要注意的现有行为

1. **前导列是绝对定位的，标题有固定的左内边距。** `.ohb-session-main` 的 `padding-left: 33px` 就是为了让状态标记出现或消失时标题不动。圆点放进前导列不影响标题位置。
2. **移动中的 spinner 优先级最高。** 现在的判断顺序是先看 `moving`，再看 `running`。等待审批要排在 `moving` 后面。
3. **消息时间议题会改同一块代码。** 它要删掉行尾的相对时间。两个议题都改 `SessionRow.tsx` 的 `meta` 和 `sidebar.css` 的行尾规则，见 02 §2.6。
4. **`--warning` 还有别的用途。** 运行中可插话的输入框描边、警告横幅、上下文圆环都在用。只换圆点的颜色，不能改这个 token。
5. **跨会话的等待状态不在本议题内。** `shell/AppController.tsx:219-228` 只给当前会话打标，切到别的会话后原会话没有圆点。这是数据来源的问题，单独开议题。
