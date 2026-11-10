# 1. 现状与问题分析

> 代码基线：2026-11-04，`main` 分支 `c9cbd475`。本议题开始前没有任何相关实施。下文路径以仓库根目录为准，`A/` 表示 `packages/ohbaby-agent/src/`，`W/` 表示 `apps/ohbaby-web/src/`。
>
> 2026-11-10：按 side chat、fork 后端落地后的代码（`codex/session-fork-backend` 分支 `61e563d5`）更新了引用行号与函数名，结论不变。

## 1.1 问题陈述

1. **发出去的消息改不了。** 用户发现问错了、漏了条件，只能再发一条补充，错误的那一轮仍然留在上下文里，占 token，还会干扰模型。
2. **“一轮对话”不是一条消息。** 一轮回答在后端（`packages/ohbaby-agent`）里存成多条 assistant 消息，每个模型步骤一条，中间还可能夹着 steer、提醒和通知。“撤销某一轮”要先说清楚撤掉哪些行。
3. **读消息的地方太多。** 消息表有二十多个读取点。要让已撤销的消息“对模型和界面都不可见”，过滤只能放在少数几个公共入口，否则一定会漏。
4. **一轮对话还牵连着别的状态。** prompt 记录、todo、goal、后台子代理、会话统计都和对话轮次挂钩。只隐藏消息、不处理这些，界面和模型会看到互相矛盾的状态。
5. **忙碌状态不在数据库里。** 会话是否正在运行、是否在压缩、是否有排队，都只存在于 adapter 的内存里。撤销必须和这些状态在同一处判断，否则会和正在进行的写入打架。

## 1.2 已确认的产品分界

见 [00 §2](00-discussion.md)。概括起来：

```
选一条用户 prompt → 它和之后的全部内容标记为已撤销（不删除）
→ Web：在气泡里改，点 Send 时撤销和发送一次做完
→ TUI：原文填回输入框，用户自己改、自己发
文件不回滚；压缩点之前不能撤；运行中先停再撤；Web 用 Edit 按钮，TUI 用 /rewind
```

## 1.3 Web 现状

### 1.3.1 消息与轮次

- `W/ui/conversation/MessageRow.tsx` 渲染单条消息，通过 `actions` 属性（:18、:124）挂操作栏。操作栏 `MessageActions`（`W/ui/conversation/MessageActions.tsx`）已由[消息复制议题](../../2026-11-04-message-copy/improve-1/02-optimization-plan-and-change-scope.md)落地，由 `ConversationStream.tsx` 的 `messageActions`（:177-197）组装，目前只有复制按钮。本议题往里加 Edit 按钮。
- `W/ui/conversation/run-process.ts` 的 `projectRunProcesses`（:36 起）通过 SDK 的 `listEndedTurns`（`packages/ohbaby-sdk/src/util/turn.ts:51`）按主上下文的 run 把消息分组成轮，每轮带上发起它的 prompt；有 prompt 的轮次即使没有其他消息也会保留。被撤销的 prompt 如果还在前端，就会被画成一轮。

### 1.3.2 输入框预填

`W/ui/composer/useComposerDraft.ts:20-25` 已有 `ComposerPrefill { scopeKey, editRevision, nonce, text }`，`SessionScreen.tsx:154,360` 用它把技能名插进输入框。Web 改为在气泡里编辑后，只有“撤销成功但发送失败”时才用它把改过的文字放进主输入框（2026-11-09），不需要新的状态通道。它目前是无条件覆盖草稿（`useComposerDraft.ts:249-259`），所以有草稿时要由调用方把改过的文字接在草稿后面再填入，不能直接覆盖。

## 1.4 核心消息与 prompt 存储现状

### 1.4.1 数据模型

| 表 | 关键列 | 与本议题的关系 |
|---|---|---|
| `message` | `id, session_id, context_scope_id, role, agent, created_at, updated_at, data` | `runId`、`parentId`、`runtimeInput` 都在 `data` JSON 里（`A/core/message/types.ts:39-75`）。没有“可见性”或“分支”字段 |
| `part` | `id, message_id, session_id, type, order_index, data` | 压缩通过在 `data` 里写 `time.compacted` 标记旧片段（`A/core/message/database-store.ts:667-685`，`commitCompaction`） |
| `prompt_submission` | `prompt_id, session_id, user_message_id, run_id, text, status, admission_order, ...` | 一轮对话的“入口”。Web 分轮时用它关联每轮的发起者（`run-process.ts:36` 起，经 `listEndedTurns`）。`text` 正好是撤销后要填回的原文 |
| `run_ledger` | `run_id, session_id, context_scope_id, status, ...` | 记录 run 状态，不引用消息 ID |
| `session` | `message_count, last_message_at, data` | 会话统计，由 `syncSessionStatsBestEffort`（`A/adapters/ui-inprocess.ts:3525`）按 `listBySession` 重算。“空会话复用”的实际判断是 `isAuthoritativelyEmptySession`（:2595-2624），除了 `messageCount` 还查 run 记录和 `hasForSession` |

