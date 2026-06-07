# Design

## 设计决策

采用方案 B：

> `CommittedTranscript` 渲染稳定历史，`LiveTail` 渲染当前流式尾部，`PromptDock` 固定在底部。历史用户 prompt 使用淡色块增强定位。

第一步不直接把所有 transcript 套进 `<Static>`；先建立 committed/live 边界。用户验收后补一个 guarded Static 收尾：真实 Windows TTY 默认把 `CommittedTranscript` 放入 `<Static>`，用于降低 PowerShell 输入时的动态区重绘；非 TTY、测试环境、重定向输出仍保持动态渲染，避免 `/resume`、`/sessions`、active session 切换时旧内容残留污染 contract。

## 术语

### Committed Transcript

已提交 transcript 是当前 active session 中稳定的历史消息集合。它满足：

- 不处于 `status: "streaming"`。
- 不包含 pending/running tool call。
- 不属于当前 run 的活跃尾部。
- 在连续 `message.part.delta` 下保持数组引用稳定。
- session 切换时必须整体替换，不能继承上一 session 的内容。

### Live Tail

live tail 是当前仍会变化的消息区域。它包括：

- `status: "streaming"` 的 assistant message。
- 包含 pending/running tool call 的 assistant message。
- 当前 run 尚未完成，且最后一条 message 是 assistant 时的尾部 message。
- 刚完成但还需要折叠 reasoning 或合并 tool result 的短暂尾部状态。
- user message 不进入 live tail；用户敲回车后立即进入 committed transcript，保证历史 prompt 淡色块立即可见。

### PromptDock

PromptDock 是输入区和状态区：

- 当前输入框有边框和背景。
- 右侧显示 context window usage。
- 状态行显示 mode、permission、session。
- 不显示草稿 token。

## 组件边界

建议组件结构：

```text
AppShell
  Header
  TranscriptViewport
    CommittedTranscript
    CommandNoticeLane
    LiveTail
    NoticeLane
  DialogManager
  PromptDock
```

### TranscriptViewport

职责：

- 接收 active session 的消息、notice、layout metrics。
- 接收 pre-computed 的 `committedMessages` 和 `liveMessage` props。
- split 逻辑由 store 在 `rebuildFromCollections` 时完成。
- `TranscriptViewport` 不自行调用 `splitTranscript`。
- 用 `key={activeSessionId}` 或等价 reset 策略隔离 session。
- 暂时保持普通 Ink column，不实现虚拟滚动。
- 不持有跨 session 的隐式缓存。
- 不决定 part-level 顺序；part 合并由 `MessageRow` 负责。

### CommittedTranscript

职责：

- 渲染稳定历史消息。
- 默认保持可替换动态渲染；真实 Windows TTY 下使用 guarded `<Static>` 降低 PowerShell prompt 输入重绘。
- 后续仍可替换为真正 scrollback 实现。
- 用 `React.memo` 或等价方式保护 committed 区域。
- props 中的 committed message array 在 live tail delta 下必须保持引用稳定。

### LiveTail

职责：

- 渲染流式 assistant message、running tool line、reasoning 当前态。
- spinner 只存在于 running/pending tool line。
- 完成后工具行保留固定 leading 占位，避免文字左移跳动。
- running 行的前缀宽度必须与 completed 行前缀宽度一致。当前约定为 running spinner 占 2 cell，completed 用两个空格占位。

### CommandNoticeLane

职责：

- 渲染 `state.commandNotices`。
- 位于 `CommittedTranscript` 与 `LiveTail` 之间。
- 不属于 `LiveTail`，避免 command notice 与 streaming assistant/tool 职责混杂。
- session 切换时沿用 store 现有清空策略。

### MessageRow

职责：

- 根据 message role 和 part type 渲染行。
- 不读取全局 store。
- 不判断 session。
- 不重新排序不同 message。
- 对同一 message 内的 parts 只做局部展示合并：tool call 与 matching result 可合并为一条工具摘要行，但不能改变 text part 与 tool call 的相对位置。
- `splitTranscript` 永远不切分 message.parts，只按 message 粒度划分 committed/live。
- 如果以后需要把单个 message 的部分内容固化，必须先引入独立的 part transcript 设计，不能把该逻辑塞进 `splitTranscript`。

