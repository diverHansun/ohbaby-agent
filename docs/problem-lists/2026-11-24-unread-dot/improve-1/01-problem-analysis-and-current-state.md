# 1. 现状与问题分析

> 行号是 2026-11-24 的快照。Web 路径相对 `apps/ohbaby-web/src/`，后端路径相对仓库根目录。

## 1.1 现状

### 侧边栏怎么知道会话的状态

- 前导列（`ui/sidebar/SessionRow.tsx`）现在有三种状态：移动中、运行中、等待审批。数据来自 `SidebarSessionItem.activity`。
- `activity` 只有当前会话有值（`ui/shell/AppController.tsx:219`）。其他会话一律是 `idle`，06 §3.4 记着这是已知限制。

### 全局会话列表

- 侧边栏的数据是 `GET /v1/sessions`（`packages/ohbaby-server/src/runtime/daemon/server.ts:811`），由 `listGlobalSessions`（`packages/ohbaby-agent/src/services/session/global-query.ts:121`）查 `session` 表，按 `updated_at` 倒序分页。
- 返回的 `UiGlobalSession`（`packages/ohbaby-sdk/src/contract/global-sessions.ts:96`）没有任何"轮次"相关的字段。
- Web 在这些时候重新读取列表（`runtime/global-layer.ts`、`runtime/index.ts`）：启动；窗口获得焦点或页面重新可见（`runtime/index.ts:894-899`）；事件流重连；归档、fork、移动等操作之后。没有定时读取。

### 轮次结束记在哪

- 每一轮在 `run_ledger` 表里一行（`packages/ohbaby-agent/src/services/database/migrations.ts:153`），结束时写 `ended_at`（`runtime/run-ledger/database.ts:399-480`）。
- `status` 的取值：`succeeded`（成功）、`failed`（出错）、`interrupted`（用户点停止，或进程崩溃后被恢复程序收尾）、`cancelled`（子代理关闭、会话删除）、`pending`、`running`。用户点停止记成 `interrupted`，和成功、出错能直接分开（`runtime/run-manager/manager.ts:226-233`）。
- 主会话的轮次 `context_scope_id IS NULL`；子代理的轮次也挂在根会话上，但 `context_scope_id` 不为空。side chat 的轮次挂在它自己的会话下，全局列表本来就不含 side chat。
- 可用的索引是 `idx_run_ledger_session_scope_status(session_id, context_scope_id, status, created_at)`。

### 事件怎么到浏览器

- 每个工作区是一个实例，浏览器的事件流（`/v1/events`，`packages/ohbaby-server/src/app/sse-hub.ts`）只连着一个实例。会话事件只投影给当前绑定的会话，别的会话的 `run.updated` 被丢掉（`packages/ohbaby-server/src/coordination/client-view.ts:939-943`）。
- 轮次结束不会发 `session.index.invalidated`，`session.updated_at` 也不一定变。
- daemon 层没有跨实例的事件通道。daemon 可以订阅每个实例的 `subscribeEvents`，但要新写一条带鉴权、重连和补发的事件流。
- 实例加载后不会被回收（`packages/ohbaby-server/src/runtime/instance-store.ts:74-77`），切换会话也不会停掉别的会话的轮次。所以"在 A 会话跑着的时候去看 B"是真实场景。

### TUI

TUI 不用全局列表，读的是每个工作区自己的会话索引，`UiGlobalSession` 加可选字段不影响它。

## 1.2 问题清单

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| P1 | 中 | 用户在别的会话时，这个会话答完了，侧边栏没有任何提示 | `AppController.tsx:219` 只给当前会话打标 |
| P2 | 中 | 前端拿不到别的会话的轮次结束时间 | `UiGlobalSession` 没有这类字段；事件流不转发别的会话的事件 |
| P3 | 低 | 页面一直开着、窗口一直在前台时，列表不会自己更新 | 列表只在焦点、可见性变化和各种操作后重读 |

## 1.3 根因

侧边栏的数据源是全局列表，而全局列表只描述"有哪些会话"，不描述"会话里发生了什么"。实时事件又只覆盖当前会话。两边都没有"别的会话刚答完"这条信息。

## 1.4 分维度诊断

| 维度 | 现状 | 差距 |
|---|---|---|
| 数据 | `run_ledger` 有结束时间和结果，全局列表没带出来 | 列表每一项要带上"最近一次有结果的轮次什么时候结束" |
| 推送 | 只有当前实例、当前会话的事件 | 要么新增跨实例推送，要么前端定时重读列表 |
| 状态存储 | 置顶已经按服务器地址存在 localStorage | 已读状态可以照搬这个做法 |
| 界面 | 前导列已有三种状态和优先级 | 加第四种"未读"，排最后 |
| 兼容 | TUI 不用全局列表 | 字段做成可选，旧前端忽略即可 |

## 1.5 改动时要注意的现有行为

1. **全局列表分页。** 前端重读时会把已加载的页都读一遍（`global-layer.ts:260` 的 `reloadSessions`），所以定时重读的成本随已加载的行数增加。默认每页 100 行。
2. **重读和本地改动有防覆盖逻辑。** `reloadSessions` 遇到进行中的本地改动会放弃这次结果。定时重读直接复用它，不另写读取逻辑。
3. **搜索结果也走 `toUiGlobalSession`。** 搜索的 SQL 是另一条，不带新字段，字段缺省就行。
4. **前导列是 `pointer-events: none`。** 不能用 `title` 做提示，只用 `aria-label`。
5. **当前会话的轮次结束时，列表里的结束时间不会马上更新。** 要等下一次重读。在这之间切走，会把刚看完的回答误判成未读，02 里专门处理。
