# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。

## 2.1 方案总览

给 `message` 和 `prompt_submission` 各加一个 `undone_at` 列。撤销在 adapter 层执行，照手动压缩的方式先独占会话，再通过消息管理器的提交流程，把目标用户消息及之后的消息标记为已撤销，同时标记对应的 prompt。存储层的列表入口默认跳过这些行，模型和界面因此都看不到它们，但数据仍在库里。撤销接口返回目标 prompt 的原文，前端把它填回输入框。

```
Web Edit / TUI /undo ──► POST /v1/sessions/:id/undo { promptId }
                           │
              adapter 层   ├─ runControl(sessionId)：检查忙碌（同手动压缩 + goal active），占住执行闸门
                           ├─ 校验：根会话、未归档、目标合法、在最近压缩点之后
                           ├─ 消息管理器 commit：markUndone → 发出 Removed 变化
                           ├─ prompt 存储：markUndone，更新 updatedAt
                           ├─ 善后：停止子代理、作废未投递的结果、清空 todo 缓存、重算统计
                           ├─ 释放闸门
                           └─ 返回 { undonePromptIds, restoredText }
                                       │
              视图投影收到 Removed ──► session.changed（removedMessageIds、prompts）
                                       │
前端 ◄─────────────────────────────────┘ 预填输入框，用户改完正常发送 POST /v1/prompts
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 已撤销的表达方式 | 两张表各加 `undone_at` 列 | SQL 过滤直接；可逆，清空列就能恢复 | 真删除（不可逆，和 00 冲突）；写进 `data` JSON（每次过滤都要 `json_extract`）；单独的切点表（每个读取方都要连表） | 一次迁移；旧版本程序读新库会看到已撤销的消息 |
| 过滤放在哪 | 消息与 prompt 的列表入口默认排除；按 ID 读取不过滤 | 覆盖绝大多数读取方；按 ID 读取服务于 steer 和空会话判断 | 每个读取方各自过滤（一定会漏）；所有入口都过滤（会弄坏 steer） | 以后需要“包含已撤销”的列表调用方要加显式选项 |
| 撤销放在哪一层 | adapter 层，照 `compactSessionInternal` 独占会话 | 忙碌状态只在 adapter 内存里；占住闸门后 prompt 准入、goal 续跑、子代理唤醒都被挡住 | 在 `services/session` 里写服务并另造锁 | `ui-inprocess.ts` 又多一个接入点；为了不让它继续变长，编排逻辑单独放进 `A/adapters/ui-inprocess/session-undo.ts` |
| 界面怎么更新 | 走消息管理器的提交流程，发出 `Removed` 变化 | 视图投影有缓存，只认提交流程；现成路径会转成 `removedMessageIds` | 直接改库再手写 `session.changed`（`GET /view` 会返回旧消息） | 消息存储接口多一个 `markUndone`，SQLite 和内存实现都要有 |
| 撤销定位 | 目标 `promptId` | 用户点的就是一条消息；并发时不会撤错 | kimi-code 的“撤销 N 轮” | 前端要知道每条用户消息对应的 `promptId`（`prompt_submission.user_message_id` 已有） |
| 撤销范围 | 按模型历史的排序，主上下文里从目标用户消息开始的全部消息；不早于目标 prompt 的全部 prompt | 规则简单，不漏 steer 和提醒 | 只按 `runId` 圈消息（会漏掉没有 `runId` 的消息） | 无 |
| 会话忙 | 拒绝，返回现有的 `SESSION_RUNNING` | 与 kimi-code 一致；不在撤销里隐式停止任务 | codex 先关掉线程再撤销 | 用户要先点停止或暂停 goal |
| 原文来源 | `prompt_submission.text` | 就是用户当时提交的原文 | 从用户消息的 text 片段拼 | 无 |
| 子代理 | 按 `root_prompt_id` 找出被撤销 prompt 发起的执行：停止仍在运行的，未投递的结果标记为已处理 | 一处标记就能挡住唤醒 | 只停止不处理投递；再额外改唤醒查询（重复防护） | 无 |
| 统计、空会话、标题 | 用现有的 `syncSessionStatsBestEffort` 重算；空会话判断和起标题判断不改 | 现有判断已能正确处理撤销到底的会话 | 改 `findReusableEmptyPrimary` | 靠 04 的测试兜底 |
| 压缩边界的前端提示 | 前端不判断，由后端报错 | 前端拿不到可靠的边界 | 在视图里暴露边界 | 压缩点之前的消息点 Edit 会看到报错提示 |
| 重复请求 | 不特殊处理 | 低频的手动操作，不值得多一条成功路径 | 幂等返回上次结果 | 网络重试时用户会看到一次“already undone”提示 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：后端

**目标**：`POST /v1/sessions/:sessionId/undo` 能用；撤销后模型上下文、视图（含缓存）、历史、导出、搜索、todo、子代理列表都看不到被撤销的内容，也不会被子代理唤醒重新带回来。

**改动**：

1. **迁移 `029_message_undo`**（`A/services/database/migrations.ts`、`schema.ts`）：`message` 和 `prompt_submission` 各加 `undone_at TEXT NULL`。只加可空列，不改旧数据，不加新索引。
2. **消息存储**（`A/core/message/database-store.ts` 和内存实现 `A/core/message/store.ts`）：
   - `listPage`（:184）、`listByIds`（:258）、`listBySession`（:701）加 `undone_at IS NULL`。
   - 新增 `markUndone(sessionId, fromMessageId, undoneAt)`：按 `listBySession` 的排序（`created_at, rowid`），把主上下文里从该消息开始、尚未撤销的消息写上时间戳，返回被标记的消息 ID。
   - `getMessage`（:398）、`getPart`（:271）不加过滤。
3. **消息管理器**（`A/core/message/manager.ts`）：新增 `markUndone`，包在 `commit(sessionId)` 里，对每条被标记的消息发出 `Removed` 变化。视图投影（`A/adapters/ui-state/source-session-projection.ts:288-350`）会据此更新缓存并产生 `removedMessageIds`。
4. **prompt 存储**（`A/runtime/prompt-scheduler/database-store.ts` 和对应的内存实现）：
   - `listVisible`（:631）、`listForSession`（:691）加 `undone_at IS NULL`。`get` 和 `hasForSession`（:667）不加过滤，`hasForSession` 是空会话判断的依据。
   - 新增 `markUndone(sessionId, fromPromptId, undoneAt)`：标记不早于目标 prompt 的全部 prompt（包括并入运行中轮次的 steer prompt），同时更新 `updatedAt`，返回被标记的 prompt。
   - SDK 的 `UiPromptSubmission` 加可选字段 `undoneAt`。
5. **会话搜索**：`A/services/session/global-query.ts` 的 `VISIBLE_MESSAGE`（:117）加上 `m.undone_at IS NULL`。规划时已在 `A/` 下搜过存储层之外直接写 SQL 读这两张表的地方，结论如下，实施时只需复核：

   | 位置 | 处理 |
   |---|---|
   | `A/services/session/global-query.ts:241`（搜索） | 加条件（本步） |
   | `A/runtime/prompt-scheduler/current-run-inputs.ts:895, 951, 962` | 按 ID 读取，有意不过滤 |
   | `A/services/session/workspace-move.ts:62`、`A/services/session/archive.ts:93` | 只看状态和范围，不受影响 |

   视图里的 run 列表不做过滤：被撤销的 run 都已结束，前端只用 run 判断“是否有正在运行的一轮”，不受影响。
6. **撤销编排**：新建 `A/adapters/ui-inprocess/session-undo.ts`，由 `ui-inprocess.ts` 注入依赖后调用。`undoSession({ sessionId, promptId })` 按顺序执行：
   1. 会话必须存在（否则 `SESSION_NOT_FOUND`）、是根会话（否则 `SESSION_NOT_ROOT`）、是 `active`（否则 `SESSION_ARCHIVED`）。
   2. 照搬 `compactSessionInternal`（`ui-inprocess.ts:3610-3628`）的写法：`sourceProjection.owner.runControl(sessionId)` 的回调里**只做**忙碌检查和占闸门。忙碌指闸门被占、恢复状态不是 `ready`、有排队 prompt、有活动 prompt、有待处理的运行时 prompt，另加 goal 处于 `active`；任一成立返回 `SESSION_RUNNING`，都不成立时 `sessionExecution.reserve`。后面第 3 至 6 步在回调之外执行，放在 `try` 里，`finally` 释放闸门。
   3. 校验目标 prompt：属于这个会话、状态为 `succeeded`、`failed`、`cancelled` 或 `interrupted`、未被撤销、有 `user_message_id`、对应的用户消息不是 steer。否则返回 `UNDO_TARGET_INVALID`。
   4. 目标用户消息必须在最近一条 `context-summary` 消息之后，否则返回 `UNDO_BEFORE_COMPACTION`。
   5. 调用消息管理器的 `markUndone` 和 prompt 存储的 `markUndone`，两者用同一个时间戳。
   6. 善后：
      - 子代理：找出 `subagent_execution.root_prompt_id`（`migrations.ts:398`）属于被撤销 prompt 的执行。仍在运行的走现有的停止流程；投递状态还是 pending 的标记为 processed（`A/agents/subagents/execution-store.ts`），唤醒（`subagent-wakeup.ts`）就不会再选中它们。
      - todo：调用 `release(sessionId)`（`A/tools/todo.ts:248`），清掉包括 goal 作用域在内的全部缓存，下次读取时按可见历史重建。
      - 统计：调用 `syncSessionStatsBestEffort(sessionId)`。
   7. `finally` 里释放闸门，返回 `{ sessionId, undonePromptIds, restoredText }`，`restoredText` 取目标 prompt 的 `text`。
7. **子代理列表**：`A/adapters/ui-inprocess/subagent-instances.ts` 返回的实例里，不再包含“第一个执行记录的 `root_prompt_id` 属于已撤销 prompt”的实例。撤销前就已存在、只是在被撤销的轮次里又被调用过的实例照常显示。
8. **与其他议题的衔接**：
   - fork：如果 fork 议题已经落地，在 `A/services/session/fork.ts` 的选行和取切点的查询里加 `undone_at IS NULL`，并补 fork 04 §4.3 的用例；反之由 fork 议题实施时补。
   - side chat：撤销入口对 side chat 会话返回 `SIDE_CHAT_UNSUPPORTED`。撤销和 side chat 谁后落地，谁在撤销入口补上这个检查和对应用例。
9. **路由与 SDK**：
   - `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` 新增 `POST /v1/sessions/:sessionId/undo`，校验与其他会话路由一致。现有会话路由多数只返回 400 和错误文本（例如压缩路由 :400-412），不能直接照抄；同一文件里的 Files 路由（:84-96）已经按错误码映射状态码并返回 `{ ok: false, error: { code, message } }`，可以照它的写法；状态码沿用 `packages/ohbaby-server/src/protocols/global-sessions.ts:94-120` 的 `globalSessionErrorStatus`（`SESSION_NOT_FOUND` 404，`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`、`SESSION_RUNNING` 409）。这个函数遇到不认识的错误码会返回 500，所以要在里面加上两个新错误码 → 400。响应体带上 `code`。
   - `packages/ohbaby-sdk/src/contract/client.ts` 的会话命令客户端加 `undoSession({ sessionId, promptId })`，HTTP 客户端和进程内实现行为一致。
   - 新错误码 `UNDO_TARGET_INVALID`、`UNDO_BEFORE_COMPACTION` 与现有的 `SESSION_RUNNING`、`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`（`packages/ohbaby-sdk/src/contract/global-sessions.ts:6` 附近）放在一起。

**完成定义**：04 的 T1 至 T17（含 T16b）通过。

### Stage 2：Web

**前置**：[消息复制议题](../../2026-11-04-message-copy/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 1 已完成，`MessageActions` 已存在。

**目标**：用户在 Web 上点 Edit，确认后对话退回，原文出现在输入框里。

**改动**：

1. 给用户消息的 `MessageActions` 加 Edit 按钮（图标加提示“Undo from here and edit”）。steer 消息、没有对应 prompt 的消息、prompt 还没结束的消息不显示。side chat 面板里不显示（side chat 议题会给 `ConversationStream` 加开关）。
2. 会话忙时按钮置灰，提示“Stop the current task first”；goal 处于 `active` 时提示“Pause the goal first”。不可用时置灰加说明，不直接隐藏。
3. 点击后弹出 `W/ui/shared/ConfirmDialog.tsx`：
   - 正文：撤销这条及之后的 N 轮对话；原文会填回输入框；文件改动不会撤销。
   - 输入框有草稿时追加一句：当前草稿会被替换。
   - 有 goal 时追加一句：goal 已用的轮数不会回退。
4. 确认后调用 `undoSession`。成功后用 `prefillComposer` 填入 `restoredText`。失败时按错误码提示，例如 `UNDO_BEFORE_COMPACTION` 提示“This message was compacted and can’t be undone”，不改动输入框。
5. 视图：`removedMessageIds` 已由 `W/store/store.ts:495-509` 从已加载历史里移除，不需要新代码。prompt 在 store 合并时处理一次：带 `undoneAt` 的 prompt 从已加载的 prompt 里移除（`W/store/store.ts:458-462`），渲染层不用改。

**完成定义**：04 的 T18 至 T23 通过（浏览器走查）。

### Stage 3：TUI `/undo`

**目标**：TUI 用户能选一轮撤销，原文回到输入框。

**改动**：

1. `A/commands/catalog.ts` 加 `undo` 命令，`surfaces` 只含 `tui`，在 `T/app.tsx` 本地拦截（参照 `export`，:231）。
2. 在 `T/components/dialog/command-panel-state.ts` 加一种交互面板，列出可撤销的 prompt，最新的在最上面，每行显示原文第一行和时间。TUI 只持有视图里最近一段 prompt，列表只覆盖这一段。
3. 选中后显示一行确认：“撤销 N 轮，文件改动不会撤销，goal 已用的轮数不会回退。Enter 确认，Esc 取消。”
4. 成功后把原文放进输入框，参照 `restoreQueuedEditInput`（`T/components/prompt/index.tsx:369`）。输入框有内容时先确认是否替换。失败时显示错误码对应的提示。
5. 视图更新：消息走 `session-recovery.ts` 现有的 `removedMessageIds` 处理；prompt 现在是直接覆盖写入（`T/store/events.ts:115-119`），要改为收到带 `undoneAt` 的 prompt 时从 store 里移除。

**完成定义**：04 的 T24 至 T26 通过（手工走查）。

### Stage 4：权威文档同步

| 文档 | 改什么 |
|---|---|
| `docs/core/message/data-model.md` §消息生命周期 | 增加“已撤销”状态，说明与删除的区别、哪些入口会过滤、哪些不会 |
| `docs/core/message/architecture.md` | 存储职责补充 `markUndone` 和列表入口的默认过滤 |
| `docs/runtime/prompt-scheduler/` | prompt 的 `undone_at` 与列表过滤 |
| `docs/services/session/`（会话生命周期相关文档） | 补充撤销操作与忙碌判断 |
| `docs/services/database/` | 记录迁移 `029` |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/undo` |

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | 迁移 `029`；`adapters/ui-inprocess/session-undo.ts` | `core/message/{database-store,store,manager}.ts`、`runtime/prompt-scheduler/database-store.ts` 及内存实现、`services/database/{migrations,schema}.ts`、`services/session/global-query.ts`、`adapters/ui-inprocess.ts`（接入撤销）、`adapters/ui-inprocess/subagent-instances.ts`、`agents/subagents/execution-store.ts`、`commands/catalog.ts` |
| `packages/ohbaby-server` | 撤销路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`（两个新错误码 → 400） |
| `packages/ohbaby-sdk` | `undoSession`、新错误码 | `contract/client.ts`、`contract/global-sessions.ts`、`UiPromptSubmission` 类型、HTTP 客户端 |
| `apps/ohbaby-web` | 无新文件 | `ui/conversation/{ConversationStream,MessageRow}.tsx`、`ui/session/SessionScreen.tsx`（接预填）、`store/store.ts`（prompt 合并）、`runtime/index.ts`、`dev/mock-runtime.ts`（`undoSession`） |
| `packages/ohbaby-cli` | 撤销选择面板 | `tui/app.tsx`、`tui/components/dialog/command-panel-state.ts`、`tui/components/prompt/index.tsx`、`tui/store/events.ts` |

## 2.5 接口、协议与迁移

### 撤销接口

```
POST /v1/sessions/:sessionId/undo
请求体：{ "promptId": "prompt_..." }

