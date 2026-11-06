# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。路径缩写同 01。

## 2.1 方案总览

side chat 是一个隐藏的根会话，`data.sideChat` 记着它属于哪个主会话。打开时复制主会话的历史，再加一条边界消息。Web 的 side chat 面板另开一个 daemon 客户端绑定到它，查看、提交、中止、审批都走现有接口；后端在提交目标是 side chat 时不改动共用的当前会话，TUI 因此不会被拉走。新写的只有四样东西：打开与关闭、列表过滤、操作拦截、两端的界面。

```
打开 ─► POST /v1/sessions/:mainId/side-chat
          一个事务：已有就返回 / 否则 forkSessionRows（切在最近一个已结束的 prompt）+ 写边界消息
          → { sideChatId, boundaryMessageId }

Web 面板 ─► 新建 daemon 客户端（新 clientId、自己的 store 和事件流）
            → 绑定 sideChatId → 现有的 view / prompts / abort / 审批
            → 只显示边界消息之后的内容
TUI ────► 进程内：提交与中止显式带 sideChatId；后端不改当前会话
          面板自己读 side chat 的视图；审批按 sideChatId 同步

关闭 ─► DELETE /v1/sessions/:mainId/side-chat → 取消排队、中止并等待（≤5 秒）→ 删除 → 清理内存（重复关闭返回 204）
启动 ─► daemon 删除 ownerPid 已不在的 side chat
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
| 缓存 | 不处理 | 临时会话，不值得把缓存用的会话标识一路传过四层代码 | 让 side chat 复用主会话的缓存 key | OpenAI 兼容接口、加载过 MCP 工具的会话可能命中不了 |
| 启动清理 | 删除 `ownerPid` 对应进程已不在的 side chat | 多个进程可能共用一个数据库 | 全部删除（会误删正在用的） | `data.sideChat` 多记一个进程号 |

## 2.3 分阶段实施

**前置**：

- 会话 fork 议题 Stage 1 已完成，`forkSessionRows` 可用。
- Stage 2（Web）另依赖消息复制议题 Stage 1（`MessageActions`）。

全部 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：核心与服务端

**目标**：能打开、使用、关闭 side chat；它不出现在任何用户可见的列表里，被禁用的操作都返回 `SIDE_CHAT_UNSUPPORTED`。

**改动**：

1. **会话字段**：`Session` 类型（`A/services/session/types.ts`）、`SessionData`、`encodeData`、`rowToSession`（`database-store.ts:176-184、191-217`）、事件的 zod 定义（`events.ts:22-24`）加可选字段 `sideChat?: { mainSessionId: string; boundaryMessageId: string; ownerPid: number }`。加一个判断函数 `isSideChatSession(session)`。SDK 的 `UiSessionIndexEntry`（`packages/ohbaby-sdk/src/contract/permission.ts:30-38`）和全局会话条目加可选的 `isSideChat`。
2. **打开**：新建 `A/adapters/ui-inprocess/side-chat.ts`，由 `ui-inprocess.ts` 注入依赖后暴露 `openSideChat({ mainSessionId })`。打开一个 `runWriteTransaction`，在回调里依次：
   1. 主会话必须存在、是根会话（不是子代理会话）、状态为 `active`、本身不是 side chat，否则分别返回 `SESSION_NOT_FOUND`、`SESSION_NOT_ROOT`、`SESSION_ARCHIVED`、`SIDE_CHAT_UNSUPPORTED`。
   2. 已有 `data.sideChat.mainSessionId` 等于主会话的会话时，直接返回它。
   3. 否则调用 `forkSessionRows(tx, { sourceSessionId: mainSessionId, cutPromptId, promptScopeKey, title: "Side chat", data: { sideChat: { mainSessionId, boundaryMessageId, ownerPid: process.pid } } })`。`cutPromptId` 取主会话最近一个已结束、未被撤销的 prompt，没有就传 `null`（只建会话行）。“未被撤销”依赖撤销议题的 `undone_at` 列，按撤销与 fork 的约定，由后落地的一方在这条查询里加上条件。`boundaryMessageId` 事先生成好。
   4. 写边界消息：一条 `role: "user"` 的消息，一个文本片段，不带 `runtimeInput`，ID 为上一步的 `boundaryMessageId`，`created_at` 为当前时间。`filterModelHistory` 会保留这样的消息（`A/runtime/prompt-scheduler/current-run-inputs.ts:524-526`）。正文用英文，依次写：
      - 这是一个旁路对话，之前的内容是从主会话继承的，只供参考；
      - 不要接着做主会话里的任务；
      - 用户在边界之后没有明确要求时，不要修改文件、Git 和配置；
      - 子代理不可用；
      - 如果主会话有正在运行的一轮，再附一句“主会话当前正在处理：”加那一轮 prompt 的原文。

   事务提交后，同 fork 议题一样发布 `SessionEvent.Created` 和会话索引失效通知，返回 `{ sideChatId, boundaryMessageId }`。
3. **列表过滤**：新建判断函数 `isUserFacingSession(session)`（放在 `A/adapters/ui-inprocess/session-controller.ts` 的 `isPrimarySession` 旁边），等于“`isPrimarySession` 为真，并且不是 side chat”。用在 01 §1.4.3 表里的每一处：
   - 全局列表与搜索：SQL 加 `json_extract(data, '$.sideChat') IS NULL`。
   - Web 备用侧栏：按索引条目的 `isSideChat` 过滤。
   - 其余各处：调用 `isUserFacingSession`。TUI 启动“继续上次会话”时把 side chat 归为 `temporary`。
4. **操作拦截**：在 01 §1.4.4 表里各操作的入口加一行检查，目标是 side chat 时返回 `SIDE_CHAT_UNSUPPORTED`。检查不放进 `assertCanUseAsPrimarySession`，它也管 prompt 提交。fork 入口由本议题加（fork 是前置议题）；撤销入口由撤销与本议题中后落地的一方加。
5. **子代理**：在 `accessGuard`（`A/adapters/ui-runtime/composition.ts:424-435`）里，请求会话是 side chat 且工具是 `agent` 时，返回“Subagents are not available in side chat.”。
6. **不改当前会话**：prompt 提交路径设当前会话的两处（`ui-inprocess.ts:1795`、`:4110`），在目标会话是 side chat 时跳过 `stateStore.setActiveSessionId`。
7. **存储区**：会话存储区已经落地（2026-11-05），由本议题让“side chat 归主会话”这条规则生效，并补 04 的 T12。
   - 归属只在一处计算：`initialTrustedRoots` 回调（`A/adapters/ui-runtime/composition.ts:481-489`），现在是 `session?.parentId ?? scope.sessionId`。在这里加一个分支：会话是 side chat 时用 `data.sideChat.mainSessionId`。
   - 环境提醒、工具输出存盘和 Bash 日志都从登记好的可信路径里取存储位置（`A/core/lifecycle/lifecycle.ts:623-625`、`A/tools/utils/output.ts:22`），不用另外改。
   - 关闭时 `cleanupDeletedSessionFiles` 按会话 ID 删除 `sessions/<id>`，不计算归属。side chat 没有自己的目录，所以这一步什么也不删，主会话的目录和 side chat 写进主会话 scratch 的文件都保留。不要为了“清理 side chat 的文件”在这里改成按归属删除。
   - side chat 面板不放 Files 页。Files 接口按客户端绑定的根会话找目录（`S/protocols/web/routes/sessions.ts:63-75`），由 side chat 的客户端调用时会找 `sessions/<sideChatId>`，以后要在面板里放文件页时，需要先改这一点。
8. **关闭**：在 `A/services/session/archive.ts` 旁新增 `deleteSideChatSession(db, sideChatId, { skipBusyCheck })`：要求是 side chat，不要求已归档；删除方式同 `deleteArchivedSession`。adapter 的 `closeSideChat({ mainSessionId })`：
   - 找不到 side chat 时直接返回；
   - 取消它排队中的 prompt，对正在运行的一轮调用 `abortRun`（`ui-inprocess.ts:5379`）；`abortRun` 不保证返回时运行已经结束，所以接着每 100 毫秒检查一次 `sourceLedger.getActiveRuns(sideChatId)` 和活动 prompt，直到都为空，最多等 5 秒，超时返回 `SESSION_RUNNING`；
   - 调用删除函数，清理内存状态（参照归档 `ui-inprocess.ts:3300-3306`，另加 `permissionState.clearSession`），调用 `cleanupDeletedSessionFiles`，发布会话移除事件。
9. **启动清理**：抽出函数 `deleteOrphanSideChats(db, isPidAlive)`：找出所有 side chat，`ownerPid` 对应进程已不存在的，调用 `deleteSideChatSession(..., { skipBusyCheck: true })` 并清理文件。在 `S/runtime/daemon/main.ts:178-186` 用全局数据库调用它（同 :558 的用法）。
10. **路由与 SDK**：
    - `S/protocols/web/routes/sessions.ts` 新增 `POST /v1/sessions/:mainId/side-chat` 和 `DELETE /v1/sessions/:mainId/side-chat`。状态码沿用 `globalSessionErrorStatus`（`S/protocols/global-sessions.ts:94-120`），在里面加 `SIDE_CHAT_UNSUPPORTED` → 409；响应体带 `code`。撤销、fork 议题已经改好的路由错误处理直接复用。
    - `packages/ohbaby-sdk/src/contract/client.ts` 加 `openSideChat`、`closeSideChat`，HTTP 与进程内实现一致；`SIDE_CHAT_UNSUPPORTED` 放进 `contract/global-sessions.ts`。

**完成定义**：04 的 T1 至 T13 通过。

### Stage 2：Web

**改动**：

1. **运行时接口**：`OhbabyWebRuntime`（`W/runtime/index.ts:38` 起）加 `openSideChat(mainSessionId)` 和 `closeSideChat(mainSessionId)`，mock 运行时（`W/dev/mock-runtime.ts`）同步实现。
2. **side chat 客户端**：新建 `W/ui/side-chat/side-chat-runtime.ts`。打开时：
   - 调用 `runtime.openSideChat` 拿到 `sideChatId`；
   - 用 `createOhbabyWebStore()` 建一个新 store，用 `createBrowserDaemonClient` 和新的 `randomUUID()` clientId 建一个新客户端，并打开它自己的事件流；注册时带 `startupIntent.resumeSessionId = sideChatId`（`S/coordination/client-view.ts:124-133`）；
   - 对外提供面板需要的最小接口：消息与 prompt 列表、提交、中止、审批。

   关闭时先调用 `runtime.closeSideChat`，再销毁这个客户端和它的事件流。这个客户端建在 `InstanceLayer` 之外，不影响主客户端。现有的 `GlobalLayer.scopedHttp` 也是在 `InstanceLayer` 之外建客户端，但它不开事件流，这里需要开。
3. **右侧面板页**：在 `W/ui/side-panel/side-pages.ts` 的 `SidePageStates`、`SIDE_PAGES` 和 `SidePanelPage.tsx` 各加一项“Side chat”，`sessionScoped: true`。切换主会话时页面重置，但不关闭 side chat；切回来再打开，`openSideChat` 返回原来那个。
4. **面板内容**：新建 `W/ui/side-chat/SideChatPage.tsx`。
   - 给 `ConversationStream` 加一个开关 `variant: "side-chat"`：为真时，消息操作栏只挂复制按钮（不挂 Edit、fork），也不挂“Ask in side chat”。由本议题添加。按 2026-11-06 讨论的顺序，本议题在撤销和 fork 之后实施，Edit、fork 按钮那时已经存在，这个开关负责把它们藏起来；如果顺序变了、本议题先落地，后做的撤销或 fork 要在挂按钮时遵守这个开关。
   - 用 `ConversationPresentation` 包住 `ConversationStream`（参照 `W/ui/session/SubagentConversationBody.tsx`），只传 `boundaryMessageId` 之后的消息和这些消息对应的 prompt。没有内容时显示空状态说明：“Ask anything about this session. The main conversation won’t see this chat. It’s deleted when you close it.”
   - 下方用 `W/ui/composer/ComposerInput.tsx` 做输入框，关闭斜杠命令面板，配发送和停止按钮，不放模型、权限、goal 控件。
   - 审批用 `ApprovalPanel`，数据来自 side chat 自己的 store。
   - 右上角关闭按钮，确认框写明“关闭后无法恢复”。
5. **选中文字**：在 `ConversationStream.tsx` 的 `.ohb-stream` 容器（:537-552）上监听选区变化。选区落在主会话的消息正文里且不为空时，在选区附近显示悬浮按钮“Ask in side chat”；点击后打开 Side chat 页，把选中的文字按 Markdown 引用（每行前加 `> `，后面空一行）填进 side chat 的输入框。

**完成定义**：04 的 T14 至 T19 通过（浏览器走查）。

### Stage 3：TUI `/btw`

**改动**：

1. `A/commands/catalog.ts` 加 `btw` 命令，`surfaces` 只含 `tui`，带一个可选参数；在 `T/app.tsx` 本地拦截（参照 `export`，:231）。TUI 连接远程 daemon 时（`packages/ohbaby-cli/src/bin.ts:377-384` 的远程路径），提示“/btw is not available when connected to a remote daemon”并返回：远程模式下按会话提交会切走客户端的绑定（`client-view.ts:676-684`）。
2. 执行时调用 `openSideChat({ mainSessionId })`，打开新面板 `T/components/side-chat-panel.tsx`：
   - 上半部分参照 `SubagentBrowser` 渲染消息（`renderMessageParts`，`T/components/subagent-browser.tsx:58`）。面板自己按 `sideChatId` 读取视图并订阅更新，只显示边界之后的消息，不依赖 TUI store 里的会话列表。标题栏写“Side chat · Esc to close”。
   - 下半部分保留现有的 `Prompt` 组件，关闭命令面板（输入原样提交），注入一个提交到 side chat 的 `submitPrompt`。不像 `SubagentBrowser` 那样隐藏输入框。
   - 中止同样显式带 side chat 的 ID。
   - 面板打开期间，审批改为 `usePermissionSync(client, store, sideChatId)`（现有实现只认当前会话，`T/use-permission-sync.ts:96`，接线在 `T/app.tsx:311`），关闭后恢复为主会话。
   - 输入框为空时按 Esc：调用 `closeSideChat`，回到主会话。
3. 带参数的 `/btw <问题>`：打开后立即把问题作为第一条消息提交。

**完成定义**：04 的 T20 至 T23 通过（手工走查）。

### Stage 4：权威文档同步

按 01 §1.12 的清单同步。

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `packages/ohbaby-agent` | `adapters/ui-inprocess/side-chat.ts` | `services/session/{types,database-store,events,archive,global-query}.ts`、`adapters/ui-inprocess.ts`（打开、关闭、列表过滤、操作拦截、当前会话规则）、`adapters/ui-inprocess/session-controller.ts`、`adapters/ui-persistent.ts`、`adapters/ui-runtime/composition.ts`、`commands/catalog.ts` |
| `packages/ohbaby-server` | 两个 side chat 路由 | `protocols/web/routes/sessions.ts`、`protocols/global-sessions.ts`、`coordination/client-view.ts`（daemon 的“继续上次会话”过滤）、`coordination/session-workspace-move.ts`、`runtime/daemon/main.ts` |
| `packages/ohbaby-sdk` | `openSideChat`、`closeSideChat`、`SIDE_CHAT_UNSUPPORTED` | `contract/client.ts`、`contract/global-sessions.ts`、`contract/permission.ts`、HTTP 客户端 |
| `apps/ohbaby-web` | `ui/side-chat/{SideChatPage.tsx,side-chat-runtime.ts}` | `runtime/index.ts`、`dev/mock-runtime.ts`、`ui/side-panel/{side-pages.ts,SidePanelPage.tsx}`、`ui/conversation/ConversationStream.tsx` |
| `packages/ohbaby-cli` | `tui/components/side-chat-panel.tsx` | `tui/app.tsx` |

不需要数据库迁移：新字段都在 `session.data` JSON 里。

## 2.5 接口

```
POST   /v1/sessions/:mainId/side-chat   → { sideChatId, boundaryMessageId }
DELETE /v1/sessions/:mainId/side-chat   → 204（没有 side chat 时也返回 204）

