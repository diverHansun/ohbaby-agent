# 1. 问题基线与当前实施状态

> 时间口径：规划时分支 `main`，HEAD `2a65b819`。分析对象是当时工作区的 Web UI，不是目标态。density 的圆钮 / 1–7 行 / 状态纯字已在代码里。

---

## 1.1 问题陈述

1. **工具卡箭头会随行宽被挤扁。** `ToolPanel` 给所有工具共用一个 Lucide `ChevronDown`，`size={16}`。折叠行是横向 flex，摘要默认会抢空间，箭头没有 `flex-shrink: 0`。`subagent_run` 这类长标题 + 长 prompt 摘要几乎顶到 `running`，箭头被压小；`web_search` 摘要和状态之间还有空，箭头保持原尺寸。看起来像两套样式，其实是同一组件。
2. **输入文字偏下，`>` 偏上。** `.ohb-composer-input` 是 `align-items: flex-end`（给多行时圆钮贴底）。`.ohb-prompt` 的 `>` 又是 `align-self: flex-start`。textarea `min-height: 24px`，圆钮 `32px`。空着时的打字机、`run in progress`、真正打出来的字，都坐在偏低的 24px 轨道上；`>` 贴着框顶。
3. **会话顶栏偏高。** `.ohb-statusbar` `min-height: 58px`、`padding: 14px 24px`，字标 17px。里面真正有字的大约 26px（状态、圆环）。侧栏顶同样 58px，但用户本轮不要动侧栏、也不要对齐。

## 1.2 已确认的产品/技术分界

引用 00：本轮只改 **ohbaby-web 展示层几何**。发送、排队、`abortSession`、工具 pairing、1–7 行算法、侧栏顶，全部保持。TUI 零改动。

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

`docs/ohbaby-web/goals-duty.md` D3 要会话交互 UI。没有规定必须留终端 `>`，也没有规定顶栏必须 58px。Non-duty：web 不持有独立事实源。本轮不改 store、不改协议。

Gap：职责成立，chrome 的偶然复杂度（可被挤的 SVG、互相打架的对齐、偏厚的顶栏）挡阅读。

### 1.3.2 architecture

| 块 | 位置 | 现状 |
|----|------|------|
| 工具折叠行 | `apps/ohbaby-web/src/ui/tool-card.tsx` `ToolPanel`（约 L118–140） | `ChevronDown` `size={16}`，打开时加 `ohb-chevron-open`。`ToolCard` 与 `OrphanToolResultCard` 都走这里。 |
| 工具行 CSS | `apps/ohbaby-web/src/ui/styles.css` `.ohb-tool-panel button`（约 L1079–1141） | flex + gap；`.ohb-tool-summary` 有 `min-width: 0` 和省略号；箭头 SVG **没有** `flex: none` / 固定宽高。 |
| 输入框 | `apps/ohbaby-web/src/ui/App.tsx` `Composer`（约 L3096–3182） | `<span className="ohb-prompt">&gt;</span>` + `.ohb-composer-text` + `ReasoningControl` + 圆钮。空项目页和主会话共用这个 Composer。 |
| 输入对齐 CSS | `styles.css` `.ohb-composer-input`（约 L2245–2313） | 行 `flex-end`；`>` `flex-start`；textarea `line-height/min-height: 24px`、`padding: 0`（给 `fitComposerTextarea` 的 24×7 用）。 |
| 会话顶栏 | `App.tsx` `StatusBar`（约 L1339–1372） | 仅 `showMain` 时渲染。空项目页走 `EmptyState` + `.ohb-empty-status`，不是这条 header。 |
| 顶栏 CSS | `styles.css` `.ohb-statusbar`（约 L589–608） | `min-height: 58px; padding: 14px 24px`。`.ohb-brand` 字号 17px。 |
| 侧栏顶 | `styles.css` `.ohb-sidebar-header`（约 L374–382） | 同样 `min-height: 58px; padding: 14px …`。本轮故意不改。 |

其它箭头（**不是**本问题，避免误修）：

- Tasks：`App.tsx` 约 L3257–3261，`ChevronDown` `size={14}`
- reasoning 下拉：约 L2379–2383，`size={13}`
- 目录选择器：`DirectoryPickerDialog.tsx` 14/16 混用

可逆改动：CSS + 删一个 span + 给工具箭头加 class。不抽新组件。不可逆决策：无。

### 1.3.3 data-model

不适用。不改 `HeaderModel`、`ComposerModel`、工具 call/result。箭头尺寸和顶栏高度不是数据字段。

### 1.3.4 dfd-interface

```
工具 call/result
  → pairToolParts → ToolCard / OrphanToolResultCard → ToolPanel
      折叠行：title | summary | meta | ChevronDown
输入
  → Composer：`>` + textarea/typewriter + ReasoningControl + 圆钮
      高度仍由 fitComposerTextarea（24px × 最多 7 行）
会话顶栏
  → showMain? StatusBar : EmptyState 右上角状态
```

本轮不改箭头指向的数据，只改折叠行 flex 谁可以被挤；不改发送路径，只删 `>`、把单行文字轨道对齐 32px 圆钮；不改连接态含义，只减 `.ohb-statusbar` 的垂直空白。

### 1.3.5 use-case