200：{ "sessionId": "...", "undonePromptIds": ["...", "..."], "restoredText": "原文" }
404 SESSION_NOT_FOUND       会话不存在
409 SESSION_RUNNING         闸门被占、恢复未就绪、有排队或活动 prompt、goal active、正在压缩
409 SESSION_NOT_ROOT        子代理会话
409 SIDE_CHAT_UNSUPPORTED   side chat 会话（撤销与 side chat 中后落地的一方加入，见 Stage 1 第 8 步）
409 SESSION_ARCHIVED        已归档会话
400 UNDO_TARGET_INVALID     目标不存在、不属于该会话、未结束、是 steer、已被撤销
400 UNDO_BEFORE_COMPACTION  目标在最近一次压缩之前
```

### SDK

- `undoSession(input: { sessionId: string; promptId: string }): Promise<UiUndoResult>`
- `UiPromptSubmission.undoneAt?: string`

### 迁移

- `029_message_undo`：两张表加可空列。向前兼容；旧版本程序读新库不报错，但会把已撤销的消息当作普通消息显示并发给模型。发布说明里要写明“升级后不要降级到旧版本继续使用撤销过的会话”。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某个直接写 SQL 的读取方 | 已撤销的内容又回到模型上下文或界面 | 过滤放在列表入口；Stage 1 第 5 步的普查表；04 的 T5 至 T12 |
| 视图缓存没更新 | `GET /view` 仍返回已撤销的消息 | 走消息管理器提交流程（Stage 1 第 3 步）；04 的 T6 |
| 撤销与新 prompt、goal 续跑、子代理唤醒竞争 | 新内容落进被撤销范围，或撤销后又冒出新一轮 | 在 `runControl` 里检查并占住闸门（Stage 1 第 6.2 步）；04 的 T14、T15 |
| 子代理结果在撤销后回流 | 父会话出现一轮用户没发过的对话 | 作废未投递的结果（Stage 1 第 6.6 步）；04 的 T13 |
| 降级 | 旧版本显示已撤销内容 | 发布说明；数据没有丢，只是不再过滤 |

回滚：界面入口可以单独撤掉；数据上把 `undone_at` 清空就能恢复全部消息。迁移 `029` 只加列，不需要反向迁移。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 撤销 N 轮并填回原文，不自动发送 | Stage 1 第 6 步、Stage 2 第 4 步、Stage 3 第 4 步 |
| 旧消息保留、隐藏 | 决策表第 1、2 行；Stage 1 第 1 至 5 步 |
| 文件不回滚，界面说明 | Stage 2 第 3 步、Stage 3 第 3 步 |
| 压缩点之前不能撤销 | Stage 1 第 6.4 步、Stage 2 第 4 步 |
| steer 不是撤销点 | Stage 1 第 6.3 步、Stage 2 第 1 步 |
| 会话忙时拒绝 | Stage 1 第 6.2 步 |
| 停止并隐藏子代理 | Stage 1 第 6.6、7 步 |
| 草稿确认 | Stage 2 第 3 步、Stage 3 第 4 步 |
| goal 计数不回退并说明 | Stage 2 第 3 步、Stage 3 第 3 步 |
| Web Edit 按钮、TUI `/undo` | Stage 2、Stage 3 |
| P1 至 P11 | 决策表与 Stage 1、2 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 连文件一起回滚 | 等 `snapshot` 模块默认启用后另立议题；撤销接口是它的接入点 |
| 浏览已撤销的分支、重做 | 暂不做，需求出现时再议 |
| TUI 双击 Esc 进入撤销；TUI 撤销视图窗口之外更早的轮次 | 后续小改动 |
| goal 计数回退 | 不做 |
