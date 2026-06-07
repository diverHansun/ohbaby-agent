# Design

## 设计决策

采用方案 B：

> `CommittedTranscript` 渲染稳定历史，`LiveTail` 渲染当前流式尾部，`PromptDock` 固定在底部。历史用户 prompt 使用淡色块增强定位。

不把 `<Static>` 作为第一步。`<Static>` 是后续优化工具，不是本阶段目标。直接套 `<Static>` 会放大 `/resume`、`/sessions`、active session 切换时旧内容残留的风险。

## 术语

### Committed Transcript

已提交 transcript 是当前 active session 中稳定的历史消息集合。它满足：

- 不处于 `status: "streaming"`。
- 不包含 pending/running tool call。
- 不属于当前 run 的活跃尾部。
- session 切换时必须整体替换，不能继承上一 session 的内容。

### Live Tail

live tail 是当前仍会变化的消息区域。它包括：

- `status: "streaming"` 的 assistant message。
- 包含 pending/running tool call 的 assistant message。
- 当前 run 尚未完成时的最后 assistant message。
- 刚完成但还需要折叠 reasoning 或合并 tool result 的短暂尾部状态。

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
    LiveTail
    NoticeLane
  DialogManager
  PromptDock
```

### TranscriptViewport

职责：

- 接收 active session 的消息、notice、layout metrics。
- 调用纯函数 `splitTranscript(messages, runtime)` 得到 committed/live 两段。
- 用 `key={activeSessionId}` 或等价 reset 策略隔离 session。
- 暂时保持普通 Ink column，不实现虚拟滚动。

### CommittedTranscript

职责：

- 渲染稳定历史消息。
- 未来可以被替换为 `<Static>` 或 scrollback 实现。
- 本阶段不直接启用 `<Static>`，但接口设计为可替换。

### LiveTail

职责：

- 渲染流式 assistant message、running tool line、reasoning 当前态。
- spinner 只存在于 running/pending tool line。
- 完成后工具行保留固定 leading 占位，避免文字左移跳动。

### MessageRow

职责：

- 根据 message role 和 part type 渲染行。
- 不读取全局 store。
- 不判断 session。
- 不重新排序不同 message。
- 对同一 message 内的 parts 只做局部展示合并：tool call 与 matching result 可合并为一条工具摘要行，但不能改变 text part 与 tool call 的相对位置。

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

## 数据流

```text
SDK UI events
  -> createCoalescedTuiEventDispatcher
  -> TuiStore
  -> selectors
  -> TranscriptViewport / PromptDock / DialogManager
```

改造重点：

- `app.tsx` 不再让根组件订阅过多 state。
- `MessageListContainer` 拆为 `TranscriptViewportContainer`。
- selector 输出应尽量稳定，例如：
  - `selectActiveSessionId`
  - `selectTranscriptMessages`
  - `selectTranscriptSplit`
  - `selectPromptDockState`
  - `selectNoticeLaneState`
- `splitTranscript` 是纯函数，便于单测。

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
- 如果 split 逻辑无法判断 live tail，默认只把最后一个 streaming 或包含 running tool 的 message 放入 live tail，其余归 committed。
- 如果 SDK 事件顺序无法表达正确 UI 顺序，先用测试定位原因，再决定是否扩展 SDK 字段；本阶段不预设新字段。

## 与 `<Static>` 的关系

本阶段先建边界，不启用 `<Static>`。

后续启用条件：

- `CommittedTranscript` 已经不依赖全局动态状态。
- active session 切换测试证明旧内容不会残留。
- `/resume`、`/sessions`、新 session、清空 session 都有 contract 测试。
- streaming tail 不进入 `<Static>`。

