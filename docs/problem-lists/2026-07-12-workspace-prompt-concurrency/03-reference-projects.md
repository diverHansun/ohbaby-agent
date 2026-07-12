# 3. 参考项目与取舍

> 参考代码均以 2026-07-12 本机 checkout 为准。本文记录可验证的 prompt 队列 UX 模式及其所有权前提。参考项目主要使用客户端队列，ohbaby 使用 durable、多 client、服务端权威队列，因此只借鉴交互心智模型，不把参考实现的并发结论直接外推到 ohbaby。

## 3.1 结论先行

| 来源 | Adopt | Adapt | Reject |
|------|-------|-------|--------|
| Codex | composer 上方内联队列预览；自适应高度、每条截断；Alt+Up/Shift+Left 把最后一条弹回 composer | 将客户端 `pop_back` 心智模型适配为服务端 edit lease；增加 workspace 10 槽与 durable submission | 纯客户端队列不持久；直接照搬按键而忽略终端透传差异 |
| Kimi Code | per-session active/queued map；稳定 prompt/message ID；submitted 事件即时投影；Send 始终可用 + Stop 独立按钮；编辑先 unqueue 再载入 composer | 把客户端队列改为服务端 SQLite 真相，加 100 条安全上限 | 纯内存队列；由 Web 自己维护队列顺序 |
| OpenCode | "QUEUED" 徽章内联在 conversation；CLI run `<leader>q` 管理面板中上下文限定的 Ctrl+E/Ctrl+D | 只借鉴“删除键必须处于明确 queue 上下文”，不引入独立面板 | stream-merge 模型；web queue dock 已废弃改 steer；把 Ctrl+D 做成全局 composer 删除键 |
| ohbaby subagent | 原子 claim、期望 owner/run ID 的条件完成、晚到结果防护 | 为 prompt 建独立、可查询、跨 session 排序的表和状态机 | 复用 subagent JSON 队列字段或把 prompt 混进 subagent 表 |

可借鉴的趋势是：队列内容靠近 composer、编辑复用 composer、破坏性删除只在明确 queue 上下文中触发、运行中仍可继续输入。不能从这些项目推出“durable 服务端队列不需要并发控制”：它们编辑前能直接移除，是因为 queue owner 在本 client；ohbaby 必须用 owner/token/expiry/renew edit lease 才能满足“编辑时 scheduler 不 claim”。

## 3.2 Codex：thread 隔离 active turn

### 3.2.1 代码证据

本机来源：`/Users/hansun025/Projects/code-cli/codex`，基线 commit `5c19155`。

**内部数据结构**：
- `codex-rs/core/src/thread_manager.rs`：`ThreadManagerState` 持有 `HashMap<ThreadId, Arc<CodexThread>>`，不同 thread 是独立运行单元。
- `codex-rs/core/src/session/session.rs`：每个 session 自己持有 `active_turn: Mutex<Option<ActiveTurn>>`，active turn 不是进程级单值。
- `codex-rs/tui/src/chatwidget/input_queue.rs:22-45`：`InputQueueState` 维护 `queued_user_messages`、`pending_steers`、`rejected_steers_queue` 三个客户端队列。

**队列 UX 渲染**：
- `codex-rs/tui/src/bottom_pane/pending_input_preview.rs`：`PendingInputPreview` widget 在 composer 上方渲染三类待处理输入。
- `pending_input_preview.rs:34`：`PREVIEW_LINE_LIMIT = 3`，每条消息最多显示 3 行，超出显示 `…`。
- `pending_input_preview.rs:139-152`：每条 queued message 用 `  ↳ ` 前缀，`dim().italic()` 样式。

**键位设计**：
- `codex-rs/tui/src/keymap.rs:920-941`：`interrupt_turn = Esc`、`edit_queued_message = Alt+Up / Shift+Left`、`composer.submit = Enter`、`composer.queue = Tab`。
- `codex-rs/tui/src/bottom_pane/chat_composer.rs:3155-3163`：运行时 Tab → `handle_submission(true)` → 入队；Enter → `handle_submission(false)` → steer。

