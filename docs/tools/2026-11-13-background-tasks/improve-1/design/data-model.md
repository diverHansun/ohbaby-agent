# 数据含义与不变量

状态：待实施设计。状态模型来自 [00](../00-discussion.md) D06、D23、D24。

已纳入输出尾部持久化、实际请求消费、统一输入协调及保守恢复契约。当前仅完成后端规划，整体尚未实施；前端展示另行交付。

## Core Concepts

| 概念 | 含义 |
| --- | --- |
| shell 任务 | 一次 `bash` 调用启动的一个进程组。沿用现有 `jobId`（UUID）作为身份 |
| 模式 `mode` | `foreground`：调用方等它结束；`background`：显式后台调用立即返回 jobId。本轮模式在启动时确定，不转换 |
| 归属方 | 启动它的会话和作用域：主代理是 `(sessionId, 无 contextScopeId)`，子代理是 `(sessionId, contextScopeId)`。查询、停止、通知都按归属方判断 |
| 任务记录 | SQLite 里的一行，任务状态的唯一权威来源。内存中的 `ShellJob` 只持有进程句柄、输出缓冲和等待者 |
| 结束通知 | 后台任务结束后写入运行时输入的一条消息，来源为 `background-task-result`，和 `subagent-result` 分开 |

## Key Data Fields

新增表 `shell_job`，一次 `bash` 调用一行。

| 字段 | 含义 |
| --- | --- |
| `job_id` | 主键 |
| `session_id`、`context_scope_id` | 模型工具的精确归属；context_scope_id 为空表示主代理，子代理可共享 child session 但 scope 独立 |
| `root_session_id` | 用户会话树查询根，从可信 owner/实例关系取得；不能假设 child sessionId 等于 rootSessionId。子代理 context_scope_id 已等于实例 ID，不再存重复 subagent_id，展示时派生 |
| `pgid`、`process_start_token` | 启动时实际采集的进程组及 OS 出生身份（带平台/精度）；缺失不能用于恢复发信号 |
| `root_run_id`、`run_id`、`message_id`、`call_id` | 启动它的轮次和工具调用，用于关联起始卡片、回滚判断 |
| `mode` | 启动时确定为前台或后台；本轮不新增转换时间字段 |
| `command`、`description`、`cwd`、`shell` | 启动参数。`description` 来自 `bash` 新增的可选参数 |
| `timeout_ms` | 寿命上限。后台未传时为空，表示不限 |
| `status`、`stop_reason` | 见下文六状态模型；仅内部启动占位的 status 可空，公共快照不返回第七种状态 |
| `exit_code`、`signal`、`error` | 进程事实；`error` 是启动失败原因 |
| `pid` | 进程组组长的 pid。POSIX 上进程组号等于 pid |
| `recovery_claim` | 可空的本次恢复认领（处理后端 ID、PID、出生标识）；同一行 CAS 防止两个后端同时发信号，处理结束后清除，不新增通用租约表 |
| `owner_pid`、`owner_id`、`owner_start_token` | 后端实例 ID 与启动时采集的 OS 出生身份；随机 ID 本身不能查询一个存活 PID 属于哪个实例，恢复时必须核对原 owner 的 OS 身份 |
| `goal_id` | 可空，由可信当前执行上下文记录；只用于 Goal 唤醒归属，不改变任务 owner 或寿命 |
| `created_at`、`started_at`、`ended_at` | 预登记、实际启动、观察到进程退出的时间。预登记时 started_at 为空，硬截止从实际启动计；均不替代 OS 身份凭证，未知退出时间保持空 |
| `settled_at` | 全部进程、输出、资源责任完成且最终记录保存后的时间；可空。output_complete=false 是数据完整性，不等于仍需收尾。恢复扫描以 status/cleanup/settled_at 为依据，不把永久不完整历史反复激活 |
| `result_ready_at` | 正常收尾或有限等待后的异常结果已保存、可供结束通知读取的时间；停止请求刚收到时为空。与实际进程结束时间不同 |
| `output_path`、`output_bytes`、`output_truncated` | 日志路径、累计输出字节数（含截断后没写进文件的部分）、日志是否已写满 10MB |
| `output_tail`、`output_checkpoint_at` | 仅后台保存最多 32 KiB UTF-8 尾部及采样时刻；纯前台为空。后台合并检查点，结果发布前保存最终尾部。日志文件仍是前 10 MiB，两者不能互相冒充 |
| `output_complete` | 输出采集是否正常收尾；收尾超时或读取异常时为 false，尚在采集时可空。与日志限额导致的 `output_truncated` 分开 |
| `cleanup` | `in-progress`、`confirmed`、`unconfirmed`，只描述清理证据 |
| `tracking_released_at` | 用户明确放弃追踪的时间；不改 cleanup 为 confirmed、不证明进程已死；有值的孤儿记录不再占额度或阻塞删除，保留放弃事实供查询 |
| `notice_state`、`notice_batch_id`、`notice_payload`、`notice_input_id`、`notice_wake_run_id` | 结束通知状态、稳定批次及分配时冻结的有界正文片段、接收输入 id、自动唤醒轮次 id |

