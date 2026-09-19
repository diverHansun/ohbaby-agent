# 2. 优化方案与改动面

> 本轮实施契约。规划会话不写代码。与 00 冲突时先改文档。
> 视觉 token 与状态矩阵按 plan-frontend-design 写在本节，不另开 `docs/frontend/` 系列。

---

## 2.1 方案总览

五刀，数据流几乎不动：

1. **新建按钮**：无描边、无默认底；hover 整块浅灰；`SquarePen` 替换 `+`；局部覆盖按钮从父级继承的 299px 最小宽度，按钮左右完整可见。
2. **顶栏圆环**：会话页 header 常驻 `ContextUsageControl`；有 usage 画进度，无 usage 画空环 +「usage unavailable」类提示；略加深轨道，好在玻璃底上看见。
3. **完整访问确认卡**：仅 default→full-access 的图标点击；确认后才 PATCH；暂不/Esc/点遮罩不改策略。工具审批 PermissionModal 不动。
4. **会话层级**：移除消息角色图标和标签；用户消息使用右侧浅天蓝气泡；Agent 回复仍是阅读列内的无气泡正文。
5. **工具披露行**：去掉卡片边缘与状态标签；所有调用默认收起；hover/focus 才显示向右箭头，展开后转向下并分别展示 Input / Output。

```
[轨][侧栏 300：其余子项保持 299px 动画约束
        [✎ New session]   ← 无边，hover 浅灰
        Recent sessions…]

[顶栏 44px：ohbaby | idle | 模型 | 环 | goal?]

点灰手 → 确认卡 → PATCH full-access → 红盾
点红盾 → 立刻 PATCH default → 灰手
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 新建描边 | 去掉 border 与默认底 | 用户确认；描边让裁切更丑 | 只加对称 margin 仍留边 | hover 才有块面 |
| 裁切 | `.ohb-sidebar > .ohb-sidebar-new` 局部 `min-width: 0`，宽度扣除左右 margin | 保留 improve-2 折叠不重排；不新增 DOM | 全局删除 min-width（动画中列表会被压扁） | 一条特定选择器 |
| 图标 | Lucide `SquarePen` 约 15px | 与参考图同构；项目已用 lucide | 自绘 SVG；改成「新建会话」四字 | 文案仍英文 |
| 圆环常驻 | null 也渲染空环，不 `return null` | 用户要顶栏始终能看到这个控件 | 只加 App.unit、指望 snapshot 永有 usage | 没数据时是空环，不是假百分比 |
| 读数 | 不在 header 常驻 `32k/200k` | 用户要的是圆环；明细已在 tooltip/popover | 改回进度条+文字 | 与过时 components 句冲突，Stage 4 改文档 |
| 确认卡 | 新卡片，不复用 PermissionModal | 两类意图；审批规格明确不改模型 | 塞进现有 slide-up | App 多一个局部组件 |
| 默认按钮 | 「Use full access」主按钮且初始焦点 | 用户确认 | 默认「Not now」（更常见的安全默认） | Enter 会立即开启完整访问 |
| 文案语言 | 确认卡英文，与其余 chrome 一致 | 2026-09-19 用户推翻中文特例 | 整页中文化；确认卡中文 | 不做整站 i18n |
| slash 确认 | 无额外改动 | 当前 Web 未发现可切权限的 slash 入口 | 为不存在的入口增加抽象 | 无 |
| 关键改动清单 | 不写 | 用户确认 | — | — |
| Agent 品牌 | 暂不显示 Lychee 名称或荔枝图标 | 用户确认先解决消息层级 | 本轮绘制静态荔枝 SVG | 无品牌标签 |
| 工具名称色 | read 金、edit/write 绿、其他蓝；失败覆盖为红 | 保留类型辨识，失败仅靠名称色弱提示 | 整行或卡片染色 | 颜色不是唯一诊断通道，展开仍有错误文本 |
| 失败工具 | 名称红色；摘要静默、默认收起；展开后保留错误输出 | Agent 可自行恢复，用户仍可主动排查 | `failed` 文本或自动展开 | 默认界面只有名称色提示 |

不可逆决策：**无。**

## 2.3 本轮视觉系统

原则：少边缘；危险动作克制但说明清楚；顶栏高度不动；侧栏折叠动画不动。

| Token | 值 | 用途 |
|-------|----|------|
| new-session-idle | 透明底、无边、字色沿用 `#4f5968` | 默认 |
| new-session-hover | 建议 `#eef0f4` 整块圆角 9px | hover/focus-visible 浅底，不是描边 |
| new-session-icon | `SquarePen` 15px，与文字 8px 间距 | 替换 Plus |
| ring-track | 比现在 `#e6e8ec` 深一档，建议 `#cfd3da` | 玻璃底上能看见空环 |
| ring-progress | 仍 `#5f86c4` | 有 usage |
| ring-size | 按钮 26px / svg 16px | 装进 44px 顶栏 |
| confirm-surface | 白底、圆角约 18px、轻阴影，最大宽度约 460px | 参考卡，不是全屏 |
| confirm-title | 深字，约 18–20px | `Enable full access?` |
| confirm-body | 次要灰，约 13–14px | 风险说明 |
| confirm-primary | 浅红底、红字，文案「Use full access」 | 默认动作与危险语义一致 |
| confirm-secondary | 浅边或浅底，文案「Not now」 | 取消 |
| confirm-warn | 小号红盾警示符；不加三行能力大面板 | 简约、友好，不是惊吓 |
| header-height | 44px | 不改 |
| sidebar-width | 300px；仅新建按钮覆盖 min-width | 其余动画约束不删 |

