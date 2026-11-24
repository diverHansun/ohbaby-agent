# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。

## 2.1 方案总览

分两步：先在消息操作行里加时间，再删掉侧边栏的相对时间。时间是操作行里的一项，交给现有的 `MessageActions`，组件接口不变。

```
回答：   [复制] [Fork] 14:32              ← 时间放最后
用户：                 14:32 [复制] [编辑] ← 靠右，时间放最前

格式（按系统时区）：
  今天   14:32
  今年   11-24 14:32
  往年   2025-11-24 14:32
  悬停   2026-11-24 14:32（title，始终写全）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| A1 时间放哪 | 作为 `MessageActions` 的一项，`key: "time"` | `MessageActions` 本来就只管排列和显隐，内容由调用方给；显隐自动和按钮一致 | 给 `MessageActions` 加 `time` 参数：要改组件接口，没有额外好处 | 时间不是按钮，却在"Message actions"分组里，可以接受 |
| A2 用哪个时间 | 用户消息用 `createdAt`；回答用 `completedAt ?? createdAt` | 用户关心"什么时候发的""什么时候答完的"；kimi-code 也取回答的结束时间 | 回答也用 `createdAt`：长回答会显示开始生成的时间 | 无 |
| A3 格式 | 今天 `HH:mm`，今年 `MM-DD HH:mm`，往年 `YYYY-MM-DD HH:mm`，24 小时制，纯数字 | 用户选定（00 C4、C5）；今年的格式和 TUI 会话列表一致 | 始终写全：每条消息都很长 | 需要一个按天刷新的时钟 |
| A4 时区 | 用 `Date` 的本地取值（`getFullYear` 等），不用 `getUTC*`，不传 `timeZone` | 浏览器按系统时区换算，符合用户要求（00 C7） | 新增 ohbaby 时区设置：没有需求，还要处理两边不一致 | 无 |
| A5 跨零点刷新 | 新增 `shared/use-day-clock.ts`，在本地零点和页面重新可见时检查日期，日期变了才更新 | 页面开着跨天时，昨天的消息要从 `14:32` 变成 `11-23 14:32`；只在日期变化时重绘，不像分钟时钟那样频繁 | 复用 `useMinuteClock`：整个会话流每分钟重绘一次，没必要 | 多一个小 hook |
| A6 时钟放哪 | `ConversationStream` 顶部调用一次，把 `now` 传给每个时间 | 一个会话流只有一个定时器 | 每个时间组件各调一次：消息多时有几百个定时器 | 零点时整个会话流重绘一次 |
| A7 侧边栏行尾 | 删掉时间，`.ohb-session-meta` 保留为空的占位元素：平时宽度 0，hover 时最小 18px，置顶行 48px | hover 按钮是绝对定位的，标题靠它避开按钮，和现在的让位方式一致 | 删掉 meta 元素，改给标题加右内边距：要重写 hover 让位规则 | 多一个空元素 |

## 2.3 分阶段实施

### Stage 1：消息时间

**新建 `conversation/message-time.ts`**，两个纯函数：

```ts
const pad = (value: number): string => String(value).padStart(2, "0");

/** Minute-level time for a message row, in the system time zone:
 *  `14:32` today, `11-24 14:32` this year, `2025-11-24 14:32` before. */
export function formatMessageTime(iso: string, now: number): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return "";
  const today = new Date(now);
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const day = `${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  if (time.getFullYear() !== today.getFullYear())
    return `${String(time.getFullYear())}-${day} ${clock}`;
  if (time.getMonth() === today.getMonth() && time.getDate() === today.getDate())
    return clock;
  return `${day} ${clock}`;
}

/** The full form for the tooltip: `2026-11-24 14:32`. */
export function formatFullMessageTime(iso: string): string;
```

**新建 `shared/use-day-clock.ts`**：

- 返回 `now: number`。
- 用 `setTimeout` 定到下一个本地零点之后 1 秒。下一个零点用 `new Date(年, 月, 日 + 1)` 算，夏令时也不会算错。
- 监听 `visibilitychange`。页面重新可见时，如果本地日期已经变了，就更新 `now`。电脑睡眠时定时器可能延后，这一步兜底。
- 日期没变时不调用 `setNow`，避免无意义的重绘。

**新建 `conversation/MessageTime.tsx`**：

```tsx
<time className="ohb-message-time" dateTime={iso} title={formatFullMessageTime(iso)}>
  {formatMessageTime(iso, now)}
</time>
```

**改 `conversation/ConversationStream.tsx`**：

- 组件顶部调用 `const now = useDayClock();`，放在其他 hook 旁边，不能放在条件分支里。
- `messageActions` 里生成时间项：用户消息取 `createdAt`，回答取 `completedAt ?? createdAt`。格式化结果为空（时间无法解析）时不加这一项。
- 排列顺序：
  - 用户消息：`[时间, 复制, 编辑]`
  - 回答：`[复制, Fork, 时间]`
- `messageActions` 返回 `null` 的条件不变：不可复制或正文为空的消息，仍然没有操作行，也就没有时间。

