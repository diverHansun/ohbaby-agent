# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。

## 2.1 方案总览

fork 只做数据复制，在一个数据库事务里完成：新建一个根会话，把源会话主上下文里到切点为止的历史复制过去。复制本身调用 side chat 议题写好的 `copySessionHistory`（side chat 02 Stage 1 第 0 步，学 ZCode：side chat 和 fork 共用同一个复制核心）。fork 自己只做四件事：定切点、算 `(n)` 标题、写来源信息、提交后发事件。调用方按返回的新会话 ID 切换。源会话不会被修改，也不需要空闲。

```
Web 回答下的 fork / 会话行菜单 / TUI /fork
        │
        ▼
POST /v1/sessions/:id/fork { runId? }
        │
adapter 层（session-fork.ts）：校验根会话、未归档、不是 side chat
        │
runWriteTransaction 回调（同步）
        ├─ 定切点：给定回答的 run，或最近一个已有最终 AI 回答正文的已结束主 run；没有就 FORK_TARGET_INVALID
        ├─ 算标题：原标题 (n)
        └─ copySessionHistory(tx, { cutRunId, title, data: { fork } })   ← 与 side chat 共用
        │
adapter 层：发布会话创建事件、刷新侧栏 → 返回 { sessionId, title }
        │
前端切换到新会话
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 复制历史 | 调用 side chat 议题的 `copySessionHistory`，fork 只在函数外面加自己的东西（切点、标题、`data.fork`、事件） | 复制逻辑（五张表、换新 ID、按值替换、`callId` 不改、清超前压缩标记、单事务）只维护一份。ZCode 的 side chat 和 Fork 也共用 `commitAtomicConversationFork`；codex 的 `/side` 就是一次临时 fork | fork 自己再写一份（kimi-code 的 btw 和会话 fork 分开写，但它的 btw 不是独立会话） | fork 依赖 side chat Stage 1 第 0 步先落地，开发顺序本来如此 |
| 提示词缓存 | 新会话用自己的缓存身份（默认行为，不设 side chat 的 `promptCacheSessionId`） | fork 是长期独立的会话；codex、kimi-code、ZCode、dsh 都给 fork 新键，codex 只让临时的 side chat 沿用父会话的键 | 沿用源会话的键（opencode） | OpenAI 官方兼容接口上 fork 后第一次请求可能少命中一次；Anthropic、OpenAI Responses 按内容前缀匹配，不受影响 |
| 源会话状态 | 不要求空闲 | fork 只读已提交的行 | 要求空闲（用户得先停止才能 fork） | 无 |
| 切点定位 | 可选的 `runId`；不给就用最近一个已有最终 AI 回答正文的已结束主 run | 一轮就是一个 run；唤醒轮、goal 续跑轮没有 prompt 记录，按 prompt 定位会漏掉 | 按 `promptId` 定位（漏掉唤醒轮）；按消息 ID 定位（要再推一次属于哪一轮） | 无 |
| 哪些轮次能 fork | 跟着复制按钮走：最终答案有复制按钮的轮次就有 fork 按钮 | 复制按钮的显示规则已经写好、测过，直接复用；唤醒轮常常就是最新结论 | ZCode、kimi-code 只认用户开启的轮次（ohbaby 唤醒轮也单独显示，有复制没 fork 会让人困惑） | 最终答案没有正文的轮次没有按钮，用会话行菜单兜底 |
| 来源信息 | `session.data.fork = { sourceSessionId, sourceRunId }` | 00 已确认；排查问题时有据可查。`sourceRunId` 已经唯一确定切点，不再记继承的消息数（复制函数写会话行时还不知道条数） | 不记（dsh）；用 `parent_id`（会被当成子代理） | 目前没有读取方，只用于排查问题 |
| 标题 | 服务端计算 `基础标题 (n)`，基础标题取源会话的**显示标题**；不加时间（时间看消息下面的时间戳）；用户之后可以自己改名 | 一次请求拿到最终结果；使用已有的显示标题可以保留从首条提问得到的可读名称；带编号的标题也能稳定显示 | dsh 那样前端再发一次改名请求 | 一次按前缀取标题、再在 JS 里精确匹配的查询 |
| 已加载的 MCP 工具 | 不另做处理：新会话第一次用到时从复制来的历史重建，得到切点那一刻的已加载工具和顺序。依赖[已加载 MCP 工具从历史重建议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)先落地（2026-11-10 确认，取代原来提交后 `copyScope` 的做法） | codex、kimi-code、ZCode、dsh 都把这份状态放在历史里，复制历史就带过去了。ohbaby 原来只存在内存里，该议题改为从历史推导 | 提交后 `copyScope` 复制内存状态（只是绕过问题，已放弃） | 新会话不会有切点之后才加载的工具，这正是切点那一刻的状态 |
| “总是允许”规则 | 不带，新会话从空开始 | fork 是从此独立的新会话；codex 的 fork 也让“本会话已批准”从空开始。权限档位是全局的，本来就一致 | 像 side chat 那样复制（side chat 是主会话的临时帮手，fork 不是）；opencode 按项目存 | 用户在新会话里第一次做写操作时要重新批准一次 |
| 侧栏显示 | 平级，和普通会话一样按更新时间排，不嵌套 | 6 个开源项目都平级；嵌套要处理分页、分组、链条断开、排序，改动面不小，收益只是“看出谁从谁来”，标题里的 `(n)` 已经够提示 | Claude app 那样嵌在源会话下面（11-09 讨论过，用户最终选平级） | 看不出 fork 来自哪个会话 |
| 子代理引用 | 不处理，卡片保留结果文字但打不开 | 不复制子代理实例和执行记录 | 复制子代理会话（牵出整套子代理生命周期） | 00 P11 已说明 |

## 2.3 分阶段实施

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：后端

**目标**：`POST /v1/sessions/:sessionId/fork` 能用；新会话的视图、历史和模型上下文与源会话在切点处一致；源会话不受影响。

**改动**：

**前置**：side chat 议题 02 Stage 1 第 0 步的 `copySessionHistory`（`A/services/session/copy-history.ts`）已经落地。复制范围、ID 改写、压缩标记、不继承的状态，都以那一步为准，本文不重复。

1. **复用切点查询**。Side Chat 已在 `A/services/session/copy-history.ts` 提供 `findEndedMainRun(tx, sessionId, runId?)`。Fork 复用它的终态、排序和主上下文约束，并通过 `findForkableMainRun` 要求最终 AI 回答有可见正文。传入 run ID 时只检查该轮，省略时跳过空轮和只有用户提问的轮次，按 `COALESCE(started_at, created_at) DESC, run_id DESC` 选择最近可复制的已结束主轮次。查询和复制共用一个写事务。
   “最终 AI 回答有正文”的判断要和 Web 决定复制按钮的规则（`W/ui/conversation/run-process.ts:54-68`）一致：只看这一轮最后一条 AI 消息（压缩摘要消息除外），它有正文、没有工具片段、没有隐藏工具调用，就算有回答。最后一条是空消息时，这一轮就算没有回答，不再往前找上一步，否则菜单 fork 会切在用户看不到按钮的位置。
2. **adapter 层**：新建 `A/adapters/ui-inprocess/session-fork.ts`，由 `ui-inprocess.ts` 注入依赖后暴露 `forkSession({ sessionId, runId? })`。打开 `runWriteTransaction`（`BEGIN IMMEDIATE`，跨进程也串行），在回调里依次：
   1. **校验源会话**：在写事务中调用 `readActiveMainSession`，按顺序检查会话存在、属于根会话、状态为 active、且为普通会话。相应错误码依次为 `SESSION_NOT_FOUND`、`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`、`SIDE_CHAT_UNSUPPORTED`。因此已归档的 Side Chat 返回 `SESSION_ARCHIVED`，活跃的 Side Chat 返回 `SIDE_CHAT_UNSUPPORTED`。
      校验源会话后，用 `assertSessionInWorkspace(source, promptScopeKey)` 核对目标工作区。移动后从旧目录发起请求会得到 `409 SESSION_MOVED`，包括尚未开始下一轮的待生效目录变更。
   2. **定切点**：`findForkableMainRun(tx, sessionId, runId)`，没结果返回 `FORK_TARGET_INVALID`。fork 从不传 `null` 给复制函数。复制函数复核切点时抛出的 `HistoryCutInvalidError` 在 Fork 入口映射为 `FORK_TARGET_INVALID`。
   3. **算标题**：用 `resolveSessionDisplayTitle` 取得源会话的显示标题，去掉末尾已有的 ` (数字)`。从所有普通根会话（含已归档）中，按大小写精确匹配基础标题和左括号前缀，再从完整数字后缀中取最大值加一。编号与复制位于同一事务。共享的 `isDefaultSessionTitle` 对所有会话生效。旧格式标题若以空格和括号数字结尾（例如 `New session - 2026-11-10 (1)`），会作为正式标题保留。
   4. **复制**：`copySessionHistory(tx, { sourceSessionId, cutRunId, promptScopeKey, title, data: { fork: { sourceSessionId, sourceRunId: cutRunId } } })`，`promptScopeKey` 取后端的 prompt 作用域（`ui-inprocess.ts:1280-1284`）。共享复制函数以 `ORDER BY run_id` 读取源轮次，给副本分配 `run_-copy_<定宽序号>_<本次复制的 UUID>`。这样开始时间相同的 run 在再次 Fork 时保持原有次序。Side Chat 使用相同的 ID 生成规则。
   - 提交后的顺序与 side chat 相同：在总线上发布 `SessionEvent.Created`（带新会话的 `Session` 对象，`SessionManager.create` 在 `manager.ts:146` 也这样做，adapter 靠它填充会话元数据缓存，`ui-inprocess.ts:737-739`）；再调用 `publishSessionIndexInvalidation()`（`ui-inprocess.ts:2304`）刷新侧栏。已加载的 MCP 工具不用复制，新会话第一次用到时从复制来的历史重建（见决策表）。不复制会话级的“总是允许”规则，也不设 `promptCacheSessionId`（新会话用自己的缓存身份）。
   - 返回 `{ sessionId, title }`。
3. **会话字段**：`session.data.fork` 加进 `Session` 类型、`SessionData`、`rowToSession`、`encodeData`（`database-store.ts:196-206、212-241`，`SessionData` 在 `:44-51`）和事件的 zod 定义（00 P13）。
4. **路由与 SDK**：
   - `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` 在归档路由旁边新增 `POST /v1/sessions/:sessionId/fork`。状态码沿用现有映射 `globalSessionErrorStatus`（`packages/ohbaby-server/src/protocols/global-sessions.ts:96-126`：`SESSION_NOT_FOUND` 404，`SESSION_NOT_ROOT`、`SESSION_ARCHIVED` 409）。这个函数遇到不认识的错误码会返回 500，所以要加上 `FORK_TARGET_INVALID` → 400。`SIDE_CHAT_UNSUPPORTED` → 409 已由 side chat 议题加入，错误处理的写法也照 side chat 的路由（side chat 02 Stage 1 第 10 步）。响应体带 `code`。
   - `forkSession({ sessionId, runId? })` 加在 SDK 的 `UiCommandClient`（`packages/ohbaby-sdk/src/contract/client.ts`）上，HTTP 客户端和进程内实现行为一致，TUI（进程内或连远端 daemon）和 Web 都用它；`FORK_TARGET_INVALID` 和现有错误码一起放在 `packages/ohbaby-sdk/src/contract/global-sessions.ts`。

**完成定义**：04 的 T1、T2、T2b、T2c、T3、T9、T10、T12b、T12c、T12d、T13、T14、T14b、T14c 通过，side chat 议题的 C1 至 C9 仍然通过。

### Stage 2：Web

**前置**：回答下面的 fork 按钮依赖[消息复制议题](../../2026-11-04-message-copy/improve-1/02-optimization-plan-and-change-scope.md)的 Stage 1（`MessageActions`）。会话行菜单不依赖它。

**改动**：

1. **回答下的 fork 按钮**：`ConversationStream` 加一个可选回调 `onFork?: (runId: string) => void`，只有主会话视图（`W/ui/session/SessionConversation.tsx`）传它；按钮只在有这个回调时显示。side chat 面板和子代理对话（`W/ui/session/SubagentConversationBody.tsx:98` 也用 `ConversationStream`）不传，所以没有 fork 按钮，不用另写开关。按钮放在每轮最终答案（`RunProcess.answerId` 指向的消息）的 `MessageActions` 里，紧挨复制按钮，用 lucide 的分叉箭头图标（样式参照用户给的 Claude 截图）。悬停提示两行：标题“Fork from here”，说明“Starts a new session from this point. This one stays as it is.”。`ConversationStream` 现在只存最终答案 ID 的集合（:169），改成从答案 ID 映射到 `RunProcess.runId`，点击时传这个 `runId`。显示条件就是复制按钮的显示条件（这一轮已结束、最终答案有正文），所以用户、goal、子代理唤醒触发的轮次都有。
2. **会话行菜单**：`W/ui/sidebar/SessionMenu.tsx` 加“Fork”菜单项，调用时不带 `runId`，不做置灰：没发过消息的会话不会出现在侧栏里。第一轮还在跑时点击，服务端返回 `FORK_TARGET_INVALID`，提示“Nothing to fork yet”，不切换。
3. **调用与切换**：`runtime.forkSession` 的路由方式照归档（`W/runtime/index.ts:286-318`，按实例或目录选客户端的分支在 `:294-297`）：源会话在当前实例、同一目录下打开时用实例客户端，否则用 `global.scopedHttp(源会话的 requestDirectory)`。这样服务端用的是源会话目录的 prompt 作用域，复制得到 prompt 记录。成功后调用 `runtime.openSession(newSessionId, 源会话的 requestDirectory)` 切到新会话（新会话还不在目录里，不传目录会落到当前实例的目录，`W/runtime/index.ts:268-272`）。失败时按错误码提示。
4. **侧栏**：不改。fork 出来的会话 `parent_id` 为空，和普通会话一样出现在列表里，按更新时间排。
5. **side chat 里没有入口**：side chat 面板不传 `onFork`（见第 1 步），会话行菜单本来就不列 side chat。后端检查见 Stage 1 第 2.1 步。

**完成定义**：04 的 T15 至 T18 通过（浏览器走查）。

### Stage 3：TUI `/fork`

**改动**：

1. `A/commands/catalog.ts` 加 `fork` 命令，`surfaces` 只含 `tui`，在 `T/app.tsx` 本地拦截（参照 `export`，:231）。
2. 执行时调用 `client.forkSession({ sessionId })`，成功后调用后端的 `client.selectSession(newSessionId)`（`packages/ohbaby-sdk/src/contract/client.ts:249`，进程内实现是 `ui-inprocess.ts:2570` 的 `selectSessionMetadata`，HTTP 是 `PATCH /v1/sessions/:id/select`）切到新会话。它会设置当前会话并发布带 `selectedSessionId` 的索引失效事件，TUI 收到事件后在 `packages/ohbaby-cli/src/tui/session-recovery.ts:596-599` 读取 `selectedSessionId`，再更新本地状态（`T/store/events.ts:437`）。提示“Forked to <标题>”。失败时显示错误码对应的提示。

**完成定义**：04 的 T19、T20 通过（手工走查）。

### Stage 4：权威文档同步

| 文档 | 改什么 |
|---|---|
| `docs/services/session/`（数据模型与生命周期相关文档） | 补充 fork 操作、`session.data.fork` 字段、复制范围 |
| `docs/core/message/data-model.md` | 说明 fork 复制消息时的 ID 改写规则和压缩标记处理 |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/fork` |

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | `adapters/ui-inprocess/session-fork.ts`；复用已落地的切点查询，在 `copy-history.ts` 增加 Fork 的最终回答条件。复制函数由 side chat 议题新建 | `adapters/ui-inprocess.ts`（接入）；`services/session/types.ts`、`database-store.ts`、`events.ts`（`Session` 类型、`SessionData`、`rowToSession`、`encodeData`（`database-store.ts:196-206、212-241`，`SessionData` 在 `:44-51`）和事件的 zod 定义都加可选的 `fork` 字段。缺任何一处，会话下次更新或经过事件缓存时 `fork` 就会丢）；`commands/catalog.ts` |
| `packages/ohbaby-server` | fork 路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`（`FORK_TARGET_INVALID` → 400） |
| `packages/ohbaby-sdk` | `UiCommandClient.forkSession`、`FORK_TARGET_INVALID` | `contract/client.ts`、`contract/global-sessions.ts`、HTTP 客户端 |
| `apps/ohbaby-web` | 无新文件 | `ui/conversation/{ConversationStream,MessageActions}.tsx`、`ui/session/SessionConversation.tsx`（传 `onFork`）、`ui/sidebar/{Sidebar,SessionMenu}.tsx`、`runtime/index.ts`、`dev/mock-runtime.ts`（`forkSession`） |
| `packages/ohbaby-cli` | 无新文件 | `tui/app.tsx` |

不需要数据库迁移：`session.data` 是 JSON 列，新增的 `fork` 字段是可选的。

## 2.5 接口

```
POST /v1/sessions/:sessionId/fork
请求体：{ "runId": "run_..." }   // 可省略

