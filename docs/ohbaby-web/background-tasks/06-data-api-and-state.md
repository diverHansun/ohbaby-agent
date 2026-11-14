# 06 数据、接口与状态

字段以 SDK 契约 [shell-job.ts](../../../packages/ohbaby-sdk/src/contract/shell-job.ts) 为准，这里只写前端怎么用这些接口，以及刷新、取消、错误处理的策略。

## 1. 接口到界面的映射

后端已经提供了 HTTP 路由（[shell-jobs.ts](../../../packages/ohbaby-server/src/protocols/web/routes/shell-jobs.ts)）和失效事件。Web 的 daemon 客户端（`apps/ohbaby-web/src/api/daemon/`）提供列表、输出与取消方法。

每个请求都必须带上当前的 `runtimeEpoch` 和 `bindingGeneration`。做法和 `listSubagentInstances` 一样，由客户端自动补上。缺了或者过期，后端会返回 `SESSION_SCOPE_CHANGED`。

| 接口 | 谁在用 | 怎么用 |
|---|---|---|
| `GET /v1/sessions/:id/shell-jobs?mode=background&owner=main&limit=1` 和 `?mode=background&owner=subagents&limit=1`，两个请求并行发 | 会话级探测（§3.1） | 每个请求只读 `statusCounts`，求和得到这一方的任务数 |
| `GET /v1/sessions/:id/shell-jobs?mode=background&owner=main\|subagents&limit=30&cursor=` | 列表视图（UC-BGT-01、02） | 转成 ViewModel 后渲染；滚到底部附近时用 `nextCursor` 往后追加 |
| `GET /v1/sessions/:id/shell-jobs/:jobId/output` | 详情视图（UC-BGT-03、05） | 渲染返回的 `job` 和 `output`；任务运行中时轮询 |
| `POST /v1/sessions/:id/shell-jobs/:jobId/stop` | Cancel（UC-BGT-04） | 请求返回后不直接改这一行，等列表或输出刷新出新状态 |
| 事件 `shell-jobs.invalidated` | 探测、列表 | 触发重新请求，但要节流（§3.2） |
| `GET .../log`、`POST .../abandon` | 不使用 | 本轮 Non-goal |

筛选选 All 时，列表请求不带 `owner` 参数。

bash 工具卡下的入口行不请求接口。它只读工具结果里已经有的三个字段：`details.kind === "bash"`、`details.mode`、`details.jobId`，定义见 [snapshot.ts](../../../packages/ohbaby-sdk/src/contract/snapshot.ts) 的 `UiToolResultDetails`。

## 2. ViewModel

后端返回的行要先在数据层转换，组件不直接读 `UiShellJobRow`。

```ts
interface BackgroundTaskItem {
  readonly jobId: string;
  /** 优先用 description；没有就取命令的第一行，截成一行。 */
  readonly title: string;
  readonly command: string;
  /** 只有子代理启动的任务才有值。 */
  readonly ownerName?: string;
  readonly group: "running" | "done";
  /** 列表行右侧显示的那一项：运行中和正常结束显示时长，失败、超时、lost 显示文字。 */
  readonly trailing:
    | { readonly kind: "elapsed"; readonly since: number }
    | { readonly kind: "duration"; readonly ms: number }
    | { readonly kind: "failed" | "timed-out" | "unknown" };
  readonly canCancel: boolean;
  /** 详情页的说明行，按 03 §5.3 的顺序选，最多 2 条。 */
  readonly notes: readonly string[];
  /** 详情页的状态行，按 03 §5.2 生成。 */
  readonly statusLine: string;
}

interface BackgroundTaskOutputView {
  readonly text: string;
  /** outputBytes > 32768：后端只返回最后 32KiB。 */
  readonly tailOnly: boolean;
  /** outputTruncated：日志文件本身因为超过上限被截断。 */
  readonly logIncomplete: boolean;
  /** 有值才显示“复制路径”图标。 */
  readonly logPath?: string;
  /** tailAvailable 为 false：这个任务没有保存输出尾部。 */
  readonly noSavedOutput: boolean;
}
```

派生规则：

