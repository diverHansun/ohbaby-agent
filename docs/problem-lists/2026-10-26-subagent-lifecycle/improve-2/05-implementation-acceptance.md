# 5. 实施验收

## 接口类型审查（2026-10-29，实现之前）

审查对象：`ce7bdb2e` 新增的 `packages/ohbaby-sdk/src/contract/subagent-instance.ts`，以及 `contract/subagent.ts`、`index.ts` 的小改动。improve-2 还没有实现，这一轮只确认类型够不够 improve-3 的前端用。审查方（也是前端实施方）的结论是：**改完下面第 1、2 项就可以开始实现，前端也可以开工。**

### 已经满足的

- improve-2/02 §2.2 A 要求的字段都在：`description`、`createdAt` 和 `updatedAt`、`status`、`currentExecutionId` 和 `latestExecutionId`、`mode`、`approvalBlocked`、`settling`（注释与 D42 一致）、`unprocessedMessageCount`。
- Active/Done 没有进入状态枚举。
- 停止请求带 `expectedExecutionId`。回执只有一个，用 `outcome` 区分 `accepted`、`confirmed`、`not_running`、`execution_changed`，符合"只返回一个回执"的约定。
- 详情锚点复用了现有 `UiSubagentConversationQuery` 的 `anchorExecutionId`（`subagent.ts:88`）。

### 必须修改

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| 1 | **快照没有版本号（已核实）。** 返回值只有 `rootSessionId` 和 `complete`。失效事件和停止回执可能同时触发两次刷新，前端分不清哪个响应更新，旧响应可能让已关闭的实例重新出现。这正是 02 风险表里的"close 后实例又出现" | `subagent-instance.ts:2-6` | 按现有约定（`UiPermissionSnapshot` 的 `permissionRevision` 和 `bindingGeneration`，`UiSessionView` 的 `version`），给快照加 `runtimeEpoch`、`bindingGeneration?` 和按主会话单调递增的 `revision`，注释写明"只在 revision 更大时替换" |
| 2 | **新类型没接进客户端和事件（已核实）。** `UiClient` 只并入了 `Partial<UiSubagentReadClient>`，没有 `UiSubagentInstanceClient`；`UiSubagentInstancesInvalidatedEvent` 不在 `UiEvent` 联合类型里，前端既没法收窄事件类型，也没法通过有类型的 client 调用 | `contract/client.ts:127`、`contract/events.ts:235-237` | 两处都加进去；失效事件带上 `runtimeEpoch`，和 `UiSessionResyncRequiredEvent` 一致 |

### 需要写清楚的语义（加注释即可）

| # | 问题 | 前端的决定或建议 |
| --- | --- | --- |
| 3 | 详情页标题要显示实例当前状态，但会话视图里只有 `executions[]` | **不用加字段。** 标题从列表快照读当前状态，右侧栏打开详情时列表快照一定已加载。在 `UiSubagentConversationView` 的注释里写明这一点即可 |
| 4 | 停止后，`status` 是在 `accepted` 时变成 `interrupted`，还是等到 `confirmed` 才变 | 注释写明。前端的做法是：`settling` 为 true 时隐藏停止按钮，显示"正在停止" |
| 5 | 只有 `SUBAGENT_CLOSED` 一个错误码，跨会话或 ID 不存在时返回什么没定义；已关闭的实例只能报错，因为回执里的 `instance` 是必填的 | 复用 SDK 已有的错误码；没有合适的，就加 `SUBAGENT_NOT_FOUND`，跨会话按现有的会话访问错误返回。注释写明"已关闭的实例返回 `SUBAGENT_CLOSED`" |
| 6 | 状态 `cancelled` 和 `pending` 的含义 | 前端把 `pending` 归入 Active，`cancelled` 归入 Done。注释写明 `cancelled` 和 `interrupted` 的区别 |

### 不需要改的

- 列表排序：前端自己按 `updatedAt` 排，后端不用约定。
- `complete: true` 作为字面量类型可以接受，以后分页时可以用它区分。
- 注释里的 "B1/B2" 是规划编号，实现后改成描述性的文字即可。
