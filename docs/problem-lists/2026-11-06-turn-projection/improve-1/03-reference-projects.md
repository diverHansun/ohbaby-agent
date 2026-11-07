# 3. 参考项目

> 2026-11-06 由子代理读 `code-cli/` 下的本地检出代码整理，代表实施时的源码，不代表各产品最新的官方行为。路径相对各项目根目录。

## 3.1 对比

| 项目 | 有没有保存“一轮”的记录 | 一轮怎么结束 | 最终答案怎么定 | 主代理空闲时被唤醒 | 唤醒那一轮在界面上 |
|---|---|---|---|---|---|
| codex | 有。`TurnStarted`、`TurnComplete` 按 turn ID 配对，记录状态、开始结束时间、耗时（`codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:387-411`，`core/src/tasks/mod.rs:917-950`） | `TurnComplete` 事件 | 最后一次不再需要后续请求的模型输出里最后一条非空回答（`core/src/stream_events_utils.rs:279-300`）；回答带 `FinalAnswer` 等阶段标记 | 子代理的完成回报先入父级收件箱，自身不要求开轮；是否唤醒另看显式触发、等待状态或功能开关（`codex-rs/core/src/agent/control/completion.rs:112-118`、`core/src/session/handlers.rs:89-99`） | 每轮一行 “Worked for Xs”（`tui/src/chatwidget/completion.rs:7-52`） |
| claude-code | 没有，消息是一条链，界面按消息顺序推断 | 一次 `onQuery` 结束 | 复制取最后一条非错误的助手消息（`src/commands/copy/copy.tsx:44-55`） | 后台任务结束时排入一条 `task-notification`，空闲时开启新一轮，消息带 `origin: task-notification`（`src/utils/queueProcessor.ts:59-95`） | 和普通的一轮一样 |
| deepseek-harness | 有。会话日志记录 `turn/start`、`turn/end` 及结束原因（`packages/core/session/src/types.ts:290-305`） | `turn/end` | 最后一步里已定稿、有正文、没有工具调用的回答（`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:151-160`） | 空闲时作为 followup 新开一轮，忙时作为 steer 并入当前一轮（`packages/subagent/subagent/src/manager.ts:1024-1038`） | 显示为“触发节点”，归在用户那次发言之下；复制、fork 挂在每轮的结尾节点上（`conversation-nodes/turn-tail.ts:58-97`） |
| ZCode | 有。每轮一个 header，带 `origin`（`userInput`、`backgroundResult`、`goalContinuation` 等）和状态（`packages/shared/src/zcode-protocol-v4/rows.ts:69-113`） | 运行时的 `TurnComplete` 关闭 header | 服务端决定 fork、重试按钮挂在哪条回答上（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:1287-1401`） | 作为独立的一轮，`origin = backgroundResult` | 有“后台结果”标题，没有用户气泡（`packages/ui/src/v4/ConversationTurnGroup.tsx:1075-1083`） |
| kimi-code | 有。`turn.started` 带 `PromptOrigin`（user、task、cron_job 等），`turn.ended` 持久化（`packages/agent-core-v2/src/agent/loop/turnOps.ts:96-119`） | `turn.ended` | 没有单独记录；TUI 收起时保留最后两条 | 空闲时新开一轮，轮次 ID 加一；忙时并入当前一轮（`human/agent/machine.ts:623-633, 812-818`） | 以任务卡片作为分界（`apps/kimi-code/src/tui/kimi-tui.ts:3861-3886`） |

## 3.2 共同做法

1. **一轮的边界以执行为准，不以用户发言为准。** 除 claude-code 外，四个项目都把轮次的开始和结束保存下来，界面读这个记录，而不是从消息顺序去猜。
2. **每一轮都记下触发来源。** codex 的 `turn_trigger`、ZCode 的 `origin`、kimi-code 的 `PromptOrigin`、claude-code 消息上的 `origin`，都在回答“这一轮是谁开的”。
3. **交付结果和启动主模型可以分开。** Kimi 的后台任务在主代理空闲时可以触发新轮；ZCode 可以把已经到达的多份结果放进同一轮。Codex 的普通完成回报不会无条件叫醒父代理。ohbaby 选择在有结果需要处理时唤醒，不因经过一段时间就启动主模型。
4. **出错后能复制什么，取决于复制入口。** Codex TUI 的历史视图能从已经输出的流式片段生成可复制正文（`codex-rs/tui/src/chatwidget/streaming.rs:136`）。Kimi 的会话级 `/copy` 从后往前找有 `modelText` 标记的非空模型正文（`apps/kimi-code/src/tui/commands/copy.ts:15-21`）。ZCode 的轮尾按钮要求最新助手文本行已定稿，复制时可合并本轮多段文本（`packages/ui/src/v4/ConversationTurnGroup.tsx:1474-1477`、同目录 `ConversationTurnRow.tsx:83-102`）。ohbaby 的按钮挂在具体消息上，只复制本轮最后一条 AI 消息中符合条件的正文。

## 3.3 本议题的借鉴与取舍

| 借鉴 | 来源 | 落点 |
|---|---|---|
| 一轮按执行单位划分，读保存下来的边界 | codex、deepseek-harness、ZCode、kimi-code | 02 §2.2：一轮 = 主会话 run，run 已有持久化的边界 |
| 每轮记录触发来源，取值只有几种 | ZCode `origin`、kimi-code `PromptOrigin`、codex `turn_trigger` | 02 Stage 1：`run_ledger.trigger` 取 `user`、`goal`、`subagent` |
| 唤醒那一轮有自己的标题或标签，不显示用户气泡 | ZCode、deepseek-harness | 02 §2.2：`Subagent update · Total 12s` |
| 最终答案按规则算，不单独保存 | codex、deepseek-harness | 02 Stage 2：检查已结束 run 的最后一条 AI 消息，错误状态也可复制其中已有的正文 |
| 每轮各自有复制入口 | deepseek-harness、ZCode | 消息复制的按钮自然覆盖唤醒轮次 |

不照搬的：

| 不照搬 | 原因 |
|---|---|
| codex 的回答阶段标记（`FinalAnswer` 等） | 要改模型输出协议；我们现有的“最后一条不带工具调用的回答”规则已经够用 |
| deepseek-harness 把唤醒的几轮归进同一次“交流” | 用户选了每次唤醒单独成一轮；合并需要先判断“任务是否真的结束”，留待以后（00 §4） |
| ZCode 由服务端指定按钮位置 | 我们的答案规则在前端一处实现即可，服务端不必知道界面细节 |
| 新开一张“轮次”表 | run 账本已经是这张表，只缺触发来源和对外的结局 |