- **分组**：`status === "running"` 归 running 组，其他状态都归 done 组。
- **能不能取消**：`canCancel = status === "running" && canStop`。为什么多一个 `running` 条件，见 00 §4。
- **由别的后端管理**：`status === "running" && !canStop && !managedByCurrentBackend`。满足时加一条说明行。已结束的任务不看 `managedByCurrentBackend`，原因见 01 §1.3。
- **清理未确认**：`cleanup === "unconfirmed" && trackingReleasedAt === null`。
- **时长**：起点用 `startedAt`，没有就用 `createdAt`；终点用 `endedAt`。
- **失败时的状态行**：`status` 是 `failed` 且 `signal` 有值，就显示信号名；否则显示 `exit N`。
- **组标题的数字**：Running 组用 `statusCounts.running`，Done 组用另外五种状态的数量之和。两个数都直接取后端统计，和前端已经加载了几页无关。

列表顺序完全照后端给的（需要关注的排前面，其余按结束时间或开始时间倒序）。前端只负责把行分到两组，组内不重新排序。

## 3. 服务端状态策略

### 3.1 两个读取器

| 读取器 | 存在多久 | 用途 |
|---|---|---|
| 探测 | 会话打开期间一直存在。放在会话层，和 `useSubagentInstances` 并列 | 决定菜单项和 Tab 显不显示、筛选图标出不出现、默认用哪个筛选 |
| 列表 | Background tasks Tab 显示期间一直存在，进入详情时也保留，所以返回列表是即时的（实施调整，2026-11-14） | 列表视图；详情页取这一行的最新状态 |

探测的结果是 `{ main: number; subagents: number } | unknown`，含义如下：

- **会话有没有任务**：`main + subagents > 0`。
- **筛选图标出不出现**：`subagents > 0`。
- **默认筛选**：`main > 0` 时用 Main agent，否则用 All。所以不需要“先查 Main，为空再查一次 All”这样的两次串行请求。

探测的结果还不知道，或者请求失败时，沿用上一次的结果（04 §2.1）。只有拿到确定的结果，界面才跟着变。

两个读取器在 SDK 的 `sync/` 下新增，写法参考 `createSubagentInstanceReader`，Web 侧用 `useSyncExternalStore` 订阅。有三条规则和子代理读取器不一样：

- **查询条件变了**（换筛选、换会话）：取消正在进行的请求，用新条件重新请求。
- **查询条件没变，又要刷新**（收到失效事件、重连）：如果已经有请求在跑，不取消它，等它结束后再补发一次。补发最多排一个。这样做是因为运行中的任务每秒都会触发失效事件，如果每次都取消上一次请求，就永远拿不到结果。
- **其余规则照搬**：请求失败时保留上一次的数据；返回的 `rootSessionId` 和请求的对不上时，丢掉这个结果。

### 3.2 什么时候刷新

后端每次更新任务记录都会发一个失效事件（`ShellJobProjection` 订阅了 store 的所有变更）。运行中的任务大约每秒写一次输出检查点，所以失效事件会很密。规则如下：

| 触发 | 探测 | 列表 | 详情输出 |
|---|---|---|---|
| 打开会话或切换会话 | 请求 | 请求（Tab 正在显示时） | — |
| `shell-jobs.invalidated` | 节流，最多 2 秒一次 | 节流，最多 2 秒一次；重新请求已加载的范围（`limit` 等于已加载的行数） | 不响应，靠轮询 |
| `session.resync-required`（断线重连后） | 请求 | 请求 | 拉一次 |
| 详情页打开且任务在运行 | — | — | 每 2 秒拉一次（§3.3） |
| 切换筛选 | — | 清空游标，重新请求 | — |
| 页面从后台切回前台 | 后台期间漏掉过失效事件，就补一次 | 同左 | 恢复轮询并马上拉一次 |

页面在后台（`document.visibilityState !== "visible"`）时，失效事件不发请求，只记一下“有变化”；回到前台后补一次。

详情输出只靠轮询更新，不靠失效事件。这样只有一种更新方式，也能覆盖“别的后端管理的任务，本地收不到事件”这种情况。详情页的状态行用输出接口返回的 `job` 来更新。