先提交启动占位，再 spawn 并补写实际进程事实；详细失败与取消路径见 dfd-interface。停止请求先保存逻辑结局、停止原因与 `cleanup: in-progress`，UI 立即显示正在停止；退出信息尚未观察到时保持未知。进程退出与输出收尾后保存已知事实、输出计数和采集完整性，再置 `result_ready_at` 并生成适用的待送通知。有限观察或收尾等待失败时，也保存一份明确标注清理未确认/输出不完整的结果并置 `result_ready_at`，不得无限等候。

晚到的退出事实、输出最终计数/完整性、清理状态及通知字段允许继续更新；不能因第一次返回 null 而冻结。运行中输出和累计字节在内存采样；只有后台任务参加合并检查点，每个 Registry 最多每秒批量保存一次变化的尾部和字节，不逐 chunk 写库。纯前台不保存尾部和周期字节检查点，只在生命周期变更时保存必要状态与最终计数。允许自动转换的前台从启动起保留有界内存尾部，转换时随 mode 一起首次持久化，之后按后台策略写入。后台最终尾部及所有任务的必要结果事实写库与 result_ready_at 同步；崩溃恢复只能报告检查点时已知字节和尾部，明确 checkpoint 时刻与采集不完整，不把下界当最终总量。管理对象只有在进程清理确认、输出关闭、最终已知事实成功持久化且资源释放完成后才从内存移除；发布逻辑终态或发出异常通知本身均不代表责任结束。

先预登记可消除“spawn 后原事务回滚而完全没有占位”的故障分支；spawn 与 PID/出生身份补写之间仍有崩溃窗口，可能留下有占位但无法定位的进程。D28 的限制仍成立，不引入系统级托管、不声称 OS spawn 与 SQLite 已原子绑定。

## 状态模型

`status`：

| status | 含义 | 终态 |
| --- | --- | --- |
| `running` | 正在运行 | 否 |
| `completed` | 自己退出，退出码 0 | 是 |
| `failed` | 自己退出但退出码非 0、被外部信号杀掉，或启动失败 | 是 |
| `timed_out` | 进程硬超时触发停止，stop_reason=timeout；是否停妥须看 cleanup | 是（逻辑结局） |
| `cancelled` | 用户、模型或生命周期策略触发停止，原因见 stop_reason；是否停妥须看 cleanup | 是（逻辑结局） |
| `lost` | 原服务退出后发现它仍为 running 或启动占位，执行/结局未知 | 是 |

`stop_reason`：timed_out 固定为 `timeout`；cancelled 使用 `user`、`model`、`owner-ended`、`output-limit`、`rewound`、`session-closed`、`shutdown`，旧记录缺失原因则为空。improve-2 转换时容量不足另记 cancelled + capacity-limit、转换内部故障记 cancelled + internal-error，属于该轮扩展。其他状态无停止原因，不凭 signal 推定是谁叫停。

内部启动占位先转 running，或在启动前取消/失败时直接形成 cancelled/failed；恢复无身份占位可转 lost。公开六状态下，running 进入某个终态，恢复时也可进入 lost。逻辑终态后不覆盖已确定的 `status`、`stop_reason`，但允许将尚未观察到的退出事实补齐，更新输出收尾、清理和通知字段。UI 将 `cancelled/timed_out + cleanup: in-progress` 显示为“正在停止”，`cleanup: unconfirmed` 显示为“清理未确认”，不能只读 status 就宣布已完全停止。

停止由谁先发起，原因就记谁。例如 `task(stop)` 已经开始终止时，即使随后又碰上会话归档，原因仍是 `model`。

