# Implementation Plan

本计划只覆盖 improve-3 的实施顺序。编码开始前，以本文件作为执行清单。

## Step 1: Transcript 纯函数与状态模型

文件落点：

- 新建 `packages/ohbaby-cli/src/tui/store/transcript.ts`
- 更新 `packages/ohbaby-cli/src/tui/store/snapshot.ts`
- 更新 `packages/ohbaby-cli/src/tui/store/events.ts`

任务：

- 定义 `TranscriptSplit`：

```ts
export interface TranscriptSplit {
  readonly committedMessages: readonly UiMessage[];
  readonly liveMessage: UiMessage | null;
}
```

- 实现 `splitTranscript(messages, runtime)`，严格按 `02-design.md` 判定表。
- 在 `TuiStoreState` 中加入 `committedMessages` 和 `liveMessage`。
- `createStateFromSnapshot`、`rebuildFromCollections`、`preserveLocalQueues` 都通过同一 helper 重新计算 transcript slices。
- `message.part.delta` 只更新 live message 所在 slice；committed array 引用保持稳定。
- user message 提交后立即进入 committed；不能因为 runtime 为 `running` 被放进 live。
- `snapshot.replaced` 和 active session 切换时丢弃旧 slices。

测试：

- 新增 `store/transcript.unit.test.ts` 覆盖判定表。
- 更新 `store/events.unit.test.ts` 覆盖 committed 引用稳定性和 snapshot 替换。

## Step 2: Selectors 拆分

文件落点：

- 新建 `packages/ohbaby-cli/src/tui/store/selectors/transcript.ts`
- 可选新建 `packages/ohbaby-cli/src/tui/store/selectors/prompt-dock.ts`
- 保留 `packages/ohbaby-cli/src/tui/store/selectors.ts` 作为全局 selector 入口或 re-export。

任务：

- 增加 `selectTranscriptSplit`、`selectCommittedMessages`、`selectLiveMessage`。
- 增加 `selectNoticeLaneState`，只返回全局 `notices`。
- 增加 command notice selector，明确其 session 作用域。
- PromptDock selector 只返回 active session、permission、runtime label、context usage 等输入区需要的字段。

测试：

- selector 单测确认不会返回其他 session 的 context usage 或 transcript。
- delta 更新时 committed selector 结果保持 `Object.is` 稳定。

## Step 3: 组件迁移到 TranscriptViewport

文件落点：

- 新建目录 `packages/ohbaby-cli/src/tui/components/transcript/`
- 新建：
  - `transcript-viewport.tsx`
  - `committed-transcript.tsx`
  - `live-tail.tsx`
  - `notice-lane.tsx`
  - `command-notice-row.tsx` 或等价命名
- 迁移或保留：
  - `components/message/message-row.tsx`
  - `components/message/parts/tool-part.tsx`

任务：

- `app.tsx` 中 `MessageListContainer` 改为 `TranscriptViewportContainer`。
- `TranscriptViewport` 接收 `committedMessages`、`liveMessage`、`notices`、`commandNotices`。
- `CommittedTranscript` 使用 `React.memo`。
- `LiveTail` 使用 `React.memo`，允许 streaming delta 重渲。
- `NoticeLane` 只渲染 `state.notices`。
- 新增 `CommandNoticeLane`，位于 committed 与 live tail 之间。
- command notices 不再混入全局 NoticeLane，也不放入 LiveTail。
- active session 用 `key={activeSessionId ?? "none"}` 重置 viewport。
- 用户验收反馈 PowerShell 输入仍闪后，`CommittedTranscript` 可增加 guarded Static：仅真实 Windows TTY 默认启用，非 TTY/测试保持动态。

测试：

- 组件单测确认 session 替换不残留旧 committed。
- integration 测试确认 command notices 切 session 清空。

## Step 4: 历史用户消息淡色块

文件落点：