**编辑机制**：
- `codex-rs/tui/src/chatwidget/interaction.rs:108-119`：Alt+Up 调 `pop_latest_queued_composer_state()`，把最后一条 queued message 弹回 composer。
- `codex-rs/tui/src/chatwidget/input_restore.rs:98-126`：`pop_latest_queued_composer_state` 从 `queued_user_messages.pop_back()` 取出，立即从队列移除，恢复到 composer。

**app-server 协议**：
- `codex-rs/app-server-protocol/src/protocol/v2/turn.rs:160-214`：只有 `turn/start`、`turn/steer`（需 `expectedTurnId`）、`turn/interrupt` 三个 RPC。
- `codex-rs/app-server/README.md:976-991`：无队列 RPC；web client 需自己实现 queue-and-drain。

### 3.2.2 队列 UX 设计

| 维度 | Codex 做法 |
|------|-----------|
| 队列位置 | TUI composer 上方 `PendingInputPreview`；app-server/web 无内置队列 |
| 高度策略 | **自适应**，flex 布局，每条消息截断 3 行 + `…`，无独立滚动 |
| 编辑方式 | **弹回 composer**：Alt+Up 把最后一条从队列弹出，载入 composer 编辑 |
| 取消方式 | **无直接 queued delete**；先弹回 composer，queued item 已从本地队列 pop，之后丢弃 composer 文本 |
| 确认/Undo | **无** |
| 并发冲突 | 单 client 本地队列中通过 `pop_back` 避免；不能证明多 client 服务端队列无需 lease |
| `/queue` 命令 | **无**，用键位 Alt+Up / Tab |
| Send/Stop | Tab=queue, Enter=steer, Esc=interrupt；无 Stop 按钮，footer 动态文字提示 |
| 队列真相源 | 客户端 `InputQueueState`（非服务端持久） |
| 多条展示 | **全部展示**，每条 `↳` 前缀，无折叠、无 count-only |
| 即时反馈 | Queued (Tab)：立即出现在预览区；Steer (Enter)：立即出现在 pending steers 区，不入 transcript |

### 3.2.3 借鉴

1. **composer 上方内联预览**：用户不用离开当前视线就能看到排队内容。
2. **自适应高度 + 每条截断**：队列区随内容增长，不隐藏信息，不用滚动条。
3. **弹回 composer 编辑**：复用用户熟悉的输入区；其“无竞态”依赖客户端拥有并立即移除队列项，ohbaby 只能借鉴交互、不能照搬并发实现。
4. **键位操作无 slash 命令**：Alt+Up 编辑、Tab 入队，交互比命令面板更轻。
5. **steer 与 queue 分离**：Enter 是 steer（合流当前 run），Tab 是 queue（等当前 run 完成后新 turn）。

### 3.2.4 不照搬

- Codex 的 thread 管理没有 workspace 10 槽与 100 条等待上限，ohbaby 需自行补上。
- Codex 队列是纯客户端的，不持久——ohbaby 已确认 queued 要跨 daemon 重启恢复。
- Codex 的 steer 语义（合流到当前 run）不在本批；ohbaby 已确认严格 FIFO。
- Codex 的具体事件名、item 模型不是 ohbaby wire contract。

## 3.3 Kimi Code：per-session prompt lane 与即时 submitted

### 3.3.1 代码证据

本机来源：`/Users/hansun025/Projects/code-cli/kimi-code`，基线 commit `19c5aa6`。

**服务端队列**：
- `packages/agent-core/src/services/prompt/promptService.ts:243-247`：`_active: Map<string, PromptState>` + `_queued: Map<string, PromptState[]>`，按 session 维度管理。
- `promptService.ts:466-478`：`_publishSubmitted` 发布 `prompt.submitted` 事件，带 `status: 'running' | 'queued'`。

