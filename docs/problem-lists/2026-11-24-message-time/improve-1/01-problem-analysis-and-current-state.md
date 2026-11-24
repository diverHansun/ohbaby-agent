# 1. 现状与问题分析

> 路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。行号是 2026-11-24 的快照。

## 1.1 现状

### 侧边栏的相对时间

```
Sidebar.tsx:126  useMinuteClock() 每分钟给一个 now
      │ now（Sidebar.tsx:226）
SessionList.tsx:31,163
      │ now
SessionRow.tsx:18,132  <small>{relativeTime(updatedAt, now)}</small>
```

- 时间放在行尾的 `.ohb-session-meta` 里。hover、菜单打开或获得焦点时，时间隐藏，位置让给「…」和 pin 按钮（`sidebar/sidebar.css:380-391`）。
- 手机宽度的触屏设备上，时间直接隐藏（`sidebar.css:475-477`）。
- 会话的顺序由服务端按 `updatedAt` 给出，前端不排序，和时间显示无关。
- `sidebar/relative-time.ts` 另有四处在用：设置页归档列表、子代理列表、文件列表、文件预览。

### 消息下方的操作行

- `conversation/MessageActions.tsx` 接收 `{ key, node }[]`，只负责排成一行和控制显隐，不关心里面是什么。
- `conversation/ConversationStream.tsx:443-486` 的 `messageActions` 决定每条消息挂什么：
  - 只有可复制的消息才有操作行：用户消息（压缩摘要除外），以及每一轮的最终回答（`answerRuns`）。正文为空的消息没有操作行。
  - 现在的顺序是「复制 · Fork · 编辑」。Fork 只给回答，编辑只给能编辑的用户消息。
  - 最新一条回答传 `persistent`，常显；其他消息 hover 或获得焦点时显示；触屏设备常显（`conversation/messages.css:443-488`）。
  - 用户消息的操作行靠右（`justify-content: flex-end`），回答的靠左。
- 主会话、子代理页（`session/SubagentConversationBody.tsx`）和 side chat（`side-chat/SideChatPage.tsx`）都用 `ConversationStream`。side chat 没有 Fork 和编辑。

### 时间数据和时区

- 数据库 `message.created_at` 是 `INTEGER`，存毫秒时间戳（`packages/ohbaby-agent/src/services/database/migrations.ts`）。
- 服务端用 `toISOString()` 转成带 `Z` 的 UTC 字符串，放进 `UiMessage.createdAt`；回答另有可选的 `completedAt`（`packages/ohbaby-sdk/src/contract/snapshot.ts:147-149`），但只有实时流会填，持久化映射不带它，刷新后就没了。
- 每一轮都有 `timing.endedAt`（`packages/ohbaby-sdk/src/util/turn.ts`），来自存库的 run 结束时间，刷新前后一致；`timing.recovered` 为真时，结束时间只是恢复程序运行的时间。
- ohbaby 没有自己的时区设置。现有的绝对时间显示都按运行环境的本地时区，比如 `settings/ArchivedSection.tsx:39` 的 `Intl.DateTimeFormat(undefined, …)`。
- `shared/use-minute-clock.ts` 每分钟刷新一次，是现在唯一的时钟 hook。

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 中 | 会话里看不到消息是什么时候发的、什么时候答完的 | 消息只有正文和操作按钮，没有时间 |
| P2 | 低 | 侧边栏相对时间信息量小，还占着行尾 | `3h`、`2d` 只能粗略判断，hover 时还要让位 |
| P3 | 低 | 侧边栏为了相对时间每分钟重绘一次 | `Sidebar.tsx:126` 的 `useMinuteClock` |

## 1.3 根因

时间放错了地方。侧边栏关心的是"哪个会话最近活跃"，这已经由排序表达了，相对时间只是重复。真正需要准确时间的是会话内部，看某条消息什么时候发的，而那里一直没有时间。

## 1.4 分维度诊断

| 维度 | 文档怎么说 | 代码怎么做 | 差距 |
|---|---|---|---|
| 职责 | `MessageActions` 只排一行、只管显隐，内容由调用方给（`05-components.md`） | 一致 | 时间作为一项交给它即可，不用改组件接口 |
| 数据 | `UiMessage` 带 `createdAt` 和可选的 `completedAt` | `completedAt` 只在实时流里有 | 回答改用轮次的 `timing.endedAt`，不用改 SDK 和服务端 |
| 时区 | 没有规定 | 存 UTC 时刻，显示按本地时区 | 无差距，按系统时区显示正好符合用户要求 |
| 性能 | 无明确指标 | 侧边栏每分钟重绘 | 删掉相对时间后可以去掉；消息时间只在跨零点时需要刷新 |
| 交互 | 侧栏 hover 时"行尾时间换成按钮"（`04-interaction-and-states.md`） | 一致 | 删掉时间后，行尾要继续给 hover 按钮留位置 |
| 测试 | `Sidebar.unit.test.tsx:457-489` 断言行尾显示 `3h` | 一致 | 测试要改；新格式化函数要补单测 |

## 1.5 改动时要注意的现有行为

1. **行尾的 `.ohb-session-meta` 还承担 hover 留位。** hover 时「…」绝对定位在右侧，标题靠 meta 的最小宽度（18px，置顶行 hover 时 48px）避开按钮。时间删掉后，meta 要保留成一个空的占位元素，并且一直保持 18px，否则 hover 时标题宽度会跳。
2. **标题滚动动画依赖标题宽度。** `SessionRow.tsx` 在 hover 时按 `titleElement.clientWidth` 计算滚动距离，用 `ResizeObserver` 跟随宽度变化。meta 宽度变化时它会自动重算，不用改。
3. **触屏设备上 hover 按钮不是绝对定位。** `@media (hover: none)` 下按钮是 `position: static`，本身就占位置，不需要 meta 留位。
4. **`relative-time.ts` 和 `useMinuteClock` 不能删。** `relativeTime` 还被归档列表、子代理列表、文件列表、文件预览使用；`useMinuteClock` 还被子代理列表、文件列表、文件预览使用（归档列表有自己的 `now`）。
5. **等待审批圆点议题会改同一块代码。** 它把圆点从 meta 挪到前导列。建议它先做，见 02 §2.6。
6. **测试的时区不固定。** 仓库没有设置 `TZ`，写死 UTC 字符串的断言换一台机器就可能失败。