## 通知判定

只有显式启动的后台任务才可能需要通知。前台任务的结果就是工具调用的返回值，`notice_state` 直接为 `suppressed`。

下表仅在 `result_ready_at` 已记录后用于结束结果投递；停止请求的即时 UI 更新不能触发“已结束”通知。无需通知的结局仍按原判定抑制。异常结果只陈述已知事实；后续补齐同一任务事实不重置自动唤醒记录。

| 结局 | notice_state 初值 | 是否允许唤醒空闲会话 |
| --- | --- | --- |
| `completed`、`failed` | `pending` | 是 |
| `timed_out` + `timeout`；`cancelled` + `user` 或 `output-limit` | `pending` | 是 |
| `cancelled` + `model`、`owner-ended`、`rewound`、`session-closed`、`shutdown` | `suppressed` | — |
| `lost` | `pending` | 否，随该会话下一轮一起带上 |

`notice_state` 的取值和变化：

| 值 | 含义 |
| --- | --- |
| `pending` | 需要通知，还没有写入运行时输入 |
| `accepted` | 已经写入运行时输入，`notice_input_id` 指向它。之后是否被请求、是否已消费，由运行时输入自己的状态说明，这里不重复记录 |
| `suppressed` | 不需要通知 |

list/output 读取不修改通知状态。工具返回不等于模型已成功处理结果；只有运行时输入的实际成功请求成员可以确认为已消费。模型主动停止的抑制仍按上表，不推导为所有读取都抑制。

`accepted` 的输入如果所在轮次结束时还没有被成功请求处理（比如那一轮失败或被 Stop），它还算没送到。之后同一归属方的任何一轮开始执行步骤时，会把它重新写入当前轮。

**自动唤醒最多一次。** 会话忙或准入未获批不消耗机会；在获准实际提交前，以持久CAS认领稳定 wakeRunId 并写入 notice_wake_run_id，再幂等提交该轮，不先提交后补标记。认领后崩溃保守视为已尝试，未消费结果留待新的合法轮次。那一轮失败或被 Stop 之后不再自动唤醒，等新的通知或用户输入开启下一轮时一起带上。这和子代理投递议题 D06 的防抖效果一致，但不照搬它的重试次数和退避时间。

**子代理作用域的任务不唤醒。** 子代理的任务只会在子代理还在执行时结束：子代理执行一结束，按 D07 它的任务就会被停掉。所以这类通知只走“注入当前轮”，不走空闲唤醒。崩溃后标为 `lost` 的子代理任务直接 `suppressed`，因为子代理那次执行本身已经被中断，主代理会通过子代理投递收到中断通知。

## 后台名额（D08）

后台占额条件为 mode=background、tracking_released_at 为空，且处于启动占位、running 或 cleanup 未确认之一。纯前台异常可阻塞自身清理流程，但不占后台额度。

显式后台按可信归属 `(session_id, context_scope_id)` 独立计数：主代理默认 10，每个子代理默认 5，不共享总计 10。统计跨轮仍活跃的所属任务，不能只按本轮计数；同一物理会话下不同子代理 scope 各有自己的额度。前台不占后台名额，已停止但进程清理未确认且用户未放弃追踪的任务仍占名额；历史记录保留数量不影响额度。启动检查与预留名额必须原子完成。

## Lifecycle and Ownership

| 事件 | 处理 | 记录结果 |
| --- | --- | --- |
| 启动 | 先提交内部占位，spawn 后更新同一行 running/PID | 未启动就取消记 cancelled；spawn 失败记 failed + error，不遗留占额 |
| 后台任务数量已满 | 显式后台启动直接报错，不启动进程、不写记录；不影响前台规则 | 后台调用返回名额不足错误 |
| 前台命令到达 timeout | 停止前台进程，模式不变，不生成后台结束通知 | `timed_out` + `timeout` |
| 用户按 Stop 结束当前轮 | 只停这一轮正在等待的前台任务，后台任务不受影响（D04） | 前台：`cancelled` + `user` |
| 当前轮因其他原因被取消或失败 | 只停这一轮正在等待的前台任务 | 前台：`cancelled` + `owner-ended` |
| 子代理正常交付、失败或被停止 | 关闭本次执行的新任务准入，停掉所属全部任务并跟踪清理；不影响主代理或兄弟子代理 | `owner-ended`（不覆盖先前停止原因） |
| 回滚 | 停掉被回滚轮次启动的任务 | `rewound` |
| 会话删除、归档 | 停掉该会话及其子代理作用域的全部任务 | `session-closed` |
| 服务正常退出 | 停掉当前后端管理的任务，不影响另一活跃后端 | `shutdown` |
| 服务启动 | 扫描旧实例启动占位、运行中及任何状态未完成清理/结果收尾的任务 | 仅原启动占位或 running 转 lost，已有终态保留 |

