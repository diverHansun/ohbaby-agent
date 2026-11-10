# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写同 01。

## 2.1 方案总览

side chat 是一个隐藏的根会话，`data.sideChat` 记着它属于哪个主会话。打开时复制主会话的历史，再加一条边界消息。Web 的 side chat 面板另开一个 daemon 客户端绑定到它，查看、提交、中止、审批都走现有接口；后端在提交目标是 side chat 时不改动共用的当前会话，TUI 因此不会被拉走。新写的东西：复制历史的函数、打开与关闭、列表过滤、操作拦截、沿用主会话的缓存身份与 MCP 工具和审批规则、主会话归档时关闭、刷新后恢复、两端的界面。

```
打开 ─► POST /v1/sessions/:mainId/side-chats（每次新建一个）
          一个事务：copySessionHistory（切在最近一个已结束的主 run）+ 写边界消息
          → { sideChatId, title, boundaryMessageId }
列出 ─► GET /v1/sessions/:mainId/side-chats（刷新后恢复还开着的）

Web 面板 ─► 新建 daemon 客户端（新 clientId、自己的 store 和事件流）
            → 绑定 sideChatId → 现有的 view / prompts / abort / 审批
            → 只显示边界消息之后的内容
TUI ────► 进程内：提交与中止显式带 sideChatId；后端不改当前会话
          面板自己读 side chat 的视图；审批同时同步主会话和 side chat

关闭 ─► DELETE /v1/side-chats/:sideChatId → 取消排队、中止并等待（≤5 秒）→ 删除 → 清理内存（重复关闭返回 204）
启动 ─► daemon、进程内 TUI 清理创建进程已退出或本进程 PID 已复用的 side chat
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 放在哪类会话里 | 隐藏的根会话，`data.sideChat` 标记 | 现有读取、推送、提交、中止、审批都能直接用 | 子会话（十几处检查要开口子，提交还会把客户端绑定切走，见 01 §1.3） | 要从约十个列表里过滤掉它，要显式拦住约八种操作 |
| Web 同时看两个会话 | 第二个 daemon 客户端 | 服务端本来按客户端分别记绑定 | 在一个客户端里加“第二绑定” | 面板要有一个精简的运行时对象 |
| TUI 不被拉走 | 后端规则：提交目标是 side chat 时不调用 `setActiveSessionId` | 只有两个调用点，规则放在后端，Web 和 TUI 都受益，SDK 不用改 | 给提交接口加参数 | 无 |
| 隐藏 | 新判断函数 `isUserFacingSession`，只用于列表 | `isPrimarySession` 和会话快照管着绑定与取消息，不能动 | 改 `isPrimarySession`（side chat 自己就绑不上了） | 列表点位要逐个改 |
| 拦截 | 统一错误码 `SIDE_CHAT_UNSUPPORTED`（409） | 一个码表达“side chat 不支持这个操作” | 每种操作各用一个码 | 无 |
| 给模型的说明 | 一条普通用户消息 | 打开时就能写；不改系统提示词 | 提醒类消息（只能在运行时写）；改系统提示词（缓存失效） | 无 |
| 子代理 | `accessGuard` 在执行时拒绝 `agent` 工具 | 工具列表不变 | 从工具列表去掉 | 无 |
| 缓存 | 沿用主会话的缓存：同一份系统提示词，用主会话的 ID 计算缓存身份，带上主会话已加载的 MCP 工具 | 三种接口都靠“前缀一致”命中，OpenAI 兼容接口还要 key 一致；codex、kimi-code 都这样做并有测试守住 | 不处理（OpenAI 兼容接口、加载过 MCP 工具的会话命中不了，原 P11） | run 多一个可选的缓存身份参数 |
| 启动清理 | 删除 PID 已退出或本机当前 PID 与旧进程实例 ID 不匹配的 side chat；daemon 启动和进程内 TUI 启动时都做 | 多个进程可能共用一个数据库 | 全部删除（会误删正在用的） | `data.sideChat` 记录创建进程的 PID 和实例 ID |
| 数量 | 一个主会话可以开多个，每次新建，标题 `Side chat N` | 临时的，可以多开（00 P2） | 一个主会话一个（原计划） | 标题取号要在事务里做 |
| 切点 | 主会话最近一个已结束的主 run，打开时的快照 | 一轮等于一个 run（00 P14） | 按 prompt 切（漏掉唤醒轮） | 无 |
| 审批规则 | 打开时复制主会话的“总是允许” | 审批跟主会话走（00 P10） | 不带过去（原计划） | 打开时一个循环 |
| 主会话归档 | 关闭它的全部 side chat | 不留残留（00 P15） | 等下次启动清理 | 归档多一步 |
| 刷新、切换主会话 | side chat 不关闭；刷新后列出还开着的恢复；切换主会话只收起标签，客户端保留 | 刷新不该丢（00 P16） | 客户端断开 5 秒就删（用户否决） | 一个列表接口 |
| 空主会话 | 主会话还没有消息时不能打开 | 照 codex（00 P17） | 建一个只有边界消息的 side chat | 无 |

## 2.3 分阶段实施

**前置**：

- 无。复制历史的函数由本议题写（Stage 1 第 0 步）。Stage 2 用到的 `MessageActions`（消息复制议题）已经落地。
- 开发顺序：本议题 → fork → 撤销重发（00 P18）。

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：核心与服务端

**目标**：复制函数可用；能打开、使用、关闭 side chat；它不出现在任何用户可见的列表里，被禁用的操作都返回 `SIDE_CHAT_UNSUPPORTED`。

**改动**：

0. **复制函数**（00 P18）：新建 `A/services/session/copy-history.ts`，导出同步函数 `copySessionHistory(tx, input)`，入参见 §2.5。`runWriteTransaction`（`A/services/database/index.ts:323-330`）要求回调同步执行，所以这个函数自己不开事务，在调用方已经打开的事务回调里执行（本议题的 `openSideChat`，以后 fork 的 adapter 也一样）。做法原写在 fork 议题 02，已搬到这里，fork 议题改为直接调用本函数（2026-11-08 确认，学 ZCode）；切点按 run 定：
   1. **定切点**：`cutRunId` 为 `null` 时跳过第 2 至 4 步，只写会话行。否则这个 run 必须属于源会话、在主上下文（`context_scope_id` 为空）、已结束（规则见第 2.3 步）。切点消息是主上下文里 `data.runId` 等于这个 run 的最后一条消息，排序同 `listBySession`（`created_at, rowid`）。找不到时抛出 `HistoryCutInvalidError(sessionId, runId)`（side chat 只传它自己查到的已结束 run，不会触发；fork 以后在自己的入口把它转成 `FORK_TARGET_INVALID`）。
   2. **选行**：
      - 消息：主上下文、按 `created_at, rowid` 排序、到切点消息为止（含）。
      - 片段：属于上面这些消息的全部片段，按消息顺序和 `order_index`。
      - prompt：读取源会话全部工作区的记录，写副本时统一将 `scope_key` 置为目标 `promptScopeKey`。选行要求 `session_id` 为源会话、`user_message_id` 或 `run_id` 落在复制范围内、状态为 `succeeded`、`failed`、`cancelled`、`interrupted` 或 `steered`。
      - 当前轮输入：`message_id` 落在复制的消息里的行。
      - run：上面这些行引用到的主上下文 run，各列原样复制（包括 `inputs_closed_at`，`filterModelHistory` 靠它判断输入是否有效，`A/runtime/prompt-scheduler/current-run-inputs.ts:195-206`）。
      - 撤销落地后，由撤销议题在第 1、2 步加上 `rewound_at IS NULL`。
   3. **建 ID 映射**：给新会话、每条消息、每个片段、每个 run、每个 prompt、每个输入生成新值。
      - 消息 ID 不能用现有生成器（随机后缀无序，`A/core/message/id-generator.ts:14-18`；用户消息又是 UUID 格式）。把复制的消息按源会话的 `(created_at, id)` 排名，新 ID 写成 `message_-copy_<补零的名次>_<本次复制的 UUID>`，视图分页（按 `created_at, id`，`A/core/message/database-store.ts:236-242`）因此和源会话顺序一致；插入时按源 `(created_at, rowid)` 顺序写，模型历史顺序也一致。同一毫秒内，边界 ID `message_-side_<UUID>` 排在复制消息之后，正常生成的消息 ID 排在边界之后。
      - 其他 ID 用项目现有的生成器。
      - `client_request_id` 写成 `copy:<新 prompt ID>`，`steer_receipt.clientRequestId` 写成 `copy:<新 prompt ID>:steer`：它们在同一 `scope_key` 内有唯一约束（`A/services/database/migrations.ts:536-537`），两个会话共用这个 `scope_key`。
   4. **改写**：
      - 一条规则：所有被复制行的每个文本列、以及 JSON 列里的每个字符串值，凡是**完全等于**映射表里某个旧值的，换成对应的新值。不单独列字段（覆盖 `id`、`session_id`、`message_id`、`run_id`、`prompt_id`、`user_message_id`、`input_id`、`source_id`、`resend_of_prompt_id`，以及 `data`、`steer_receipt` 里的引用）。
      - 工具调用的 `callId` 不在映射表里，保持原值（模型原生状态回放依赖它）。
      - 片段的 `time.compacted` 晚于切点消息的时间时，去掉这个标记（切点之后的压缩，摘要不在复制范围里）。
   5. **写会话行**：复制 `project_id`、`working_directory`、`workspace_directory`、`pending_working_directory`、`agent`；`parent_id` 为空，`status` 为 `active`，`created_at`、`updated_at` 为当前时间；`title` 用调用方传的值；`message_count` 为复制的消息数，`last_message_at` 为复制消息中最晚的时间；`data` 为 `{ reasoning, modelEntryId, childrenIds: [], isSubagent: false, ...input.data }`，`reasoning`、`modelEntryId` 取自源会话。
   6. **写复制行**：消息与片段保留原来的 `created_at`、`updated_at`，按源顺序插入；run 记录的 `owner_*` 置空；prompt 的 `admission_order` 原样复制，`edit_lease_*`、`owner_*`、`title_expected` 置空，`resend_of_prompt_id` 不在映射表里时置空。
   7. 不复制：goal、排队的 prompt、正在运行的那一轮、子代理实例与执行记录、快照检查点。复制过来的子代理卡片仍显示结果文字，但打不开子代理对话（同 fork 议题 00 P11）。

1. **会话字段**：`Session` 类型（`A/services/session/types.ts`）、`SessionData`、`encodeData`、`rowToSession`（`database-store.ts:176-184、191-217`）、事件的 zod 定义（`events.ts:22-24`）加可选字段 `sideChat?: { mainSessionId: string; boundaryMessageId: string; ownerPid: number; ownerId?: string }`。新记录写入进程启动时生成的 UUID，同一进程各工作区共享。读取旧记录时允许缺少 `ownerId`。加一个判断函数 `isSideChatSession(session)`。SDK 的 `UiSessionIndexEntry`（`packages/ohbaby-sdk/src/contract/permission.ts:30-38`）和全局会话条目加可选的 `isSideChat`。
2. **打开**：新建 `A/adapters/ui-inprocess/side-chat.ts`，由 `ui-inprocess.ts` 注入依赖后暴露 `openSideChat({ mainSessionId })`。打开一个 `runWriteTransaction`，在回调里依次：
   1. 主会话必须存在、是根会话（不是子代理会话）、状态为 `active`、本身不是 side chat、已经开始过（至少有一个主 run，或者有一个已被接收的 prompt：刚发出的第一条消息可能还在排队，没有 run 记录），否则分别返回 `SESSION_NOT_FOUND`、`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`、`SIDE_CHAT_UNSUPPORTED`、`SIDE_CHAT_UNSUPPORTED`（说明 “Send a message first”，00 P17）。
   2. 先用 `assertSessionInWorkspace(main, promptScopeKey)` 检查同一事务读到的主会话。目录已变更时抛 `SessionMovedError`，Fork 编排可直接复用此检查。标题取 `Side chat N`：N 是这个主会话现有 side chat 里最小的空号（00 P2）。取号在这个事务里做，两个并发打开不会拿到同一个号。
   3. 调用 `copySessionHistory(tx, { sourceSessionId: mainSessionId, destinationSessionId: sideChatId, cutRunId, promptScopeKey, title, data: { sideChat: { mainSessionId, boundaryMessageId, ownerPid: process.pid, ownerId: processOwnerId } } })`。`cutRunId` 取主会话最近一个已结束的主 run，在本事务里用 SQL 查，切点要求至少有一条主上下文历史消息；SDK 目前也会列出空消息轮次，二者如何对齐留到 Fork 设计阶段（00 P14）：`run_ledger` 里 `session_id` 为主会话、`context_scope_id` 为空、结束状态为成功、失败、取消或中断（轮次投影议题给 `UiRun.outcome` 的同一来源）；有 prompt 记录（`prompt_submission.run_id` 等于它）的，prompt 也处于已结束状态；没有 prompt 的，至少有一条不带 `runtimeInput` 的消息属于它；按 `COALESCE(started_at, created_at) DESC, run_id DESC` 取第一个（`started_at` 可能为空；与 SDK `listEndedTurns` 的排序一致）。这条查询写成独立函数 `findEndedMainRun(db, sessionId, runId?)`（放在 `copy-history.ts` 旁边）：不给 `runId` 返回最近一个，给了就检查这个 run 是否已结束；fork 议题直接调用它。主会话第一轮还在跑、没有已结束的 run 时传 `null`（只建会话行，side chat 里只有边界消息）。复制函数的切点参数因此按 run 定，不再按 prompt 定。撤销落地后，由撤销议题在这条查询里加“未被撤销”的条件。`boundaryMessageId` 事先生成好。
   4. 写边界消息：一条 `role: "user"` 的消息，一个文本片段，不带 `runtimeInput`，ID 为上一步的 `boundaryMessageId`，`created_at` 为当前时间。`filterModelHistory` 会保留这样的消息（`A/runtime/prompt-scheduler/current-run-inputs.ts:524-526`）。正文用英文，依次写：
      - 现在在 side chat 里，不是主对话；之前的内容是从主会话继承的，只供参考；
      - 不要接着做主会话里的任务；
      - 用户在边界之后没有明确要求时，不要修改文件、Git 和配置；
      - 子代理不可用；
      - 如果主会话有正在运行的主 run，按它的触发来源（`run_ledger.trigger`）再附一句：`user` 附上那条 prompt 的原文；`goal` 写主对话正在继续 goal，附 goal 内容；`subagent` 写主对话正在处理子代理交回的结果。第一条消息还在排队、没有 run 时，附上那条 prompt 的原文。

   5. 更新 side chat 的会话行：`message_count` 加一，`last_message_at` 设为边界消息的时间（复制函数写会话行时还没有这条消息）。

   事务提交后、返回之前，依次：
   - 把主会话当时的“总是允许”规则（`permissionState.getSessionRules(mainSessionId)`，`A/permission/state.ts:76-91`）逐条用 `addSessionRule` 登记给 side chat（00 P10）；
   - 同 fork 议题一样发布 `SessionEvent.Created` 和会话索引失效通知，返回 `{ sideChatId, title, boundaryMessageId }`。
3. **列表过滤**：新建判断函数 `isUserFacingSession(session)`（放在 `A/adapters/ui-inprocess/session-controller.ts` 的 `isPrimarySession` 旁边），等于“`isPrimarySession` 为真，并且不是 side chat”。用在 01 §1.4.3 表里的每一处：
   - 全局列表与搜索：SQL 加 `json_extract(data, '$.sideChat') IS NULL`。
   - Web 备用侧栏：按索引条目的 `isSideChat` 过滤。
   - 其余各处：调用 `isUserFacingSession`。TUI 启动“继续上次会话”时把 side chat 归为 `temporary`。
4. **操作拦截**：在 01 §1.4.4 表里各操作的入口加一行检查，目标是 side chat 时返回 `SIDE_CHAT_UNSUPPORTED`。检查不放进 `assertCanUseAsPrimarySession`，它也管 prompt 提交。压缩只拦手动入口（`resolveCompactTarget`，`ui-inprocess.ts:3588`），上下文管理里的自动压缩不拦（00 P7）。显式以侧聊为目标的 `executeCommand` 一律返回 `SIDE_CHAT_UNSUPPORTED`，TUI 的 `/btw` 阶段再评估是否需要开放个别命令。fork、撤销在本议题之后实施，它们的入口检查由各自议题加（00 P18）。
5. **子代理**：在 `accessGuard`（`A/adapters/ui-runtime/composition.ts:414` 起）里，请求会话是 side chat 且工具是 `agent` 时，返回“Subagents are not available in side chat.”。这个检查要放在“不是 MCP 工具就直接放行”的早返回之前。
   模型通过工具访问 goal 时同样在执行入口拒绝，使用 goals 模块定义的工具名。
5a. **缓存**（00 P11）：不另写缓存逻辑，沿用主会话的请求路径。
   - 缓存身份：新增可选字段 `promptCacheSessionId`，默认等于会话自己的 ID。提交路径（`ui-inprocess.ts` 约 :4038-4056 组装 run 参数处）读会话的 `data.sideChat`，是 side chat 时设为 `mainSessionId`，经 run 管理器传进 lifecycle 参数。它只替换两处模型调用传给 LLM 客户端的 `sessionId`：agent 步骤（`A/core/lifecycle/lifecycle.ts` 传给 `streamResponse` 处，约 :1528）和自动压缩生成摘要（`A/adapters/ui-runtime/prompt-context.ts:81-90`），最终进入 `resolvePromptCacheRequest`（`packages/ohbaby-llm/src/client/prompt-cache.ts`）。这样 OpenAI 兼容接口发出的 `prompt_cache_key` 与主会话相同；Anthropic、OpenAI Responses 按前缀匹配，不需要别的处理。消息归属、run、审批、缓存用量统计仍用 side chat 自己的 ID。
   - 工具定义：不另做处理，依赖[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)先落地（2026-11-10 确认，取代原来新增 `copyScope(from, to)` 的做法）。该议题把已加载的 MCP 工具改为从历史里 `select_tools` 的结果推导，工具顺序按“内置工具注册顺序 + 历史里的加载顺序”计算，并删除 `ScopeToolSequence`。side chat 的历史复制自主会话主上下文，第一次用到时重建出的工具和顺序就与主会话一致。
   - 系统提示词：不改（00 P3）。
6. **不改当前会话**：prompt 提交路径设当前会话的两处（`ui-inprocess.ts:1804`、`:4120`），在目标会话是 side chat 时跳过 `stateStore.setActiveSessionId`。
7. **存储区**：会话存储区已经落地（2026-11-05），由本议题让“side chat 归主会话”这条规则生效，并补 04 的 T12。
   - 归属只在一处计算：`initialTrustedRoots` 回调（`A/adapters/ui-runtime/composition.ts:471-473`），现在是 `session?.parentId ?? scope.sessionId`。在这里加一个分支：会话是 side chat 时用 `data.sideChat.mainSessionId`。
   - 环境提醒、工具输出存盘和 Bash 日志都从登记好的可信路径里取存储位置（`A/core/lifecycle/lifecycle.ts:623-625`、`A/tools/utils/output.ts:22`），不用另外改。
   - 关闭时 `cleanupDeletedSessionFiles` 按会话 ID 删除 `sessions/<id>`，不计算归属。side chat 没有自己的目录，所以这一步什么也不删，主会话的目录和 side chat 写进主会话 scratch 的文件都保留。不要为了“清理 side chat 的文件”在这里改成按归属删除。
   - side chat 面板不放 Files 页。Files 接口按客户端绑定的根会话找目录（`S/protocols/web/routes/sessions.ts:63-75`），由 side chat 的客户端调用时会找 `sessions/<sideChatId>`，以后要在面板里放文件页时，需要先改这一点。
8. **关闭**：在 `A/services/session/archive.ts` 旁新增 `deleteSideChatSession(db, sideChatId, { skipBusyCheck })`：要求是 side chat，不要求已归档；删除方式同 `deleteArchivedSession`。adapter 的 `closeSideChat({ sideChatId })`：
   - 找不到 side chat 时直接返回；
   - 取消它排队中的 prompt，对正在运行的一轮调用 `abortRun`（`ui-inprocess.ts:5388`）；`abortRun` 不保证返回时运行已经结束，所以接着每 100 毫秒检查一次 `sourceLedger.getActiveRuns(sideChatId)` 和活动 prompt，直到都为空，最多等 5 秒，超时返回 `SESSION_RUNNING`；
   - 调用删除函数，清理内存状态（参照归档 `ui-inprocess.ts:3300-3306`，另调用权限管理器的 `clearSession(sideChatId)`（`A/permission/manager.ts:556`，它清掉规则，同时取消这个会话还在等待的审批）调用 `cleanupDeletedSessionFiles`，发布会话移除事件。
8a. **主会话归档**（00 P15）：归档主会话（`ui-inprocess.ts:3267` 的 `archiveSessionInternal`）时，在忙碌检查通过之后、把状态改成 `archived` 之前，找出 `data.sideChat.mainSessionId` 等于它的全部 side chat，在各侧聊原有工作区的运行实例逐个调用 `closeSideChat`。忙碌检查失败时不碰 side chat。永久删除只能删已归档的会话，那时它的 side chat 已经关掉，不用另外处理。
9. **启动清理**：daemon 启动和持久化进程内后端初始化均在恢复工作前调用 `deleteOrphanSideChats`。创建 PID 已退出，或 PID 等于当前进程但实例 ID 不同（包括旧记录缺少 ID）时，跳过忙碌检查并删除侧聊。其他存活 PID 的旧记录保留给其创建进程。
10. **路由与 SDK**：
    - `S/protocols/web/routes/sessions.ts` 新增 `POST /v1/sessions/:mainId/side-chats`、`GET /v1/sessions/:mainId/side-chats` 和 `DELETE /v1/side-chats/:sideChatId`。`GET` 按 `data.sideChat.mainSessionId` 列出这个主会话当前开着、`ownerId` 等于本进程实例 ID 的 side chat，按创建时间排序（00 P16）：同一个库里进程内 TUI 开的 side chat 不会出现在 Web 上。状态码沿用 `globalSessionErrorStatus`（`S/protocols/global-sessions.ts:94-120`），本议题在里面加 `SIDE_CHAT_UNSUPPORTED` → 409，响应体带 `code`；会话路由按错误码映射状态码的写法照同一文件里的 Files 路由（`S/protocols/web/routes/sessions.ts:84-96`）。fork、撤销以后复用这套写法。
    - `packages/ohbaby-sdk/src/contract/client.ts` 加 `openSideChat`、`closeSideChat`、`listSideChats`，HTTP 与进程内实现一致；`SIDE_CHAT_UNSUPPORTED` 放进 `contract/global-sessions.ts`。

**完成定义**：04 的 C1 至 C9、T1 至 T13（含 T9b、T13b）通过。

### Stage 2：Web

**改动**：

1. **运行时接口**：`OhbabyWebRuntime`（`W/runtime/index.ts:38` 起）加 `openSideChat(mainSessionId)`、`listSideChats(mainSessionId)` 和 `closeSideChat(sideChatId)`，mock 运行时（`W/dev/mock-runtime.ts`）同步实现。
2. **side chat 客户端**：新建 `W/ui/side-chat/side-chat-runtime.ts`。打开时：
   - 调用 `runtime.openSideChat` 拿到 `sideChatId`；
   - 用 `createOhbabyWebStore()` 建一个新 store，用 `createBrowserDaemonClient` 和新的 `randomUUID()` clientId 建一个新客户端，并打开它自己的事件流；注册时带 `startupIntent.resumeSessionId = sideChatId`（`S/coordination/client-view.ts:124-133`）；
   - 对外提供面板需要的最小接口：消息与 prompt 列表、提交、中止、审批。

   页面加载时，调用 `runtime.listSideChats(mainSessionId)`，按结果给每个还开着的 side chat 建客户端、摆回面板（00 P16）。客户端断开不关闭 side chat，事件流沿用现有的重连逻辑。

   关闭时先调用 `runtime.closeSideChat`，再销毁这个客户端和它的事件流。这个客户端建在 `InstanceLayer` 之外，不影响主客户端。现有的 `GlobalLayer.scopedHttp` 也是在 `InstanceLayer` 之外建客户端，但它不开事件流，这里需要开。
3. **右侧面板标签**（00 P12）：在 `W/ui/side-panel/side-pages.ts` 的 `SidePageStates`、`SIDE_PAGES` 和 `SidePanelPage.tsx` 各加一项 `sideChat`，照终端的写法：没有 `initialState`，只在服务端建好 side chat 之后才开标签，状态是 `{ mainSessionId, sideChatId, title, awaitingApproval? }`，`tabLabel` 显示标题，`awaitingApproval` 为真时在标题旁加小圆点，悬停显示 “Waiting for approval”。入口页那一项写 “Ask about this chat without changing it”。
   - 新建入口：主界面顶栏菜单加 “Side chat”，快捷键暂定 `⌘;`（实施时确认不和浏览器、现有快捷键冲突）；右侧面板入口页；side chat 标签排里的 +。主会话还没开始过时三个入口都置灰，悬停显示 “Send a message first”（00 P17）。三个入口都是先调用 `openSideChat`，拿到结果后用 `openPage("sideChat", state)` 新开一个标签；不用 `revealPage`，它会覆盖已有的 side chat 标签。刷新后恢复也是逐个新开标签。
   - 切换主会话：现有 `use-side-panel.ts` 在主会话变化时重置 `sessionScoped` 页的状态，这条保留不变（`sideChat` 不设 `sessionScoped`）。另加一条：只显示 `mainSessionId` 等于当前主会话的 side chat 标签，其余的收起但不移除，它们的客户端和事件流也保留，审批照常到达；切回来时直接显示，不用重新列出。
4. **面板内容**：新建 `W/ui/side-chat/SideChatPage.tsx`。
   - 给 `ConversationStream` 加一个开关 `variant: "side-chat"`：为真时，消息操作栏只挂复制按钮（不挂 Edit、fork），也不挂“Ask in side chat”。由本议题添加。本议题先于 fork 和撤销实施（00 P18），Edit、fork 按钮由它们以后挂上，挂按钮时要遵守这个开关。
   - 用 `ConversationPresentation` 包住 `ConversationStream`（参照 `W/ui/session/SubagentConversationBody.tsx`），只传 `boundaryMessageId` 之后的消息和这些消息对应的 prompt。没有内容时只显示 “No messages yet”，下面一行小字 “Sees this chat up to now. The main chat won't see it.”。
   - 下方用 `W/ui/composer/ComposerInput.tsx` 做输入框，占位文字 “Ask a quick question”，关闭斜杠命令面板，配发送和停止按钮，不放模型、权限、goal 控件。
   - 审批用 `ApprovalPanel`，数据来自 side chat 自己的 store。
   - 每个 side chat 有关闭按钮，点了直接关闭并删除，不弹确认。
5. **选中文字**：在 `ConversationStream.tsx` 的 `.ohb-stream` 容器（:537-552）上监听选区变化。选区落在主会话的消息正文里且不为空时，在选区附近显示悬浮按钮“Ask in side chat”；点击后：右侧面板当前显示的是某个 side chat 标签，就把选中的文字按 Markdown 引用（每行前加 `> `，后面空一行）填进它的输入框；否则新建一个 side chat 再填进去。不自动发送。

**完成定义**：04 的 T14 至 T19（含 T19b）通过（浏览器走查）。

### Stage 3：TUI `/btw`

**改动**：

1. `A/commands/catalog.ts` 加 `btw` 命令，`surfaces` 只含 `tui`，带一个可选参数；在 `T/app.tsx` 本地拦截（参照 `export`，:231）。TUI 连接远程 daemon 时（`packages/ohbaby-cli/src/bin.ts:377-384` 的远程路径），提示“/btw is not available when connected to a remote daemon”并返回：远程模式下按会话提交会切走客户端的绑定（`client-view.ts:676-684`）。
2. 主会话还没有主 run 时不打开，提示 “/btw is unavailable until this conversation has started. Send a message first, then try /btw again.”（00 P17）；后端同样会返回 `SIDE_CHAT_UNSUPPORTED`。主会话正在运行时可以打开。执行时调用 `openSideChat({ mainSessionId })`，打开新面板 `T/components/side-chat-panel.tsx`：
   - 上半部分参照 `SubagentBrowser` 渲染消息（`renderMessageParts`，`T/components/subagent-browser.tsx:58`）。面板自己按 `sideChatId` 读取视图并订阅更新，只显示边界之后的消息，不依赖 TUI store 里的会话列表。标题栏写“Side chat · Esc to close”。
   - 下半部分保留现有的 `Prompt` 组件，关闭命令面板（输入原样提交），注入一个提交到 side chat 的 `submitPrompt`。不像 `SubagentBrowser` 那样隐藏输入框。
   - 中止同样显式带 side chat 的 ID。
   - 面板打开期间，审批同时同步主会话和 side chat：现有 `usePermissionSync` 一次只绑定一个会话（`T/use-permission-sync.ts:85-97`，接线在 `T/app.tsx:311`），所以再起一个实例绑定 side chat，主会话那个照常运行：side chat 的审批在面板里弹出现有的权限对话框；主会话的审批不在面板里弹，只在标题栏显示“Main session needs approval · Esc to return”，关闭面板回到主会话后照常弹出（00 P10）。
   - 输入框为空时按 Esc：调用 `closeSideChat`，回到主会话。
   - 一次只开一个：面板里没有斜杠命令，打不了 `/btw`，关掉以后才能再开。
3. 带参数的 `/btw <问题>`：打开后立即把问题作为第一条消息提交。

**完成定义**：04 的 T20 至 T23 通过（手工走查）。

### Stage 4：权威文档同步

按 01 §1.12 的清单同步。

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | `services/session/copy-history.ts`、`adapters/ui-inprocess/side-chat.ts` | `services/session/{types,database-store,events,archive,global-query}.ts`、`adapters/ui-inprocess.ts`（打开、关闭、列表过滤、操作拦截、当前会话规则、缓存身份、归档时关闭）、`adapters/ui-inprocess/session-controller.ts`、`adapters/ui-persistent.ts`（进程内启动清理）、`adapters/ui-runtime/{composition,prompt-context}.ts`、`core/lifecycle/lifecycle.ts`、`commands/catalog.ts` |
| `packages/ohbaby-server` | 三个 side chat 路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`、`coordination/client-view.ts`（继续会话和快照）、`app/sse-hub.ts`、`coordination/permission-router.ts`（所有客户端按绑定分发 todo、goal、会话 notice 和审批）、`coordination/session-workspace-move.ts`、`runtime/daemon/main.ts` |
| `packages/ohbaby-sdk` | `openSideChat`、`listSideChats`、`closeSideChat`、`SIDE_CHAT_UNSUPPORTED` | `contract/client.ts`、`contract/global-sessions.ts`、`contract/permission.ts`、HTTP 客户端 |
| `apps/ohbaby-web` | `ui/side-chat/{SideChatPage.tsx,side-chat-runtime.ts}` | `runtime/index.ts`、`dev/mock-runtime.ts`、`ui/side-panel/{side-pages.ts,SidePanelPage.tsx,use-side-panel.ts}`、顶栏菜单所在的组件、`ui/conversation/ConversationStream.tsx` |
| `packages/ohbaby-cli` | `tui/components/side-chat-panel.tsx` | `tui/app.tsx`、`tui/use-permission-sync.ts`（按需支持第二个实例） |