表结构定义在 `A/services/database/schema.ts:9-61, 158-184`，最新迁移是 `028_subagent_message_input`（`A/services/database/migrations.ts:662`）。

**结论**：现在没有办法表达“这条消息还在，但已经不算数了”。唯一的删除能力是 `messageManager.removeMessage` / `removeMessages`（`A/core/message/manager.ts:334-353`），它会真删数据，而且只能删单条或整个会话。

### 1.4.2 压缩

压缩时在旧片段上写 `time.compacted`，再插入一条摘要消息，摘要的文本片段带 `metadata.kind = 'context-summary'`（`database-store.ts:578-665`，识别在 `A/core/message/origin.ts:67-71` 的 `isContextSummaryPart`）。构建上下文时 `getActiveHistory` 丢掉已压缩片段、把摘要移到最前（`A/core/context/context-manager.ts:220-238`）。

**结论**：压缩点之前的对话已经写进摘要文本里了，撤销这些消息也拿不掉摘要里的内容，所以只能禁止撤销压缩点之前的消息。

### 1.4.3 消息的读取点

| 类别 | 位置 | 走不走存储层公共入口 |
|---|---|---|
| 模型上下文、上下文用量 | `context-manager.ts:639-651` `loadModelHistory` → `messageManager.listBySession` | 走 |
| Web / TUI 视图与历史分页 | `A/adapters/ui-state/source-session-projection.ts:165,178,582,619` → `listPageBySession` / `listPageByRun`（都走 `listPage`） | 走 |
| 全量快照 | `A/adapters/ui-state/persistent-store.ts:467`、`A/adapters/ui-inprocess.ts:2470` | 走 |
| 导出 | `A/services/session-export/collect.ts:210` | 走 |
| todo 恢复 | `A/tools/todo.ts:416-474` 从历史里找最后一次 `todo_write` | 走 |
| 中断、执行恢复、steer 恢复 | `A/core/message/interruption.ts:46`、`A/runtime/execution-recovery/history.ts:19`、`A/adapters/ui-inprocess/steer-recovery.ts:37,86,118` | 走 |
| 子代理相关 | `A/agents/subagents/execution-facts.ts:68`、`monitor.ts:281` 等 | 走，但它们读的是子会话，不受主会话撤销影响 |
| 会话搜索 | `A/services/session/global-query.ts:117,245`（`VISIBLE_MESSAGE` 条件） | **不走**，直接写 SQL |
| 当前轮输入 | `A/runtime/prompt-scheduler/current-run-inputs.ts` 的 `readMessage`（SQLite 实现约 :894，内存实现约 :763） | **不走**，按 ID 直接读，服务于 steer 流程（:373、:485） |
| 按 ID 读单条 | `database-store.ts` 的 `getMessage`（:451）、`getPart`（:349） | 不走列表入口 |
| fork 标题 | `A/adapters/ui-inprocess/session-fork.ts:26` 直接调用 `readSessionMessages`（`database-store.ts:143-175`，`listBySession` 也转调它）取用户消息 | 走 |
| fork、side chat 复制历史与切点 | `A/services/session/copy-history.ts`（`endedMainRuns`、`findForkableMainRun`、`selectHistory`） | **不走**，直接写 SQL |
| side chat 的边界提示、空会话判断、关闭时取消 prompt | `A/adapters/ui-inprocess/side-chat.ts:128,156,241` 直接查 `prompt_submission` | **不走**，直接写 SQL |
| prompt 列表 | `A/runtime/prompt-scheduler/database-store.ts` 的 `listVisible`（:633）、`listForSession`（:693）；`hasForSession`（:669） | 视图里的 prompt 由 `listForSession(messageIds, runIds)` 取，`runIds` 来自 run 记录（`ui-inprocess.ts:844-862`） |

存储层的三个公共入口是 `listPage`（`database-store.ts:262`，`listPageBySession` 和 `listPageByRun` 都用它）、`listByIds`（:336）、`listBySession`（:701，转调 `readSessionMessages`，:143-175）。

`part` 表只通过所属消息读取，搜索也是按消息连表，不需要单独过滤。

