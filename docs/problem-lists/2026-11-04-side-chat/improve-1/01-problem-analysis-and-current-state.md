# 1. 现状与问题分析

> 代码基线：2026-11-04，`main` 分支 `c9cbd475`。本议题开始前没有任何相关实施。2026-11-06 按 `main` `2728b8fb`（会话存储区与 Files 页落地后）复核，会话存储区改动过的文件里的行号已更新。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`，`W/` = `apps/ohbaby-web/src/`，`T/` = `packages/ohbaby-cli/src/tui/`。

## 1.1 问题陈述

1. **没有“临时问一句”的地方。** 斜杠命令里没有 side、btw 一类的命令（`A/commands/catalog.ts`），Web 右侧面板现在有子代理、Files、终端三页。
2. **side chat 放在哪一类会话里，决定了要改多少地方。** 子会话（有 `parent_id`）会被大量“只认根会话”的检查拦住；根会话能用全部现有机制，但会出现在各种列表里、能做 fork 和归档。
3. **一个客户端同一时间只绑定一个会话。** side chat 要和主会话同时显示、同时能发消息。
4. **TUI 和后端共用一个“当前会话”。** 往别的会话提交会把 TUI 拉过去。
5. **给模型的说明放在哪。** 改系统提示词会让提示词缓存失效；提醒类消息只能在运行时写。

## 1.2 已确认的产品分界

见 [00 §2](00-discussion.md)。

```
主会话 ─(复制到最近一轮已结束的对话)─► side chat（隐藏的根会话）
                                        ├─ 边界消息（模型可见、界面隐藏）
                                        └─ 用户在 side chat 里的对话（界面显示）