**改 `conversation/messages.css`**，在 `.ohb-message-action` 后面加：

```css
/* Minute-level time in the action row (message time topic). */
.ohb-message-time {
  color: var(--text-dim);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  padding: 0 6px;
  white-space: nowrap;
}
```

完成定义：04 的 F 组、R 组，以及 B-1 到 B-4 通过。

### Stage 2：删掉侧边栏时间

**`sidebar/SessionRow.tsx`**

- 删掉 `relativeTime` 的 import、`now` 参数和 `meta` 变量。
- 行尾渲染成空的占位：`<span className="ohb-session-meta" aria-hidden="true" />`。
- 组件顶部注释改成：前导列显示状态，行尾为 hover 按钮留位。

**`sidebar/SessionList.tsx`**：删掉 `now` 参数和往下传的 `now={props.now}`。

**`sidebar/Sidebar.tsx`**：删掉 `useMinuteClock` 的 import、`const now = useMinuteClock();` 和 `now={now}`。

**`sidebar/sidebar.css`**

- `.ohb-session-meta` 的 `min-width` 从 `18px` 改成 `0`。
- 删掉 `.ohb-session-meta > small`、`.ohb-session-row.ohb-session-active .ohb-session-meta > small` 两条规则。
- 把"hover 时隐藏时间"那条规则（选择器以 `> small` 结尾）改成"hover 时撑开占位"：

```css
/* Room for the hover buttons, which sit over the end of the row. */
.ohb-session-row:hover .ohb-session-meta,
.ohb-session-row.is-menu-open .ohb-session-meta,
.ohb-session-row:focus-within .ohb-session-meta {
  min-width: 18px;
}
```

- 置顶行 48px 的规则保留不动。它的选择器多一个 `.is-pinned`，优先级更高，能覆盖 18px。
- 删掉手机媒体查询里的 `.ohb-session-meta > small { display: none; }`。
- 文件里"Session row: single line, title and a faint relative time."的注释改成"Session row: single line, a status column and the title."。

**`sidebar/Sidebar.unit.test.tsx`**：457 行用例里关于 `3h` 和 `small` 的断言删掉，改成断言 `.ohb-session-meta` 没有文字内容。如果不再需要假时间，`vi.useFakeTimers` 也一起删掉。

完成定义：04 的 B-5 到 B-7 通过。

### Stage 3：同步设计文档

路径相对 `docs/ohbaby-web/redesign-2026-10/`。

| 文件 | 位置 | 改成 |
|---|---|---|
| `03-ui-layout-and-style.md` | 会话行一节，行尾的描述 | 行尾不显示时间，只在 hover 时出现操作按钮 |
| `03-ui-layout-and-style.md` | 消息操作栏一节："现在只有复制，以后撤销和 fork 的按钮也放这里" | 操作栏有复制、Fork、编辑和一个精确到分钟的时间；写明格式和时区规则 |
| `04-interaction-and-states.md` | 会话行状态表："hover：……行尾时间换成归档和菜单按钮" | "hover：行尾出现菜单按钮"，删掉"行尾只显示一项"的优先级 |
| `05-components.md` | SessionRow 的 Anatomy | 行尾区域只有 hover 按钮 |
| `05-components.md` | MessageActions 一节 | 补一句：时间也作为一项交给它，用户消息放最前，回答放最后 |
| `06-data-api-and-state.md` | `updatedAt: string; // 显示为相对时间` | 注释改成"用于排序" |

等待审批圆点议题也改 `03` 会话行和 `04` 状态表的同一句话。后做的议题负责把这句话改成最终的样子。

## 2.4 兼容与迁移

没有数据、接口和 SDK 变化。用户能看到的变化是：侧边栏行尾不再有时间；消息操作行多了时间。

## 2.5 风险与回滚

| 风险 | 应对 |
|---|---|
| 跨零点后日期没刷新 | 零点定时器加 `visibilitychange` 兜底；单测覆盖跨零点 |
| 测试在不同时区结果不同 | 测试输入用本地时间构造，比如 `new Date(2026, 10, 24, 14, 32).toISOString()` |
| 删掉时间后，hover 时标题和按钮重叠 | 2.3 保留 meta 占位，04 的 B-6 专门检查 |
| 操作行变宽，在窄的 side chat 里挤 | 时间最长 16 个字符，加两三个 24px 按钮，宽度在 side chat 内够用；04 的 B-4 检查 |

两个 Stage 分别提交，出问题单独回退。

## 2.6 与其他议题的关系

- [等待审批圆点](../../2026-11-24-approval-dot/README.md)：两个议题都改 `SessionRow.tsx` 的行尾和 `sidebar.css` 的行尾规则。建议先做圆点议题，它把圆点移出行尾后，本议题 Stage 2 只需要处理时间。如果顺序反过来，后做的一方负责把 meta 清理干净。

## 2.7 留到以后

- 没有操作行的消息（压缩摘要、空回答）不显示时间。如果以后需要，再单独考虑。