## splitTranscript 判定表

`splitTranscript(messages, runtime)` 是纯函数，返回：

```ts
{
  committedMessages: readonly UiMessage[];
  liveMessage: UiMessage | null;
}
```

第一版只支持一个 live message，不切分 parts。

| runtime.status | lastMessage.role | lastMessage 状态 | liveMessage | committedMessages |
| --- | --- | --- | --- | --- |
| `idle` | any | any | `null` | `messages` |
| `running` | `assistant` | `status === "streaming"` 或包含 pending/running tool | `last` | `messages.slice(0, -1)` |
| `running` | `assistant` | 全 completed，包括已折叠 reasoning | `last`，短暂等待 run 完成 | `messages.slice(0, -1)` |
| `running` | `user` | any | `null` | `messages` |
| `waiting-for-permission` | any | 包含 pending/running tool | `last` | `messages.slice(0, -1)` |
| `waiting-for-permission` | `user` | any | `null` | `messages` |
| `waiting-for-permission` | `assistant` | completed 且无 pending/running tool | `null` | `messages` |
| `error` | any | any | `null` | `messages` |

判定优先级：

1. 首选 `message.status === "streaming"`。
2. 其次检查 `message.parts[*].type === "tool-call"` 且 `call.status` 为 `pending` 或 `running`。
3. 只有在 message 状态缺失时，才使用 runtime 作为 fallback。
4. runtime 为 `running` 但 messages 全部 completed 时，不强行把 completed assistant 放入 live tail，除非它是最后一条 assistant 且 run 尚未完成。
5. user message 永远不因 runtime 为 `running` 进入 live tail。

必须满足的 invariant：

- 连续 100 次 `message.part.delta` 只改变 `liveMessage`，`committedMessages` 保持 `Object.is` 引用稳定。
- active session 变化或 `snapshot.replaced` 后，旧 `committedMessages` 与 `liveMessage` 必须丢弃，由新 snapshot 重建。
- `splitTranscript` 不处理 notices，不处理 command notices，不渲染任何 UI。

## 历史用户消息样式

历史用户 prompt 使用淡色块，不再只依靠竖线：

- 背景：`theme.message.userBlockBg`，保持低对比。
- 左侧：`theme.message.userGutter` 或后续新增 `userAccent`。
- 正文：`theme.role.user`，不 dim。
- 圆角不适用于终端；使用 padding 和背景即可。
- 不显示 `you`、`user`、`prompt` 等文字标签。
- 多行 prompt 的背景块覆盖每一行，续行缩进与首行正文对齐。

当前 PromptDock 仍然比历史用户消息更突出：

- PromptDock 保留边框。
- 历史用户消息不使用边框。
- 历史用户消息背景应比 PromptDock 更弱。

量化规则：

- `theme.message.userBlockBg` 必须贴近 page background；dark 模式下相对 page background 的感知亮度差异应小于约 4%。
- `theme.border` 与 `userBlockBg` 的感知亮度差异应至少约 6%，保证 PromptDock 边框更突出。
- `theme.spinner` 颜色不得与 `userBlockBg` 同色相，避免 16 色降级路径下混成一块。
- 16 色或低 color level 下必须回退到可读 ANSI 色名，不允许出现白底白字。

## 数据流

```text
SDK UI events
  -> createCoalescedTuiEventDispatcher  (合并相邻 message.part.delta 为单次 dispatch)
  -> TuiStore.dispatchMany
  -> state.committedMessages / state.liveMessage
  -> memoized selectors
  -> TranscriptViewport
      CommittedTranscript  (React.memo，只在 activeSessionId 或 committed 引用变化时重渲)
      CommandNoticeLane    (React.memo，只随 commandNotices 变化)
      LiveTail             (React.memo，可随 delta 重渲)
      NoticeLane           (React.memo，只随 notices 变化)
  -> PromptDock / DialogManager
```

改造重点：

