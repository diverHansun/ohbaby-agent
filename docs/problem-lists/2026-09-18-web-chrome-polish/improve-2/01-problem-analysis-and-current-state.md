# 1. 问题基线与当前实施状态

> 时间口径：规划时分支 `codex/web-chrome-polish`，HEAD `2a65b819`，工作区已含 improve-1 的顶栏 44px / 无 `>` / 箭头 14px。分析对象是当时工作区 Web UI，不是本轮目标态。

---

## 1.1 问题陈述

1. **输入框被底栏两颗胶囊顶住。** `.ohb-composer` 底 padding 约 22px，下面还有 `.ohb-composer-tools`（mode + permission 带字按钮，高约 30px）。框本身离窗口底不远，中间却隔着一整行 chrome。
2. **mode / permission 边缘感重。** 能力已经在：`Shift+Tab` 切 mode，点击切 permission。脸上却是两颗白底描边胶囊，和「无感」相反。
3. **侧栏不能做动画。** `SessionSidebar` 在 `open === false` 时 `return <></>`，节点卸掉，宽度过渡接不上。
4. **顶栏和会话列表过白。** `.ohb-statusbar` / `.ohb-sidebar` 是实 `#ffffff`，正文 `#fafafa`，硬边白块显得呆。
5. **header 字标和品牌不是一套。** 空态已是三色小写圆角 `oh / ba / by`；header 仍是四色点 + 黑色大写 Plex Mono `OHBABY`。

## 1.2 已确认的产品/技术分界

引用 00：只改 **ohbaby-web 展示层**。mode/permission 的数据路径、`Shift+Tab`、点击循环、`full-access` 不弹窗，全部保持。阅读列宽度、侧栏推进模型、TUI，不改。

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

`docs/ohbaby-web/goals-duty.md` D3 要求 composer 能切 mode 与权限策略。`docs/ohbaby-web/ui/README.md` 把它们写成「底部按钮」。能力是 duty，带字胶囊不是。

Gap：duty 成立；偶然复杂度是框外底栏、实白顶栏、第二套字标。

### 1.3.2 architecture

| 块 | 位置 | 现状 |
|----|------|------|
| Composer 底栏 | `App.tsx` 约 L3182–3216 | `.ohb-composer-tools`：mode 按钮 + policy 按钮；slash/队列错误和 queued hint 也塞在这行 |
| 切 mode | `cycleMode` 约 L2896；`Shift+Tab` 约 L2996 | 键盘和点击走同一函数 |
| 切权限 | `cyclePermissionLevel` 约 L2901 | 只在底栏按钮上 |
| 输入卡 | `styles.css` `.ohb-composer-input` 约 L2254 | `max-width: 720px`；边 `#cdd7e8` + 蓝光；与 mode 无关 |
| 高度 | `composerTextarea.ts` + 调用处 `lineHeight: 24, maxLines: 7` | CSS `line-height/min-height: 24px`、`max-height: 168px`；字号继承 body 16px |
| 阅读列 | `.ohb-stream-inner` `max-width: 720px` | 本轮保持 |
| 侧栏 | `SessionSidebar` 约 L1237 | 关闭即卸载 |
| 顶栏 | `StatusBar` 约 L1347–1356 | `ohb-logo-grid` + 文本 `OHBABY` |
| 空态字标 | `EmptyState` 约 L1057–1061 | `oh / ba / by` 三色，`.ohb-wordmark` 70px |
| 玻璃 | 无 | header/sidebar 实白 |

可逆：CSS + Composer/Sidebar/StatusBar 的 JSX。侧栏要从「卸载」改成「折叠 class」，这是结构小改，不是新模块。不可逆决策：无。

### 1.3.3 data-model

`ComposerModel.mode`（`auto` \| `plan`）和 `permissionLevel`（`default` \| `full-access`）不改字段。本轮只改投影：mode → 输入框 class；permission → 图标。没有新实体。

### 1.3.4 dfd-interface

```
Shift+Tab / （本轮删除的 mode 按钮）
  → cycleMode → onSetPermission({ mode }) → PATCH /v1/permission
权限图标点击
  → cyclePermissionLevel → onSetPermission({ level }) → 同上
侧栏开关
  → sessionSidebarOpen boolean → 今天装卸 DOM；目标改为 class + 宽度
header 品牌
  → 纯展示，无请求
```

协议、PermissionModal、`full-access` 不弹窗：不改。

### 1.3.5 use-case

