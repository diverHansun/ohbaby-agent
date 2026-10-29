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

`spawn` 默认后台执行。Host 在创建 session、sandbox、run 等异步工作之前预占本主会话的执行名额。前后台合计最多六个实际执行；满额直接返回未启动，不创建排队任务。每个实例同时只能有一个执行。

`send` 有两个结果：

- 实例空闲：在同一 scope 启动新执行，模型取当前会话的选择。
- 实例运行中：把消息写入该 child run 的 `CurrentRunInputStore`，下次模型请求读取；不打断当前工作，不改变 mode，不创建新 execution。输入 ID 绑定调用身份，重试返回原收据。

RunManager 在 durable ledger 已标记 running 后通知输入通道就绪。输入受理与 run 封口使用同一存储事务；若结束先发生，Host 等旧执行实际收尾后才尝试新执行。旧版本的 `pendingQueue` 仅供恢复识别，不再自动 drain。

## 停止、关闭与资源回收

`stop` 中断实例当前执行并保留实例。带 `expectedExecutionId` 的停止只作用于匹配执行；迟到请求不能停掉后续执行。未成功送入模型的消息保留原文和关闭原因。

`close` 还写入不可逆的 `closedAt`，拒绝继续执行，并清理整个实例的 shell、sandbox 与缓存。`list` 不再返回该实例；模型的 `monitor` 可继续读取保存的历史。

名额只在模型调用、前台工具及必要资源清理全部确认后释放。取消超时只报告清理未确认，不能冒充物理退出；迟到退出证据可自动释放名额。自然完成、失败或超时只封口执行的 shell owner，已转后台的 shell 继续遵守十分钟上限，不占用子执行名额。显式 stop 取消当前执行的 shell，close 取消整个实例的 shell。

普通主轮次完成或 Stop 保留后台子执行。主 Stop 只中断本轮前台子执行；直接停止子执行不向上取消主会话或兄弟实例。Goal 整体终止、预算耗尽、会话销毁和服务退出另外按实际归属回收执行。

## 结果交付与监督

后台自然终态把结果写到执行台账的 pending delivery。前台通过工具结果返回，主动 stop/close 的控制回执不触发后台结果唤醒。

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