**结论**：在三个消息列表入口和 prompt 列表入口统一加过滤，能覆盖绝大多数读取方；会话搜索单独改。按 ID 读取的入口服务于 steer 和“空会话”判断，不应过滤。

**视图投影有自己的缓存。** `A/adapters/ui-state/source-session-projection.ts` 按会话缓存消息（`messages`，:41；初始化在 `seed`，:160-238），只通过消息管理器的提交流程（`commitMessages` → `owner.commit`，:306-379）更新版本。直接改库不会让 `GET /view` 变化。

### 1.4.4 和对话轮次挂钩的其他状态

| 状态 | 存在哪 | 撤销后的问题 |
|---|---|---|
| todo | 没有表，内存缓存 `A/tools/todo.ts:160-330`，从历史重建 | 缓存还是撤销前的列表。`releaseScope`（:263）只清默认作用域，goal 的作用域（`goal:<id>`）要用 `release(sessionId)`（:248）一起清 |
| goal | 追加写的 `goal_record`（`A/goals/persistence.ts:25`），记 `turnsUsed`、`tokensUsed`，不引用消息 ID | 计数里含被撤销的轮次。00 已确认不回退。goal 处于 `active`（`A/goals/types.ts:1`）时会自动续跑，会和撤销冲突 |
| 后台子代理 | `subagent_execution` 记 `requester_run_id`、`root_run_id`、`root_prompt_id`（`migrations.ts:395-398`），其中 `root_prompt_id` 声明了但从没写过值，`root_run_id` 每次都写且有索引（`migrations.ts:420`）；投递状态有 none、foreground、pending、delivered、processed（`A/agents/subagents/execution-store.ts:92`） | 被撤销那几轮启动的子代理可能还在跑，也还在列表里。已完成但没投递的结果会由唤醒（`A/adapters/ui-inprocess/subagent-wakeup.ts:28-68` 的 `reserveSubagentWakeup`）开启父会话的新一轮 |
| prompt 记录 | `prompt_submission` | 不处理的话，Web 仍会按它画出被撤销的轮次 |
| 会话统计 | `session.message_count`、`last_message_at` | 要重算；现有的空会话判断和起标题判断（`isFirstUserMessageForTitle`，`ui-inprocess.ts:3561-3594`，只在标题仍是默认值时起标题）不会因此出错 |
| 快照检查点 | `snapshot_checkpoint`，默认关闭（`A/adapters/ui-persistent.ts:806`） | 本轮不动 |

### 1.4.5 实时事件

- `session.changed` 已有 `removedMessageIds` 字段（`packages/ohbaby-sdk/src/contract/session-view.ts:99`），TUI 已经在用（`packages/ohbaby-cli/src/tui/session-recovery.ts:523-556`）。撤销后可以直接用它让前端移除消息。
- prompt 只有 `prompt.submitted` 和 `prompt.updated` 两种事件（`packages/ohbaby-sdk/src/contract/events.ts:117,123`），没有移除事件。`session.changed` 另有 `prompts` 字段（`session-view.ts:104`），可以带上状态变化后的 prompt。
- 消息管理器的提交协调器会把删除变化转成 `MessageCommittedChange.removedMessageIds`（`A/core/message/manager.ts:76-90`），视图投影据此更新并标记历史失效，最终变成 `session.changed` 的 `removedMessageIds`。撤销可以走这条现成的路。
- Web store 收到 `removedMessageIds` 后会从已加载的历史里删掉对应消息（`W/store/store.ts:551`）；已加载的 prompt 按 `updatedAt` 取较新的一份（`rememberPrompt`，:105-110）。

### 1.4.6 忙碌判断与串行化

忙碌状态只存在于 adapter 的内存里：`sessionExecution`（会话执行闸门）、`compactingSessions`、`pendingRuntimePromptsBySession`、`activePromptsBySession`（`A/adapters/ui-inprocess.ts:672-675`），以及 prompt 调度器的恢复状态。手动压缩已经示范了怎样安全地独占一个会话：在 `sourceProjection.owner.runControl(sessionId)` 里检查上面这些状态，空闲时占住闸门（`compactSessionInternal`，`ui-inprocess.ts:3752-3771`）。goal 续跑（`runGoalTurn`，:1555-1615）和子代理唤醒（`subagent-wakeup.ts:28-43`）也走同一个 `runControl` 和闸门。`withSessionAdmission`（:710）是全局读写锁，不是按会话的。

**结论**：撤销应该放在 adapter 层，照手动压缩的方式独占会话，而不是在 `services/session` 里另起一套。

## 1.5 服务端与 SDK 现状