**Web 队列 UX**：
- `apps/kimi-web/src/components/chat/ChatPane.vue:666-734`：队列渲染为 `.q-stack`，**内联在 transcript 尾部**，在运行中 turn 的 "working" 占位符之后。
- `ChatPane.vue:1212-1386` CSS：`background: var(--color-surface-raised)` + `border: 1px dashed` → 虚线边框 pending 气泡；第一条 `q-tag-next` = "Up next"，后续 `q-tag-idx` = `#2`, `#3`。
- `ChatPane.vue:672`：标题 `Queue · <b>{{ queued.length }}</b>` + hint "sends automatically when the current turn ends"。
- `ChatPane.vue:691-697`：`.q-grip` 拖拽手柄，HTML5 drag-and-drop 重排序。
- `ChatPane.vue:728`：`.q-rm` ×按钮，`opacity: 0` 直到 hover。

**Web composer**：
- `apps/kimi-web/src/components/chat/Composer.vue:1130-1148`：Stop 按钮 `v-if="running"`，Send 按钮 `:disabled="starting"`（只在首次 session 创建时禁用，running 时不禁用）。
- `Composer.vue:528-532`：注释明确 "Send is always 'send' — while running it enqueues. Interrupt lives on a separate Stop button."
- `Composer.vue:922`：textarea `:disabled="starting"`，running 时不禁用。
- `Composer.vue:74-82`：placeholder 运行时变为 "Press Enter to queue · Ctrl+S to inject into the running turn"。

**Web 编辑/取消**：
- `apps/kimi-web/src/components/chat/ConversationPane.vue:903-913`：`handleEditQueued` → `loadComposerForEdit(text)` 载入 composer，成功后 `emit('editQueued')` → `client.unqueue(index)` 从队列移除。
- `apps/kimi-web/src/composables/client/useWorkspaceState.ts:1974-1982`：`unqueue(index)` 纯本地 `splice`，无确认、无 undo。

**TUI 队列 UX**：
- `apps/kimi-code/src/tui/components/panes/queue-pane.ts:16-67`：`QueuePaneComponent` 在 activity 与 editor 之间渲染，顶部 `─` 边框，每条 `❯ <text>` 一行。
- `kimi-tui.ts:889-899`：布局 `transcript → activity → todos → queueContainer → btwPanel → editor`。
- `queue-pane.ts:24-35`：hint 行动态变化 "↑ to edit · ctrl-s to steer immediately / will send after current task / after compaction"。
- `kimi-tui.ts:1153-1158`：`recallLastQueued` 立即从 `queuedMessages` 弹出最后一条，载入 editor。

**TUI 键位**：
- `apps/kimi-code/src/tui/controllers/editor-keyboard.ts:67-69`：`editor.onSubmit` 始终绑定。
- `editor-keyboard.ts:294-312`：空 editor 时 Up-arrow → `recallLastQueued()` 弹回最后一条。
- `editor-keyboard.ts:239-273`：Ctrl+S → steer（把所有非 bash queued + editor 文本注入当前 run）。
- `editor-keyboard.ts:144-202`：Ctrl-C / Esc → `cancelCurrentStream()`。

**无 `/queue` 命令**：
- `apps/kimi-code/src/tui/commands/registry.ts:135-431`：完整 slash command 注册表，无 `/queue`。

### 3.3.2 队列 UX 设计