200：{ "sessionId": "session_...", "title": "原标题 (1)" }
404 SESSION_NOT_FOUND     源会话不存在
409 SESSION_NOT_ROOT      源会话是子代理会话
409 SIDE_CHAT_UNSUPPORTED 源会话是活跃的 Side Chat
409 SESSION_ARCHIVED      源会话已归档（含已归档的 Side Chat）
409 SESSION_MOVED         请求使用了旧的工作目录
400 FORK_TARGET_INVALID   run 不存在、不属于该会话、不在主上下文、未结束、最终 AI 回答没有可见正文，或会话里还没有符合条件的轮次
```

SDK：`forkSession(input: { sessionId: string; runId?: string }): Promise<{ sessionId: string; title: string }>`。

HTTP 空请求体和 `{}` 都表示选择最近一个有效回答。JSON 解析失败、请求体不是对象、含未知字段，或显式提供 `runId: null`、空白字符串等无效值，统一返回 HTTP 400 和 `FORK_TARGET_INVALID`。超过请求体大小限制时，HTTP 层先返回 413。

JSON-RPC 客户端在服务端提供时保留错误中的 `targetDirectory`，收到 `SESSION_MOVED` 后可从中读取目标目录。OpenAPI 已登记 Fork 路由的认证、客户端请求头、请求体、成功响应及错误状态。

复制函数沿用 side chat 02 §2.5 的 `copySessionHistory` 接口。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 复制本身出错（漏 ID、压缩标记、运行时输入、顺序、并发写入） | 新会话的视图或模型上下文和源会话不一致 | 由复制函数负责，side chat 议题 04 的 C1 至 C9 守住；fork 的 T1 在 fork 入口再跑一遍端到端 |
| 从用户问题或空轮误建 fork | 菜单复制了没有回答的最后一轮 | 两种入口都检查最终 AI 回答；指定无效轮次时报错，菜单向前找到最近一次回答。见 04 的 T2c |
| 后端的可 fork 规则和 Web 复制按钮规则有出入 | 有按钮但后端拒绝，或菜单切在没有按钮的轮次 | 第 1 步要求两边按同一条规则判断，T2c 用同一个夹具比对。2026-11-10 核查时剩两处边缘差异：prompt 已结束但 run 记录还不是终态（Web 认为已结束，后端不认）；run 已是终态但没有结束时间也没有 prompt（后端认，Web 不显示）。都只在恢复或旧数据时出现，本轮接受，后端拒绝时按 `FORK_TARGET_INVALID` 提示 |
| 最新一轮没有回答 | 会话行菜单的 fork 落在更早一轮，界面不提示 | 本轮接受，成功提示里带新会话标题；从回答下的按钮 fork 不受影响 |

回滚：fork 只新增会话，删掉入口即可；已经 fork 出来的会话是普通会话，可以照常归档和删除。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 复制切点之前的历史成新会话 | Stage 1 前置（共用 `copySessionHistory`）、第 2.4 步 |
| 切点在一轮已结束对话的末尾 | Stage 1 第 1 步、第 2.2 步 |
| 来源信息放 `session.data`，不用 `parent_id` | Stage 1 第 2.4 步、第 3 步 |
| 侧栏平级 | 复制函数写 `parent_id` 为空；Stage 1 第 2 步（发布事件）；Stage 2 第 4 步 |
| 归档、删除互不牵连 | 不改归档和删除逻辑（`parent_id` 为空，不进级联） |
| Web 两处入口、TUI `/fork` | Stage 2、Stage 3 |
| 标题 `(n)` | Stage 1 第 2.3 步 |
| 不带 goal、排队、运行中的一轮、子代理实例 | 复制函数（side chat 02 Stage 1 第 0.7 步） |
| 继承工作区、目录、agent、模型、reasoning | 复制函数（side chat 02 Stage 1 第 0.5 步） |
| P1 至 P13 | 决策表与 Stage 1 至 3 |
| 11-08、11-09 确认的第 1 至 5 问（00 §6） | 决策表；Stage 1 第 1、2 步；Stage 2 第 1 至 5 步；Stage 3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 从一轮中间或从用户消息 fork | 不做 |
| 侧栏把 fork 嵌在源会话下面、从 fork 跳回源会话的链接、fork 徽章 | 不做（11-09 用户确认平级） |
| 已加载的 MCP 工具从历史重建（重启、恢复后也不丢） | 已另立[议题](../../2026-11-09-mcp-loaded-tools-from-history/README.md)，并先于本议题实施；本议题因此不写 `copyScope` |
| 让 fork 出来的会话能打开源会话的子代理、免确认读取源会话存储区里的文件 | 不做。[子代理结果搬迁议题](../../2026-11-05-subagent-results-location/README.md)和会话存储区第二期 a 已把子代理报告（`subagents/`）和工具长输出（`tool-results/`）都放进源会话的存储区。复制过来的历史里的这类路径不改写，fork 出来的会话读取时按外部路径弹确认即可，不另开授权（04 T14b） |
