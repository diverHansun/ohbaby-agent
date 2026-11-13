# 数据含义

## 核心对象

| 对象 | 本轮含义 |
| --- | --- |
| ShellJob | improve-1 的任务实体；本轮不新建 Task 表或另一份状态。 |
| job_id / jobId | 输入仍用 job_id，返回 metadata 保留 jobId，指向同一个原始 ID。必须完整非空 ID，不引入前缀匹配。 |
| action | 仅 list/output/stop；用于验证、权限、审计和历史投影，不作为任务状态。 |
| owner | 可信 sessionId + contextScopeId，不能由模型传入或覆盖。 |
| 快照 | 某时刻的真实状态、输出和回收事实，不保证下一时刻未变化。 |

## 返回事实

单任务响应沿用 improve-1 的 `running/completed/failed/timed_out/cancelled/lost`、stopReason、cleanup、退出码/信号、时间、输出捕获字节、日志位置及完整性字段。未知事实保留未知，不把 null 当 0；逻辑终态不能冒充清理成功。

启动占位不冒充公共 running 快照，列表可报告 pendingStartCount。用户已放弃追踪的孤儿保留 trackingReleasedAt 与原 cleanup；stop 不重新取得其信号权。

metadata 保留单任务 `jobId` 及已有消费者需要的事实，增加 `taskAction`。list 返回有界 `jobs` 摘要及截断信息，不伪造一个顶层 jobId，也不携带各任务完整日志。确切序列化字段与 improve-1 契约共用，避免 tool 与 UI 各自产生一套状态名。

停止响应区分 `requested` 与 `already_finished` 等操作结果，同时附当前任务快照；这是操作是否受理，不是任务一定已经结束。不得用请求成功的 `outcome: success` 替代 job 的状态和 cleanup。

## 状态与停止原因

| status | 含义 | stopReason |
| --- | --- | --- |
| running | 仍在运行 | 无 |
| completed | 自然退出且 exit code 为 0 | 无 |
| failed | 非零退出、外部信号终止或启动失败 | 无；保留 exitCode/signal/error |
| timed_out | 到达进程硬超时，被系统停止 | timeout |
| cancelled | 被用户、模型或生命周期/资源策略叫停 | user/model/owner-ended/output-limit/rewound/session-closed/shutdown；improve-2 增 capacity-limit/internal-error |
| lost | 服务恢复时发现旧 running 或启动身份未补齐的占位，执行/结局未知 | 无；未知退出事实不补造 |

旧 cancelled 没有原因时保留未知。stop 是操作，不是第七种状态。后端内部的统一停止路径可产生 timed_out 或 cancelled，但模型主动 task(stop) 通常产生 cancelled + model，不能传 status=timed_out 伪造超时。若调用时任务已经 timed_out/completed 等，幂等 stop 保留其已有结局。

六状态在数据库、共享类型、工具返回、list 筛选、通知及后端/SDK 投影中一致。list 的 status 是查询条件；output/stop 的 status 是返回事实，不是可写输入。timed_out/cancelled 是逻辑结局，仍须看 cleanup 判断进程树是否已回收。读等待超时不会把 running 改成 timed_out。

## 输出与存储边界

output 使用尾部快照，不引入隐式读游标或“读过就消失”的输出。后台正文尾部上限沿用 improve-1 的 32 KiB 契约；纯前台不持久保存尾部，异常前台的 output 明确 tailAvailable=false 并提供元数据/可用日志位置；不能用日志前缀冒充尾部。正文状态摘要说明实际捕获字节及截断情况；stdout 为零也正常返回事实和已存在的日志位置，不猜测命令自行重定向的文件。

本轮不新增 DB migration。旧 tool part 保持原名、原输入、原 ID；投影兼容不代表重新执行旧工具。