| 维度 | Kimi Code 做法 |
|------|----------------|
| 队列位置 (Web) | **内联在 transcript 尾部**，虚线边框 pending 气泡，在运行中 turn 之后 |
| 队列位置 (TUI) | activity 与 editor 之间的 `queueContainer`，自适应高度 |
| 高度策略 | **全部自适应**，无高度限制，Web transcript follow 滚动；TUI 按内容增长 |
| 编辑方式 (Web) | 点击卡片体 → 载入 composer（**先 `unqueue(index)` 再编辑**） |
| 编辑方式 (TUI) | Up-arrow（空 editor）→ `recallLastQueued()` 弹回最后一条 |
| 取消方式 (Web) | ×按钮 hover 显现，直接 `splice` 移除 |
| 取消方式 (TUI) | **无直接 queued delete**；空 editor 且 streaming/compacting 时 Up recall 最后一条，之后由用户丢弃 |
| 确认/Undo | **无**（`useConfirmDialog` 不覆盖 queue 路径） |
| 并发冲突 | 客户端本地队列通过先移除规避；不等价于服务端 lease |
| `/queue` 命令 | **无** |
| Send/Stop (Web) | **Send 始终可用 + Stop 独立按钮并排**（running 时两个按钮同时可见） |
| Send/Stop (TUI) | Enter 始终可用，Esc/Ctrl-C 中断，无 Stop 按钮 |
| 队列真相源 | **客户端** `queuedBySession` (Web) / `queuedMessages` (TUI)，非服务端 |
| 多条展示 | **全部展示**，Web 有 "Up next" / `#N` 标签；TUI 每行 `❯` 前缀 |
| 拖拽重排序 | Web 支持 HTML5 drag-and-drop；TUI 不支持 |
| 即时反馈 | idle 时：optimistic user message + `prompt.submitted` 合并；running 时：只显示在 queue 区，不入 transcript |

### 3.3.3 需要适配

- Kimi 的 `_active/_queued` 是进程内的，ohbaby 已确认 queued 要持久到 SQLite。
- Kimi 队列真相在客户端——ohbaby 要求服务端是唯一队列真相，客户端从 snapshot/event 恢复。
- Kimi 没有 workspace 10 槽与 100 queued admission，ohbaby 需自行补上。
- Kimi 的 steer（Ctrl+S 合流当前 run）不在本批；ohbaby 已确认严格 FIFO。

### 3.3.4 不照搬

- 纯内存队列不持久。
- Web 自己维护队列顺序——ohbaby 要求服务端排序。
- 把 request Promise 挂到 run 终态——只有非交互 `ohbaby run` 显式 wait。

## 3.4 OpenCode：stream-merge 与分场景队列

### 3.4.1 代码证据

本机来源：`/Users/hansun025/Projects/code-cli/opencode`。

**运行时无队列——stream-merge 模型**：
- `packages/opencode/src/effect/runner.ts:33-37`：`Runner` 状态机只有 `Idle | Running | Shell | ShellThenRun`，无队列数据结构。
- `packages/opencode/src/session/prompt.ts:1052-1071`：`prompt()` 先调 `createUserMessage(input)` 持久化 user message，再调 `loop()`。
- `prompt.ts:1081-1130`：`runLoop` 每次迭代轮询 `MessageV2.filterCompactedEffect(sessionID)`，新 user message 的 ID 大于 last assistant → loop 继续执行，LLM 被重新调用并包含新 message。
- `runner.ts:115-138`：`ensureRunning` 在 `Running` 状态时返回 `awaitDone(st.run.done)`——第二个 `runLoop` 的工作被静默丢弃，只等第一个 run 完成。
- `packages/opencode/test/session/prompt.test.ts:1365-1428`：测试确认 "prompt submitted during an active run is included in the next LLM input"。

**标准 TUI：QUEUED 徽章**：
- `packages/tui/src/routes/session/index.tsx:238-242`：`pending` = 未完成 assistant message 的 ID。
- `index.tsx:1373`：`queued = props.pending && props.message.id > props.pending`。
- `index.tsx:1423-1438`：user 气泡上渲染 ` QUEUED ` 实心徽章替代时间戳。
- `packages/tui/src/component/prompt/index.tsx:946-1146`：`submitInner()` 无 `status !== "idle"` 检查，Enter 始终可提交。
- `prompt/index.tsx:391-420`：ESC×2（5 秒窗口内）→ `session.abort`。
- `packages/tui/src/config/keybind.ts:102`：`session_queued_prompts` 键位已定义，但 TUI **从未注册处理器**——无队列管理 UI。

