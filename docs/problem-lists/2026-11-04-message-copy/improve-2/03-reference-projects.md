# 3. 参考项目

> 2026-11-07 由四个子代理只读调研，主代理核对了关键代码。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。kimi-code 的 Web 端源码不在仓库里，只能读压缩后的产物，相关结论可信度较低。

## 3.1 调研问题

1. 隐藏的工具在哪一层隐藏：服务端不发出，还是客户端拿到数据后不画？
2. 怎么判断一轮的最终答案或复制对象？后面跟着工具调用的文字算不算答案？
3. 中断的轮次给不给复制？
4. 长会话里，还在显示的消息，所属轮次的信息是否一起保留？

## 3.2 四家做法对照

| 项目 | 隐藏工具 | 判断最终答案 | 中断的轮次 | 进度句会不会被当答案 |
|---|---|---|---|---|
| codex | 纯内部工具（tool_search）核心层不发事件；计划工具走单独通知，不进消息流 | 核心层：这一步调用了任何工具就要继续，不算答案（`codex-rs/core/src/session/turn.rs:751-752`）；消息另带 `phase`，app-server 只选非 commentary 的消息（`codex-rs/app-server/src/thread_state.rs:240-248`） | 没有最终答案（`codex-rs/app-server/src/bespoke_event_handling.rs:1606-1626`，`last_agent_message: None`） | 不会 |
| deepseek-harness | 不隐藏，工具调用完整发给客户端 | 折叠：最后一步带工具调用就不是答案（`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts:157-162`）；复制：取最后一个有正文的步骤，不看工具（`turn-tail.ts:58-76`） | 照样给复制 | 会（复制那套规则） |
| kimi-code | 不隐藏，Todo 画成可见卡片 | VS Code 复制最后一步的全部文字，不看工具（`apps/vscode/webview-ui/src/components/ChatMessage.tsx:248-258`）；Web 端有“文字后面出现工具就作废”的规则，但最新一轮会退回到最后一段文字 | 照样给复制 | 会 |
| ZCode | 数据留在客户端，界面上不画 Todo 行（`packages/ui/src/v4/ConversationRowView.tsx:2430-2440`） | 优先取服务端授予操作权限的那行文字，否则要求这一轮最后一行是文字（`packages/ui/src/v4/conversationTurnRenderUnits.ts:258-268`） | 中断的文字不给复制 | 可能会：“可重试”权限不检查后面是否还有工具，会绕过兜底（推断，没有测试覆盖） |

## 3.3 可借鉴点

| 项目 | 做法 | 本项目取舍 |
|---|---|---|
| codex | “这一步还要继续”这个事实在源头记录，客户端不靠看工具片段来判断 | **采用**：后端投影时留下 `hiddenToolCalls` |
| codex、deepseek-harness（折叠）、kimi-code（Web） | 调用过工具的步骤不算答案 | **采用**：规则本来就是这条，补上隐藏工具 |
| deepseek-harness、ZCode、codex | 轮次信息跟着显示中的内容一起保留（连续事件窗口、每行带 `turnId`、按轮次保存） | **采用**：问题 1 让 run 和 prompt 跟着显示中的消息走 |

## 3.4 明确不借鉴

- **工具数据照发给客户端、由界面隐藏**（deepseek-harness、kimi-code、ZCode）：方向合理，但对本项目意味着重新划分后端、Web、TUI、导出的隐藏职责，留到以后统一隐藏层时再议。
- **中断的轮次没有最终答案**（codex）：与用户已确认的“Stop 后可复制半段正文”冲突。
- **复制另用一套宽松规则**（deepseek-harness 的 turn-tail、kimi-code 的 VS Code 与 TUI、codex 的 TUI `/copy`）：这正是它们出现同类问题的原因。

## 3.5 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 后端留标记 | codex |
| 调用过工具就不是答案 | codex、deepseek-harness、kimi-code |
| 复制只认 `answerId` | deepseek-harness、kimi-code 的反例 |
| run 和 prompt 跟着消息缓存 | deepseek-harness、ZCode、codex |
