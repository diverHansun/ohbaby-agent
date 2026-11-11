# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。
>
> 2026-11-10：按 side chat、fork 后端落地后的代码更新了引用行号与函数名，决定不变。

## 2.1 方案总览

给 `message`、`prompt_submission`、`subagent_execution` 各加一个 `rewound_at` 列。撤销在 adapter 层执行：会话在运行时先停下来，再照手动压缩的方式独占会话，停掉被撤销轮次里的子代理和后台任务，再通过消息管理器的提交流程，把目标用户消息及之后的消息标记为已撤销，同时标记对应的 prompt。存储层的列表入口默认跳过这些行，模型和界面因此都看不到它们，但数据仍在库里。接口有两种用法：Web 在气泡里改完点 Send，请求带上 `text`，后端撤销后在同一次调用里接收新 prompt；TUI 不带 `text`，后端只撤销并返回原文，TUI 填回主输入框。

```
Web 气泡 Send ──► POST /v1/sessions/:id/rewind { promptId, text }
TUI /rewind   ──► POST /v1/sessions/:id/rewind { promptId }
                           │
              adapter 层   ├─ 预检：根会话、未归档、目标有用户消息、在最近压缩点之后、没在压缩（不过就什么都不停）
                           ├─ 停下来并占闸门（最多 10 秒）：暂停 goal（保留后台子代理），
                           │   循环“取消撤销前已排队的提问 → 中断当前这一轮并等结束 → runControl 里查忙碌、占闸门”
                           ├─ 完整校验目标（被中断的那一轮此时已结束）
                           ├─ 先停止被撤销轮次里的子代理和后台 shell 任务（失败则不撤销）
                           ├─ 标记消息、prompt、子代理调用；发 prompt.updated；未投递的结果改为不投递
                           ├─ 善后：清空 todo 缓存、重算统计
                           ├─ 带 text：用目标 prompt 的模型和 reasoning 接收新 prompt（仍占着闸门）
                           ├─ 释放闸门（先执行修改稿，再执行撤销期间收到的新提问）
                           └─ 返回 { restoredText, prompt?, sendError? }
                                       │
              视图投影收到 Removed 和 prompt.updated ──► session.changed（removedMessageIds、prompts）
                                       │
Web ◄──────────────────────────────────┤ 气泡退出编辑状态，新一轮照常出现
TUI ◄──────────────────────────────────┘ 原文填回主输入框，用户改完正常发送 POST /v1/prompts
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 已撤销的表达方式 | `message`、`prompt_submission` 各加 `rewound_at` 列（子代理调用表同样加，见“子代理与后台任务”行） | SQL 过滤直接；可逆，清空列就能恢复 | 真删除（不可逆，和 00 冲突）；写进 `data` JSON（每次过滤都要 `json_extract`）；单独的切点表（每个读取方都要连表） | 一次迁移；旧版本程序读新库会看到已撤销的消息 |
| 过滤放在哪 | 消息与 prompt 的列表入口默认排除；按 ID 读取不过滤 | 覆盖绝大多数读取方；按 ID 读取服务于 steer 和空会话判断 | 每个读取方各自过滤（一定会漏）；所有入口都过滤（会弄坏 steer） | 以后需要“包含已撤销”的列表调用方要加显式选项 |
| 撤销放在哪一层 | adapter 层，照 `compactSessionInternal` 独占会话 | 同一后端负责安排新提问、goal 续跑和子代理唤醒的执行顺序。独立后端正在跑的轮次通过 `run_ledger` 发现；和独立后端的手动压缩谁先提交谁生效，后提交的一方在自己的事务里复查失败（2026-11-10 确认，不另加跨进程标记） | 在 `services/session` 里写服务并另造锁；跨进程的“历史操作”标记（实施时加过，验收时去掉：标记只看 PID 时可能残留，正确性已由两边的事务内复查保证） | `ui-inprocess.ts` 又多一个接入点；为了不让它继续变长，编排逻辑单独放进 `A/adapters/ui-inprocess/session-rewind.ts` |
| 界面怎么更新 | 走消息管理器的提交流程，发出 `Removed` 变化 | 视图投影有缓存，只认提交流程；现成路径会转成 `removedMessageIds` | 直接改库再手写 `session.changed`（`GET /view` 会返回旧消息） | 消息存储接口多一个 `markRewound`，SQLite 和内存实现都要有 |
| 撤销定位 | 目标 `promptId` | 用户点的就是一条消息；并发时不会撤错 | kimi-code 的“撤销 N 轮” | 前端要知道每条用户消息对应的 `promptId`（`prompt_submission.user_message_id` 已有） |
| 撤销范围 | 按模型历史的排序，主上下文里从目标用户消息开始的全部消息；从目标 prompt 到后台开始撤销时已接收的 prompt。goal 续跑、子代理唤醒、提醒不按来源单独处理（目标之后有压缩摘要时目标本身就不能撤销，见 P10 与 Stage 1 第 6.2 步），一起隐藏 | 规则简单，不漏 steer 和提醒；有撤销功能的五个参考项目都是从撤销点往后一刀切 | 只按 `runId` 圈消息（会漏掉没有 `runId` 的消息） | 无 |
| 会话在运行 | 学 ZCode，后端先停再撤：取消开始前已排队的 prompt、暂停 active 的 goal、中断当前这一轮，等空闲后占闸门。独立 TUI 占用同一会话、正在压缩、恢复未就绪、排队项被别的窗口锁住编辑或等待超时等情况返回 `SESSION_RUNNING` | 气泡编辑最常见的场景就是 AI 正在跑时发现问错了；Stop 只发信号不等结束，停止必须和占闸门放在后端同一次调用里，否则排队的 prompt 或 goal 会抢走空档 | kimi-code、codex 运行中拒绝（11-04 原方案）；前端先调 Stop 再调撤销（中间有空档）；ZCode 保留排队但暂停自动发送（ohbaby 没有“暂停队列”） | 新写一个“停下来并等空闲”的步骤；等待超时时，已停止的任务、已取消的排队、已暂停的 goal 不会恢复 |
| 原文来源 | `prompt_submission.text` | 就是用户当时提交的原文 | 从用户消息的 text 片段拼 | 无 |
| Web 编辑方式 | 在气泡里编辑，Send 时一次完成撤销和发送；不碰主输入框 | 学 ZCode；主输入框里的草稿不受影响 | 填回主输入框（codex、claude-code、kimi-code、opencode 的做法） | 接口多一个可选的 `text` |
| 编辑框能改什么 | 只改文字；模型和 reasoning 取目标 prompt 记录的值 | ohbaby 没有附件；ZCode 编辑框也不放模型选择 | 在编辑框里放模型和 reasoning 控件 | 想换模型要先在主输入框切换，再正常发一条 |
| 撤销后接收失败 | 预检先确认模型可选，让失败几乎不发生；真失败时撤销保留，返回 200 并带 `sendError`。前端把改过的文字放进主输入框：输入框为空就直接填入，有草稿就接在草稿后面（空一行），不覆盖草稿 | 学 ZCode：撤销可以留下，用户的文字不能丢；草稿也不能丢 | 失败时回滚撤销（要做三张表的反向标记和事件）；保持编辑框打开（被编辑的那条消息已经撤销，编辑框没有地方挂） | 用户需要再点一次发送 |
| 文件改动 | 本轮不回退 | `snapshot` 模块要补只回退 AI 改过的文件、冲突检查、默认开启、清理旧快照，单独立议题更稳 | 本轮一起做（改动面翻几倍，覆盖出错会丢用户代码） | 编辑框提示“文件改动不会撤销”；以后接口加 `files: true` |
| 子代理与后台任务 | 学 ZCode：先停后撤。按被撤销轮次的 runId（`root_run_id`）停掉子代理和后台 shell 任务，停止失败就不撤销；再把这些子代理调用标为已撤销、结果改为不投递 | 停不掉就不动数据，不会出现消息已隐藏、子代理还在跑的状态；两条送回结果的路径本来就跳过“不投递” | 原方案按 `root_prompt_id` 找（这一列从没写过值）；只停止不处理投递（结果仍会唤醒父会话）；opencode、kimi-code 不停任务 | `subagent_execution` 多一列；执行存储多一个方法 |
| 统计、空会话、标题 | 用现有的 `syncSessionStatsBestEffort` 重算；空会话判断和起标题判断不改 | 现有判断已能正确处理撤销到底的会话 | 改 `findReusableEmptyPrimary` | 靠 04 的测试兜底 |
| 压缩边界的前端提示 | 前端不判断，由后端报错 | 前端拿不到可靠的边界 | 在视图里暴露边界 | 压缩点之前的消息点 Edit 会看到报错提示 |
| 重复请求 | 不特殊处理 | 低频的手动操作，不值得多一条成功路径 | 幂等返回上次结果 | 网络重试时用户会看到一次“already rewound”提示 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：后端

**目标**：`POST /v1/sessions/:sessionId/rewind` 能用；撤销后模型上下文、视图（含缓存）、历史、导出、搜索、todo、子代理列表都看不到被撤销的内容，也不会被子代理唤醒重新带回来。

**改动**：

1. **迁移 `029_message_rewind`**（`A/services/database/migrations.ts`、`schema.ts`）：`message`、`prompt_submission`、`subagent_execution` 各加 `rewound_at TEXT NULL`。会话表再加默认值为 0 的 `rewind_revision`，撤销事务递增它。共享同一个库的后台进程据此刷新会话缓存。沿用现有索引。
2. **消息存储**（`A/core/message/database-store.ts` 和内存实现 `A/core/message/store.ts`）：
   - `listPage`（:262）、`listByIds`（:336）加 `rewound_at IS NULL`。`listBySession`（:701）现在只转调 `readSessionMessages`（:143-175），条件加在 `readSessionMessages` 里。fork 起标题（`A/adapters/ui-inprocess/session-fork.ts:26`）也直接调用 `readSessionMessages`，撤销后同样看不到已撤销的用户消息，这是预期的；side chat 不调用它。`listPageByRun`（:333-335）就是带 runId 调用 `listPage`，过滤 `listPage` 就覆盖了它，但测试必须走到这条路径：视图初始化（`source-session-projection.ts:160-188` 的 `seed`）用它取最近一轮的全部消息，撤销后最近一轮通常就是被撤销的那轮，漏掉的话它的助手消息和这一轮会重新出现在视图里。
   - 新增 `markRewound(sessionId, fromMessageId, rewoundAt)`：按 `readSessionMessages` 的排序（`created_at, rowid`，`listBySession` 与它相同），把主上下文里从该消息开始、尚未撤销的消息写上时间戳，返回被标记的消息 ID。
   - `getMessage`（:451）、`getPart`（:349）不加过滤。
3. **消息管理器**（`A/core/message/manager.ts`）：新增 `markRewound`，包在 `commit(sessionId)` 里，对每条被标记的消息发出 `Removed` 变化。视图投影（`A/adapters/ui-state/source-session-projection.ts:306-379` 的 `commitMessages`）会据此更新缓存并产生 `removedMessageIds`。
4. **prompt 存储**（`A/runtime/prompt-scheduler/database-store.ts` 和对应的内存实现）：
   - `listVisible`（:633）、`listForSession`（:693）加 `rewound_at IS NULL`。`get` 和 `hasForSession`（:669）不加过滤，`hasForSession` 是空会话判断的依据。
   - 新增 `markRewound(sessionId, promptIds, rewoundAt)`：标记按消息位置与准入次序选中的 prompt（包括并入运行中轮次的 steer prompt），同时更新 `updatedAt`，返回被标记的 prompt。
   - SDK 的 `UiPromptSubmission` 加可选字段 `rewoundAt`。
5. **会话搜索**：`A/services/session/global-query.ts` 的 `VISIBLE_MESSAGE`（:117，搜索在 :245 使用）加上 `m.rewound_at IS NULL`。规划时已在 `A/` 下搜过存储层之外直接写 SQL 读这两张表的地方，结论如下，实施时只需复核：

   | 位置 | 处理 |
   |---|---|
   | `A/services/session/global-query.ts:245`（搜索） | 加条件（本步） |
   | `A/runtime/prompt-scheduler/current-run-inputs.ts:896, 952, 963` | 按 ID 读取，有意不过滤 |
   | `A/services/session/workspace-move.ts:63`、`A/services/session/archive.ts:131` | 只看状态和范围，不受影响 |
   | `A/adapters/ui-inprocess/side-chat.ts:128` | 只取正在运行或排队的那条 prompt 原文。撤销会先停掉运行、取消排队，不受影响 |
   | `A/adapters/ui-inprocess/side-chat.ts:156` | 判断主会话“发过消息没有”。主会话的全部 prompt 都被撤销后，这里仍认为发过，side chat 只会带一条边界消息、没有继承的历史。本轮接受，不加条件 |
   | `A/adapters/ui-inprocess/side-chat.ts:241` | 只读 side chat 自己的排队 prompt，side chat 不能撤销，不受影响 |

   实施时复核了两个新增的直接读取方。`session-rewind.ts` 按主上下文和可见性读取切点、摘要与轮次，复查所有工作区的未完成 prompt。`rewind-shell.ts` 查后台任务及清理回执，按任务 ID 和所有者确认能否安全停止。标题生成在空会话上检查是否曾撤销过 prompt，以保留原有标题。

   当前视图只保留正在运行或还有可见消息的 run（`visibleRuns`），其历史种子也来自已过滤的 `listPageByRun`。旧式全量快照还会列出没有消息的终态 run，因此在 `fullyRewoundRuns` 单独检查：只有当该 run 的所有消息和 prompt 都有撤销标记时才隐藏它。
6. **撤销编排**：新建 `A/adapters/ui-inprocess/session-rewind.ts`，由 `ui-inprocess.ts` 注入依赖后调用。`rewindSession({ sessionId, promptId, text? })` 按顺序执行：
   1. 会话检查：会话存在（否则 `SESSION_NOT_FOUND`）、是根会话（否则 `SESSION_NOT_ROOT`）、是 `active`（否则 `SESSION_ARCHIVED`）、不是 side chat（否则 `SIDE_CHAT_UNSUPPORTED`，见第 8 步）、没被移到别的目录（否则沿用现有的 `SESSION_MOVED`）。前四项可直接复用 side chat、fork 已落地的 `readActiveMainSession`（`A/services/session/database-store.ts:161-173`），最后一项复用 `assertSessionInWorkspace`（`A/services/session/working-directory.ts:37-44`）。检查顺序跟随这两个函数，所以已归档的 side chat 返回 `SESSION_ARCHIVED`（2026-11-10 按已落地代码对齐顺序，不是新决定）。带 `text` 时，`text` 去掉首尾空白后为空返回 `REWIND_TARGET_INVALID`。
   2. 预检。只做不依赖运行状态的检查，任一不过直接返回，**不停止任何东西**：
      - 目标 prompt 属于本会话、未被撤销，状态不是 `queued`、`retained`、`starting`（这些还没有用户消息气泡）。
      - 目标的用户消息行存在、可见、在主上下文（`contextScopeId` 为空）、不是 steer。`prompt_submission.user_message_id` 本身总是有值（`migrations.ts:435`），用户消息却要等 prompt 真正执行时才写入（`ui-inprocess.ts` 的 `submitPromptWork`：:4089 构造用户消息，:4178-4187 通过 `runtime.startSession` 的 `initialUserMessageId` 交给运行时写入），所以要查消息行本身。从排队区取消过、或还没开始就失败的 prompt 没有消息行，不能当目标。否则返回 `REWIND_TARGET_INVALID`。
      - 目标用户消息在最近一条 `context-summary` 消息之后，否则返回 `REWIND_BEFORE_COMPACTION`。
      - 没在压缩、恢复已就绪；独立 TUI 未占用本会话，排队区里没有 `retained` 的 prompt，也没有被别的窗口持有编辑锁的 prompt（取消它会抛 `PromptEditLeaseHeldError`，见 `A/runtime/prompt-scheduler/database-store.ts` 的 `cancelQueued`，:449-463）。否则返回 `SESSION_RUNNING`。
      - 带 `text` 时，确认要用的模型仍可选（`assertModelEntrySelectable`），不可选就原样返回这个错误。这样第 8 步的接收几乎不会再失败。
      - 不另加跨进程标记。压缩在写摘要的同一个事务里复查源消息仍未撤销、内容没变（`A/core/message/database-store.ts` 的 `commitCompaction`）；撤销在提交事务里复查切点仍在最近一次摘要之后，并检查 `run_ledger`。和独立后端的手动压缩同时发生时，后提交的一方失败，用户重试即可。自动压缩一直只靠这处复查。
   3. 停下来并占住闸门（学 ZCode）。总时限 10 秒（参照 codex），下面所有等待都算在内：
      - goal 处于 `active` 时先暂停。现有的 `pauseGoal`（`A/goals/service.ts:411-423`）调用内部的 `pauseActiveGoal`（:606-645）时没有传 `preserveBackground`，会停掉 goal 名下所有轮次的后台子代理，包括撤销点之前要保留的轮次。`pauseActiveGoal` 本身已经支持这个参数，所以只需给 `pauseGoal` 加一个 `preserveBackground` 选项并透传下去，撤销时传 `true`，后台子代理留给第 5 步按轮次处理。暂停原因记为“编辑消息”，事件照常推给界面。暂停会顺带中断正在跑的 goal 轮次。
      - 同一会话已经开始办理的提交先办完，后到的提交按收到的顺序等待。同一后台收到其他窗口发给这个会话的新提问时，以后台开始处理撤销的时刻为界。之后到达的提问等此次操作结束后执行。带修改稿的请求先安排修改稿，再放行这些提问。
      - 然后循环，直到占到闸门或超时：
        1. 取消后台开始撤销前本会话已排队的 prompt（`promptScheduler.cancelQueued`，`ui-inprocess.ts:5306-5316` 的 `cancelQueuedPromptForOwner`）。它们排在撤销点之后，本来就要移除（学 opencode）。要先取消排队，再中断当前这一轮，否则这一轮一结束，调度器就会把下一条排队的 prompt 跑起来。
        2. 有活动 prompt 时，先用 `waitForPromptRunReadyOrIdle`（`ui-inprocess.ts:4435-4458`）拿到它的 runId，再调用 `abortPromptRun`（`A/adapters/ui-inprocess/runtime-controller.ts:312-318`，经 `cancelPromptRun`（:303）调用 `interruptRunTree`，会顺带取消这一轮的后台 shell 任务），然后等 `runManager.waitForCompletion(runId)`。
        3. 照搬 `compactSessionInternal`（`ui-inprocess.ts:3752-3771`）的写法：`sourceProjection.owner.runControl(sessionId)` 的回调里**只做**忙碌检查和占闸门。忙碌指闸门被占、恢复状态不是 `ready`、正在压缩、有排队 prompt、有活动 prompt、有待处理的运行时 prompt、goal 仍是 `active`。都不成立时 `sessionExecution.reserve`，退出循环。
        4. 仍然忙时，像 `runGoalTurn`（`ui-inprocess.ts:1555-1615`）那样订阅闸门变化，等闸门放开后回到第 1 小步。调度器可能还在给刚中断的轮次写最终状态，这些工作按原规则收尾。撤销期间子代理唤醒不会开新一轮：唤醒的认领在撤销进行中暂停（`ui-inprocess.ts` 里 `isClaimPaused` 和 `runGoalTurn` 前的检查），撤销结束后再按原规则处理，被撤销轮次的子代理结果已改为不投递。若独立 TUI 占用同一会话，返回 `SESSION_RUNNING`，该 TUI 的提问与执行照常保留。
      - 超时返回 `SESSION_RUNNING`。已暂停的 goal、已取消的排队、已中断的轮次都不恢复：用户点 Send 本来就是要停下来改消息，可以接受。
      - 不处理客户端中途断开请求的情况，最多 10 秒后自然结束。
      - 后面第 4 至 8 步放在 `try` 里，`finally` 释放闸门。
   4. 完整校验：重复第 2 步对目标的检查，并要求目标 prompt 此时已结束（`succeeded`、`failed`、`cancelled` 或 `interrupted`；被中断的那一轮此时已结束）。不满足返回 `REWIND_TARGET_INVALID`。
   5. 先算范围、再停止（学 ZCode，停不掉就不撤销）：
      - 用 `listBySession(sessionId, { scope: { contextScopeId: undefined } })` 只取主上下文的消息（不传 scope 会返回全部上下文，见 `readSessionMessages`，`database-store.ts:151-158`），从目标用户消息开始，加上不早于目标的 prompt，把它们的 runId 去重，得到“被撤销的轮次”。goal 续跑、子代理唤醒这类没有 prompt 的轮次也由此找到。
      - 对每个轮次调用 `interruptByRootRun(runId)`（`A/agents/subagent-host.ts:1012-1092`）停掉仍在运行的子代理，再调用 `cancelByRootRun(runId)`（`A/tools/shell-job-registry.ts:362`）停掉后台 shell 任务。两者在轮次结束后都可以调用，现有代码已有这样的用法（`A/adapters/ui-runtime/composition.ts:1492`、`:1023`）。
      - 任一停止抛错，原样返回错误（路由按未知错误返回 500），这时还没有标记任何数据。
   6. 标记并通知，三处用同一个时间戳：
      - 在共享事务里调用消息存储的 `markMessagesRewound`，提交后由消息管理器的 `notifyRewound` 发出 `Removed` 变化。
      - 在同一个事务里调用 prompt 存储的 `markPromptsRewound`。它绕过调度器的通知，所以接着要对每条被标记的 prompt 通过 `publish()` 发一次 `prompt.updated`（带 `rewoundAt`）。视图投影只在收到 prompt 事件时重算 prompt 列表（`source-session-projection.ts:469-494`），不发的话 `GET /view`、Web 和 TUI 都还会留着这些 prompt。
      - 执行存储新增 `markRewoundByRootRuns(sessionId, runIds, rewoundAt)`（`A/agents/subagents/execution-store.ts`）：给 `root_run_id` 在其中的执行写上 `rewound_at`，并把投递状态还是 `pending` 或 `delivered` 的改成 `{ state: "none" }`。空闲唤醒（`session-supervisor.ts:110-115`）和下一轮插入结果（`continuation-coordinator.ts:59-145`）都跳过 `none`，不用改它们。现有的 `markProcessed` 要求结果已经送达，不能用在这里。
      - 已被停止的执行之后才跑完时，只记 `lateResult`，不再投递（`execution-store.ts:491-500`），所以迟到的结果也不会冒出新的一轮。
      - SQLite 在同一个写事务内复查会话、切点、执行状态及停止范围，再标记三张表。成功提交后发送 Removed 和 prompt.updated。若后台 shell 属于另一个仍在运行的进程，且没有确认清理的回执，返回 `SESSION_RUNNING`。
   7. 善后：
      - todo：调用 `release(sessionId)`（`A/tools/todo.ts:248`），清掉包括 goal 作用域在内的全部缓存，下次读取时按可见历史重建。
      - 已加载的 MCP 工具：调用 `mcpToolMenu.disposeSession(sessionId)`，下次读取时按可见历史重建（由[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)提供，它先于本议题实施；`readSessionMessages`（`listBySession` 转调它）加上 `rewound_at IS NULL` 后，重建自然不含被撤销的 `select_tools`）。漏掉这一步，撤销前加载的工具会留在工具列表里。
      - 统计：调用 `syncSessionStatsBestEffort(sessionId)`（`ui-inprocess.ts:3525`）。
      - steer 恢复：被撤销轮次里没被消费的 steer 不能再显示“resend”。实施时确认 `listUnconsumedSteers` 的结果是否需要刷新（`refreshSteerRecovery`），需要就在这里调用。
   8. 请求带 `text` 时，仍在占着闸门的状态下接收新 prompt：复用 `submitPromptAcceptedWork`（`ui-inprocess.ts:1857`）的接收路径，`sessionId` 固定为本会话，`modelEntryId` 和 `reasoning` 取目标 prompt 记录上的值；目标没记 `modelEntryId` 时（这个字段可选），沿用会话当前的模型。修改稿由撤销请求自己接收。执行队列会跳过闸门被占的会话，第 9 步放开后先执行修改稿，再执行撤销开始后其他窗口发来的提问。这时没有正在跑的 goal 轮次，接收不会变成 steer。不要在 `runControl` 的回调里等待接收，否则会死锁。
      - 接收失败时撤销不回滚。撤销本身成功，所以仍返回 200，在结果里带上 `sendError: { code, message }`，不带 `prompt`。
   9. `finally` 里释放闸门，返回 `{ sessionId, restoredText, prompt?, sendError? }`：`restoredText` 取目标 prompt 的 `text`，给 TUI 填回输入框；带 `text` 且接收成功时，`prompt` 是新 prompt 的回执（与 `submitPrompt` 返回的相同）。
7. **子代理列表**：只在两个界面读取入口过滤，**不改**执行存储的通用列表。`listByRootRun`、`listSessionExecutions` 还要给停止、唤醒和 goal 判断用，不能过滤。
   - 调用列表 `A/adapters/ui-inprocess/subagent-views.ts:72-110`：排除 `rewound_at` 有值的调用。TUI 子代理浏览器和 Web 对话里的子代理卡片都用它。
   - 实例列表 `A/adapters/ui-inprocess/subagent-instances.ts:152-172`：现在只按 `closedAt` 过滤，数据还可能来自内存里的运行时状态。改为：某个子代理的调用在执行存储里全部被撤销时，不显示这个子代理。还有未撤销调用的子代理照常显示，显示内容不改（可能是被撤销的那次最近调用，接受）。
   - 有意不做：子代理自己的对话不回退，它仍然记得被撤销的那次任务；第 1 轮启动的子代理在第 2 轮收到追加消息、再撤销第 2 轮时，它不会被停止。
8. **与其他议题的衔接**：
   - fork 与 side chat：开发顺序是 side chat → fork → 撤销，这两个议题落地后才有共用的复制函数 `A/services/session/copy-history.ts` 和切点查询。改动以 fork 合入后的代码为准，按 side chat 和 fork 的实现，要加 `rewound_at IS NULL` 的地方有四处：
     1. **复制选消息**：`selectHistory`（:145）选 `message` 的查询（:157-161），以及它算切点位置的子查询（:159-160）。`part`、`current_run_input`、`run_ledger` 都从选中的消息推出来，不用另加条件。
     2. **复制选 prompt**：`selectHistory` 选 `prompt_submission` 的查询（:189-191）。side chat 落地的复制函数会复制所有作用域的 prompt，再改写到目标作用域，这个条件对所有作用域都生效。
     3. **已结束轮次**：`findEndedMainRun`（:57）和 `findForkableMainRun`（:66）共用的已结束轮次查询 `endedMainRuns`（:18-54），在按 run 汇总消息的 `anchors` CTE（:27-31）加条件。`run_ledger` 没有 `rewound_at` 列，所以只剩已撤销消息的 run 自然被排除。
     4. **fork 的最终回答**：`findForkableMainRun` 取每轮 AI 回答的查询（:75-78），已撤销的回答不算。

     复制 prompt 时保留插入顺序。已写入主消息的 prompt 按该消息在模型历史中的位置切分，包括 steer 和重新排队的草稿。未写入消息的排队或取消项按最近一次准入定位。新准入顺序同时覆盖会话及工作区，跨目录移动后仍能比较。

     对应 04 的 T16c，并补 fork 04 §4.3 的用例。
   - side chat：撤销入口对 side chat 会话返回 `SIDE_CHAT_UNSUPPORTED`，放在第 6.1 步的会话检查里。撤销在 side chat 之后落地，由本议题加这个检查和对应用例（04 的 T16b）。
9. **路由与 SDK**：
   - `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` 新增 `POST /v1/sessions/:sessionId/rewind`，校验与其他会话路由一致。照同一文件里的 fork 路由（:200-226）写：它在出错时调用 `sessionFailure`（:43），按错误码映射状态码并返回 `{ ok: false, error: { code, message } }`。压缩路由（:460-500）也用 `sessionFailure`，但把不认识的错误兜底成 400，不要照抄这一点；状态码沿用 `packages/ohbaby-server/src/protocols/global-sessions.ts:96-125` 的 `globalSessionErrorStatus`（`SESSION_NOT_FOUND` 404，`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`、`SESSION_RUNNING` 409）。这个函数遇到不认识的错误码会返回 500，所以要在里面加上两个新错误码 → 400。响应体带上 `code`。
   - `packages/ohbaby-sdk/src/contract/client.ts` 的会话命令客户端加 `rewindSession({ sessionId, promptId, text? })`，HTTP 客户端和进程内实现行为一致。
   - 新错误码 `REWIND_TARGET_INVALID`、`REWIND_BEFORE_COMPACTION` 定义在 `packages/ohbaby-sdk/src/contract/global-sessions.ts`，和那里现有的 `SESSION_RUNNING`、`SESSION_MOVED`、`FORK_TARGET_INVALID` 放在一起；`SESSION_NOT_ROOT`、`SESSION_ARCHIVED` 不在 SDK 里，由 agent 的 `SessionArchiveError`（`A/services/session/errors.ts:73-77`）抛出，服务端映射在 `packages/ohbaby-server/src/protocols/global-sessions.ts:118-119`，沿用即可。

**完成定义**：04 的 T1 至 T17（含 T1b、T1c、T12b、T13b、T15b、T15c、T16b、T16c）通过。

### Stage 2：Web

**前置**：[消息复制议题](../../2026-11-04-message-copy/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 1 已完成，`MessageActions` 已存在。

**目标**：用户在 Web 上点 Edit，直接在气泡里改文字，点 Send 后对话退回到这一条，改过的文字作为新一轮发出。

**改动**：

1. 用户消息卡片下方的操作栏（`MessageActions`），鼠标悬停时出现，紧挨复制按钮加一个铅笔图标按钮，提示文字“Edit”。任意一条用户消息都可以选，**包括正在跑的这一轮**。steer 消息、没有对应 prompt 的消息不显示；排队中还没开始的 prompt 没有消息气泡，仍由排队区自己的编辑处理。做法和 fork 按钮一样：`ConversationStream` 加可选回调 `onEdit?: (promptId) => void`，只有主会话视图传它，所以 side chat 面板和子代理对话里都没有这个按钮。side chat 议题给 `ConversationStream` 加的 `variant: "side-chat"` 开关下也不挂 Edit，两条规则同时满足。
2. 会话在运行、有排队、goal 在跑时按钮照常可点，不置灰；后端会先停下来（Stage 1 第 6.3 步）。只有正在压缩时置灰，提示“Compacting…”。
3. 点 Edit 后，这条用户消息的气泡原地变成编辑框，预填原文，下方有 Cancel 和 Send：
   - Enter 发送，Shift+Enter 换行，Esc 等同 Cancel。
   - 编辑框下方一行灰字（下面是中文意思，界面上用[前端设计](../../2026-11-10-session-actions-frontend.md)第五节的英文文案）：“文件改动不会撤销”；这一条之后还有 N 轮时追加“之后的 N 轮对话会被移除”；有 goal 时追加“goal 已用的轮数不会回退”；会话在运行时追加“当前任务会先停止”；有排队的 prompt 时追加“排队中的 N 条消息也会移除”；goal 处于 `active` 时追加“goal 会暂停”。说明写在编辑框里，点 Send 就算确认，不再弹确认框。说明随会话状态实时更新。
   - 文字为空时 Send 置灰。
   - 同一时间只能有一个气泡处于编辑状态；主输入框和它的草稿不受影响。
   - 编辑状态只存在组件里，刷新页面就丢，不做持久化。
4. 点 Send 调用 `rewindSession({ sessionId, promptId, text })`：
   - 成功且有 `prompt`：退出编辑状态，新一轮照常出现。
   - 成功但带 `sendError`：退出编辑状态，把改过的文字放进主输入框并提示发送失败的原因。`prefillComposer` 会直接覆盖草稿（`useComposerDraft.ts:249-259`），所以输入框为空时直接填入，有草稿时把改过的文字接在草稿后面（空一行）。
   - 失败：保持编辑状态和用户改过的文字，按错误码提示，例如 `REWIND_BEFORE_COMPACTION` 提示“This message was compacted and can’t be edited”，`SESSION_RUNNING` 提示“The session is busy, try again in a moment”。
   - 请求进行中（含后端等待停下来的几秒）Send 显示加载状态，不能重复点。
5. 视图：`removedMessageIds` 已由 `W/store/store.ts:551` 附近的处理从已加载历史里移除，不需要新代码。prompt 在 store 合并时处理一次：带 `rewoundAt` 的 prompt 从已加载和记住的 prompt 里移除（`rememberPrompt`，`W/store/store.ts:105-108`），渲染层不用改。

**完成定义**：04 的 T18 至 T23 通过（浏览器走查）。

### Stage 3：TUI `/rewind`

**目标**：TUI 用户能选一轮撤销，原文回到输入框。

**改动**：

1. `A/commands/catalog.ts` 加 `rewind` 命令（不设别名），`surfaces` 只含 `tui`，在 `T/app.tsx` 本地拦截（参照 `export`，:231）。
2. 在 `T/components/dialog/command-panel-state.ts` 加一种交互面板，列出可撤销的 prompt，最新的在最上面，每行显示原文第一行和时间。TUI 只持有视图里最近一段 prompt，列表只覆盖这一段。
3. 选中后显示一行确认（界面上用前端设计 5.2 的英文文案）：“撤销 N 轮，文件改动不会撤销，goal 已用的轮数不会回退。Enter 确认，Esc 取消。”会话在运行、有排队或 goal 在跑时，按 Web 编辑框的规则追加对应说明。运行中也能执行 `/rewind`，行为与 Web 相同。
4. 成功后把原文放进输入框，参照 `restoreQueuedEditInput`（`T/components/prompt/index.tsx:369`）。输入框有内容时先确认是否替换。失败时显示错误码对应的提示。
5. 视图更新：消息走 `session-recovery.ts` 现有的 `removedMessageIds` 处理；prompt 现在是直接覆盖写入（`T/store/events.ts:120-124`），要改为收到带 `rewoundAt` 的 prompt 时从 store 里移除。每轮结束时追加的完成提示（`T/store/transcript.ts:385-432` 的 `appendTurnCompletions`）目前只增不删，撤销后要把被撤销轮次的那几行一并删掉，否则屏幕上会留下孤立的“Total Xs”。

**完成定义**：04 的 T24 至 T26 通过（手工走查）。

### Stage 4：权威文档同步

| 文档 | 改什么 |
|---|---|
| `docs/core/message/data-model.md` §消息生命周期 | 增加“已撤销”状态，说明与删除的区别、哪些入口会过滤、哪些不会 |
| `docs/core/message/architecture.md` | 存储职责补充 `markRewound` 和列表入口的默认过滤 |
| `docs/runtime/prompt-scheduler/` | prompt 的 `rewound_at` 与列表过滤 |
| `docs/services/session/`（会话生命周期相关文档） | 补充撤销操作与忙碌判断 |
| `docs/services/database/` | 记录迁移 `029` |
| `docs/agents/data-model.md` | `subagent_execution.rewound_at`、`markRewoundByRootRuns`、列表默认过滤 |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/rewind` |

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | 迁移 `029`；`adapters/ui-inprocess/session-rewind.ts` | `core/message/{database-store,store,manager}.ts`、`runtime/prompt-scheduler/database-store.ts` 及内存实现、`services/database/{migrations,schema}.ts`、`services/session/global-query.ts`、`adapters/ui-inprocess.ts`（接入撤销）、`adapters/ui-inprocess/{subagent-instances,subagent-views}.ts`、`agents/subagents/execution-store.ts`（`markRewoundByRootRuns`）、`goals/service.ts`（`pauseGoal` 加 `preserveBackground` 选项）、`commands/catalog.ts` |
| `packages/ohbaby-server` | 撤销路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`（两个新错误码 → 400） |
| `packages/ohbaby-sdk` | `rewindSession`、新错误码 | `contract/client.ts`、`contract/global-sessions.ts`、`UiPromptSubmission` 类型、HTTP 客户端 |
| `apps/ohbaby-web` | 用户消息编辑框组件（放在 `ui/conversation/` 下） | `ui/conversation/{ConversationStream,MessageRow}.tsx`、`ui/session/SessionScreen.tsx`（发送失败时预填主输入框）、`store/store.ts`（prompt 合并）、`runtime/index.ts`、`dev/mock-runtime.ts`（`rewindSession`） |
| `packages/ohbaby-cli` | 撤销选择面板 | `tui/app.tsx`、`tui/components/dialog/command-panel-state.ts`、`tui/components/prompt/index.tsx`、`tui/store/events.ts` |

## 2.5 接口、协议与迁移

### 撤销接口

```
POST /v1/sessions/:sessionId/rewind
请求体：{ "promptId": "prompt_...", "text": "改过的文字（可选）" }

