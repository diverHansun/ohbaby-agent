# 1. 问题基线与当前实施状态

> 时间口径：规划时分支 `codex/web-chrome-polish-improve-2`，HEAD `3c3d7580`（improve-2 已实施）。分析对象是当时工作区 Web UI，不是本轮目标态。

---

## 1.1 问题陈述

1. **New session 右边被裁掉。** 按钮有描边和圆角，左边看得到圆，右边贴着侧栏边。根因不是「圆角画错」，是折叠动画用的子项 `min-width: 299px` 加上左右 `margin: 14px`，总宽超过 300px 侧栏，被 `overflow: hidden` 切掉右侧。
2. **顶栏看不到上下文圆环。** `StatusBar` 仍挂着 `ContextUsageControl`，并没有从 JSX 里删掉。但 `usage === null` 时组件 `return null`，顶栏连分隔线都不出。用户截图里模型名后面没有竖线和环，与这条路径一致。组件单测还把「没数据就不渲染」写成合同。
3. **一点盾/手就切到 full-access。** `cyclePermissionLevel` 直接 `setPermission({ level })`。improve-2 明确不弹 PermissionModal（那是工具审批）。完整访问会跳过后续询问，现在没有第二步。

## 1.2 已确认的产品/技术分界

引用 00：只改 **ohbaby-web 展示层**。权限 PATCH、context 估算、工具审批模态、TUI 不改。New session 文案保持英文。确认卡用英文（2026-09-19 用户推翻中文特例）。

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

`docs/ohbaby-web/goals-duty.md` D3 要求能切 mode 与权限策略。G3 要求会话行为与 CLI/TUI 一致，不是像素一致。Web 在 PATCH 前加确认卡不改变策略语义。

Gap：duty 成立；偶然复杂度是描边被裁切、圆环在 null 时消失、危险策略无确认。

### 1.3.2 architecture

| 块 | 位置 | 现状 |
|----|------|------|
| 新建按钮 | `App.tsx` `SessionSidebar` 约 L1255–1264 | `Plus` + 文案 `New session` |
| 新建样式 | `styles.css` `.ohb-sidebar-new` 约 L428–458 | 浅底 + `border: 1px solid #e7e9ee` + `border-radius: 9px` + `margin: 14px` |
| 侧栏裁切 | `.ohb-sidebar` 约 L143–169 | `overflow: hidden`；`> * { min-width: 299px }`（为 200ms 折叠不重排） |
| 顶栏 | `StatusBar` 约 L1343–1372 | 三色字标；`ContextUsageControl usage={header.contextWindowUsage}` |
| 圆环组件 | `ContextUsage.tsx` 约 L35–72 | `if (!usage) return null` |
| 圆环测例 | `ContextUsage.unit.test.tsx` 约 L67–70 | 「usage 不可用时不渲染空环」 |
| 顶栏圆环测例 | `App.unit.test.tsx` | **没有**断言 `.ohb-statusbar` 里有 `.ohb-context-ring-button` |
| 权限切换 | `cyclePermissionLevel` 约 L2901–2907；底栏按钮约 L3161–3182 | 点击立即两态循环 |
| 权限测例 | `App.unit.test.tsx` 约 L2468–2489 | 点击后立刻 `setPermission({ level: "full-access" })`，并断言无菜单 |
| 工具审批 | `PermissionModal` 约 L2151 | 队列驱动 slide-up；与策略确认不是同一件事 |

可逆：CSS + 三个小组件的 JSX。确认卡是新的局部 UI 状态，不是新协议。不可逆决策：无。

### 1.3.3 data-model

不新增领域字段。`ComposerModel.permissionLevel` 仍是 `default` \| `full-access`。确认卡是前端局部 boolean（打开/关闭），不进 snapshot。

`HeaderModel.contextWindowUsage` 仍可为 null；`contextLabel` 在无 usage 时已是 `"0 / 0"`，但顶栏并不渲染这串字，只在 `/status` overlay 使用。

### 1.3.4 dfd-interface

```
点 New session
  → onCreateSession → runtime.createSession()   （本轮不改这条，只改按钮脸）

snapshot.contextWindowUsages[sessionId]
  → selectContextUsage → header.contextWindowUsage
  → ContextUsageControl
  → 今天：null 则不挂 DOM

点权限图标（default）
  → cyclePermissionLevel
  → 今天：立刻 onSetPermission({ level: "full-access" }) → PATCH /v1/permission
  → 目标：先出确认卡；暂不 = 不发 PATCH；确认 = 再 PATCH

点权限图标（full-access）
  → 仍立刻 onSetPermission({ level: "default" })
```

工具审批 `PermissionModal`、context tracker、TUI status bar：不改。

### 1.3.5 use-case

| 用户在干什么 | 今天看到 | 问题 |
|--------------|----------|------|
| 扫侧栏顶部 | 一颗描边按钮，右边被切平 | 不要描边；hover 才显浅灰整块 |
| 找「新建」 | `+` New session | 要方框+笔，不要 `+` |
| 看上下文还剩多少 | 很多会话顶栏是空的 | 圆环应在；没数据也要有空环 |
| 点灰手切完整访问 | 立刻变红盾，不问 | 要先出卡，默认「Use full access」，可 Not now |
| 从红盾点回灰手 | 立刻变回 | 保持立刻，不出卡 |
| 工具要审批 | 底部 slide-up PermissionModal | 本轮不要把确认卡做成这个模态 |

### 1.3.6 non-functional

