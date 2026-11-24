# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。

## 2.1 方案总览

把等待审批圆点从行尾挪进前导列，和"运行中"点阵用同一个位置。颜色换成新的专用 token `--attention: #f2c230`，子代理列表的同款圆点一起换。

```
改动前                                   改动后
[点阵] 标题……………… [圆点/时间] […]       [圆点] 标题……………… [时间] […]
 运行中           等待审批  hover 时重叠    等待审批          hover 时让位
```

前导列的显示优先级：移动中 spinner > 运行中点阵 > 等待审批圆点 > 空。运行中和等待审批在数据上互斥，这里排先后只是为了代码写起来清楚。

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| A1 圆点位置 | 前导列，在文件夹图标正下方 | 状态都在同一列，hover 按钮只占右侧，永远不重叠；dsh 也这样做 | 放右侧「…」左边：hover 时圆点要左移 24px（置顶行 48px），或者平时右侧空一块 | 用户的视线要从行尾挪到行首 |
| A2 垂直位置 | 在行内上下居中 | 用户要求；前导列已经是 `top: 0; bottom: 0` 加 `align-items: center`，不用新写规则 | 无 | 无 |
| A3 颜色 | 新增 `--attention: #f2c230` | 用户选定；只换圆点，不连带插话描边和警告横幅 | 改 `--warning`：影响面太大 | 多一个 token |
| A4 子代理圆点 | `StatusGlyph` 的 `approval` 圆点也换成 `--attention` | 它的注释和设计文档都写明要和侧边栏同色 | 保持 `--warning`：两处"等待审批"颜色不同 | 无 |
| A5 圆点大小 | 侧边栏保持 7px，`StatusGlyph` 保持 6px | 只换位置和颜色，不改尺寸 | 统一尺寸：不在本次范围 | 无 |
| A6 提示文字 | 前导列容器保留 `role="status"`、`aria-label="Waiting for approval"`，另加 `title="Waiting for approval"` | 鼠标用户也能看到含义 | 不加 `title`：圆点颜色较浅，含义只能靠猜 | 无 |

## 2.3 具体改动

### `styles/tokens.css`

在 `--warning-border` 后面加：

```css
  /* Waiting for the user: the sidebar and subagent approval dots. */
  --attention: #f2c230;
```

### `sidebar/SessionRow.tsx`

- `lead` 加一个分支，放在 `running` 后面：

```tsx
) : props.session.activity === "awaiting" ? (
  <span
    className="ohb-session-lead"
    role="status"
    aria-label="Waiting for approval"
    title="Waiting for approval"
  >
    <span className="ohb-session-awaiting" aria-hidden="true" />
  </span>
) : null;
```

- `meta` 不再判断 `awaiting`，只剩相对时间。消息时间议题会把相对时间也删掉，见 2.6。
- 文件顶部的组件注释改成：前导列显示运行中点阵或等待审批圆点，行尾显示相对时间。

### `sidebar/sidebar.css`

- `.ohb-session-awaiting` 的 `background` 改成 `var(--attention)`。它现在在前导列里，前导列本身负责居中，这条规则的其他属性不用动。
- 注释 "an amber dot" 改成 "a yellow-orange dot"。

### `shared/shared.css`

- `.ohb-status-dot::before` 的 `background` 改成 `var(--attention)`。
- 上方注释里的 "the sidebar's amber" 改成 "the sidebar's attention dot"。

### `shared/StatusGlyph.tsx`

- 注释里的 "the sidebar's amber dot" 改成 "the sidebar's attention dot"。

### `sidebar/Sidebar.unit.test.tsx`

- 457 行的用例改名为"运行中和等待审批都显示在标题左侧"，断言改成：
  - C 行的 `.ohb-session-lead` 带 `aria-label="Waiting for approval"`，里面有 `.ohb-session-awaiting`。
  - C 行的 `.ohb-session-meta` 里没有圆点。
  - B 行的前导列仍是运行中点阵。前导列总数会变，不再断言总数，改为按 `aria-label` 分别断言 B 行和 C 行。

## 2.4 同步设计文档

路径相对 `docs/ohbaby-web/redesign-2026-10/`。

| 文件 | 位置 | 改成 |
|---|---|---|
| `03-ui-layout-and-style.md` | 色板表 `--warning` 一行 | 用途删掉"等待审批的圆点"；新增一行 `--attention`，用途"等待用户操作的圆点（侧栏、子代理列表）"，值 `#f2c230` |
| `03-ui-layout-and-style.md` | 会话行一节："运行中时，4 个点在 3×3 点阵里跳动。行尾按优先级只显示一项……" | 状态位显示运行中点阵或等待审批圆点；行尾只显示相对时间（消息时间议题再删掉这半句） |
| `03-ui-layout-and-style.md` | 子代理页一节："等审批是琥珀色小点" | 改成"橙黄色小点" |
| `04-interaction-and-states.md` | 会话行状态表 | awaiting：标题左侧状态位显示 `--attention` 圆点；"行尾只显示一项，优先级 awaiting > 时间"删掉 |
| `04-interaction-and-states.md` | 等待审批一行："侧栏该会话行显示琥珀点" | 改成"橙黄点" |
| `05-components.md` | SessionRow 的 Anatomy | 状态位：running 点阵、awaiting 圆点或 moving 转圈；行尾区域只有时间 |
| `08-test-and-acceptance.md` | 两处"琥珀点" | 改成"橙黄点" |

## 2.5 兼容与迁移

没有数据和接口变化。用户能看到的变化是：等待审批的圆点从行尾挪到标题左侧，颜色变黄；子代理列表的等待圆点颜色同步变化。

## 2.6 与消息时间议题的关系

两个议题都改 `SessionRow.tsx` 的 `meta` 和 `sidebar.css` 的行尾规则。建议**先做本议题，再做消息时间**：

- 本议题做完，行尾只剩相对时间。
- 消息时间议题再删掉相对时间，并处理行尾留空后的 hover 让位规则。

如果顺序反过来，后做的一方负责把 `meta` 清理干净。两个议题可以在同一个实施会话里连续做，分两个 commit。

## 2.7 风险与回滚

| 风险 | 应对 |
|---|---|
| `#f2c230` 在浅灰侧边栏上对比度约 1.6:1，低于 WCAG 对非文字元素建议的 3:1 | 用户选定的颜色。圆点有 `aria-label` 和 `title`，审批卡片本身也在消息区显示，圆点不是唯一的信息来源 |
| 圆点和运行中点阵视觉重量不同，切换时行首有轻微变化 | 都在 15px 列里居中，标题位置不变，可以接受 |

改动集中在一个 commit 里，出问题整体回退。

## 2.8 留到以后

- 跨会话等待状态：让非当前会话也显示圆点。需要服务端推送每个会话的审批状态，单独开议题。