200：{ "sessionId": "...", "restoredText": "原文",
       "prompt": { 新 prompt 的回执，仅带 text 且接收成功时有 },
       "sendError": { "code": "...", "message": "..." }  仅带 text 且接收失败时有 }
404 SESSION_NOT_FOUND       会话不存在
409 SESSION_RUNNING         独立 TUI 正占用此会话、正在压缩、恢复未就绪、排队区有 retained 或被别的窗口锁住编辑的 prompt、停下来时 10 秒内没占到闸门
409 SESSION_MOVED           会话已移到别的目录（沿用现有错误码）
409 SESSION_NOT_ROOT        子代理会话
409 SIDE_CHAT_UNSUPPORTED   side chat 会话（见 Stage 1 第 8 步；已归档的 side chat 返回 SESSION_ARCHIVED）
409 SESSION_ARCHIVED        已归档会话
400 REWIND_TARGET_INVALID     目标不存在、不属于该会话、还在排队或没开始、没有用户消息、是 steer、已被撤销；或 text 为空白
400 REWIND_BEFORE_COMPACTION  目标在最近一次压缩之前
```

### SDK

- `rewindSession(input: { sessionId: string; promptId: string; text?: string }): Promise<UiRewindSessionResult>`
- `UiRewindSessionResult = { sessionId; restoredText; prompt?: UiPromptReceipt; sendError?: { code; message } }`
- `UiPromptSubmission.rewoundAt?: string`

### 迁移

- `029_message_rewind`：三张表加可空列，会话表另记录撤销修订号。向前兼容；旧版本程序读新库不报错，但会把已撤销的消息当作普通消息显示并发给模型。发布说明里要写明“升级后不要降级到旧版本继续使用撤销过的会话”。

### 实施时新增、对所有会话生效的改动（2026-11-10 验收补记）

| 改动 | 位置 | 影响 |
|---|---|---|
| goal 驱动者归属 | `A/goals/persistence.ts`，`app_state` 里按会话登记驱动 goal 的后端（进程实例 ID 加 PID） | 修掉 main 上已有的问题：另一个后端打开会话时，会把别人正在驱动的 goal 改成 `paused`。现在只有驱动者能暂停或清除 goal，其他后端返回 `SESSION_RUNNING`；驱动者不在了，才按崩溃残留改成 `paused`。对所有用 goal 的会话生效（00 第 6 节 D2） |
| `KeyLockManager` 没有前驱时同步启动 | `A/services/storage/lock-manager.ts` | 原来至少等一个 microtask。全局存储锁也用它，排队语义不变，只是时序提前 |
| 准入序号 | `A/runtime/prompt-scheduler/database-store.ts`、`in-memory-store.ts` | `admission_order` 和 `accepted_at` 取工作区和会话两者中的较大值，会话移动工作区后仍可比较，序号会跳号。同一工作区内仍单调递增 |
| 撤销期间隐式提交 | `A/runtime/prompt-scheduler/scheduler.ts` 的 `accept` | 没带 `sessionId` 的提交解析到正在撤销的会话时，排队等撤销结束，最多被拖住约 10 秒。新建会话不受影响 |
| 复制 prompt 的条件 | `A/services/session/copy-history.ts` 的 prompts 汇总 | 除第 8 步的四处外，这里也加了 `rewound_at IS NULL`，效果相同 |

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某个直接写 SQL 的读取方 | 已撤销的内容又回到模型上下文或界面 | 过滤放在列表入口；Stage 1 第 5 步的普查表；04 的 T5 至 T12 |
| 视图缓存没更新 | `GET /view` 仍返回已撤销的消息 | 走消息管理器提交流程（Stage 1 第 3 步）；04 的 T6 |
| 撤销与新 prompt、goal 续跑、子代理唤醒竞争 | 新内容落进被撤销范围，或撤销后又冒出新一轮 | 同一后台把撤销期间的新提问排在撤销及修改稿之后。独立 TUI 占用会话时返回忙。goal 和子代理按 Stage 1 第 6.3 步处理，见 04 的 T14、T15、T15b |
| 子代理结果在撤销后回流 | 父会话出现一轮用户没发过的对话 | 先停止，再把未投递的结果改为不投递（Stage 1 第 6.5、6.6 步）；04 的 T13 |
| 停止子代理或后台任务失败 | 撤销做了一半 | 停止放在标记之前，失败时什么都不改（Stage 1 第 6.5 步）；04 的 T13b |
| 停下来时等待超时 | 撤销没做成，但当前这一轮已被中断、排队已取消、goal 已暂停 | 返回 `SESSION_RUNNING`，前端保留编辑框和文字，用户可以再点 Send；04 的 T15c |
| 降级 | 旧版本显示已撤销内容 | 发布说明；数据没有丢，只是不再过滤 |

回滚：界面入口可以单独撤掉；数据上把 `rewound_at` 清空就能恢复全部消息。迁移 `029` 只加列，不需要反向迁移。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| Web 气泡编辑、Send 一次完成；TUI 填回原文 | Stage 1 第 6.8、6.9 步、Stage 2 第 3、4 步、Stage 3 第 4 步 |
| 旧消息保留、隐藏 | 决策表第 1、2 行；Stage 1 第 1 至 5 步 |
| 文件不回滚，界面说明 | 决策表“文件改动”行、Stage 2 第 3 步、Stage 3 第 3 步 |
| 压缩点之前不能撤销 | Stage 1 第 6.2 步、Stage 2 第 4 步 |
| steer 不是撤销点 | Stage 1 第 6.2、6.4 步、Stage 2 第 1 步 |
| 运行中先停再撤（取消排队、暂停 goal、中断并等空闲） | Stage 1 第 6.3 步、Stage 2 第 2、3 步、Stage 3 第 3 步 |
| 停止并隐藏子代理、停止后台任务 | Stage 1 第 6.5、6.6、7 步 |
| 草稿确认（仅 TUI） | Stage 3 第 4 步 |
| goal 计数不回退并说明 | Stage 2 第 3 步、Stage 3 第 3 步 |
| Web Edit 按钮、TUI `/rewind` | Stage 2、Stage 3 |
| P1 至 P13 | 决策表与 Stage 1、2、3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 连文件一起回滚 | 另立议题：`snapshot` 模块补只回退 AI 改过的文件、回退前查冲突、默认开启（含大仓库耗时评估）、清理旧快照；撤销接口加 `files: true`，Web 编辑框加 “Send and undo file changes” |
| 浏览已撤销的分支、重做 | 暂不做，需求出现时再议 |
| TUI 双击 Esc 进入撤销；TUI 撤销视图窗口之外更早的轮次 | 后续小改动 |
| goal 计数回退 | 不做 |