- 会话路由在 `packages/ohbaby-server/src/protocols/web/routes/sessions.ts`（view、history、control、model、reasoning、archive、compact、abort 等）和 `runtime/daemon/server.ts:334-346`（列表、搜索、移动、删除）。没有撤销相关路由。
- 现有的“resend”只是重发还没被处理的 steer 输入（`POST /v1/steer-inputs/:id/resend`，SDK `resendSteerInput`）；`PATCH /v1/prompts/:id` 和 edit-lease 只能改还在排队的 prompt。它们和撤销是两回事，名字上要避免混淆。
- 提交走 `POST /v1/prompts`（`routes/prompts.ts:66`），Web 端是 `W/api/daemon/client-prompts.ts:162` 的 `submitPromptAccepted`。撤销后用户手动发送时走的就是这条路，不需要新接口。

## 1.6 TUI 现状

- 命令清单在 `A/commands/catalog.ts`，`surfaces` 控制在哪些界面出现（:8-10）。现有命令里没有 undo。
- TUI 在本地拦截部分命令，例如 `export`（`packages/ohbaby-cli/src/tui/app.tsx:231`）。`/rewind` 可以照这个方式处理。
- 交互面板有现成的框架：`components/dialog/command-panel-state.ts` 定义交互类面板（connect、effort），`/rewind` 的选择列表可以作为一种新的交互面板。
- 往输入框里填文本：排队编辑的流程已有 `restoreQueuedEditInput`（`packages/ohbaby-cli/src/tui/components/prompt/index.tsx:369`）。
- TUI 只持有视图里最近一段 prompt（`packages/ohbaby-cli/src/tui/store/events.ts:513-519` 附近），更早的轮次不在内存里。
- 视图更新：`session-recovery.ts:523-556` 已经处理 `removedMessageIds`。

## 1.7 测试现状

- 测试和源码放在同一目录，按 `*.unit.test.ts`、`*.integration.test.ts`、`*.contract.test.ts` 分类。
- `run-process.ts`、`useComposerDraft.ts`、消息存储、手动压缩（与撤销同样独占会话）都有现成测试，可以在旁边加用例。
- 现在没有任何测试覆盖“消息存在但不可见”这种状态，因为这种状态本来就不存在。最大的测试缺口有两个：撤销之后，二十多个读取点里有没有哪一处还能读到已撤销的消息；视图投影的缓存会不会继续返回旧消息。

## 1.8 跨模块影响面

```
packages/ohbaby-agent   迁移 029、消息与 prompt 存储过滤、adapter 层撤销编排、子代理与 todo 的善后
packages/ohbaby-server  新路由 POST /v1/sessions/:id/rewind
packages/ohbaby-sdk     撤销方法、错误码、UiPromptSubmission.rewoundAt
apps/ohbaby-web         Edit 按钮、气泡编辑框（依赖消息复制议题的操作栏）
packages/ohbaby-cli     /rewind 选择面板与输入框回填
```

迁移 `029` 给三张表加列，旧版本程序读新库不会报错（多出来的列会被忽略），但旧版本不会过滤已撤销的消息。

## 1.9 SWE 原则审视

- **把复杂度收在一处**：过滤放在存储层公共入口，而不是让每个读取方各自判断。这是信息隐藏：读取方不需要知道“撤销”这个概念存在。
- **复用现有机制**：独占会话照手动压缩，界面更新走消息提交流程，错误码复用已有的，不另造。
- **不删数据**：只打标记，出问题时清掉标记就能恢复；真删除做了就退不回来。
- **不过度设计**：不做分支浏览、不做重做、不做文件回滚，这些都有明确的后续入口，但本轮没有需求。
- **按目标定位，不按数量定位**：撤销接口接收 `promptId`，避免并发提交时“撤销 2 轮”指向不同的内容。
- **风险点**：直接写 SQL 的读取方是这个设计的漏洞来源。04 要专门覆盖。

## 1.10 与既有文档关系

| 文档 | 现状描述 | 本议题之后 |
|---|---|---|
| `docs/core/message/data-model.md` §消息生命周期（约 :556-580） | 只有创建、使用中、完成、删除 | 要加“已撤销”状态，说明它和删除的区别 |
| `docs/core/message/architecture.md` | 存储职责只有增删改 | 补充：公共读取入口默认排除已撤销消息 |
| `docs/services/session/` | 会话生命周期 | 补充撤销操作与“空会话复用”的规则 |
| `docs/runtime/prompt-scheduler/` | prompt 存储 | 补 `rewound_at` 与列表过滤 |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 命令清单 | 补 `/rewind` |
