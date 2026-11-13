# 数据模型

复用 improve-1 的 ShellJob。status 仍为六态，mode 与 status 正交：正在运行的任务可以是前台或后台；转后台不是新状态。

| 字段 | 含义 |
| --- | --- |
| started_at | 原命令启动时间，转换不改。 |
| timeout_ms / deadline | 显式或纯前台默认硬寿命；deadline 从 started_at 推导，转换不重置。 |
| foreground wait deadline | 本次调用等待截止，仅运行中需要，不是进程硬截止。 |
| mode | 当前 foreground/background，转换提交后变更。 |
| promoted_at | 仅自动转换成功时写入；显式后台无需伪造转换时间。 |
| owner / root_run_id | 原归属和原始启动轮次，转换不转移。 |
| capacity-limit / internal-error | 转换满额/转换持久化故障时 cancelled 的停止原因；错误细节另行报告，不伪装 timed_out。 |

不新增公共 promoting 状态；未提交的转换不是可见后台事实。逻辑终态不能反向变回 running，晚到 callback 只补退出/输出/清理事实。记录失败不能伪装成成功，也不能通过重启命令重试转换。
