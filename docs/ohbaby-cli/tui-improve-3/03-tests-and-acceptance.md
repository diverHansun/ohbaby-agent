# Tests And Acceptance

## 单元测试

新增或更新：

- `splitTranscript`：
  - empty session。
  - 全部 completed 消息。
  - 最后一条 assistant streaming。
  - assistant 包含 pending/running tool call。
  - tool result 后追加 text。
  - active session 替换时不复用旧结果。

- `MessageRow`：
  - 历史用户消息使用淡背景块和左 accent。
  - 用户正文不 dim。
  - 多行用户 prompt 续行对齐。
  - running tool 有 spinner。
  - completed tool 无 spinner，但保留 leading 占位。
  - reasoning completed 折叠为 `Thought`。

- `selectors`：
  - prompt dock selector 只输出 PromptDock 需要的字段。
  - transcript selector 只输出 active session 消息。
  - context window usage 不显示其他 session 的缓存。

## 集成测试

新增或更新：

- SDK event -> TuiStore -> TranscriptViewport：
  - user prompt -> assistant text -> tool call -> tool result -> assistant text 的显示顺序稳定。
  - `message.part.delta` 高频合并后只更新 live tail。
  - `message.updated` completed 后 live tail 可转入 committed。
  - session 切换后旧 session 消息不显示。

- run stream adapter 已有顺序测试继续保留：
  - tool result 后的 text 仍在 parts 中位于工具之后。
  - TUI 新增一条端到端渲染断言，确认视觉顺序与 parts 顺序一致。

## TUI E2E

使用现有 integration helper 或新增场景：

- 启动 TUI，发送普通 prompt，确认历史用户消息块出现。
- 发送会触发工具调用的 prompt，确认 running spinner 出现，完成后只留工具名称/摘要。
- 触发一段 streaming assistant 输出，确认 Header/Logo 不出现重复或旧内容残留。
- `/sessions` 或 `/new` 后确认旧 session transcript 不残留。
- 窄屏下历史用户消息块整体缩放，文本不越界。

## 真实 API 测试

实施完成后使用 `.env` 中真实 API key 执行：

- 普通中文问答。
- 工具调用问答。
- 多轮上下文问答，观察 context window usage。
- 中途切换 session，再回到原 session，确认缓存和 transcript 都属于对应 session。

## 子代理检查点

实施完成后派发子代理审查：

- 架构边界：TranscriptViewport、CommittedTranscript、LiveTail、PromptDock 是否职责清晰。
- 顺序语义：message-level 和 part-level 顺序是否有测试覆盖。
- 视觉语义：历史用户消息是否清楚但不抢当前 PromptDock。
- 性能风险：streaming delta 是否仍导致无关组件高频重渲染。
- 回归风险：slash command、permission dialog、context window usage、notice lane 是否未被破坏。

## 验收标准

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- `pnpm lint` 通过；若存在历史 warning，需在验收中标明。
- TUI E2E 覆盖 prompt、tool、session switch。
- 子代理审查无阻塞项。
- 用户在 PowerShell 和 VS Code terminal 中手动验收历史用户消息、streaming 输出、session 切换。