**CLI `opencode run`：真正的管理面板**：
- `packages/opencode/src/cli/cmd/run/runtime.queue.ts:59-349`：客户端串行队列，`state.queue` + `state.queued`。
- `runtime.queue.ts:278-296`：运行中的普通 prompt 被转入本地队列，不发送到服务端。
- `runtime.queue.ts:113-266`：`drain()` 串行出队，每条 prompt 的 turn 开始前 `removeLocalQueued`。
- `footer.view.tsx:466-468`：状态行显示 `N queued`。
- `footer.command.tsx:672-767`：`<leader>q` 打开管理面板，每行 `ctrl+e edit · ctrl+d remove`。
- `footer.view.tsx:697-701`：Ctrl+E → `onQueuedRemove(messageID)` + `composer.replacePrompt(item.prompt)` 载入 composer。
- `runtime.queue.ts:323-329`：Ctrl+D → `onQueuedRemove(messageID)` 从 `state.queue` 和 `state.queued` 同时移除。

**Web app：queue dock 已废弃**：
- `packages/app/src/pages/session/composer/session-followup-dock.tsx:74-106`：`SessionFollowupDock` 折叠时显示 count + 首条预览，展开时 `max-h-42 overflow-y-auto` 列表，每条有 Send Now / Edit 按钮。
- `packages/app/src/pages/session.tsx:1758-1762`：`queueEnabled` 始终返回 false。
- commit `ae7e2eb3f`：force-migrate "queue" → "steer"，web 现在用 `promptAsync` 即时发送。
- `packages/app/src/components/prompt-input.tsx:1808-1822`：变色龙按钮——空文本+running → Stop，有文本 → Send。

### 3.4.2 队列 UX 设计

| 维度 | OpenCode 做法 |
|------|---------------|
| 并发模型 | **stream-merge**：prompt 立即持久化为 user message，run loop 自动拾取；无队列数据结构 |
| 标准 TUI 队列 | **无队列区**；user message 直接进 scrollback，带 ` QUEUED ` 徽章 |
| CLI run 队列 | `<leader>q` 面板，Ctrl+E edit, Ctrl+D remove，串行 drain |
| Web 队列 | **已废弃**，改为 steer（`promptAsync` 即时发送） |
| 编辑方式 | CLI run：Ctrl+E → `onQueuedRemove` + `composer.replacePrompt`（**先移除再载入**） |
| 取消方式 | CLI run：Ctrl+D 即时移除 |
| 确认/Undo | **无** |
| 并发冲突 | CLI run 本地队列通过 `removeLocalQueued` 规避；标准 TUI 的 queued badge 不提供删除入口 |
| `/queue` 命令 | **无**（CLI run 用 `<leader>q` 键位） |
| Send/Stop (Web) | 变色龙按钮：空+running→Stop，有文→Send |
| Send/Stop (TUI) | Enter 始终可用，ESC×2 中断 |
| 即时反馈 (Web) | optimistic local insert，`server-session.ts:1073-1106` |
| 即时反馈 (CLI run) | **无即时反馈**——queued prompt 只在 turn 开始时才进 scrollback |

### 3.4.3 借鉴

- CLI run 的 `<leader>q` 面板证明"键位打开管理面板"比 slash 命令更直接。
- Ctrl+E / Ctrl+D 的 edit/remove 交互简洁有效。
- "先移除再载入 composer"的编辑模式与 Codex/Kimi 一致。

### 3.4.4 不照搬

- **stream-merge 模型**：prompt 立即持久化为 user message 进 context，run loop 自动拾取——这违反 ohbaby 的"queued prompt 不进入当前 run context"不变量。ohbaby 用 submission/message 分表解决。
- 标准 TUI 的 "QUEUED" 徽章方案不提供编辑/取消入口——ohbaby 需要这些能力。
- Web queue dock 已废弃——OpenCode 自己放弃了队列 UI 改为 steer，说明 queue UI 在 web 上的维护成本不低。ohbaby 需要更简洁的设计（自适应高度 + 弹回 composer）来控制复杂度。

## 3.5 跨项目可观察模式与适用边界

以下是可观察模式，不是对 ohbaby 服务端状态机的“共识证明”。每条都必须先检查 queue owner、持久化与多 client 前提。

### 模式 1：当前主路径偏向内联、自适应

