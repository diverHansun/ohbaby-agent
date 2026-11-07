# 1. 现状与问题分析

> 代码基线：2026-11-06，`main` 分支 `983b8ca6`（会话存储区与 Files 页已合入）。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`，`K/` = `packages/ohbaby-sdk/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。

## 1.1 run、turn、step、call 在代码里的对应

| 层 | 代码 | 说明 |
|---|---|---|
| run | `run_ledger` 表；`A/runtime/run-ledger/`；`A/runtime/run-manager/worker.ts` | 一次执行。worker 对每个 run 只建一次 lifecycle 循环（`worker.ts:240-256`） |
| turn | `A/core/lifecycle/lifecycle.ts` 的 `Lifecycle.run` | 只在第一次准备好上下文时发 `turn:start`（`lifecycle.ts:633-645`），结束时发 `turn:end`。所以一个 run 只有一个 turn |
| step | `Lifecycle` 的私有 `runModelStep`，事件里的 `step` 序号、`step:complete`（`A/core/lifecycle/types.ts:160-305`） | 一次模型请求。每个 step 保存成一条助手消息（消息里带 `model-state` 片段） |
| call | 助手消息里的 `tool-call` / `tool-result` 片段，用 `callId` 关联 | 一次工具调用 |

**结论**：界面上的“一轮”应当对应 run（也就是唯一的那个 turn）。run 有保存下来的开始、结束时间和状态，是现成的、可靠的边界。

## 1.2 run 的几种来源

主会话（`context_scope_id` 为空）的 run 有下面几种来源。只有第一种会写 prompt 记录：

| 来源 | 入口 | 提交方 | prompt 记录 | run 里第一条输入 |
|---|---|---|---|---|
| 用户发消息 | prompt 调度器 `execute` → `submitPromptInternal`（`A/adapters/ui-inprocess.ts:1360`） | `user` | 有 | 用户消息 |
| goal 续跑 | `runGoalTurn` → `submitPromptInternal`（`ui-inprocess.ts:1583-1595`） | `goal` | **没有** | 一条用户消息，正文是 goal 的显示文字（`displayText`，`ui-inprocess.ts:3953`） |
| 子代理唤醒 | `createSubagentWakeup` 的 `submit`（`A/adapters/ui-inprocess/subagent-wakeup.ts:223, 258`）→ `submitPromptInternal` | `subagent` | **没有** | `subagent-status` 运行时输入，之后可能还有 `subagent-result` |
| goal 期间的子代理唤醒 | 被唤醒的子代理属于正在执行的 goal 时，改走 `runGoalTurn(sessionId, goal, wakeOptions)`（`subagent-wakeup.ts:237-241`）；`runGoalTurn` 展开 `wakeOptions` 后把提交方改成 `goal`，并且因为有运行时输入而不带 goal 的显示文字（`ui-inprocess.ts:1583-1595`） | `goal` | **没有** | `subagent-status` 运行时输入，没有可见的用户消息 |
| 插话（steer） | 并入正在运行的 run（`current_run_input`） | — | 插话自己的 prompt 状态是 `steered`，不新开 run | — |
| `/loop` 周期任务 | 只有设计文档（`docs/loop/`），代码里没有实现 | — | — | — |

提交方的类型是 `PromptOwner = "user" | "goal" | "subagent"`（`ui-inprocess.ts:285`）。它只存在内存里的活动 prompt 状态中，决定修改类操作的上下文（`ui-inprocess.ts:907`）、todo 的作用域（`:3785`），并给 `UiSessionControl.driver` 赋值（`:4861`，`K/contract/session-view.ts:67`），**没有写进 run**。

注意上表第四行：提交方是 `goal`，触发这一轮的却是子代理。所以“谁提交的”和“什么事件开启了这一轮”是两件事，不能拿提交方直接当触发来源。

本地数据（用户数据库，只读统计）：主会话 run 共 180 个，有 prompt 的 136 个。没有 prompt 的 44 个里，38 个没有任何消息（中途失败或被打断），另外 6 个全部是子代理唤醒。数据库里没有 goal 会话，所以 goal 续跑的影响没有在真实数据里出现，但代码路径和子代理唤醒相同。

## 1.3 run 记录缺两样东西

1. **触发来源**。`TriggerSource` 只有 `"user"`（`A/runtime/run-ledger/types.ts:9`）。创建 run 的唯一入口把它写死成 `"user"`（`A/core/agents/runner.ts:239`，入参类型 `A/core/agents/types.ts:100`）；读当前轮输入时也写死（`A/runtime/prompt-scheduler/current-run-inputs.ts:825`）。于是 goal 续跑和子代理唤醒都被记成了 `user`。
2. **结局**。`UiRun`（`K/contract/snapshot.ts:111-122`）只有 `status: UiRunStatus`，取值是 `idle`、`running`、`waiting-for-permission`、`error`（`snapshot.ts:6-16`）。`runStatusToUiStatus`（`A/adapters/ui-state/persistent-store.ts:327-344`）把成功、用户取消、因停止或关机而中断都映射成 `idle`。前端拿到一个已结束的 run，分不清它是成功结束还是被取消。`runToUiRun`（同文件 `:346-359`）也没把触发来源交出去。