禁止：紫渐变、重遮罩把会话衬得像系统警报、把确认卡做成 PermissionModal 的 slide-up、把顶栏加高、把 New session 改成描边胶囊、前端编造 token 数。

确认卡正文：

> 开启后，ohbaby 将跳过后续操作确认，并可能执行命令、访问网络或修改工作区文件。你可以随时切回默认权限。

不要出现 Ultra、Codex、深度推理。

## 2.4 状态矩阵（本轮涉及的组件）

### New session

| 状态 | 视觉 | 触发 |
|------|------|------|
| idle | 无边无底，方笔图标 + `New session`，左右都离开侧栏边 | 默认 |
| hover | 整颗浅灰圆角，宽高不变 | 指针 |
| focus-visible | 与 hover 同类浅底 + 可见焦点环 | 键盘 |
| disabled | 沿用全局 disabled | composer.disabled |
| 侧栏折叠中 | 其他子项保持 299px；按钮在可见宽度内 | improve-2 动画 |

### 顶栏圆环

| 状态 | 视觉 | 触发 |
|------|------|------|
| 有 usage | 轨道 + 蓝色进度弧；aria 含百分比和大约 token | snapshot 命中当前 session |
| 无 usage | 只有轨道的空环；tooltip/aria 说明 usage unavailable 或 pending；**禁止**写假的 12% | usages 空、session 不匹配、尚未投影 |
| hover（未展开） | 现有黑底 tooltip | 指针/focus |
| 展开 | 现有 Context Usage popover | 点击；Esc/外点关闭 |
| 无会话主界面 | header 不存在（空态） | showMain false，本轮不在空态硬插圆环 |

### 完整访问确认卡

| 状态 | 视觉 | 用户操作 |
|------|------|----------|
| 关闭 | 无卡 | 默认；暂不/Esc/点浅遮罩 |
| 打开 | 卡片；焦点在「Use full access」 | 在 default 时点权限图标 |
| 确认 | 关卡 + PATCH `{ level: "full-access" }` | 点主按钮或在主按钮上 Enter |
| 取消 | 关卡 + **不** PATCH，仍是灰手 | 暂不 / Esc / 点遮罩 |
| 已是 full-access 时点图标 | 无卡，立刻 PATCH default | 降级 |
| 工具审批同时出现 | 确认卡与 PermissionModal 是两套；确认开启 full-access 后仍走现有「full-access 不展示审批模态」 | 先确认策略，再投影审批 |

## 2.5 分阶段实施

全部 Stage 属于 improve-3。

### Stage 1 — New session 按钮

