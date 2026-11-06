# 3. 参考项目

> 2026-11-06 由子代理读 `code-cli/` 下的本地检出代码整理，代表实施时的源码，不代表各产品最新的官方行为。路径相对各项目根目录。

## 3.1 对比

| 项目 | 有没有保存“一轮”的记录 | 一轮怎么结束 | 最终答案怎么定 | 主代理空闲时被唤醒 | 唤醒那一轮在界面上 |
|---|---|---|---|---|---|
| codex | 有。`TurnStarted`、`TurnComplete` 按 turn ID 配对，记录状态、开始结束时间、耗时（`codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs:387-411`，`core/src/tasks/mod.rs:917-950`） | `TurnComplete` 事件 | 最后一次不再需要后续请求的模型输出里最后一条非空回答（`core/src/stream_events_utils.rs:279-300`）；回答带 `FinalAnswer` 等阶段标记 | 新开一轮，新 ID，记录 `turn_trigger`、`parent_turn_id`、`root_turn_id`（`protocol/src/turn_input.rs:83-89`） | 每轮一行 “Worked for Xs”（`tui/src/chatwidget/completion.rs:7-52`） |
| claude-code | 没有，消息是一条链，界面按消息顺序推断 | 一次 `onQuery` 结束 | 复制取最后一条非错误的助手消息（`src/commands/copy/copy.tsx:44-55`） | 后台任务结束时排入一条 `task-notification`，空闲时开启新一轮，消息带 `origin: task-notification`（`src/utils/queueProcessor.ts:59-95`） | 和普通的一轮一样 |
| deepseek-harness | 有。会话日志记录 `turn/start`、`turn/end` 及结束原因（`packages/core/session/src/types.ts:290-305`） | `turn/end` | 最后一步里已定稿、有正文、没有工具调用的回答（`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:151-160`） | 空闲时作为 followup 新开一轮，忙时作为 steer 并入当前一轮（`packages/subagent/subagent/src/manager.ts:1024-1038`） | 显示为“触发节点”，归在用户那次发言之下；复制、fork 挂在每轮的结尾节点上（`conversation-nodes/turn-tail.ts:58-97`） |
| ZCode | 有。每轮一个 header，带 `origin`（`userInput`、`backgroundResult`、`goalContinuation` 等）和状态（`packages/shared/src/zcode-protocol-v4/rows.ts:69-113`） | 运行时的 `TurnComplete` 关闭 header | 服务端决定 fork、重试按钮挂在哪条回答上（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.ts:1287-1401`） | 作为独立的一轮，`origin = backgroundResult` | 有“后台结果”标题，没有用户气泡（`packages/ui/src/v4/ConversationTurnGroup.tsx:1075-1083`） |
| kimi-code | 有。`turn.started` 带 `PromptOrigin`（user、task、cron_job 等），`turn.ended` 持久化（`packages/agent-core-v2/src/agent/loop/turnOps.ts:96-119`） | `turn.ended` | 没有单独记录；TUI 收起时保留最后两条 | 空闲时新开一轮，轮次 ID 加一；忙时并入当前一轮（`human/agent/machine.ts:623-633, 812-818`） | 以任务卡片作为分界（`apps/kimi-code/src/tui/kimi-tui.ts:3861-3886`） |

## 3.2 共同做法

1. **一轮的边界以执行为准，不以用户发言为准。** 除 claude-code 外，四个项目都把轮次的开始和结束保存下来，界面读这个记录，而不是从消息顺序去猜。
2. **每一轮都记下触发来源。** codex 的 `turn_trigger`、ZCode 的 `origin`、kimi-code 的 `PromptOrigin`、claude-code 消息上的 `origin`，都在回答“这一轮是谁开的”。
3. **空闲时被唤醒就新开一轮；正在运行时就并入当前一轮。** 五个项目在这一点上完全一致。
4. **最终答案不需要单独保存**，在一轮结束后按“最后一条有正文、没有工具调用的回答”算出来。只有 ZCode 让服务端直接指定按钮挂在哪条回答上。

## 3.3 本议题的借鉴与取舍

| 借鉴 | 来源 | 落点 |
|---|---|---|
| 一轮按执行单位划分，读保存下来的边界 | codex、deepseek-harness、ZCode、kimi-code | 02 §2.2：一轮 = 主会话 run，run 已有持久化的边界 |
| 每轮记录触发来源，取值只有几种 | ZCode `origin`、kimi-code `PromptOrigin`、codex `turn_trigger` | 02 Stage 1：`run_ledger.trigger` 取 `user`、`goal`、`subagent` |
| 唤醒那一轮有自己的标题或标签，不显示用户气泡 | ZCode、deepseek-harness | 02 §2.2：`Subagent update · Total 12s` |
| 最终答案按规则算，不单独保存 | codex、deepseek-harness | 02 Stage 2：沿用现有的答案规则，只是挂到 run 上 |
| 每轮各自有复制入口 | deepseek-harness、ZCode | 消息复制的按钮自然覆盖唤醒轮次 |

不照搬的：

| 不照搬 | 原因 |
|---|---|
| codex 的回答阶段标记（`FinalAnswer` 等） | 要改模型输出协议；我们现有的“最后一条不带工具调用的回答”规则已经够用 |
| deepseek-harness 把唤醒的几轮归进同一次“交流” | 用户选了每次唤醒单独成一轮；合并需要先判断“任务是否真的结束”，留待以后（00 §4） |
| ZCode 由服务端指定按钮位置 | 我们的答案规则在前端一处实现即可，服务端不必知道界面细节 |
| 新开一张“轮次”表 | run 账本已经是这张表，只缺触发来源和对外的结局 |
