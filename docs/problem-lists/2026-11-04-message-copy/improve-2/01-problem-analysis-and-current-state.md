# 1. 现状与问题分析

> 代码基线：2026-11-07，`main` 分支 `c0c24b4f`（improve-1 与轮次投影前端已合入）。`W/` 表示 `apps/ohbaby-web/src/`，`A/` 表示 `packages/ohbaby-agent/src/`。标“已证实”的结论都有临时测试输出佐证，测试跑完已删除，没有留在仓库里。

## 1.1 问题陈述

1. **长会话里，旧答复还在，复制按钮却消失了。** 答复移出服务端最近 50 条消息的窗口后，Web 仍显示正文，但找不到它所属的轮次，于是 `Copy answer` 和耗时行一起消失。用户先点 `Load earlier messages` 才能找回。
2. **隐藏工具执行后中断，阶段说明被当成了最终答案。** 后端在发给 Web 之前删掉了隐藏工具，Web 看到的是一条纯正文消息，就把它当成了答案。（“阶段说明”即轮次投影文档里的“阶段结论”：模型在调用工具前写的过渡文字。）

两条都是 improve-1 和轮次投影议题的遗漏，前面的修复方向本身没有问题。问题 1 是轮次投影 Stage 2 只缓存了“翻历史”带回的 run，没覆盖“实时被挤出窗口”这条路；问题 2 在 improve-1 时就已存在（当时中断的轮次也会找答案，工具执行完再中断的消息状态是 `completed`，不是 `error`），这次验收才测出来。

## 1.2 已确认的分界

见 [00 §3、§4](00-discussion.md)。

## 1.3 问题 1：Web 没有留住旧消息的 run 和 prompt

### 1.3.1 Web store 的三份缓存

| 缓存 | 谁往里写 | 代码 |
|---|---|---|
| `loaded`（消息） | 每次实时视图更新都写；翻历史时也写 | `W/store/store.ts:388-396`（`setSessionSync`）、`:480-494`（`installSessionHistory`） |
| `loadedRuns` | 只有翻历史时写，且无条件覆盖 | `W/store/store.ts:470-471` |
| `loadedPrompts` | 只有翻历史时写，按 `updatedAt` 比较，跳过未结束的 prompt | `W/store/store.ts:472-479` |

`install()`（`W/store/store.ts:208-266`）把实时视图的 run 和 `loadedRuns` 合起来，实时视图里的副本优先；prompt 同理。Web 不删除被后端挤出窗口的消息，所以旧正文一直显示。

### 1.3.2 后端实时视图只保留窗口内的 run 和 prompt

- run：`trim()` 裁掉 50 条以外的消息时，用 `visibleRuns` 同步裁掉不再被消息引用、也不在运行的 run（`A/adapters/ui-state/source-session-projection.ts:513-560`、`:647-659`）。
- prompt：`trim()` 不碰 prompt。prompt 只在收到 prompt 事件时重新过滤，保留未结束的、用户消息还在窗口里的、或 run 还在视图里的（`source-session-projection.ts:459-483`）。

**已证实**（临时集成测试，真实的 `SourceSessionProjection`）：旧轮次 R0 贴在窗口底部，用户提交新 prompt P1。答复 A0 被挤出时 R0 立刻从视图消失；旧 prompt P0 一直留到 P1 结束的那次 prompt 事件才消失。

### 1.3.3 结果：轮次算不出来

轮次由 SDK 的 `listEndedTurns`（`packages/ohbaby-sdk/src/util/turn.ts`）列出：一轮要么有 run，要么有已结束的 prompt。复制按钮只挂在 `projectRunProcesses` 算出的 `answerId` 上（`W/ui/conversation/ConversationStream.tsx:164-181`）。

**已证实**（临时 store 单元测试）：

| 情况 | 消息 | run | prompt | 是否算出轮次 |
|---|---|---|---|---|
| 普通用户轮次被挤出窗口 | 还在 | 无 | 无 | 否 |
| 子代理轮次被挤出窗口 | 还在 | 无 | 本来就没有 | 否 |
| 对照：只有 prompt 还在 | 还在 | 无 | 有 | 是 |

所以普通用户轮次也会丢按钮，只是比子代理轮次晚一步（要等 prompt 也被筛掉）。子代理轮次没有 prompt，最先暴露。

**推断（未跑测试）**：刷新页面后，旧消息从历史页加载回来，历史页自带 run 和 prompt，按钮会恢复。问题只出现在当前页面内的实时滑动。

### 1.3.4 `loadedRuns` 的覆盖方式

`W/store/store.ts:471` 用历史页里的副本无条件覆盖已有的 run，也不看它是否已结束。历史页读取时的版本不会比实时视图新（`:454-457` 的检查），同一个 run 的历史页副本可能比实时副本旧。prompt 跳过未结束的项，并按 `updatedAt` 比较（`:474-478`）；run 两样都没有。

run 的 `updatedAt` 比不出新旧：后端取的是 `endedAt ?? startedAt ?? createdAt`（`A/adapters/ui-state/persistent-store.ts:360-362`），运行中状态变化时它不变。

缓存的 run 会进入 `snapshot.runs`，除了轮次投影，还被“会话里有没有活动 run”的判断读取（例如 `W/ui/session/prompt-projection.ts` 的 `hasLiveRunForSession`、`W/ui/session/use-stop-request.ts`）。所以缓存里如果留着一份过期的运行中副本，影响的不只是复制按钮。

## 1.4 问题 2：隐藏工具的事实在发给 Web 之前就丢了