- **目标**：无描边；hover 整块浅灰；`SquarePen`；左右完整，不再右贴边。
- **改动文件**：`App.tsx` `SessionSidebar`；`styles.css` 侧栏；必要时 `styles.unit.test.ts`。
- **结构**：保留 `.ohb-sidebar > * { min-width: 299px }`；新增更具体的 `.ohb-sidebar > .ohb-sidebar-new`，令其 `min-width: 0`，宽度为侧栏宽度减去左右 margin。侧栏 DOM 和其他子项动画约束不动。
- **删除**：按钮上的 `Plus`；`.ohb-sidebar-new` 的 `border` 与默认实心底。
- **保留**：`onCreateSession`、英文文案、title/可访问名（可补 aria-label，不必改成中文）。
- **DoD**：DOM 无该按钮上的 Plus；有 SquarePen；计算样式 border 为 0；侧栏关闭后节点仍在（improve-2 T8 不回退）；折叠动画规则仍在。

### Stage 2 — 顶栏圆环常驻

- **目标**：主会话 header 始终有环；null 空环；轨道在玻璃底可见；popover 行为不变。
- **改动文件**：`ContextUsage.tsx`；`ContextUsage.unit.test.tsx`；`App.tsx` StatusBar（若需在无 usage 时仍保留分隔逻辑）；`App.unit.test.tsx`。
- **null 策略**：改掉 `return null`。空环不编造 composition、不编造 currentTokens。aria 区分「百分之几」和「usage unavailable」。
- **StatusBar**：有环或有 goal 时才出分隔线的逻辑，改为「主会话 header 默认就有环」，避免环在但竖线逻辑仍当它不存在。
- **对比度**：只改圆环轨道/进度，不动思考三色、字标三色。
- **DoD**：`ContextUsageControl(null)` 仍有 `.ohb-context-ring-button`；带 `contextWindowUsages` 的 App 挂载能在 `.ohb-statusbar` 里查到该按钮；点击仍打开现有 dialog；顶栏 min-height 仍 44px。

### Stage 3 — 完整访问确认卡

- **目标**：default 点权限图标先出卡；确认才 PATCH；暂不不变；full-access 点回去仍立刻 default。
- **改动文件**：建议新文件 `FullAccessConfirm.tsx`（避免再往 `App.tsx` 堆职责）；`App.tsx` Composer 点击分支；`styles.css`；`App.unit.test.tsx`。
- **不要**：改 `permissionButtonClass` / `.ohb-perm-btn*` / PermissionModal 队列。
- **打开/关闭**：Esc、暂不、点浅遮罩为同一语义。打开时焦点落入主按钮并留在卡片内（Tab 不要回到 textarea，避免 Enter 误发送）。关闭后焦点回到权限图标。
- **DoD**：原「点击立刻 setPermission full-access」测例改为「先出 dialog、确认后才调用」；取消路径零 PATCH；已是 full-access 时点击仍立刻 default。

### Stage 4 — 对话消息层级

- **目标**：用户消息右对齐浅蓝气泡；Agent 回复无气泡；不渲染双方图标或角色标签。
- **改动文件**：`App.tsx` 的 `MessageRow`；`styles.css`；`App.unit.test.tsx`；`styles.unit.test.ts`。
- **布局**：阅读列仍为 720px。用户气泡最大宽度 76%，窄屏约 92%；Agent 内容占阅读列宽度并左对齐。
- **DoD**：消息 DOM 不再出现可见的 `.ohb-message-label`；用户正文命中 `.ohb-message-user-bubble`；Agent 正文命中 `.ohb-message-assistant-bare`；消息 article 仍以 `aria-label` 向辅助技术说明说话者。

### Stage 5 — 轻量工具披露行

- **目标**：一次调用一行；默认无卡片边缘且全部收起；摘要不显示运行状态或失败状态；保留工具名称语义色。
- **改动文件**：`tool-card.tsx`、`tool-card.unit.test.tsx`、`styles.css`、`styles.unit.test.ts`，以及 App 集成测例。
- **交互**：整行保持原生 button。鼠标/触控板点击切换；Tab 恰好聚焦时 Enter/Space 沿用浏览器原生按钮行为，不增加全局快捷键。
- **箭头**：收起时默认透明；hover/focus-visible 时出现右箭头；展开后持续显示并旋转 90° 向下。
- **密度**：工具行外边距收紧到上下 2px，按钮上下内边距收紧到 3px；左右内边距、圆角和 hover 浅底保持不变，使连续调用更紧凑、hover 块贴近文字且彼此仍有留白。
- **名称色**：read 金色、edit/write 绿色、其他蓝色；失败优先级最高，仅把名称改为红色。摘要、箭头和展开内容保持中性灰。
- **详情**：分别渲染 Input 与 Output。失败不自动展开、不显示 `failed` 或错误摘要；用户主动展开后输出区仍展示错误文本。
- **DoD**：短失败与长失败均默认收起；摘要无失败文案；点击后同时看见 JSON 输入和结果/错误输出；孤立失败结果同样不在摘要泄露错误。

