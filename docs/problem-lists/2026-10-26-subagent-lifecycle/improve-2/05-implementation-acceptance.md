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

## 实现验收（2026-10-29）：通过，前端详情和停止开工前先做 B4

验收范围：`1eb981d3`（类型反馈）和 `4ed9f980`（实现）。Codex 的交接说明见 [improve-1/06](../improve-1/06-backend-review-response.md) 的"improve-2 后端交接"。验收方用一个子代理逐项读代码、跑了 9 个相关测试文件（108 项全部通过），关键问题由验收方再读代码核实。仓库级的 typecheck、lint、完整测试和编译后的 Web E2E 结果见 [improve-1/05](../improve-1/05-implementation-acceptance.md) 第二轮。

### 类型审查意见的处理

- 第 1 项（版本号）：快照加了 `runtimeEpoch`、`bindingGeneration?`、按主会话递增的 `revision`；失效事件也带 `runtimeEpoch` 和 `revision`。已修。
- 第 2 项（接入 client 和事件）：`listSubagentInstances` 进了 `UiQueryClient`，`stopSubagent` 进了 `UiCommandClient`，失效事件进了 `UiEvent`。读和写分开放，比原建议更好。已修。
- 第 3–6 项（语义注释）：都补了。新增 `SUBAGENT_NOT_FOUND`，会话绑定变化复用 `SESSION_SCOPE_CHANGED`。

### 验收项

| 项 | 证据 | 结论 |
| --- | --- | --- |
| I2-01 | `subagent-instances.integration.test.ts` 的 61 个实例、同一实例跨 5 次执行只占一行；SDK `subagent-instance-reader.unit.test.ts` 的失败保留旧列表、乱序、换会话 | 通过 |
| I2-02 | 已完成实例 close 后没有执行事件也会失效；读取中 close 会重试；旧响应不能让实例复活；关闭后详情返回 `SUBAGENT_CLOSED`，monitor 仍能读 | 通过。缺一个测试：在真实组合里 close 一个**运行中**的实例，再看列表 |
| I2-03 | `subagent-instance-control.integration.test.ts` 的空闲和前台停止、旧身份返回 `execution_changed`；server `session-recovery.integration.test.ts` 走 REST 和 RPC，`abortRun` 从未被调用，跨会话 409，缺 `expectedExecutionId` 返回 400，已关闭返回 410 | 通过，但见下面 B4 第 1、4 条 |
| I2-04 | 原有的锚点、跨执行分页、稳定名称测试保留 | 通过 |
| I2-05 | conversation 和 SDK reader 的 watch 释放、换会话、迟到响应、close 后不重连 | 通过。缺一个测试：释放 watch 后子执行继续跑 |
| I2-06 | 原 `subagent-views.integration.test.ts` 和 SDK `subagent-reader.unit.test.ts` 通过，CLI 的 execution reader 还在 | 通过 |

`revision` 的来源核对过：实例创建、改名、改描述、关闭，执行状态和 mode 变化，审批，停止和收尾，未处理消息条数变化，都会让 revision 增加并发出失效事件。

### B4：交给 Codex 的补充批次

前端的容器（C1）和列表（C2）不依赖这些，可以先做；详情和停止（C3）要等 B4。

> 2026-10-29 补充：用户随后要求前端直接基于现有接口实施，不等 B4。C3 对第 1–3 条先在前端兜底，做法见 [improve-3/02 §2.7](../improve-3/02-optimization-plan-and-change-scope.md)。B4 仍然要做，做完后前端删掉兜底。另外请在 SDK 契约里给 `SUBAGENT_SNAPSHOT_CHANGED` 加一个错误类型（和 `UiSubagentClosedError` 一样），前端现在只能按字符串判断。

| # | 级别 | 问题 | 建议 |
| --- | --- | --- | --- |
| 1 | 必须修（已核实） | **停止已经生效，接口却可能返回 409。** `subagent-instances.ts:219-220` 先调用 stop，再调用 `list()` 拼回执。stop 本身会触发收尾，让 revision 连续变化，`list()` 重试 3 次后抛 `SUBAGENT_SNAPSHOT_CHANGED`。前端会以为停止失败 | 回执里的 `instance` 只取这一行，不要求整份快照一致；或者 `list()` 失败时退回只读这一行。回执本来就注明"客户端还会刷新完整快照" |
| 2 | 必须修（已核实） | **详情没法按 `subagentId` 打开。** SDK conversation reader 的 `select` 只接受完整的 `UiSubagentExecution`（`subagent-conversation-reader.ts:28`），而实例快照里没有这些字段。improve-3/02 §2.4 要求"列表里按 `subagentId` 选择"，还没有执行的 pending 实例也打不开 | 在 SDK reader 上加 `selectInstance({ subagentId, anchorExecutionId? })`，没有锚点时跟随最新执行 |
| 3 | 必须修（已核实） | **断线重连后列表不刷新。** `createSubagentInstanceReader` 不处理 `session.resync-required`，而 conversation reader 处理（`subagent-conversation-reader.ts:534`）。SSE 断开期间漏掉的失效事件不会补，列表一直停在旧状态 | instance reader 收到这个事件就 `refresh()` |
| 4 | 建议修（已核实） | close 和 stop 同时发生时，`SubagentHost.stop` 抛的是不带 code 的普通 Error（`subagent-host.ts:905, 910`），HTTP 会变成 500，而不是 404/410 | 用 `subagentAccessError` 带上 code |
| 5 | 建议修 | I2-02、I2-05 各缺的那个测试 | 补上 |

另外两个前端自己处理的点，记在这里备查：

- stop 可能阻塞约 2 秒（`cleanupWaitMs`），按钮要先显示"正在停止"。
- 前端只给 reader 传 `rootSessionId`，由 client 注入当前绑定。如果把 `runtimeEpoch` 和 `bindingGeneration` 也写进查询，重新绑定后每次刷新都会失败。