不需要数据库迁移：新字段都在 `session.data` JSON 里。

## 2.5 接口

```
POST   /v1/sessions/:mainId/side-chats  → { sideChatId, title, boundaryMessageId }（每次新建一个）
GET    /v1/sessions/:mainId/side-chats  → { sideChats: [{ sideChatId, title, createdAt, boundaryMessageId, workingDirectory }] }
DELETE /v1/side-chats/:sideChatId      → 204（已经不存在时也返回 204）

404 SESSION_NOT_FOUND        主会话不存在
409 SESSION_NOT_ROOT         主会话本身是子代理会话
409 SESSION_ARCHIVED         主会话已归档
409 SESSION_RUNNING          侧聊属于另一存活进程，或关闭时运行未能在 5 秒内停止
409 SESSION_MOVED            请求所在目录与会话的目标目录不一致，或原工作区的运行实例不可用
409 SIDE_CHAT_UNSUPPORTED    主会话本身是 side chat；主会话还没有消息（“Send a message first”）；或对 side chat 执行被禁用的操作
```

查看、提交、中止、审批都用现有接口，由绑定到 side chat 的客户端调用。

主会话移动工作区后，调用方在新工作区列出还开着的 Side Chat，然后按每条记录的 `workingDirectory` 绑定并用 `boundaryMessageId` 恢复面板。移动前已打开的 Side Chat 留在原目录，移动后新开的使用目标目录。归档主会话时，各工作区分别终止并清理自己负责的 Side Chat。