- `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- `packages/ohbaby-cli/src/tui/theme/tokens.ts`
- `packages/ohbaby-cli/src/tui/theme/tokens.unit.test.ts` 或现有 theme 测试文件

任务：

- 用户历史消息用 background block 渲染，正文不 dim。
- 多行用户消息每行都应用同一背景。
- 首行左侧保留 `| ` 或等价 accent，续行对齐正文。
- 当前 PromptDock 样式不变。
- theme token 当前已有 `userBlockBg` 和 `userGutter`，本阶段补测试；若视觉不达标，再调整 palette。

测试：

- 用户消息背景、gutter、正文颜色断言。
- 多行续行对齐断言。
- 16 色降级路径可读性断言。

## Step 5: Tool Row 稳定宽度

文件落点：

- `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- `packages/ohbaby-cli/src/tui/components/spinner.tsx`

任务：

- running tool line 前缀宽度与 completed tool line 前缀宽度一致。
- 当前约定：running spinner 宽度为 braille + space，completed 前缀为两个空格。
- completed 后不显示状态图标，不显示 check/cross。

测试：

- `string-width` 或现有可见宽度 helper 断言 running/completed prefix 宽度一致。
- E2E 场景确认 running -> completed 不左移。

## Step 6: 错误恢复和顺序验收

文件落点：

- `packages/ohbaby-cli/src/tui/store/events.ts`
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`
- `tests/integration/tui/`

任务：

- `message.part.delta` 指向不存在 message 时 drop + warning notice。
- active session 变 null 时 transcript 清空。
- 保留后端 run-stream-adapter 的顺序测试。
- 新增 TUI contract 测试确认视觉顺序与 parts 顺序一致。

测试：

- unit + contract + integration 覆盖 user -> assistant text -> tool -> result -> assistant text。
- `/new` 或 `/sessions` 后旧内容不残留。

## Step 7: 验证与子代理审查

命令：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

真实 API key 测试：

- 普通中文问答。
- 工具调用问答。
- 多轮上下文问答。
- session 切换再返回。

子代理审查：

- 架构边界。
- 顺序语义。
- 视觉语义。
- 性能风险。
- 回归风险。

## 实施顺序约束

- 先完成 `splitTranscript` 和 store slices，再迁移组件。
- 先让 tests fail，再实现。
- 不启用无条件 `<Static>`；只允许 Windows TTY guarded Static，并提供 `OHBABY_TUI_STATIC_TRANSCRIPT=0/1` 覆盖。
- 不改 SDK 协议字段。
- 不新增 coalescer。
- 不改变 PromptDock 交互行为。

## Step 8: `/new` 强新窗口与单空会话收尾

文件落点：

- `packages/ohbaby-agent/src/services/session/types.ts`
- `packages/ohbaby-agent/src/services/session/manager.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- `packages/ohbaby-agent/src/commands/builtin.ts`
- `packages/ohbaby-cli/src/tui/app.tsx`
- `packages/ohbaby-cli/src/tui/layout/metrics.ts`
- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- `packages/ohbaby-cli/src/tui/theme/colors.ts`
- `packages/ohbaby-cli/src/tui/theme/tokens.ts`
- `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`
- `packages/ohbaby-cli/src/tui/components/message/parts/tool-part.tsx`

任务：

- 在 session lifecycle 层新增 project-scope empty primary session 查询。
- `/new` 先复用同 project/root 下 empty primary session，没有再创建。
- `/new` 的 command action 带明确来源标记，TUI 只认该标记触发强清屏。
- TUI 写 `\x1b[2J\x1b[3J\x1b[H` 清当前屏幕和 scrollback，并推进 viewport generation。
- Prompt content width cap 从 132 改为 160，PromptDock 保持输入内容在框内。
- 用户历史 prompt 背景调整为克制淡蓝。
- tool name 使用克制 brand gold，tool arg 使用 dim gray，并在渲染层分色。

测试：

- session manager unit：同 project empty primary 可查到；subagent 和不同 project 不匹配。
- ui-inprocess contract：连续 `/new` 复用 empty primary，不创建多个空会话。
- command service unit：`/new` action 带来源标记。
- app contract：`/new` action 写强清屏 ANSI；`/resume` 不清屏。
- layout unit：宽屏 cap 为 160。
- theme/message unit：用户淡蓝块和工具金/灰分色。
