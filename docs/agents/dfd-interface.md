# agents 数据流与接口

当前模型工具入口为 `agent`，action 为 `spawn`、`send`、`list`、`monitor`、`stop`、`close`。旧 `subagent_run/status/close` 只保留历史展示兼容，不再注册到工具目录。

## 身份与执行边界

| 身份 | 用途 |
| --- | --- |
| `rootSessionId` / `parentSessionId` | 子代理所属主会话，跨主轮次保持不变 |
| `subagentId` | 稳定实例 ID；stop 后可继续，close 后不可再执行 |
| `sessionId + contextScopeId` | 子代理消息、上下文、压缩和 sandbox 的隔离键 |
| `executionId` / `childRunId` | 一次真实执行及其 RunManager run |
| `rootRunId` | 发起这次执行的主 run，记录来源，不代表后台资源的取消所有权 |

一个 child session 可以容纳多个独立 scope。当前 `contextScopeId = subagentId`，不应把它当作 session ID。

## 启动与发送消息

主会话经 `AgentService.startSession → AgentInstance.turn → core/agents.runAgent → RunManager` 执行。子代理经 `SessionSubagentHost → AgentInstance.turn` 进入相同运行原语。

`spawn` 一律后台执行，工具先返回受理回执。Host 在创建 session、sandbox、run 等异步工作之前预占本主会话的执行名额。最多六个实际执行；满额直接返回未启动，不创建排队任务。每个实例同时只能有一个执行。工具 schema 不再暴露 `mode`，旧调用显式传 `background` 仍可接受，`foreground` 会被拒绝（D54）。

`send` 有两个结果：

- 实例空闲：在同一 scope 启动新执行，模型取当前会话的选择。
- 实例运行中：把消息写入该 child run 的 `CurrentRunInputStore`，下次模型请求读取；不打断当前工作，不创建新 execution。输入 ID 绑定调用身份，重试返回原收据。

RunManager 在 durable ledger 已标记 running 后通知输入通道就绪。输入受理与 run 封口使用同一存储事务；若结束先发生，Host 等旧执行实际收尾后才尝试新执行。旧版本的 `pendingQueue` 仅供恢复识别，不再自动 drain。

## 停止、关闭与资源回收

`stop` 中断实例当前执行并保留实例。带 `expectedExecutionId` 的停止只作用于匹配执行；迟到请求不能停掉后续执行。未成功送入模型的消息保留原文和关闭原因。

`close` 还写入不可逆的 `closedAt`，拒绝继续执行，并清理整个实例的 shell、sandbox 与缓存。`list` 不再返回该实例；模型的 `monitor` 可继续读取保存的历史。

名额只在模型调用、前台工具及必要资源清理全部确认后释放。取消超时只报告清理未确认，不能冒充物理退出；迟到退出证据可自动释放名额。自然完成、失败或超时只封口执行的 shell owner，已转后台的 shell 继续遵守十分钟上限，不占用子执行名额。显式 stop 取消当前执行的 shell，close 取消整个实例的 shell。

普通主轮次完成或 Stop 保留子执行；主 Stop 只停止主执行及其自己的工具。直接停止子执行不向上取消主会话或兄弟实例。Goal 整体终止、预算耗尽、会话销毁和服务退出另外按实际归属回收执行。

## 结果交付与监督

子执行自然终态把结果写到执行台账的 pending delivery，独立于最初的工具受理回执交付。主动 stop/close 的控制回执不触发结果唤醒。历史 foreground 记录继续只读，不能按新后台结果重新投递。

- 主会话忙碌：continuation coordinator 在下一模型请求前接收本会话 pending 结果。
- 主会话空闲：session supervisor 通过现有 `SessionExecutionGate` 和内部提交入口申请一轮，和用户输入共用执行门。
- 每个结果保留稳定的 `notificationId`，每个接收 run 使用独立 `inputId`。旧请求成员关系不可改写。
- 只有请求成功才 mark processed。失败或停止后的结果可在后续用户输入、新结果或允许的监督中重投；`wakeupAttemptedAt` 防止同一结果反复自动开启主轮次。
- 内部唤醒输入标记为 `subagent-status`，实际结果为 `subagent-result`。未发送的旧监督快照在真实结果到达时撤销。

监督从主会话 idle 起计时，首次两分钟，之后每轮结束再等五分钟；连续三次无新事实后停止定时唤醒。普通工具进度不清零计数。新执行、执行终态、结果处理和新审批是状态事实；纯审批阻塞不反复唤醒。用户 Stop 撤销旧 timer generation，真实新结果仍能唤醒。每次子执行默认及最大三十分钟实际工作预算，纯审批等待不计入。