### 3.3 输出轮询

- 同时满足三个条件才轮询：详情视图正在显示、任务是 `running`、页面在前台。
- 间隔初值 2 秒。上一次请求返回后才开始计时，所以请求不会重叠。
- 任务结束后继续读到 `resultReadyAt` 有值，再停止轮询。
- 请求失败就暂停轮询，等用户点 `Retry`。
- 离开详情、关闭 Tab、切换会话时：取消正在进行的请求，停掉计时器。

### 3.4 分页（D11）

- 每页 30 行。列表末尾放一个哨兵元素，用 `IntersectionObserver` 观察；进入可视区（初值提前约一屏）且 `hasMore` 为 true、当前没有在加载时，用 `nextCursor` 请求下一页。
- 不设前端上限，也不显示任何“已到底”说明。
- 收到失效事件后，从头重新请求已加载的范围：后端单次最多 100 行，所以按每次 100 行、沿 `nextCursor` 依次请求，直到行数达到已加载的数量。通常已加载的不超过 100 行，只需一次请求。
- 重新请求期间保留旧列表，全部返回后一次替换，避免列表在中途变短。
- 加载下一页失败后停止自动加载，等用户点 `Retry`。

### 3.5 取消

- 点击 Cancel 后，在内存里记下 `cancelling: Set<jobId>`，按钮立刻变成 `Cancelling…`。
- 返回 `accepted`：继续保持 cancelling，等列表或输出里这个任务的状态不再是 `running`，再从集合里移除。
- 返回 `already-terminal`：从集合里移除，刷新列表。
- 请求出错：从集合里移除，按 §4 显示。
- 请求 10 秒没有回应：中止请求，从集合里移除，按钮恢复成 `Cancel`。后端正常 2 秒内就会回应（直接停止约 1.2 秒，接管旧任务也有上限），10 秒没回应说明请求丢了或服务卡住了。没有超时的话，按钮会一直停在 `Cancelling…`，用户也没法重试。
- 超时前列表或输出已经看到任务结束（任务已经不在集合里），说明取消已经生效，只是响应没回来，这时不提示；否则按 §4 显示一行提示。重试是安全的：任务已结束时后端返回 `already-terminal`。
- 这个集合挂在 Background tasks Tab 页面上，列表和详情共用。切换会话时清空。

### 3.6 时钟

运行时长要每秒更新。只有在列表或详情里有运行中的行时，才启动一个 1 秒的时钟；没有运行中的任务就不走秒。Done 组的时长是固定的，用不到时钟。

## 4. 错误到界面的映射

| 错误 | 哪个接口会返回 | 界面表现 | 对应 04 的状态 |
|---|---|---|---|
| `SHELL_JOB_NOT_FOUND` | output、stop | 详情显示 `This task is no longer available.`；刷新列表 | 2.3 任务不存在 |
| `SHELL_JOB_OTHER_BACKEND` | stop | Cancel 消失；刷新后出现说明行 | 2.3 由别的后端管理 |
| `SHELL_JOB_CLEANUP_BUSY` | stop | 显示一行 `ohbaby is already cleaning up this task.`，刷新列表 | 2.2 / 2.3 取消失败 |
| `SHELL_JOB_NOT_READY` | output | 不提示，下一次轮询再试 | 2.3 运行中 |
| `SHELL_JOB_NOT_READY` | stop | 按网络错误处理（列表里的任务都已登记完成，正常情况下不会遇到） | 2.2 / 2.3 取消失败 |
| 请求超时（10 秒没有回应） | stop | 恢复 Cancel，显示一行 `System didn't respond to Cancel. Try again.`，刷新列表；列表已经看到任务结束时不提示（§3.5） | 2.2 / 2.3 取消失败 |
| `SESSION_SCOPE_CHANGED` | 所有接口 | 不提示，丢掉结果，等切换会话后的新请求 | — |
| `SHELL_JOB_INVALID_QUERY` | 所有接口 | 按未知错误处理。出现它说明前端有缺陷，开发阶段就应该修掉 | 未知错误 |
| 网络错误、断线、未知错误 | 所有接口 | 出错的位置显示一行 `readableError` 文案。加载类错误带 `Retry`；取消类错误不带，用户可以直接再点 Cancel。不能吞掉错误不提示 | 2.2、2.3 失败行 |