404 SESSION_NOT_FOUND        主会话不存在
409 SESSION_NOT_ROOT         主会话本身是子代理会话
409 SESSION_ARCHIVED         主会话已归档
409 SESSION_RUNNING          关闭时等待运行结束超过 5 秒
409 SIDE_CHAT_UNSUPPORTED    主会话本身是 side chat；或对 side chat 执行被禁用的操作
```

查看、提交、中止、审批都用现有接口，由绑定到 side chat 的客户端调用。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| 漏掉某个列表 | 侧栏、搜索、TUI 列表里出现“Side chat” | `isUserFacingSession` 一处定义；04 的 T4 逐个列表检查 |
| 漏掉某个操作的拦截 | side chat 能被 fork、归档或压缩 | 04 的 T6 逐个操作检查；以后新增会话级操作时要加检查 |
| 第二个客户端影响主客户端 | 主会话的事件中断或绑定被改 | 客户端建在 `InstanceLayer` 之外；04 的 T11、T15 |
| TUI 被拉到 side chat | 主界面切到 side chat | 后端规则（Stage 1 第 6 步）；04 的 T8、T21 |
| 启动清理误删 | 别的进程正在用的 side chat 被删 | 只删 `ownerPid` 已不在的；04 的 T10 |
| 缓存不命中 | 费用变高 | 00 P11 已接受 |

回滚：撤掉两个路由和界面入口即可；已创建的 side chat 会在下次 daemon 启动时被清理。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 继承主对话、界面不显示继承内容 | Stage 1 第 2 步、Stage 2 第 4 步、Stage 3 第 2 步 |
| Web 选中文字与右侧面板、TUI `/btw` | Stage 2、Stage 3 |
| 工具可用、软提醒 | Stage 1 第 2.4 步 |
| 禁用 fork、撤销、压缩、goal、换模型、改名、归档、子代理 | Stage 1 第 4、5 步；面板不提供改名和斜杠命令 |
| 关闭即删、启动清理 | Stage 1 第 8、9 步 |
| 一个主会话一个 | Stage 1 第 2.2 步 |
| 主会话运行时可开、只带正在运行那一轮的用户输入 | Stage 1 第 2.3、2.4 步 |
| 选中文字只有“在 side chat 里问” | Stage 2 第 5 步 |
| 不出现在列表和导出里 | Stage 1 第 3、4 步 |
| P1 至 P13 | 决策表与 Stage 1 至 3 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| 一个主会话多个 side chat | 不做 |
| 选中文字引用到主输入框 | 不做 |
| side chat 结论带回主会话 | 不做 |
| side chat 复用主会话的提示词缓存 | 不做 |
| TUI 连接远程 daemon 时使用 `/btw` | 不做 |
| 主会话归档或删除时立即删除它的 side chat | 不做；面板会随主会话切换消失，残留的 side chat 在下次启动时清理 |