复制函数（以后 fork 也用）：

```ts
// A/services/session/copy-history.ts
copySessionHistory(tx, input: {
  sourceSessionId: string;
  destinationSessionId?: string; // 调用方可指定目标 ID，省略时由复制函数生成
  cutRunId: string | null;      // null：不复制历史，只写会话行
  promptScopeKey: string;
  title: string;
  data?: Partial<SessionData>;  // 合并进新会话的 data：side chat 传 { sideChat }，fork 以后传 { fork }
}): { sessionId: string; copiedMessageCount: number }
```

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某个列表 | 侧栏、搜索、TUI 列表里出现“Side chat” | `isUserFacingSession` 一处定义；04 的 T4 逐个列表检查 |
| 漏掉某个操作的拦截 | side chat 能被 fork、归档或压缩 | 04 的 T6 逐个操作检查；以后新增会话级操作时要加检查 |
| 第二个客户端影响主客户端 | 主会话的事件中断或绑定被改 | 客户端建在 `InstanceLayer` 之外；04 的 T11、T15 |
| TUI 被拉到 side chat | 主界面切到 side chat | 后端规则（Stage 1 第 6 步）；04 的 T8、T21 |
| 归档与提交并发 | 对所有会话树生效，已归档节点及其后代无法再入队或创建 run | `archiveIdleRoot` 在归档事务内复查空闲状态；prompt 和 run 在各自的写事务内检查 `assertActiveSessionForWork` |
| 启动清理误删 | 别的进程正在用的 side chat 被删 | 检查 PID 存活状态和当前进程实例 ID；04 的 T10 |
| 主会话开着 `full-access` 时 side chat 改了文件 | 用户只想问问题，文件却被改了 | 00 第 6 节 2026-11-08 已接受：审批跟主会话档位走，靠边界消息里的“默认只读”约束模型（同 codex、ZCode） |
| 缓存不命中 | 费用变高 | Stage 1 第 5a 步；04 的 T13b |

