# Tests And Acceptance

## 单元测试

新增或更新：

- `splitTranscript`：
  - empty session。
  - 全部 completed 消息。
  - 最后一条 assistant streaming。
  - assistant 包含 pending/running tool call。
  - tool result 后追加 text，整条 message 作为 live 还是 committed 由判定表决定，不切分 parts。
  - active session 替换时不复用旧结果。
  - reasoning-only assistant message。
  - 同一 assistant message 包含多个 pending/running tool call。
  - `snapshot.replaced` 导致 active session 变化时旧 committed/live 全部丢弃。
  - 100 次 `message.part.delta` 后 `committedMessages` 的 `Object.is` 引用保持不变。
  - 用户消息提交后立即进入 committed，runtime 为 `running` 时也不进入 live tail。
  - `message.updated(status=completed)` 且 runtime 已结束后 live tail 转入 committed。
  - runtime 为 `running` 但 message 全部 completed 时，按判定表处理，不让 runtime 独自决定 reasoning 或 split。
  - runtime 为 `waiting-for-permission` 且最后一条 user message 时，live 为 `null`，全部 committed。
  - runtime 为 `waiting-for-permission` 且最后一条 assistant completed、无 pending/running tool 时，live 为 `null`，全部 committed。

- `MessageRow`：
  - 历史用户消息使用淡背景块和左 accent。
  - 用户正文不 dim。
  - 多行用户 prompt 续行对齐。
  - running tool 有 spinner。
  - completed tool 无 spinner，但保留 leading 占位。
  - completed tool row 的 prefix 字符宽度等于 running tool row 的 prefix 字符宽度。
  - reasoning completed 折叠为 `Thought`。

- `theme`：
  - `userBlockBg`、`userGutter` 在 dark/light 和 16 色降级路径均可读。
  - `userBlockBg` 低于 PromptDock 边框视觉权重。
  - 用户历史消息色块不再复用 `surface`，dark/light 使用淡蓝语义背景，16 色降级为稳定蓝底。

- `CommittedTranscript`：
  - `shouldUseStaticTranscript` 在 Windows TTY 下默认启用。
  - 非 TTY 下保持动态渲染，测试和重定向输出不走 Static。
  - `OHBABY_TUI_STATIC_TRANSCRIPT=0/1` 可显式覆盖默认行为。

- `selectors`：
  - prompt dock selector 只输出 PromptDock 需要的字段。
  - transcript selector 只输出 active session 消息。
  - context window usage 不显示其他 session 的缓存。
  - transcript selector 放在 `tui/store/selectors/transcript.ts`。

## 集成测试

新增或更新：

- SDK event -> TuiStore -> TranscriptViewport：
  - user prompt -> assistant text -> tool call -> tool result -> assistant text 的显示顺序稳定。
  - `message.part.delta` 高频合并后只更新 live tail。
  - `message.updated` completed 后 live tail 可转入 committed。
  - session 切换后旧 session 消息不显示。
  - command notices 不进入全局 `NoticeLane`，随 transcript/live tail 显示或在 session 切换时清空。
  - `message.part.delta` 指向不存在的当前 session message 时，drop 并产生 warning notice。

- run stream adapter 已有顺序测试继续保留：
  - tool result 后的 text 仍在 parts 中位于工具之后。
  - TUI 新增一条端到端渲染断言，确认视觉顺序与 parts 顺序一致。

## TUI E2E

使用现有 integration helper 或新增场景：

- 启动 TUI，发送普通 prompt，确认历史用户消息块出现。
- 用户敲回车后立即看到淡色块；assistant 尚未开始 streaming 时，用户消息不消失。
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

## 性能基线

第一版以可测 smoke 为主：

- 1000 条 committed message 下，执行一次 prompt 输入 dispatch 的 reducer 路径耗时应小于 5ms。该测试可先标记 `it.skip`，作为性能债务基线。
- 1000 条 committed message + 1 条 live message 下，执行一次 `message.part.delta` dispatch 路径耗时应小于 2ms。该测试覆盖本阶段 split 工程的核心性能承诺。
- 200 次连续 `message.part.delta` 后，Header 与 PromptDock 不应因 transcript delta 获得新 props。可用测试替身计数、React Profiler 或 why-did-you-render 类工具验证。
- guarded `<Static>` 只进入 Windows TTY committed transcript；后续若扩大范围，必须先比较 ANSI 序列字节数和 frame 间隔。

## Definition Of Done

### Merge Gate

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- `pnpm lint` 通过；若存在历史 warning，需在验收中标明。
- `splitTranscript` 单测覆盖本文件列出的全部 case。
- committed 引用稳定性测试通过。
- TUI E2E 覆盖 prompt、tool、session switch。
- 子代理审查无阻塞项。

### Manual Gate

- 用户在 PowerShell terminal 手动验收历史用户消息、streaming 输出、session 切换。
- 用户在 PowerShell terminal 手动验收 prompt 输入时历史 committed 行不再随每个字符明显重绘。
- 用户在 VS Code terminal 手动验收同样 3 个场景。
- 真实 API key 场景完成并记录结果。