| 用户在干什么 | 今天看到 | 问题 |
|--------------|----------|------|
| 打字、看底 | 框下面还有两颗胶囊，框被顶起来 | 要框贴底、控件进框 |
| 默认 auto | 绿底「auto mode」 | 不要提示 |
| Shift+Tab 到 plan | 蓝底「plan mode」 | 只要浅黄描边 |
| 看/切权限 | 带字「default」方块 | 灰色手 / 红色感叹盾 |
| 收起会话列表 | 瞬间消失，正文猛地变宽 | 要 200ms 推进 |
| 扫顶栏 | 白条 + 黑大写 OHBABY | 玻璃 + 三色小写 |

### 1.3.6 non-functional

- **颜色不能当唯一通道**：plan 只用黄边，色盲/读屏不够。脸上可以没字，但 `aria-label`（或 textarea 可访问名）必须带当前 mode。
- **7 行盒模型**：字号改 14px、行高改 22px 后，`fitComposerTextarea` 与 CSS `max-height` 必须一起改成 22×7=154，textarea 仍 `padding: 0`。
- **输入框比正文宽**：800 vs 720 是用户要的；todo/queue 盖在输入框上，宽度应跟输入框走，不要跟 720 阅读列。
- **backdrop-filter**：无支持时退回实色浅灰，禁止透明到字叠字。
- **动效频率**：侧栏一天几十次，180–200ms ease-out，禁止弹跳；`prefers-reduced-motion` 时 0ms。
- **思考指示器配色**与 `.ohb-logo-grid` 写在同一组 CSS。header 去掉点阵时，**不要删掉** `.ohb-thinking` 的三色规则。

### 1.3.7 test

| 已有测试 | 锁了什么 | 缺口 |
|----------|----------|------|
| App.unit 1–7 行 | height 24/72/168 | 字号改了要改期望值 |
| styles.unit | 圆钮 32、textarea padding 0、顶栏 44、侧栏顶 58 | 不锁 composer 800、mode 边、无 mode 按钮 |
| 无侧栏动画测试 | 开关即有/无 `.ohb-sidebar` | 折叠后节点仍在时，旧「没有 sidebar」断言会坏 |
| TUI contract | 无关 | 必须继续绿 |

高风险：改字号忘改 7 行常量；卸载改折叠后测例当侧栏消失；误把阅读列加到 800；误删 thinking 三色；删 `.ohb-composer-tools` 时把 slash 错误和改队列 hint 一起丢掉。

## 1.4 跨模块一致性

只动 `apps/ohbaby-web` 与 `docs/ohbaby-web/ui`。CLI TUI 的 mode/权限脸不动。`PATCH /v1/permission` 不变。

## 1.5 改动影响面（现状视角）

- `App.tsx`：Composer 结构、StatusBar 字标、SessionSidebar 常挂 DOM。
- `styles.css`：composer 宽/字/边/底栏、玻璃、侧栏 transition。
- `composerTextarea` 调用处的 lineHeight；既有 App.unit 高度数。
- 权威文档 `components.md`、`ui/README.md` 决策 3 的「底部按钮」表述、`test.md` 若仍写 mode 胶囊。

## 1.6 SWE 原则审视摘要

- **KISS**：mode 用现成描边，不新做胶囊变体。权限用两枚 Lucide，不引入图标字体。
- **YAGNI**：不抄参考图的加号/High 下拉/麦，也不新增模型切换。不抽通用 GlassChrome 组件，几条 CSS token 即可。
- **信息隐藏**：侧栏折叠是展示状态，不要改会话数据。
- **可逆**：玻璃和字标可单独回滚。侧栏常挂 DOM 是小结构债，比再写 JS 动画库便宜。
- **反教条**：颜色区分 mode 不满足「状态不能只靠颜色」——用 aria 补，不把按钮加回来。

## 1.7 与既有文档关系

| 文档 | 文档说 | 代码做 | 本轮 |
|------|--------|--------|------|
| components.md §3 | 底部 mode/policy 带字按钮 | 确有 `.ohb-composer-tools` 两颗胶囊 | 改成框边 + 框内图标；更新文档 |
| components.md §1 | 点阵 + `OHBABY` | 一致 | 改成三色小写，无点 |
| ui/README 决策 3 | mode/policy 在底部 | 一致 | 保留能力，改脸 |
| density 02 | 思考芯片与圆钮在输入行右下 | 同行 flex-end | 收到框内底栏右；仍在输入卡里 |
| improve-1 00 | 侧栏顶 58、不对齐 | 仍 58 | 不翻案；可以一起换玻璃底 |
| improve-1 04 T8 | sidebar-header 58px | 应仍成立 | 本轮 CSS 断言继续锁 |