## 5. 隐藏任务结果消息

`ConversationStream` 现在会过滤掉 `subagent-result` 和 `subagent-status` 两种消息。在这个过滤条件里加上 `runtimeInputKind === "background-task-result"`。

实现时要确认一件事：被这条消息唤醒的那一轮，在 `run-process` 分组里开头没有用户消息，渲染是否正常。子代理结果唤醒的轮次已经是这种情况，预计可以直接复用。

## 6. Mock 场景

沿用 `apps/ohbaby-web/src/dev/mock-scenarios.ts` 的 `?mock=<name>` 机制，在 mock runtime 里实现上面四个接口和失效事件。

| 场景 | 内容 | 对应 |
|---|---|---|
| `bg-none` | 会话没有任何任务 | 04 §2.1 入口不出现 |
| `bg-running` | 主代理 2 个运行中（一个 30 秒前启动，一个 2 小时前启动）；3 个已结束（成功、失败、被用户取消）；输出持续增长，并且每秒发一次失效事件 | UC-BGT-01、03、04 |
| `bg-subagents` | 主代理 1 个任务，两个子代理各 2 个 | UC-BGT-02 |
| `bg-subagents-only` | 只有子代理有任务 | §3.1 默认筛选为 All |
| `bg-many-done` | 1 个运行中，250 个已结束 | 滚动自动加载、超过 100 行后的失效刷新 |
| `bg-special` | 每种各一个：`lost`、清理未确认、由别的后端管理（运行中）、`timed_out`、停止原因为 `owner-ended`、输出超过 32KiB、日志被截断、没有保存输出尾部 | 04 §2.3 特殊状态 |

`bg-none`、`bg-running`、`bg-chat` 里另有两条前台记录（一条刚结束未收尾、一条清理未确认），用来验证 D12：它们不能出现在列表里，也不能让入口出现。
| `bg-cancel-errors` | 取消时分别返回 `OTHER_BACKEND`、`CLEANUP_BUSY`、`NOT_FOUND`、网络错误 | 04 §2.2、§2.3 取消失败 |
| `bg-output-fail` | 输出接口返回失败 | 04 §2.3 输出拉取失败 |
| `bg-chat` | 对话里有：一张启动了后台任务的 bash 卡片、一张前台 bash 卡片、一条 `background-task-result` 消息和它唤醒的回复 | UC-BGT-05、06 |
| `bg-two-chats` | 两个会话，一个有任务、一个没有，可以来回切换 | 01 §2.4 |

mock 还要能控制网络延迟（用来看 `Loading…`）。断线沿用现有 mock 的做法。

## 7. 和后端的对齐

| 项 | 结论 |
|---|---|
| 列表、输出、停止、事件 | 后端已提供，字段够用 |
| 输出变化没有专门的事件 | 用 2 秒轮询解决，后端不用改 |
| 按启动时间筛选、正序排序 | 后端不支持，本轮也不做（D5），后端不用改 |
| 行数据里没有 pid | 本轮界面不显示 pid，用不到 |
| 旧会话的 bash 结果没有 `mode` 字段 | 不显示入口行，可以接受 |
| `managedByCurrentBackend` 在服务重启后对所有旧任务都是 false | 前端只在任务运行中看这个字段（§2），后端不用改 |
| 已结束但清理未确认的任务也有 `canStop` | 本轮不提供重试清理的入口（00 §4），后端不用改 |

| 后端默认列表包含刚结束未收尾和清理异常的前台命令 | 实施审查时发现（D12）。后端新增可选参数 `mode=background`：内存和 SQLite 查询都只取 `mode = 'background'`，计数随之一致；cursor 指纹包含这个参数，不能和未筛选的列表混用；模型的 `task list` 不传，行为不变 |

除了 `mode=background` 这一个可选参数，本轮不需要后端补其他接口或字段。