| 项目 | 高度策略 |
|------|---------|
| Codex | 自适应 flex，每条截断 3 行，无独立滚动 |
| Kimi Code (Web) | 自适应，在 transcript 内 follow 滚动 |
| Kimi Code (TUI) | 自适应，按内容增长 |
| OpenCode (CLI run) | 分页面板，非固定高度滚动区 |

**结论**：当前 Codex/Kimi 主路径偏向内联、自适应。OpenCode 已废弃的 Web `SessionFollowupDock` 实际使用 `max-h-42 overflow-y-auto no-scrollbar`，因此不能声称“没有项目采用固定 viewport”；它只说明该路径后来被整体禁用并迁移到 steer。ohbaby 选择 1–5 条自适应、超过 5 条折叠，是结合自身 100 cap 做出的产品取舍。

### 模式 2：避免 inline 编辑，复用 composer

| 项目 | 编辑方式 |
|------|---------|
| Codex | Alt+Up 弹回最后一条到 composer |
| Kimi Code (Web) | 点击卡片体 → `unqueue(index)` → 载入 composer |
| Kimi Code (TUI) | Up-arrow → `recallLastQueued()` 弹回最后一条 |
| OpenCode (CLI run) | Ctrl+E → `onQueuedRemove` + `composer.replacePrompt` |

**结论**：四个数据点都复用 composer，且在本地 queue owner 中先移除再编辑。ohbaby 借鉴“弹回 composer”的心智模型，但不能把服务端 prompt 真正移出 durable queue；必须通过可续租 edit lease 令 scheduler 不可 claim。锁定的是 per-session lane head，因此同 session 后续 prompt 也等待，其他 session 继续并行。

### 模式 3：并发 token 不成为用户概念

参考项目没有展示 `expectedUpdatedAt`，主要因为队列由当前 client 所有，缺少 ohbaby 的 durable 多 client 竞争。ohbaby 同样不向用户显示并发 token，但协议必须携带 edit lease capability；“不展示 token”不等于“删除并发控制”。

### 模式 4：不用 `/queue` slash 命令

| 项目 | 操作入口 |
|------|---------|
| Codex | 键位（Alt+Up, Tab） |
| Kimi Code | 内联展示 + 键位（Up-arrow, Ctrl+S） |
| OpenCode (CLI run) | 键位（`<leader>q` 打开面板） |

**结论**：没有项目用 slash 命令作为主要队列入口，但 OpenCode CLI run 使用 `<leader>q` 打开明确的 queued menu。ohbaby 不增加面板：内联展示保持可见，`Alt+Up` 进入 queued-edit 模式，模式内 `Ctrl+D` 才取消当前项。

### 模式 5：观察到的取消路径无确认/undo

| 项目 | cancel 确认 | undo |
|------|------------|------|
| Codex | 无 | 无 |
| Kimi Code | 无 | 无 |
| OpenCode | 无 | 无 |

**结论**：观察到的实现都没有确认或 undo，但这不能证明误操作风险不存在。ohbaby 选择即时取消、无确认、无 undo，理由是保持 terminal 状态单向并控制状态机复杂度；误操作后重新提交新 prompt。

### 模式 6：TUI 删除依赖明确上下文

| 项目 | TUI 删除方式 |
|------|--------------|
| Codex | 没有直接 delete；Alt+Up/Shift+Left 将最后一条从本地队列 pop 回 composer，之后丢弃文本 |
| Kimi Code | 没有直接 delete；仅在 streaming/compacting 且 editor 为空时 Up recall 最后一条，之后丢弃 |
| OpenCode CLI run | `<leader>q` 进入 queued menu，选中条目后 Ctrl+D remove；Ctrl+D 不是全局 composer 绑定 |

**ohbaby 取舍**：不引入 `/queue` 或独立面板；普通 `↑/↓` 保留 history。`Alt+Up` 获取最后一条的 edit lease 并进入 queued-edit 模式，只有该模式内 `Ctrl+D` 才取消当前 prompt；Esc 释放 lease 并保留服务端原文。这样既保留内联轻量交互，也让破坏性动作具有明确上下文。

## 3.6 参考结论如何落到方案