- **裁切**：`.ohb-sidebar > * { min-width: 299px }` 是 improve-2 动画的承重约束。修按钮时不能把折叠动画改回卸载 DOM，也不能让列表在动画中被压扁。只对 `.ohb-sidebar-new` 覆盖 `min-width` 和可用宽度，保留其他子项的动画约束。
- **顶栏高度**：圆环按钮现 26px，顶栏 min-height 44px + padding 8px。常驻空环也必须装进 44px，禁止加高顶栏去「对齐」侧栏 58px。
- **对比度**：玻璃底 `#f6f6f7` 上轨道 `#e6e8ec` 几乎看不见。常驻之后要把轨道加深一点，否则「加回去」看起来还是没有。
- **a11y**：确认卡 `role="dialog"`、Esc = 暂不、打开时焦点进主按钮、关闭后焦点回到权限图标。颜色不是唯一通道：标题和按钮有字。
- **危险动作默认焦点**：用户明确要求默认选「Use full access」。这与常见「默认取消」相反，但是产品决定，不要擅自改成默认 Not now。
- **文案语言**：确认卡与周围 chrome 一律英文（2026-09-19 用户推翻「确认卡中文」特例）。仍不做整站 i18n，不改 New session / idle。

### 1.3.7 test

仓库无项目级 `test-blueprint.md`。相关测例：

| 文件 | 覆盖 | 缺口 |
|------|------|------|
| `ContextUsage.unit.test.tsx` | 有 usage 时环、tooltip、popover | 把「null 不渲染」写成目标，和本轮相反 |
| `App.unit.test.tsx` | 点权限立刻 PATCH；点 New session 建会话 | 不断言顶栏有环；确认卡还不存在 |
| `styles.unit.test.ts` | 不抽查 `.ohb-sidebar-new` 边框/裁切 | 本轮要锁「无 border」和折叠规则仍在 |
| `selectors.unit.test.ts` | usage 投影、无 usage 时 `contextLabel: "0 / 0"` | 选择器本身不是圆环消失的原因 |

高风险：改侧栏 min-width 时弄坏 improve-2 折叠动画；改圆环 null 策略时只改组件、顶栏仍因没测而漏挂；确认卡复用 `PermissionModal` 把工具审批搞乱；现有「点击立刻 full-access」测例不改会红。

### 1.3.8 会话消息与工具披露现状

- `MessageRow` 为用户与 Agent 都渲染小号角色图标和大写标签，双方正文使用同一种左对齐结构，缺少自然的问答层级。
- `.ohb-tool-panel` 默认是白底描边卡片，每次调用都会形成一个明显盒子；状态和色彩进一步放大了工具的存在感。
- 短错误会自动展开，失败摘要直接显示 `failed`。这会把 Agent 可自行处理的内部尝试提升成用户必须关注的信息。
- 工具有结果后，现有 `toolBody` 只展示结果，原始输入被替换。用户主动排查时无法同时核对输入与输出。

目标是将用户消息变成右侧浅蓝气泡，Agent 回复保持阅读列内的左对齐正文；工具调用变成无边框披露行，失败默认静默收起，但主动展开仍保留完整诊断信息。

## 1.4 跨模块一致性

Web 顶栏圆环消费 `snapshot.contextWindowUsages`。TUI 有自己的 usage 展示，本轮不改。后端 tracker 不在本轮。若真实会话 snapshot 经常没有 usage，空环会常亮——这是诚实状态，不是估算 bug；不要在前端编造 token 数。

## 1.5 改动影响面（现状视角）

- `apps/ohbaby-web/src/ui/App.tsx`：侧栏按钮图标；Composer 点击权限的分支；可能抽确认卡。
- `apps/ohbaby-web/src/ui/App.tsx`：`MessageRow` 去掉角色标签，给用户和 Agent 正文分配明确样式类。
- `apps/ohbaby-web/src/ui/tool-card.tsx`：默认收起、静默状态摘要、分离 Input / Output。
- `apps/ohbaby-web/src/ui/styles.css`：`.ohb-sidebar-new` 的局部宽度、圆环轨道、确认卡。
- `apps/ohbaby-web/src/ui/ContextUsage.tsx` 及 unit：null 时仍渲染空环。
- `App.unit.test.tsx` / `styles.unit.test.ts`。
- `docs/ohbaby-web/ui/components.md`、必要时 `ui/README.md`。

不进：`packages/ohbaby-cli`、`permission-projection`、`context-window-usage.ts`、improve-1/2 规划文档。

## 1.6 SWE 原则审视摘要

- **偶然复杂度**：右缘裁切是动画约束泄漏到按钮盒模型（02 耦合），不是新建功能缺失。
- **信息隐藏**：确认卡不要并进 PermissionModal。工具审批的 choices/intent 和策略切换不是一类变化。
- **YAGNI**：不抽通用 Dialog 框架、不「不再提醒」、不 i18n 系统。
- **可逆**：CSS 与局部 React state。选错确认文案可以改；不要改 PATCH 契约。
- **先查重**：圆环组件、popover、权限 layer 都已存在。加回圆环 = 改挂载策略和对比度，不是新画一个环。

## 1.7 与既有文档关系

| 文档 | 文档说 | 代码做 | gap |
|------|--------|--------|-----|
| `ui/components.md` Header | 细进度条 + `32k / 200k` | 圆环 + 无常驻读数；null 则无控件 | 规格过时；本轮以圆环为准写回 |
| `ui/components.md` Composer | 单击循环权限，无菜单；full-access 不弹权限模态 | 单击立刻 PATCH | 「不弹工具审批」仍对；缺策略确认卡 |
| improve-2 00/02 | 点击仍两态循环；不改 PermissionModal | 已落地 | 本轮在循环前插入确认，需改权威句，不回写 improve-2 |
| `ContextUsage.unit.test.tsx` | null 不渲染 | 是 | 与「常驻圆环」冲突，本轮改测例 |