3. **按触发来源取的默认策略只有 `user`**。创建 run 时 `mergeRunDefaults` 按触发来源取默认策略，取不到就抛 `RunDefaultsPolicyError`（`A/runtime/run-manager/policy.ts:4-18`）；`DEFAULT_RUN_POLICY` 只给 `user` 配了 `permissionProfileId: "interactive"`、`multitaskStrategy: "reject"`（`A/adapters/ui-runtime/composition.ts:169-177`）。策略表的类型是 `Partial<Record<TriggerSource, RunDefaults>>`（`A/runtime/run-manager/types.ts:30`），少配一项类型检查发现不了。“主会话同一时间只有一个运行中的 run”靠的就是 `reject` 策略（`A/runtime/run-manager/manager.ts:138-145`）。

2026-09-29 的折叠议题正因为第 2 点，规定“整体成功只能来自 prompt 结果，不能由 `UiRun.status` 推断”，并且“不新增 SDK 字段”（`docs/problem-lists/2026-09-29-web-run-process-collapse/improve-1/02-optimization-plan-and-change-scope.md:24-43`）。这个前提在当时成立，但它把“一轮”绑在了 prompt 上，没有 prompt 的 run 就无法折叠。

## 1.4 视图里的 run 只有最近 50 个

- 会话视图的 run 列表来自 `sourceLedger.listBySession(sessionId, { limit: 50 })`，取回后再过滤掉子代理作用域的 run（`ui-inprocess.ts:780-789`）。账本按 `created_at DESC` 排序（`A/runtime/run-ledger/database.ts:544-556`）。子代理的 run 先占了名额再被过滤掉，实际留下的主会话 run 可能远少于 50 个。
- 增量更新时，`run.updated` 把新 run 插到前面并截断到 50 个（`A/adapters/ui-state/source-session-projection.ts:425-445`）。
- 视图初次装载（`seed`）依赖“新的在前”这个顺序：先取运行中的 run，没有就取列表第一个，再把这个 run 的全部消息补进来（`source-session-projection.ts:150-176`）。run 提供方只接收会话 ID，拿不到已加载的消息（`:55`）。
- 视图会把已加载的消息裁剪到最近 50 条（`trim()`，`source-session-projection.ts:499-539`）。
- `getActiveRuns(sessionId)`（`A/runtime/run-ledger/types.ts:104`）也会返回子代理作用域的 run。
- 翻历史（`getSessionHistory` → `history()`，`source-session-projection.ts:582-610`）只返回消息和 prompt，`UiSessionHistory` 没有 `runs` 字段（`K/contract/session-view.ts:52-59`）。
- Web 的 store 会把翻历史拿到的 prompt 合并进来（`W/store/store.ts:235-240, 458-463`），run 没有这样的合并，`install()` 只用视图里的 run 覆盖（`store.ts:222-233`）。

prompt 的取法已经是“跟着已加载的消息走”：`listForSession` 按已加载消息的 ID 和 run ID 去取（`ui-inprocess.ts:790-807`）。run 没有跟上这个做法。

## 1.5 Web 按 prompt 划分一轮

`W/ui/conversation/run-process.ts` 的 `projectRunProcesses`（:13-107）是唯一决定“一轮”的地方，只有 `ConversationStream.tsx:132` 调用：

- 先取本会话、已结束、时间有效、状态为 `succeeded`、`failed`、`cancelled`、`interrupted` 的 prompt（:19-31）。
- 再用 `prompt.runId` 找这一轮的消息（:33-36），取这一轮最后一条助手消息；它有正文、不带工具调用、不在流式输出也没出错，才作为最终答案 `answerId`，否则这一轮没有答案，不会往前再找（:37-51）。
- 只有 `prompt.status === "succeeded"`、答案已定稿、没有插话时才能折叠（:86-105）。

`ConversationStream` 用这些结果做四件事：

| 用途 | 位置 |
|---|---|
| 折叠中间过程，展开状态按 `[sessionId, runId]` 记住 | `ConversationStream.tsx:128-160` |
| 显示耗时行 `PromptDuration`，读 prompt 的 `acceptedAt ?? createdAt`、`endedAt`、`status`、`endTimeSource` | `ConversationStream.tsx:228-230`；`W/ui/conversation/ExecutionProgress.tsx:58-102` |
| 折叠控件的 DOM ID 用 `prompt.promptId` | `ConversationStream.tsx:236, 239, 382, 400` |
| 复制按钮挂在 `answerId` 上，常显的一行挂在 `processes.at(-1)?.answerId` 上 | `ConversationStream.tsx:164-171` |

`SessionConversation` 只把活动 run 交给 `ConversationStream`（`activeRun`），全部 run 的列表到不了这里；`selectors.ts` 也只用 run 找活动 run（`W/ui/session/selectors.ts:109, 246-260`）。