关闭 → 删除；一个主会话一个；工具可用但不能建子代理；不能 fork、撤销、压缩、goal、换模型
```

## 1.3 做成子会话为什么不行

最初的设想是 `parent_id` 指向主会话、`isSubagent` 设为 `true`，让现有的子会话过滤自动把它藏起来。核查发现它会被下面这些检查拦住：

| 检查 | 位置 | 影响 |
|---|---|---|
| `validatePermissionRoot` 拒绝非主会话 | `A/adapters/ui-inprocess.ts:2490-2498`，被视图、历史、控制（:4610-4618）、回执（:4879）、steer（:5014、:5049）、重新提交（:5134）、进入会话（:1020）调用 | 读不到、发不了、停不了 |
| `assertCanUseAsPrimarySession` 拒绝有父会话的会话 | `ui-inprocess.ts:3355-3374`，被 prompt 提交（:1711、:3838）等调用 | 不能提交 |
| 服务端只允许读取客户端绑定的根会话 | `S/coordination/session-access.ts:155-158`，中止也经过它（:209-217） | 读不到、停不了 |
| 提交时把客户端绑定切到目标会话 | `S/coordination/client-view.ts:676-684`；后端也会设当前会话（`ui-inprocess.ts:1795, 4110`） | 第一次在 side chat 提问后，主会话的事件就收不到了 |
| `stateStore.getSession` 对子会话返回空 | `A/adapters/ui-state/persistent-store.ts:611-620` | 拿不到视图 |

**结论**：做成子会话要在十几处开口子，放弃。

## 1.4 做成隐藏的根会话

### 1.4.1 Web 可以多开一个客户端

- `createBrowserDaemonClient({ config, fetch, store })`（`W/api/daemon/client.ts:565-583`）按 `config.clientId` 建自己的 HTTP 客户端和事件流，store 由调用方传入，没有模块级单例。`createOhbabyWebStore()` 每次调用都是新实例（`W/store/store.ts:65`）。
- `GlobalLayer.scopedHttp` 已经用 `randomUUID()` 在 `InstanceLayer` 之外注册额外的客户端（`W/runtime/global-layer.ts:235-256`），可以参照；不同的是它不开事件流（:231-233），side chat 的客户端要开。`InstanceLayer` 只持有一个 `activeClient`，连接新的会关掉旧的（`W/runtime/instance-layer.ts:199-201`），所以 side chat 的客户端要建在它之外。
- 服务端接受任意 clientId 注册（`S/protocols/web/routes/events.ts:111-127`）。注册时带 `startupIntent.resumeSessionId` 就能绑定到指定会话，条件是这个会话在会话索引里、是根会话（`client-view.ts:124-133`）；或者用 `PATCH /v1/sessions/:id/select`（`S/protocols/web/routes/sessions.ts:296`），它只改这个客户端的绑定（`S/coordination/permission-access.ts:97-128`）。
- 每个客户端有自己的绑定，快照（`client-view.ts:210-251`）、事件（:870）、会话索引失效通知（`S/app/sse-hub.ts:527-534`）都按客户端过滤。
- `SessionScreen` 和它的 hook 读 `runtime.store`、`runtime.client`（`W/ui/session/SessionScreen.tsx:64-99`），side chat 面板需要一个精简的同类对象。`ApprovalPanel` 完全靠 props 驱动（`W/ui/permissions/ApprovalPanel.tsx:43`），可以直接复用。

后端仍有一个共用的当前会话（`persistent-store.ts:456, 623`），每次提交都会改它（`ui-inprocess.ts:1795, 4110`）。daemon 模式下这不影响其他 Web 客户端的绑定；运行状态的兜底逻辑（`client-view.ts:1062-1084`、`ui-inprocess.ts:2338`）可能受影响，多标签页本来就有同样的问题，未细查。

### 1.4.2 TUI 只有一个绑定

- TUI 默认在进程内运行（`packages/ohbaby-cli/src/bin.ts:383-389`、`A/host/core-api-factory.ts:84`），没有客户端视图这一层，后端的当前会话就是 TUI 的绑定。
- TUI 收到会话索引失效通知时，如果 `selectedSessionId` 和自己的不同，就会重新选中（`T/session-recovery.ts:585-590`）。往 side chat 提交会改当前会话，下一次通知就会把 TUI 拉过去。
- `Prompt` 组件可以注入 `submitPrompt`（`T/components/prompt/index.tsx:62, 1265-1272`，接线在 `T/app.tsx:1251`）。`SubagentBrowser`（`T/components/subagent-browser.tsx`）只能看、不能输入，打开时主输入框被隐藏（`T/app.tsx:1219, 1231`）。
- TUI store 会保存收到的所有会话的消息（`T/store/events.ts:121-146`），运行状态只更新当前会话（:194-217）。审批同步丢弃不属于当前会话的事件（`T/use-permission-sync.ts:96`，接线在 `T/app.tsx:311`）。
- TUI 连接远程 daemon 时（`packages/ohbaby-cli/src/bin.ts:377-384`），按会话 ID 提交会切换客户端的绑定（`client-view.ts:676-684`）。

**结论**：TUI 往 side chat 提交和中止时必须显式带 ID，后端不能因此改动当前会话；面板要自己读 side chat 的视图、按 side chat 的 ID 同步审批；远程模式下不支持。

### 1.4.3 要从列表里隐藏的地方

会话数据和会话索引条目里都没有表示 side chat 的字段。`encodeData` 每次更新都整块重写 `data`（`A/services/session/database-store.ts:177-185, 191-217`），`UiSessionIndexEntry` 也没有（`packages/ohbaby-sdk/src/contract/permission.ts:30-38`）。

`isPrimarySession`（`A/adapters/ui-inprocess/session-controller.ts:55`、`persistent-store.ts:401`）同时决定会话索引（:563-570），而绑定、读取都依赖索引（`validatePermissionRoot`、`resolveStartupActiveSessionId`、`S/app/sse-hub.ts:385-399` 的绑定校正），所以不能用它来隐藏 side chat。会话快照 `readSessions`（`persistent-store.ts:501`）也不能过滤：客户端快照从这里取消息（`S/coordination/client-view.ts:236-238`），TUI store 也只给已有的会话追加消息（`T/store/events.ts:876-889`），过滤后 side chat 自己的客户端就拿不到消息。

需要过滤掉 side chat 的用户可见列表：

| 位置 | 说明 |
|---|---|
| `A/services/session/global-query.ts:131` | 全局列表（活跃和归档） |
| `global-query.ts:268` | 搜索；不过滤会因为复制了主会话历史而出现重复结果 |
| `W/runtime/index.ts:798` | Web 没有控制面时的备用侧栏，需要索引条目带 `isSideChat` |
| `ui-inprocess.ts:3112-3117` | TUI 的 `/sessions`、`/resume` |
| `A/adapters/ui-persistent.ts:678` | TUI 启动时“继续上次会话”；`resolveStartupSession` 会忽略非主会话（`A/adapters/ui-startup-session.ts:24-27`） |
| `client-view.ts:141-143` | daemon 的“继续上次会话” |
| `ui-inprocess.ts:2556, 2615` | 空会话复用（主会话为空时才可能碰到） |
| `ui-inprocess.ts:3317` | 归档后挑替补会话 |

### 1.4.4 要显式拦住的操作

根会话默认什么都能做，目前没有任何地方判断“是不是 side chat”：

| 操作 | 入口 |
|---|---|
| 压缩 | `resolveCompactTarget`（`ui-inprocess.ts:3591`），路由 `sessions.ts:379` |
| goal | `resolveGoalSessionId`（`ui-inprocess.ts:4454-4471`） |
| 切换模型、reasoning | `sessions.ts:167, 202` → `ui-inprocess.ts:2990, 2966` |
| 归档 | `ui-inprocess.ts:3273` |
| 移动工作区 | `S/runtime/daemon/server.ts:770`、`S/coordination/session-workspace-move.ts:67` |
| 导出 | `sessions.ts:107` |
| fork、撤销 | 由各自议题新建，需在入口加检查 |
| 斜杠命令 `/new`、`/resume`、`/sessions` | 会改客户端绑定（`client-view.ts:807-816`），side chat 面板不提供斜杠命令 |
| 创建子代理 | `resolveRequester`（`A/adapters/ui-runtime/composition.ts:954-970`）只拒绝有父会话的请求方，side chat 作为根会话能通过。调度器的 `accessGuard`（`A/core/tool-scheduler/scheduler.ts:2062-2072`，实现在 `composition.ts:424-435`）可以按会话拒绝 `agent` 工具（`A/tools/subagent.ts:27-29`），不改工具列表 |

不能把这些检查放进 `assertCanUseAsPrimarySession`，它也管 prompt 提交。

## 1.5 边界消息

- 提醒类消息要锚定在一条助手消息上（`A/core/message/origin.ts:61-71`），只在准备一轮运行时创建（`A/core/context/context-manager.ts:1641-1671`），锚点缺失的会被隐藏（`A/core/context/reminder-history.ts:7-11`）。打开 side chat 时写不了。
- 普通用户消息、不带 `runtimeInput` 时，会被 `filterModelHistory` 保留（`A/runtime/prompt-scheduler/current-run-inputs.ts:524-526`），可以在打开时写入。

## 1.6 权限审批

- 审批请求按根会话路由到绑定它的客户端（`S/coordination/permission-router.ts:15-40`），客户端快照只保留自己绑定会话的审批（`client-view.ts:150-160`）。side chat 是根会话，它的审批只会到 side chat 的客户端，主会话的界面看不到。
- 权限模式和档位是全局的（`A/permission/state.ts:33-34, 49-75`）；“总是允许”按请求的会话 ID 存在内存里（`A/permission/manager.ts:296, 445`）。

## 1.7 系统提示词与缓存

- 系统提示词、工具、提醒由每一轮 run 的 `isSubagent` 参数决定（`A/core/lifecycle/lifecycle.ts:595`）。主会话的 prompt 不传这个参数（`ui-inprocess.ts:4038-4056`），side chat 作为根会话走同一条路径，系统提示词与主会话一致。
- OpenAI 兼容接口的缓存 key 按会话 ID 计算（`packages/ohbaby-llm/src/client/prompt-cache.ts:192-209, 260-268`）。已加载的 MCP 工具按 `(sessionId, contextScopeId)` 存放和排序（`composition.ts:591-610`、`A/mcp/integration/tool-sequence.ts:16-18`），主会话加载过的 MCP 工具，side chat 一开始没有。

## 1.8 删除与启动清理

- 永久删除 `deleteArchivedSession` 要求已归档的根会话（`A/services/session/archive.ts:36-44`），并在有忙碌 run 时拒绝（:84-101）。消息、片段、run、prompt、当前轮输入靠外键级联删除；之后 `cleanupDeletedSessionFiles` 清文件（`archive-files.ts:7-44`）。归档时会清理内存状态（`ui-inprocess.ts:3300-3306`）。
- 启动时 `recoverAllInterrupted` 只修复 prompt 记录（`A/runtime/prompt-scheduler/database-store.ts:889-940`），崩溃留下的 run 记录可能还标着运行中，照搬忙碌检查会删不掉。
- daemon 启动时在 `S/runtime/daemon/main.ts:178-186` 还没有工作区运行时，只有全局数据库；永久删除接口就是这样用全局数据库的（:558）。
- prompt 恢复会检查 owner 进程号，说明同一个数据库可能被多个进程同时使用（例如进程内运行的 TUI 和 daemon）。

## 1.9 Web 右侧面板与选中文字

- 右侧面板按页注册：`SidePageStates`、`SIDE_PAGES`（`W/ui/side-panel/side-pages.ts:9-30, 73-101`，注释里已提到 side chat）和 `SidePanelPage.tsx:32-86` 各加一项。Files 页（`files`）是照这个方式加的，可以参照。`sessionScoped: true` 的页在主会话切换时重置（`use-side-panel.ts:96-106`）。
- 渲染别的会话可参照 `W/ui/session/SubagentConversationBody.tsx:36-151`：用 `ConversationPresentation` 包住 `ConversationStream`。输入框可以用只管展示的 `W/ui/composer/ComposerInput.tsx`。
- 消息区没有任何选中文字的处理，挂载点是 `ConversationStream.tsx:537-552` 的 `.ohb-stream` 容器。

## 1.10 测试现状

会话过滤、客户端绑定、权限路由都有现成测试。没有测试覆盖“同一页面两个客户端绑定不同会话”和“TUI 往非当前会话提交”。

## 1.11 SWE 原则审视

- **顺着现有机制走**：根会话加第二个客户端，读取、推送、提交、中止、审批都不用改；代价集中在“列表过滤”和“操作拦截”这两张清单上，清单是有限的、可以逐条测。
- **一个判断函数**：列表过滤统一用 `isUserFacingSession`，不散写条件。
- **不动系统提示词**：说明放在边界消息里。
- **接受小缺口**：缓存可能不命中、主会话的“总是允许”不带过去，都在 00 里写明。

## 1.12 与既有文档关系

| 文档 | 本议题之后 |
|---|---|
| `docs/services/session/`（数据模型） | 补充 `data.sideChat` 字段与 `isUserFacingSession` |
| `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` 的右侧面板部分 | 补 Side chat 页 |
| `docs/ohbaby-web/architecture.md` | 补“side chat 面板使用独立的 daemon 客户端” |
| `docs/cli/commands/` 或 `docs/ohbaby-cli/tui-productization/slash-menu.md` | 补 `/btw` |