| 用户在干什么 | 今天看到 | 问题 |
|--------------|----------|------|
| 看正在跑的 subagent + 两条 search | 第一张箭头小，后两张大 | 同一组件，行越满箭头越小 |
| 框空、run 未聚焦 | `>` 靠上，`run in progress` 靠下 | 两套对齐 |
| 框空、idle 未聚焦 | `>` 靠上，打字机靠下 | 同上 |
| 打字 | 字仍靠下 | textarea 24px 贴着 32px 钮的底 |
| 打很多行 | 圆钮在右下，`>` 仍在第一行顶 | density 当时就要这个；本轮去掉 `>` 后不再有第一行顶的符号 |
| 读会话 | 顶栏 58px + 对话流再 32px padding | 顶栏空白多；侧栏顶同高但是用户不要齐 |

### 1.3.6 non-functional

- **flex + SVG**：部分浏览器把 SVG 的 `min-width: auto` 当成 0，行一满就缩小。只靠 Lucide 的 `size={16}` 锁不住。要 CSS `flex: none` + 写死宽高。
- **7 行盒模型**：`styles.unit.test.ts`（约 L85–93）锁死 textarea `padding: 0`、`line-height: 24px`、`max-height: 168px`。垂直居中不得给 textarea 加 padding 来「垫一垫」，否则 `fitComposerTextarea` 会把 padding 算进行高。正确做法：外层 `.ohb-composer-text` 用 `min-height: 32px` 对齐圆钮，textarea 仍 24px、`padding: 0`。
- **禁止 stretch**：同文件约 L80–82 禁止 `.ohb-composer-input { align-items: stretch }`。多行仍用 `flex-end`。
- **窄屏顶栏**：`@media (max-width: 720px)` 里 `.ohb-statusbar` 仍是 `padding: 13px 16px` 且 `align-items: flex-start`（约 L2929–2933）。若只改桌面 44px、不改这条，窄屏会把变矮抵消掉。本轮应把窄屏垂直 padding 一并收紧，**换行行为保留**，不要为了对齐侧栏去改侧栏。
- **Goal 芯片 / 上下文圆环**：芯片约 26px、圆环 26px，44px 栏（8px×2 padding）里还能放下。不要为了顶栏再缩小圆环。

### 1.3.7 test

| 已有测试 | 锁了什么 | 缺口 |
|----------|----------|------|
| `styles.unit.test.ts` | 圆钮 32px、textarea 24/168、输入行不要 stretch、工具名无胶囊 | 不锁箭头 14px、不锁顶栏高度、不禁止精确选择器 `.ohb-prompt`（负向匹配时必须避开 `.ohb-prompt-queue`） |
| `App.unit.test.tsx` | 打字机显隐、1–7 行高度、无 Send 字 | 不断言 composer 里没有 `>` |
| `tool-card.unit.test.tsx` | pairing、短失败展开、不暴露 call id | jsdom 测不了 flex 挤扁；几何靠 CSS 单测 |
| TUI contract | 无关 | 必须继续绿 |

高风险缺口：改对齐时误给 textarea 加 padding，弄坏 7 行；误改 `.ohb-sidebar-header`；只锁 Lucide `size` 不锁 CSS，长摘要下问题还在。

## 1.4 跨模块一致性

只动 `apps/ohbaby-web` 与 `docs/ohbaby-web/ui`。CLI TUI 的 prompt `>` 是终端传统，本轮不动。工具 pairing 仍在 web 的 `pairToolParts`，本轮不改。

## 1.5 改动影响面（现状视角）

- `apps/ohbaby-web/src/ui/tool-card.tsx`、`styles.css`、`App.tsx`（删 `>`、可能给 composer-text 加 min-height）、对应 unit 测试。
- 权威文档 `components.md`、`test.md` 一句。
- **不要动**：`packages/ohbaby-cli/`、`.ohb-sidebar-header`、`composerTextarea.ts` 的 24/7 常量（除非实施时发现盒模型被破坏——那应视为回归，而不是改算法）。

## 1.6 SWE 原则审视摘要

- **偶然复杂度**（00 哲学）：`>` 的 `flex-start` 和行的 `flex-end` 是自己造的错位，不是聊天输入的本质复杂度。去掉符号比继续微调 1px 更干净（KISS）。
- **DRY**：所有工具已经共用 `ToolPanel`。一处锁 14px，bash/read/edit/search/subagent 一起好。不要为每种工具写分支。
- **YAGNI**：不要抽 `DisclosureChevron` 去统一 Tasks / reasoning / 目录。用户只要工具卡一致。
- **一致性的例外**：侧栏顶和会话顶栏现在同高。改完会不齐。这是用户明确接受的产品选择，不是漏改。文档必须写死，避免实施时「顺手对齐」。
- **可逆**：纯 CSS/JSX，回滚就是还原三个文件。

## 1.7 与既有文档关系

| 文档 | 文档说 | 代码做 | 本轮 |
|------|--------|--------|------|
| `docs/ohbaby-web/ui/components.md` §3 | 「`>` 提示符 + 1–7 行」 | 确有 `>`；1–7 行已落地 | 删 `>`；补顶栏约 44px、工具箭头 14px |
| density `improve-1/02` | 「`>` `align-self: flex-start`」 | 已落地，正是偏上的原因 | **覆盖**该条；不回写 density 文档 |
| density `improve-1/02` | 输入行 `flex-end`、textarea `padding: 0` | 已落地 | **保留**（多行圆钮贴底、7 行盒模型） |
| `components.md` §1 | 顶栏左右分布，无高度 | 58px | 写成约 44px；注明不与侧栏对齐 |
| `components.md` §2 | 折叠态 chevron 旋转 | 有旋转，尺寸不稳 | 写死 14px 且不可被挤 |

`docs/ohbaby-web/ui/design/session-screen.dc.html` 若仍画着 `>`，本轮不当权威、不强制改静态稿。