## 只读检查

`monitor` 直接读持久实例、执行和消息，不启动模型、不订阅、不写状态、不确认结果，也不生成结果文件。一次最多六个目标，每目标最多二十条最近记录，总 JSON 输出最多 16 KiB。每目标独立游标向历史分页，单目标错误不抹掉其他目标。游标绑定主会话、实例和 requester scope，closed 历史读取不会复活实例。

## 模块所有权

| 模块 | 职责 |
| --- | --- |
| `SessionSubagentHost` | 受理、名额、实例串行、stop/close、执行预算 |
| instance / execution stores | 实例状态、执行历史、结果交付与幂等收据 |
| `execution-message-channel` | 运行中消息的持久受理、关闭记录和原文读取 |
| `continuation-coordinator` | 当前 run 的结果输入与成功请求确认 |
| `session-supervisor` | 会话空闲监督、结果发现和 timer generation |
| `ui-inprocess` | 用户、Goal、结果和监督共用的主执行准入 |
| `RunManager` | run ledger、运行和终结；不依赖 agents 的具体编排 |
| `ShellJobRegistry` | 实际执行 owner 的命令取消和物理退出证据 |

owner 恢复以明确 owner 身份和存活证据为准，不能因为发起主 run 已 completed 就判定后台执行死亡。服务退出沿现有 cleanup 协议处理未确认资源。

## Store 契约与恢复

`claim` 和 `finishRun` 不是普通 update 的别名。`claim` 原子地检查实例尚未关闭、没有其他执行 owner，再写入本次执行；`finishRun(expectedCurrentRunId)` 使用 CAS，防止旧执行在 close、恢复或后续执行之后覆盖新状态。SQLite 在同一条条件写语句中用 `RETURNING` 取结果，不能拆成 update 后再 select。实例变更订阅只在成功提交后发布，失配和失败不会发布假变更。

primary 历史仍按 `context_scope_id IS NULL` 读取。子代理按 `sessionId + contextScopeId` 读取，不能因为多个实例共享 child session 而混用历史。RunManager 的执行锁只覆盖当前 scope；一个 scope 等待取消或清理，不阻塞兄弟 scope。

runtime 重置先经过 `resetRuntime` 串行屏障并关闭新准入，再发出 `RunManager.cancelAll`，由 `SandboxManager.dispose` 等待已有 lease 的清理。关闭阶段可以在同一 deadline 内并行等待各资源，但不能把超时或销毁失败写成已确认。重置不会重播旧排队任务；旧输入保留原文及 `closedAt/closeReason`。

Goal 的显式整体停止与预算耗尽按该 Goal 实际持有的 root runs 回收后台执行；普通主 Stop 不走这条整体终止路径。Goal root 归属目前只存内存，重启时已有后台执行会被恢复为中断，因此无需依靠重启后的旧归属继续执行。耗尽 Goal 的结果不会自动冒用普通轮次绕过预算；同一会话的普通后台结果仍可独立唤醒，用户主动输入也可查看已保存的 Goal 结果。

## UI 实例读取与停止

SDK 的 `listSubagentInstances` 返回主会话全部未关闭实例的完整快照，带 `runtimeEpoch`、绑定信息和该主会话的 `revision`。同一绑定内仅接受更大 revision 的完整快照；读取失败、部分结果和旧响应都不能清空列表或复活已关闭实例。实例、执行、审批、未消费输入及清理确认变化复用现有 UI 事件通道发布失效通知。

`stopSubagent` 必须带 `expectedExecutionId`，交由 Host 原子比对，不调用主会话 abort。回执区分 accepted、confirmed、not_running 和 execution_changed。UI 详情在 close 后返回 `SUBAGENT_CLOSED` 并释放 watch/projection；未知或跨 root 的实例返回 `SUBAGENT_NOT_FOUND`，失效的客户端会话绑定返回既有 `SESSION_SCOPE_CHANGED`。释放 watch 不停止执行。主模型 monitor 的授权历史读取和 CLI 的旧 execution reader 仍保留。

HTTP 入口为 `GET /v1/sessions/:id/subagent-instances` 与 `POST /v1/sessions/:id/subagents/:subagentId/stop`；既有 conversation 路径继续负责详情、锚点和 watch。SDK 与 RPC 采用相同的方法及回执，读授权和控制授权分别检查所选主会话。