回滚：撤掉三个路由和界面入口即可；已创建的 side chat 会在下次 daemon 启动时被清理。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 继承主对话、界面不显示继承内容 | Stage 1 第 2 步、Stage 2 第 4 步、Stage 3 第 2 步 |
| Web 选中文字与右侧面板、TUI `/btw` | Stage 2、Stage 3 |
| 工具可用、默认只读的提示、审批跟主会话走 | Stage 1 第 2.4 步 |
| 禁用清单（00 P7） | Stage 1 第 4、5 步；面板不提供改名和斜杠命令 |
| 关闭即删、启动清理 | Stage 1 第 8、9 步 |
| 一个主会话可以开多个、关闭即删、不弹确认 | Stage 1 第 2.2、8 步；Stage 2 第 4 步 |
| 主会话运行时可开、正在运行的那一轮按触发来源写说明 | Stage 1 第 2.3、2.4 步 |
| 选中文字只有“在 side chat 里问” | Stage 2 第 5 步 |
| 不出现在列表和导出里 | Stage 1 第 3、4 步 |
| 缓存沿用主会话（P11） | Stage 1 第 5a 步 |
| 审批规则复制、等审批时关闭（P10） | Stage 1 第 2 步（提交后）、第 8 步；Stage 3 第 2 步 |
| 主会话归档时关闭（P15） | Stage 1 第 8a 步 |
| 刷新恢复、切换主会话（P16） | Stage 1 第 10 步；Stage 2 第 2、3 步 |
| 主会话没消息不能开（P17） | Stage 1 第 2.1 步；Stage 2 第 3 步；Stage 3 第 2 步 |
| 开发顺序与复制函数（P18） | Stage 1 第 0 步 |
| P1 至 P18 | 决策表与 Stage 1 至 3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 选中文字引用到主输入框 | 不做 |
| side chat 结论带回主会话 | 不做 |
| TUI 连接远程 daemon 时使用 `/btw` | 不做 |