### Stage 6 — 权威文档

- `docs/ohbaby-web/ui/components.md`：Header 改为常驻圆环（空数据空环）；Composer 权限改为「升到 full-access 先确认卡，降回 default 立刻切；full-access 仍不弹工具审批」。
- `docs/ohbaby-web/ui/README.md`：决策 3 补一句确认卡，不写成本轮才发明权限策略。
- **不回写** improve-1 / improve-2 的 00–04。
- **DoD**：components 不再写「细进度条 + 32k/200k」当现行规格，不再写「单击无确认循环到 full-access」。

## 2.6 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | 建议 `FullAccessConfirm.tsx`（可含 colocated unit） | `App.tsx`、`styles.css`、`ContextUsage.tsx`、相关 unit | New session 的 Plus 节点 | 展示层 |
| `apps/ohbaby-web/src/ui/tool-card.tsx` | 无 | 工具披露结构与状态 | 自动展开、meta 状态、色彩卡片类 | 展示层 |
| `docs/ohbaby-web/ui/` | 无 | `components.md`、必要时 `README.md` | 「进度条+读数」「单击无确认」句 | 权威规格 |
| `packages/ohbaby-cli/` | 无 | 无 | 无 | 禁止 |
| improve-1/2 规划文档 | 无 | 无 | 无 | 不回写 |

## 2.7 API / 协议 / 迁移与兼容

无协议变更。确认后的请求仍是 `PATCH /v1/permission` `{ level: "full-access" }`。键盘：Enter 在确认卡上激活焦点按钮；Esc 关闭确认卡时不要误伤 Composer 的双击 Esc 中断（焦点在 dialog 内）。slash、队列、pairing 不改。

## 2.8 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 折叠动画列表被压扁 | 只覆盖新建按钮，04 锁 transition + 关闭后节点仍在 | 不改其他子项的 299px 约束 |
| 空环被当成 0% 事实 | aria/tooltip 写 unavailable，不写 0% Full | — |
| 确认卡复用 PermissionModal | 新组件 + 04 断言工具审批四键 class 不变 | 删新卡，恢复立刻 PATCH |
| Enter 误开完整访问 | 这是 00 的默认选择；正文必须把风险写清 | 只改文案/主按钮样式，不改协议 |
| 顶栏加高 | 04 锁 44px | 缩小环，不加 padding |

## 2.9 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 无描边、hover 浅灰、SquarePen、去掉 + | Stage 1 |
| 文案保持 New session | Stage 1 |
| 圆环加回并常驻 | Stage 2 |
| 不常驻 32k/200k | Stage 2 |
| 确认卡英文两键，默认 Use full access | Stage 3 |
| 降级不出卡 | Stage 3 |
| 不改 PermissionModal / 协议 / TUI | 2.6 / 2.10 |
| 不写关键改动清单 | 未单列该节 |
| 权威文档 | Stage 4 |

## 2.10 不在本轮

- TUI chrome 与 TUI 切权限确认。
- New session 中文化；整站 i18n。
- 工具审批 PermissionModal、permission-projection、PATCH 字段。
- context-window-usage 算法、编造 usage。
- 「不再提醒」、plan 模式确认。
- Lychee 名称、荔枝图标或新的 Agent 品牌人格标识。
- 侧栏与顶栏齐高、阅读列 800、回写 improve-1/2。
- Playwright 截图回归。

下一轮候选（不预开目录）：TUI 的 full-access 确认是否对齐；snapshot 长期缺 `contextWindowUsages` 时要不要查后端投影。