| 参考结论 | 02 中的落点 | 验收重点 |
|----------|-------------|----------|
| composer 上方内联预览（Codex） | §2.10.1 Web Queue 区、§2.10.2 TUI 内联 | 队列在 composer 上方，不遮挡 conversation |
| 当前主路径偏向自适应可见 | §2.10.1 Queue 区自适应 + 可折叠 | 1–5 条全部可见，超过 5 条折叠 "+N more" |
| 弹回 composer 编辑 | §2.10.1/§2.10.2 弹回 composer + edit lease | owner/token/expiry/renew；锁定 head 不被越过 |
| token 不作为用户概念 | §2.7 lease token 仅保存在持有 client | 用户不看到 token；协议仍有并发控制 |
| 删除只在明确 queue 上下文 | §2.10.2 TUI `Alt+Up` 进入 queued-edit、模式内 `Ctrl+D` | 普通 history/字符输入不冲突，无 `/queue` 面板 |
| Send 始终可用 + Stop 独立（Kimi） | §2.10.1 Web Stop/Send 共存、§2.10.2 TUI Enter 始终可用 | running 时可继续发送 |
| 参考实现取消无确认 | §2.10.1 Web/TUI 即时 cancel、无 undo | terminal 单向，不存在 restore API |
| active state 按 thread/session 隔离 | §2.5、§2.6 | 10 个不同 session 真并发 |
| submit 与 completion 解耦（Codex/Kimi） | §2.7.1、§2.7.4 | receipt 立即返回 |
| submission 一等对象（Kimi） | §2.3、§2.4 | queued 可刷新/重启恢复 |
| 稳定 ID 与事件投影（Kimi） | §2.7.2、§2.10.1 | receipt/SSE 任意顺序不重复 |
| atomic claim / expected run（ohbaby subagent） | §2.4.1、§2.5.2 | 双 drain 与晚到 completion 不破坏状态 |
| 参考项目多为客户端 queue owner，ohbaby 明确不照搬 | §2.1.1、§2.10 | 多 Web/CLI 只观察同一 backend truth |

## 3.7 最终建议

采用“Codex 的 composer 上方内联预览 + Kimi 的 submission/即时事件/Send-Stop 共存 + 跨项目的弹回 composer 心智模型 + OpenCode 的上下文内删除 + ohbaby 自身 durable atomic claim/edit lease”。由 ohbaby 的产品约束补上 workspace 10 槽、100 waiting cap、重启恢复与 `clientRequestId` 幂等；不增加 undo/restore。

具体取舍：

1. **队列展示**：采用 Codex/Kimi 当前路径的内联、自适应方向，放弃固定两行 + 隐藏滚动条。超过 5 条时折叠为 "+N more"；这是 ohbaby 针对 100 cap 的独立取舍。
2. **编辑交互**：采用“弹回 composer”，但服务端实现 owner/token/expiry/renew edit lease；60 秒是不活动 TTL，20 秒续租。lease head 阻塞同 session 后续 prompt，不占 active slot，不阻塞其他 session。
3. **TUI 操作**：普通 `↑/↓` 保留 history；`Alt+Up` 编辑最后一条，queued-edit 模式内 `Ctrl+D` 删除当前项、Esc 保留原项；无 `/queue` 或独立面板。
4. **cancel**：即时取消、无确认、无 undo；`cancelled` 保持 terminal，误操作通过新提交恢复意图。
5. **Send/Stop**：采用 Kimi 的 Web Send 始终可用 + Stop 独立按钮并排；TUI Enter 始终可用，双击 Esc 中断。
6. **提交关联**：新增 `clientRequestId` 幂等键，原样贯穿 request/receipt/event/snapshot；实体仍按 `promptId/userMessageId` 合并。SSE/replay 只关联 attempt 和更新投影，绝不直接清 composer；仅当前页面 matching receipt 清 live draft。

这些取舍明确区分“可借鉴的交互”与“不可照搬的队列所有权”，更符合 ohbaby 的单 daemon、durable、多 client 队列约束。