### 1.4.1 后端删除隐藏工具

`A/adapters/ui-state/persistent-store.ts:50-54` 定义隐藏名单 `select_tools`、`todo_read`、`todo_write`；`partToUiParts` 遇到这些工具直接返回空（`:187-189`）。消息上不留任何字段说明这一步调用过工具。

**已证实**（临时单元测试）：一条“正文 + `todo_read` + 中断提示”的消息，经 `messageToUiMessage` 投影后只剩正文片段和带 `lifecycle-interruption` 标记的提示片段，状态为 `completed`。

### 1.4.2 实时和重开走同一条路

Web 主会话的实时消息来自 `SourceSessionProjection.project()`，它调用的也是 `messageToUiMessage`（`source-session-projection.ts:236-265`）。主 run 启动投影时传 `projectMessages: false`（`A/adapters/ui-inprocess.ts:4014`），`A/adapters/ui-runtime/run-stream-adapter.ts` 会跳过工具事件（`:733-738`），所以它在 `:468`、`:494` 的隐藏逻辑对 Web 主会话不起作用。

结论：只要在 `messageToUiMessage` 留下事实，实时和重开都能拿到。

### 1.4.3 Web 判定答案

`W/ui/conversation/run-process.ts:54-64` 取这一轮最后一条 AI 消息，满足以下条件就当答案：不在流式输出、没有 `tool-call` 或 `tool-result` 片段、去掉中断提示后正文不为空。阶段说明的工具片段已被后端删掉，三个条件都满足。

**已证实**（临时单元测试）：把上面的消息放进 `interrupted` 或 `cancelled` 的轮次，`answerId` 指向它。

正常成功的轮次不会出问题：调用工具之后模型还会再走一步，阶段说明不会是最后一条。

### 1.4.4 `finishReason` 不够可靠

`message.info.finish` 在模型这一步结束、工具执行之前就已写入（`A/core/lifecycle/lifecycle.ts:961-966`），中断只追加中断提示，不改它。各模型适配层把工具调用的结束原因统一为 `tool_calls`。但 `lifecycle.ts:1064` 也接受“模型报 `stop` 却带着工具调用”的情况，这时值是 `stop`。Web 目前不使用 `finishReason`。

### 1.4.5 隐藏名单有四份

| 位置 | 名单 |
|---|---|
| `A/adapters/ui-state/persistent-store.ts:50` | 三个工具 |
| `A/adapters/ui-runtime/run-stream-adapter.ts:52` | 三个工具 |
| `packages/ohbaby-cli/src/tui/store/events.ts:1607` | 三个工具 |
| `W/ui/conversation/MessageRow.tsx:184-211`（`filterTodoToolMessages`） | 只有 `todo_read`、`todo_write` |

这是已有的重复，本轮不处理（见 [00 §4](00-discussion.md)）。`filterTodoToolMessages` 复制消息时保留其他字段（`{ ...message, parts }`），消息级字段能传到 `run-process`。

## 1.5 测试现状

| 已有测试 | 覆盖 | 缺口 |
|---|---|---|
| `W/store/store.unit.test.ts:67`（轮次投影 T13） | 历史页的 run 在实时视图之后保留 | 实时视图把消息挤出窗口时 run 和 prompt 是否保留 |
| `W/ui/conversation/run-process.unit.test.ts:287`（轮次投影 T11） | 纯正文加中断提示的轮次有答案 | 带隐藏工具的阶段说明 |
| `A/adapters/ui-state/persistent-store.unit.test.ts:210` | 删掉 todo 工具后保留正文 | 删掉后是否留下标记 |
| `A/adapters/ui-persistent.integration.test.ts:1263` | Stop 后的半段正文在重开 SQLite 后仍在 | 隐藏工具后中断、重开后的答案判定 |

没有任何测试同时覆盖“隐藏工具 + 中断 + 答案判定”。

## 1.6 改动影响面

- 问题 1：只动 `W/store/store.ts`。
- 问题 2：`packages/ohbaby-sdk` 的 `UiMessage` 多一个可选字段；`A/adapters/ui-state/persistent-store.ts`；`W/ui/conversation/run-process.ts`；同步 `docs/tools/todo-list/architecture.md` 的“Transcript 静默但保留底层事务”一节。

## 1.7 SWE 原则审视

- **没有新增结构。** 问题 1 让 run、prompt 和消息用同一种缓存方式，消除不对称；问题 2 给已有规则补上它缺的一个事实。
- **信息在源头保留。** 后端是唯一知道“这一步调用过隐藏工具”的地方，事实应在这里留下，客户端不靠猜（`finishReason`）。
- **一条规则只写一份。** 复制按钮继续挂在 `answerId` 上。参考项目里，复制另写一套规则的都出了同类问题（见 [03](03-reference-projects.md)）。
- **不扩大范围。** 隐藏名单的四份重复是存量问题，本轮不碰。

## 1.8 与既有文档关系

| 文档 | 关系 |
|---|---|
| [improve-1](../improve-1/02-optimization-plan-and-change-scope.md) | 本轮修正其“复制哪条回答”的漏洞，不改其余设计 |
| [轮次投影 02 Stage 2](../../2026-11-06-turn-projection/improve-1/02-optimization-plan-and-change-scope.md) | 补上 Web store 实时缓存 run 和 prompt；P3“run 跟着已加载的消息走”在 Web 侧同样成立 |
| [轮次投影 00 §2](../../2026-11-06-turn-projection/improve-1/00-discussion.md) | “沿用工具消息的排除规则”明确包含隐藏工具 |
