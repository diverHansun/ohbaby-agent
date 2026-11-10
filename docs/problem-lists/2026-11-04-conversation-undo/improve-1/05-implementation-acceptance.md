# Rewind 后端实施验收

本地分支 `codex/session-rewind-backend` 从 Fork 验收提交 `224eaf7d` 切出。范围是持久化后端、SDK、HTTP 和 JSON-RPC。Web 和 TUI 的编辑交互留待后续阶段。

Stage 1 后端已通过三批联测，结果见[合并前检查](#合并前检查2026-11-10)。

## 接口与数据

- `POST /v1/sessions/:id/rewind` 按用户提问的 `promptId` 定位。省略 `text` 时返回原文，传 `text` 时同时返回替代 prompt 回执。接收替代消息失败时，已经提交的撤销仍有效，返回 `sendError`。
- 迁移 `029_message_rewind` 保留原消息、prompt 和子代理调用。撤销事务给选中记录写入同一个时间戳，同时增加会话修订号，供其他共享 SQLite 的运行时检测缓存是否过期。
- 暂停活动 goal 时保留后台任务。按实际受影响的轮次停止子代理和 shell，确认清理后才写入撤销标记。其他运行时持有的后台 shell 没有可核实的清理回执时，接口返回 `SESSION_RUNNING`。
- 继承标题的空会话可能仍在使用系统最初给的临时标题。撤销到底后，后端显式保留该标题，清空最后消息时间，另行新建会话会得到新的 ID。

## 命令行端到端

用打包后的 CLI 启动 daemon，隔离工作目录、模型配置和 SQLite。用 `curl` 调用公开 HTTP 接口，用 `sqlite3` 查看实际记录，用本机固定响应的模型检查收到的上下文。

| 场景 | 实测结果 |
|---|---|
| 三轮对话后，撤销第二轮并重发 | 返回第二轮原文和新回执，新 prompt 执行成功。模型请求包含第一轮及修改稿，第二、三轮的文字均已移除。数据库中两轮的记录仍在。 |
| 同一切点再次撤销 | HTTP 400，`REWIND_TARGET_INVALID`。 |
| 在撤销后的会话上打开 Fork 和 Side Chat | 两个副本的 prompt 都只有第一轮与修改稿。 |
| AI 正在回答，后面排着两条提问，此时只撤销 | 返回正在回答的提问原文。运行状态变为 `interrupted`，两个排队项变为 `cancelled`，三条都有撤销标记。 |
| 重启 daemon，重新绑定原会话 | 当前视图、历史页和旧式快照都保留第一轮和修改稿，第二、三轮的旧内容均不可见。 |
| 非法请求与 Side Chat | 参数形状错误或请求体试图指定其他所有者返回 HTTP 400，从 Side Chat 发起撤销返回 HTTP 409。 |
| A 撤销期间 B 发送，第三个窗口新建会话 | 用两个客户端分别调用公开 HTTP 接口。在旧轮次停止并等待收尾时，B 的请求已抵达但尚未入库。第三个窗口立即得到另一个会话 ID。放行后 A 收到 200，B 收到 202；模型依次收到原问题、修改稿、B 的提问。原队列项被取消且没有启动 run。 |
| 独立进程持有同一会话的活动轮次 | 两个本机进程共用临时 SQLite，另一进程发起撤销收到 HTTP 409 和 `SESSION_RUNNING`。原轮次继续运行，消息、prompt 和子代理调用的撤销标记数保持不变。 |

## 后端回归与审查

持久化后端的测试直接检查当前视图和重新打开后的视图、历史分页、HTML 和 JSONL 导出、全文搜索、上下文用量、todo、MCP 工具权限、标题和统计。队列测试区分本窗口与另一窗口持有的编辑锁。另用 SQLite 注入替代消息接收失败，确认请求返回 `sendError`，下一次提问仍能执行。

复审核查了把旧草稿重新排队后的实际轮次顺序、同一 SQLite 上两个独立运行时的会话缓存，以及旧式快照暴露的轮次。后台任务测试使用真实子进程，检查停止失败时三张表保持可见，再次撤销后进程确已退出。

重新排队的草稿沿用原记录的 ID，已写入主消息时以实际消息位置为准。跨目录的旧数据中，若同一毫秒有重提和没有消息的准入记录，旧格式缺少全局序号，无法还原唯一顺序。新写入在会话和工作区两个范围内分配可比较的准入序号。

两个独立后端共用 SQLite 的回归还覆盖了暖视图、只读旧式快照和直接继续提问。跨进程缓存按需刷新；主动读取或开始下一轮时观察会话修订号。同一 daemon 的多个客户端沿用既有事件订阅。

两个后端同时打开有活动 goal 的会话时，只有驱动 goal 的后端能暂停它。子代理用两个独立客户端验证了两种打开顺序。其他后端打开会话不会暂停正在运行的 goal，尝试撤销会收到 `SESSION_RUNNING`。持有 goal 的后端撤销后，另一个后端再次读到的 goal 为 `paused`，也看不到已撤销的历史。

本轮全量 Vitest 含 T14，共 7897 项通过，17 项跳过，0 项失败。类型、格式和打包检查通过。lint 为 0 错误、119 条警告，与 Fork 验收时相同。

## T14 多窗口操作

2026-11-10 确认以后台开始撤销为界。此前已排队的问题随撤销取消。之后收到的新问题保留，撤销带修改稿时先执行修改稿，再执行新问题。独立 TUI 正占用同一会话时，撤销返回 HTTP 409 和 `SESSION_RUNNING`。

并发回归另外覆盖了两个请求紧接着到达、显式与隐式提问混合排队、另一会话同时新建，以及撤销失败后等候者继续执行。两个后端同时压缩和撤销同一段历史时，先提交的操作生效。撤销先提交，压缩会在写摘要前发现源消息已撤销。压缩先提交，再撤销摘要覆盖的轮次会收到 `REWIND_BEFORE_COMPACTION`。

同一后端用 `KeyLockManager` 按会话排序，并把它改为没有前驱时同步启动（全局存储锁也用它，见 02 的“实施时新增”表）。等待发生在取得工作区读锁之前，其他窗口仍能新建会话。

> 2026-11-10 验收后修改：原实现让手动压缩与撤销跨进程共用一条 `app_state` 记录。按 D1 的确认已删掉，改由两边的事务内复查保证正确，见下方“收尾记录”。

## 验收意见（2026-11-10）

验收范围是 `224eaf7d..e46c552d`，共 6 个提交。验收按两条线并行审查：一条看缺陷和代码质量，一条逐条对照 02 和 04。验收会话在本地复跑了以下检查：

- `pnpm typecheck`、`pnpm format:check` 通过。
- `pnpm lint` 报告 0 个错误、119 个警告。
- 全量 `pnpm test`：7897 项通过，17 项跳过，0 项失败。

以下几处核实过，没有问题：

- 迁移 `029` 只用 `ADD COLUMN` 加列，不重建表，也不碰旧数据。
- 消息、prompt、搜索、子代理视图、steer 恢复，以及 `copy-history.ts` 的四处 `rewound_at` 条件都加了过滤。
- 修改稿在 `runControl` 外面接收，不会死锁。
- 其他后端在接收提问、进入会话时，会按修订号刷新缓存。

结论：**主体完成。修完 R1 到 R3、补齐 R4 和 R5、并由用户确认 D1 和 D2 后，后端可以合并到 main。**

### 必须修复

| 编号 | 位置 | 问题 | 修法 |
|---|---|---|---|
| R1 | `ui-inprocess.ts:3977-4031` | 撤销事务提交后，`queueRewindRefresh`（发 `Removed`、重建视图、同步统计）和 `finally` 里的 `releaseHistory()` 只要有一步抛错，整个请求就报失败。可此时三张表已经标记完，修改稿也可能已被接收。客户端重试会收到 `REWIND_TARGET_INVALID`，修改稿只能手动重发。 | 提交成功后，刷新失败只记日志或发通知，不再往外抛。`releaseHistory()` 的异常单独捕获，不能覆盖已经成功的返回值。补一条测试：让刷新抛错，请求仍返回 200 和回执。 |
| R2 | `session-rewind.ts:229-241` `withRewindDeadline` | `check()` 用 `performance.now()` 判断超时，`timeout` 由 `setTimeout` 触发，两个时钟可能差 1 毫秒。落在这个窗口里时：等待先超时，外层 `finally` 释放了令牌，之后还没取消的 `runControl` 回调执行，`check()` 照样通过，`reserve` 成功。闸门就此泄漏，这个会话在本进程内永久卡住。 | 定时器回调里设置 `expired = true`，`check()` 只看这个标志。 |
| R3 | `agents/subagent-host.ts:999-1033` | 停止子代理失败时抛普通 `Error`，路由会返回 500。02 要求停不掉就返回 `SESSION_RUNNING`，不做撤销。 | 改为抛 `SessionRunBusyError`，或其他映射到 409 的错误。补 T13b 原文要求的用例：让 `interruptByRootRun` 抛错，什么都不标记，返回 409。 |

### 测试与文档补齐

| 编号 | 内容 |
|---|---|
| R4 | **补测试：**<br>- **T13**：Web 和 SDK 实际读到的子代理列表、调用列表，过滤掉已撤销的项。现在只测了存储层。<br>- **T12b**：已撤销轮次里的提醒（reminder）不再出现。<br>- **T16b**：检查顺序，按 02 第 6.1 步，`NOT_FOUND`、`NOT_ROOT`、`ARCHIVED`、`SIDE_CHAT_UNSUPPORTED`、`MOVED` 依次组合断言。<br>- **T15c**：会话运行中，目标在压缩点之前时直接拒绝，当前这一轮照常运行。<br>- **fork 04 §4.3**：用直接写库的夹具构造“同一轮只有最终 AI 回答被撤销”，单独守住 `findForkableMainRun` 的 `rewound_at` 条件（`copy-history.ts:76`）。现在删掉这个条件，测试照样通过。<br><br>**改 04：** T15b 的原文是“撤销中途子代理唤醒抢先开出的一轮也被中断并隐藏”，实现是撤销期间挡住唤醒（`ui-inprocess.ts:1386`、`:1554`）。按实现改写 T15b 并补测试，02 第 6.3 步同步。 |
| R5 | **02 补记全局行为变化：**<br>- `KeyLockManager` 改为没有前驱时同步启动，全局存储锁也用它。<br>- goal 驱动者归属（`e34a9bce`，`goals/persistence.ts`）。<br>- 准入序号取工作区和会话两者中的较大值，会话移动工作区后会跳号。<br>- 撤销期间，隐式“New”最多可能被拖住 10 秒。<br>- `copy-history.ts:36` 的 prompts 查询多加了一处 `rewound_at` 条件。<br><br>**02 内部矛盾：** 决策表把“另造锁”列为被放弃的选项，实现却用了 `app_state` 的历史操作标记。改写这一行，说明这个标记只用于跨进程。<br><br>**05：**<br>- 把“复用现有的 `KeyLockManager`”改为如实描述它的改动。<br>- 补一张 04 编号到测试用例的对照表。<br>- 写明“停止成功、提交失败”时，已停掉的后台任务不会恢复，这和“运行中撤销”的不可逆点一致。 |

### 需要用户确认

| 编号 | 事项 | 验收建议 |
|---|---|---|
| D1 | 00 和 02 把 P5 从“取消排队的 prompt”改成三点：<br>- 以后台开始撤销的时刻为界，之前已排队的取消，之后到达的保留、在修改稿之后执行；<br>- 独立 TUI 正占用这个会话时，返回 `SESSION_RUNNING`；<br>- 新增 `app_state` 历史操作标记。<br>00 记为“用户确认”，和本文档在同一个提交 `e46c552d` 里。 | **2026-11-10 用户已确认**：前两点接受；第三点去掉 `app_state` 历史操作标记，见 R6。 |
| D2 | goal 驱动者归属：同一个会话同时被 TUI 和 daemon 打开时，只有驱动 goal 的那一边能暂停或清除 goal，另一边会收到 `SESSION_RUNNING`。恢复时，驱动者还活着就不再把 goal 改为 `paused`。这对所有使用 goal 的会话都生效。 | **2026-11-10 用户已确认接受。** 它修的是 main 上已有的 bug：另一个后端打开会话时，会把别人正在驱动的 goal 当成崩溃残留，改成 `paused`。存活判断已经用了进程实例 ID 加 PID，和 side chat 一致。R5 里要写明：这处改动修的是已有 bug，对所有用 goal 的会话都生效。多个进程同开一个会话的整体规则，以后另立议题设计。 |

### D1 确认后追加

| 编号 | 位置 | 要做的事 |
|---|---|---|
| R6 | `services/session/history-operation.ts`；`ui-inprocess.ts` 的 import（:40）、撤销时的登记（:3926）和释放（:4029）、手动压缩时的登记（:4055-4063）和释放（:4089） | 删掉跨进程的历史操作标记。验收会话核实过，删掉后不会出现数据错误：<br>- 压缩在写摘要的同一个事务里复查源消息仍未撤销、内容没变（`core/message/database-store.ts:605-684` 的 `commitCompaction`）。自动压缩本来就不登记这个标记，一直只靠这处复查。<br>- 撤销在提交事务里复查切点仍在最近一次摘要之后，并检查 `run_ledger`（`session-rewind.ts:105-144`）。<br>- 压缩和撤销谁先提交，后提交的一方都会失败，用户重试即可。少掉的只是“提前报忙”。<br><br>上面两处事务内复查必须保留。同进程内的互斥（`compactingSessions`、`rewindingSessions`）不变。改写 `ui-persistent.integration.test.ts:4051-4120`：<br>- 一个进程压缩到一半，另一个进程撤销：撤销成功，压缩失败。<br>- 压缩先提交，再撤销压缩点之前的目标：返回 `REWIND_BEFORE_COMPACTION`。<br>02、04 的 T14、本文档里关于这个标记的描述同步删改。R5 里“另造锁”那条矛盾随之消失，决策表保持原来的“不另造锁”。 |

### 记录（不阻塞合并）

- R6 已删除历史操作标记。对于 goal 驱动者，若记录的 PID 等于本进程，还会核对进程实例 ID。判断其他进程是否存活仍靠 PID，其他进程的 PID 被复用时可能继续报忙。后续工作见[多进程会话占用议题](../../2026-11-10-multi-process-session-ownership/README.md)。
- 数据库迁移 `029` 的降级限制已写入[发布说明](../../../releases/unreleased.md)。

## 收尾记录（2026-11-10，验收会话实施）

用户确认 D1、D2 之后，验收会话直接完成了收尾，没有再交回实施会话。

### 修复

| 编号 | 改动 | 守住它的测试 |
|---|---|---|
| R1 | 撤销提交后，视图刷新失败只发一条 warning 通知，请求照常返回结果和修改稿回执。刷新失败时，内存里这一版的记录会被清掉，下一次读取会按数据库里的切点重新构建视图。 | `returns the rewind result even when refreshing this view fails afterwards` |
| R2 | `withRewindDeadline` 只看定时器设置的 `expired` 标志，不再另外比较 `performance.now()`。 | 原有的 `times out after ten seconds ...` 保持通过 |
| R3 | 被撤销轮次的后台任务确认不了已停止时，返回 `SESSION_RUNNING`，原错误放在 `cause` 里。 | `reports SESSION_RUNNING and marks nothing when rewound background work cannot be stopped` |
| R6 | 删掉 `services/session/history-operation.ts` 及撤销、手动压缩里的登记和释放。 | `lets a rewind win over another backend's unfinished summary and rejects cuts before a committed one` |

### 补测试（R4）

除 T15b 外，每条都临时去掉对应的实现确认过会失败，再恢复。T15b 的验证方式见表中说明。

| 04 编号 | 测试 | 守住的实现 |
|---|---|---|
| T13 | `hides rewound subagents from the execution and instance lists that clients read` | `subagent-views.ts` 的 `visibleOnly`，`subagent-instances.ts` 回退到更早一次未撤销的调用 |
| T12b（提醒） | `drops reminders recorded by a rewound turn from the view and the next model request` | 提醒按 user 消息存储，`markMessagesRewound` 会一并标记 |
| T16b（顺序） | `orders session checks NOT_FOUND, NOT_ROOT, ARCHIVED, SIDE_CHAT_UNSUPPORTED, MOVED when several apply` | `readActiveMainSession` 的检查顺序，目录检查排在最后 |
| T15c（压缩点） | `refuses a cut before compaction while a turn runs, leaving that turn and its queue untouched` | 停止之前的预检 |
| T15b（唤醒） | `holds subagent wakes while a rewind waits and then wakes only for kept turns` | `prepareSession` 里 `rewindingSessions` 的检查。用例靠 300 毫秒的等待来判断“没有开出新一轮”，连跑 3 次都稳定 |
| fork 04 §4.3 | `copy-history.integration.test.ts` 的 `skips a run whose only rewound message is its final AI answer` | `findForkableMainRun` 查 AI 回答时的 `rewound_at IS NULL` |

### 04 编号与测试对照

除特别注明外，测试都在 `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts` 的 “persistent conversation rewind” 一组。

| 04 编号 | 测试 |
|---|---|
| T1 至 T8、T16 | `rewinds a suffix across saved history, open views, exports, model input and restart` |
| T1b、T1c、T15b（运行中） | `checks a running target before stopping and cancels its owner's queued drafts ...`、`commits a rewind when replacement admission fails ...` |
| T9、T9b | `side-chat-runtime.integration.test.ts` 的 “rebuilds a second backend's ...” |
| T10 | `steer-recovery.integration.test.ts` 的 “hides rewound inputs ...” |
| T12 | `it.each(["resubmitted", "earlier"])` |
| T12b | 上面的提醒用例，以及 `it.each(["goal", "subagent"])` |
| T13 | 上面的子代理列表用例 |
| T13b | 上面的 R3 用例 |
| T14 | 第 3940 行起的 `it.each` 并发用例，以及上面的 R6 用例 |
| T15 | `pauses an idle goal and defers its retained child's wake ...` |
| T15b | `it.each(["goal", "subagent"])`，以及上面的唤醒用例 |
| T15c | `times out after ten seconds ...`，以及上面的压缩点用例 |
| T16b | `rejects inaccessible sessions, foreign prompts and cuts before compaction ...`，以及上面的顺序用例。`SESSION_MOVED` 另见 `tests/integration/web/new-session-lifecycle.integration.test.ts` |
| T16c | `copy-history.integration.test.ts` 的 “copies only visible history ...”，以及上面的 fork 用例 |
| T17 | `tests/integration/web/new-session-lifecycle.integration.test.ts` 的撤销接口用例 |

### 已知未覆盖

- `ui-inprocess.ts` 里传给调度器的 `isClaimPaused: (id) => rewindingSessions.has(id)`，没有测试守住，把它改成恒为 `false`，撤销的全部用例仍然通过。撤销期间的新提问被准入锁挡在外面，排队的提问也已被取消，目前造不出会走到这个判断的场景。保留它作为防御。以后有新的路径不经过准入锁就认领排队提问时，再补测试。
- “停止成功、提交失败”时，已停掉的后台任务不会恢复，这和“运行中撤销”的不可逆点一致，见 README。

## 合并前检查（2026-11-10）

在临时工作目录和 SQLite 数据库里，用命令从 HTTP 入口联测三个后端。并发场景用可控制停止时机的本地模型。真实模型场景用打包后的 CLI 启动 daemon，调用 `deepseek-flash`。

| 场景 | 实测结果 |
|---|---|
| Side Chat | 侧聊继承主会话历史，自己的追问只写入侧聊。全局列表隐藏侧聊，绑定索引用 `isSideChat` 标识它，恢复列表返回原目录。连续关闭同一侧聊两次都返回 204。 |
| Fork | 传入第一轮 AI 回答所属的 `runId` 只复制第一轮。最新一轮还在运行时，从菜单 Fork 会复制到上一个已回答轮次。传用户消息 ID 返回 400 和 `FORK_TARGET_INVALID`。 |
| 两个窗口同时操作 | 撤销停止当前轮次，取消此前已排队的提问。另一个窗口在撤销期间发来的提问排在修改稿之后，两条都执行成功。 |
| 独立 TUI 后端正在运行一轮 | daemon 尝试撤销同一会话，返回 409 和 `SESSION_RUNNING`。原轮次正常结束后，重试成功。 |
| 撤销后的副本 | 新开的 Side Chat 和 Fork 只复制可见轮次。撤销前建立的副本保留原历史。 |
| 真实模型的上下文 | 在主会话中给模型一个随机口令，Side Chat 和 Fork 都能独立复述它。再给主会话第二个口令，撤销这轮并重新提问，模型只答出第一个。JSONL 导出也只含第一个，SQLite 中第二轮的原始记录已标记撤销。 |

全量测试时发现一条旧断言仍在匹配 shell 清理失败时的报错文本。按 R3 改为同时核对公开错误码 `SESSION_RUNNING` 和 `cause` 中的原始原因。该用例还验证失败后历史仍可见，重试后后台进程确实退出。

最终全量 Vitest 共 7905 项通过、17 项跳过、0 项失败，包含 CLI 打包安装与进程测试。`pnpm build`、`pnpm typecheck` 和 `pnpm format:check` 通过。`pnpm lint` 报告 0 个错误、119 个警告，与 Fork 验收时相同。