子代理的运行时输入在投影之前就被隐藏（`ConversationStream.tsx:97-103`），这是对的；但唤醒 run 自己的助手消息仍然显示，只是没有 prompt 认领它们。

**后果**（以会话 `session_1793633275109_owbs9e1` 为例）：一个用户 prompt 之后跟着三次子代理唤醒。第一轮正常折叠；后三轮的中间过程全部展开，没有耗时行，最后一条回答没有复制按钮，消息复制议题的“常显操作栏”也停留在第一轮的答案上。goal 续跑的轮次同理。界面上也没有任何地方说明“这一轮是子代理触发的”。

## 1.6 TUI 按 prompt 显示耗时

- `T/store/transcript.ts:373-422` 的 `appendPromptCompletions` 用和 Web 一样的 prompt 过滤条件生成一行 `PromptCompletion`，由 `T/components/transcript/prompt-completion.tsx` 显示成 `Total X`，按 `promptId` 去重。只有恢复会话时（`restoring`），才把它插到最后一条属于 `userMessageId` 或该 run 的消息之后；平时直接追加在末尾（`transcript.ts:405-416`）。调用点在 `T/store/events.ts:65, 617, 699`。
- TUI store 已经保存 run（`T/store/events.ts:79, 201, 570`）。翻历史只合并消息，不合并 prompt 和 run（`T/session-recovery.ts:614-660`）。
- TUI 没有折叠、没有最终答案的概念、没有复制按钮。
- 子代理的运行时输入由 `isVisibleTranscriptMessage` 隐藏（`T/store/transcript.ts:309-314`）。

**后果**：唤醒 run 和 goal 续跑在 TUI 里同样没有耗时行，也看不出是谁触发的。

## 1.7 测试现状

- `W/ui/conversation/run-process.unit.test.ts`、`run-process.integration.test.tsx`、`ConversationStream.unit.test.tsx`、`message-copy.unit.test.tsx` 覆盖了按 prompt 的折叠、耗时、复制，fixture 都是“一个 prompt 对应一个 run”。
- 没有任何测试覆盖“没有 prompt 的 run”，也没有子代理唤醒或 goal 续跑的轮次。
- run 账本、`runToUiRun` 的测试没有覆盖触发来源（只有一个取值）。

## 1.8 勘测中的其他发现

| 发现 | 位置 | 影响 | 处理 |
|---|---|---|---|
| `subagent_execution.root_prompt_id` 从未写入：只有列映射（`A/services/database/schema.ts:102`）和存储层的读写（`A/agents/subagents/execution-store.ts:29, 191`），没有任何地方给它赋值；本地数据里全部为空，`root_run_id` 有值 | 见左 | 撤销议题打算靠它找到并停止被撤销轮次里的子代理，现在行不通 | 不在本议题修，见 02 §2.8 |
| 右侧栏的子代理详情传 `prompts={[]}`，`sessionId` 用的是 `root:subagentId` 组合标识 | `W/ui/session/SubagentConversationBody.tsx:98-129` | 子代理对话里没有折叠、耗时和答案复制 | 不在本轮，见 02 §2.8 |

## 1.9 SWE 原则审视

- **以真实的执行单位为准**：run 有持久化的边界和状态，prompt 只是 run 的一种来源。把“一轮”绑在 prompt 上，是用一个派生概念去推断另一个，来源一多就漏。
- **一个事实只在一处产生**：“什么事件开启了这一轮”只有提交时知道。在创建 run 时写进账本，界面、诊断和以后的 fork、撤销都读这一个事实，而不是各自从消息内容去猜。它和提交方（决定权限、todo 作用域、`driver`）取值相同但含义不同，不能合并（§1.2 第四行）。
- **约束交给类型检查**：按触发来源取的默认策略是 `Partial` 表，漏配要到运行时才暴露（§1.3 第 3 点）。新增取值时应当在编译期就被发现。
- **把判断留在有信息的一方**：成功与否只有后端知道。给 `UiRun` 加 `outcome`，前端就不必借 prompt 间接判断。
- **数据覆盖跟着读取方走**：prompt 已经按已加载消息取，run 也应如此，否则长会话会在第 50 个 run 之后悄悄失效。
- **KISS**：不新增“交流”或“任务”层级，不新增表或迁移；只补 run 上缺的两个字段，把投影的键从 prompt 换成 run。

## 1.10 与既有文档的关系

| 文档 | 本议题之后 |
|---|---|
| `docs/problem-lists/2026-09-29-web-run-process-collapse/` | 其中“成功只来自 prompt、不加 SDK 字段”的前提被本议题取代；其余折叠规则（定稿、插话、展开状态、阅读锚点）保留 |
| `docs/runtime/run-ledger/`（data-model、dfd-interface） | 补 `trigger` 的三个取值和写入时机 |
| `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` §4.3、`05-components.md` | 折叠和耗时按 run；子代理触发的轮次带标签 |
| `docs/ohbaby-cli/` 中描述 transcript 的文档 | 耗时行按 run |