- `app.tsx` 不再让根组件订阅过多 state。
- `MessageListContainer` 拆为 `TranscriptViewportContainer`。
- `HeaderContainer` 保持现有 `state.messages.length === 0` 订阅即可；它只在长度或 session 切换时变化，不参与 committed/live 切分优化。
- 在 `TuiStoreState` 中拆出 `committedMessages: readonly UiMessage[]` 和 `liveMessage: UiMessage | null`，让 delta 只更新 live slice。
- selector 输出应尽量稳定，例如：
  - `selectActiveSessionId`
  - `selectTranscriptMessages`
  - `selectTranscriptSplit`
  - `selectPromptDockState`
  - `selectNoticeLaneState`
- `splitTranscript` 是纯函数，便于单测。
- transcript 相关 selector 放在 `tui/store/selectors/transcript.ts`，避免单个 `selectors.ts` 继续膨胀。
- `tui/store/selectors.ts` 保留 context window、runtime 等全局 selector。

### Notice 归属

notice 分两类处理：

- `state.notices` 是全局/后端 UI notice，例如 startup warning、context unavailable，进入 `NoticeLane`。
- `state.commandNotices` 是命令执行结果，属于会话作用域提示。第一版不放入全局 `NoticeLane`，也不放入 `LiveTail`；由 `CommandNoticeLane` 单独渲染。

session 切换时：

- command notices 继续按现有逻辑清空。
- UI notices 可保留，但不能伪装成某个 session 的历史消息。

## 顺序规则

message-level：

- snapshot 合并仍按 `createdAt` 排序。
- 同一 active session 的追加事件不能被前端重新排序。
- 如果出现相同 `createdAt`，应保留已有数组顺序作为 tie-breaker；是否调整 store 由测试结果决定。

part-level：

- text part 按原始 parts 顺序显示。
- running tool call 显示 spinner + tool label。
- completed tool call/result 合并为工具摘要行，位置以 tool call 所在位置为准。
- tool result 不应单独漂到后续 text 之后。
- tool result 后再来的 text 必须显示在工具摘要行之后。

reasoning：

- streaming 时显示灰色 reasoning 内容。
- run 完成后自动折叠为一行 `Thought`。
- 不能用 runtime idle/running 推断所有 reasoning 状态；优先使用 message/part 状态。

## 错误与恢复

- active session 切换时 transcript view 必须 reset。
- context window usage 刷新失败仍沿用 improve-1 决策：当前 session 自己的旧缓存可保留，并发 warning notice；无缓存则右侧留空。
- 如果 `message.part.delta` 的 `messageId` 在当前 session 不存在，静默 drop，并发 warning notice。
- `snapshot.replaced` 触发时旧 live tail 直接丢弃，旧 committed 也丢弃，等待新 snapshot 提供。
- session 删除导致 `activeSessionId` 变为 `null` 时，`TranscriptViewport` 渲染空态或 `select a session` hint。
- dispatcher/coalescer 捕获 SDK 上游报错时，保留当前 frame，并通过 `runtime.updated` 发出 recoverable error。
- 如果 SDK 事件顺序无法表达正确 UI 顺序，先用测试定位原因，再决定是否扩展 SDK 字段；本阶段不预设新字段。

## 与 `<Static>` 的关系

本阶段主体仍是先建边界；`<Static>` 只作为 PowerShell 闪烁反馈后的 guarded 收尾启用。

启用规则：

- `CommittedTranscript` 已经不依赖全局动态状态。
- 真实 Windows TTY 默认启用 committed Static，减少 prompt 输入时历史行参与动态重绘。
- 非 TTY、测试、重定向输出保持动态渲染，保证 contract 测试可以验证 active session 替换不残留旧 committed 行。
- `OHBABY_TUI_STATIC_TRANSCRIPT=0` 可关闭；`OHBABY_TUI_STATIC_TRANSCRIPT=1` 可强制开启。
- streaming tail 不进入 `<Static>`。
- 后续若扩展到所有终端，必须先补 active session 清屏/视口代际策略，并比较 ANSI 序列字节数和 frame 间隔。