会话删除前先封闭准入并完成整棵会话树的进程、输出和资源清理；未确认且未被用户明确放弃追踪时，返回可诊断的忙/清理未确认结果，保留会话、记录和日志，不先级联删除恢复证据。清理确认后，任务记录随会话删除。日志文件位于会话存储目录，随会话目录删除。已结束的记录不按数量淘汰。

## 兼容性

- 前台 bash 的 executionOutcome 继续按实际状态映射：timed_out → timed-out，cancelled → cancelled，failed → error。不能把停止动作受理成功当作任务执行成功。
- 旧 tool part 的 timed_out、cancelled 保持原值，不改写持久历史；旧 cancelled 的原因未知仍为空。工具、SDK、模型投影使用同一六状态集合，新增 lost，不新增 stopped。
- 旧会话没有 `shell_job` 记录。回滚判断在找不到记录时，保留现在根据 tool part 推断的做法作为兜底，见 [02](../02-optimization-plan-and-change-scope.md)。

## 持久输出与投递不变量

生命周期状态以持久记录为准；本后端运行中的输出可来自 Registry 实时缓存，其他后端只读持久快照。后台终态来自持久尾部；纯前台不重复保存输出，必要时明确 tailAvailable=false 并提供已有日志/工具结果位置，不拿日志前缀冒充尾部。尾部检查点滞后或日志读取失败必须明示；读失败不是 0 bytes。记录的 10 MiB 日志路径只有在文件可用时提供，不伪造路径。

批次成员先在同一数据库事务中分配稳定 notice_batch_id，并保存 notice_payload（含当时完整性、尾部和确定排序），再接收运行时输入；每个批次有界，最多 20 个任务、单任务尾部最多 2 KiB，且包含标题、状态及外壳的完整正文硬上限为 32 KiB。32 KiB 优先于任务数量；装不下的整条任务保留到下一批，不能先分配后截丢。命令/说明等摘要本身有界，确保单任务总能装入一个空批次。每次 beforeStep 最多接入一个新批次，其余保持 pending。冻结正文包含采样时刻和完整性，批次外壳不使用当前时间等动态内容；跨run重投只读冻结片段，不再从可变化的output_tail重渲染。已分配批次不再追加成员或改写正文；晚到事实更新任务快照，不改已冻结通知。inputId 由批次身份和接收 runId 构成；若接收后绑定记录前崩溃，重试复用已存在输入，不重建不同内容的同 ID 消息。不要只对“当前 pending jobId 集合”临时做 hash，否则集合变化会重复投递旧任务。

accepted 只表示输入已写入，不表示模型已处理。只有成功请求的实际 inputIds 成员才能推进 processed；失败或中断后换新 run 接收，保留该结果的自动唤醒记录。工具读到结果不抑制投递。模型主动 stop 不通知仍是产品规则，与“假定返回值必已被消费”无关。

清理未确认且未被用户明确放弃追踪的记录属于仍有责任的任务。恢复扫描显式包含 status IS NULL 的启动占位、running，以及任意逻辑终态但 cleanup 未确认或 settled_at 缺失的记录；只有原启动占位或 running 转 lost，已有 timed_out/cancelled/completed/failed 不改成 lost。原 owner 已确认退出时才由当前后端重建需要的保护；活跃 foreign owner 仍自行持有责任。用户已放弃追踪的记录不再重新认领。恢复结束后不能再补齐的输出定格为 incomplete；仅在进程、输出与资源责任均已完成后才设置 settled_at，不因 output_complete=false 重复恢复、占额或通知。

恢复查询必须显式写出 status IS NULL，不能用 status != 'running' 隐含包含占位。占位恢复通知只能说“服务退出时启动登记尚未完成，命令可能已经启动，也可能尚未启动”，不能断言进程曾在运行。
