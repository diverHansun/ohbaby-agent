# 数据流与接口

## Context and Scope

输入为 Bash 参数、可信 shell 配置、调用取消、自然退出、硬截止、等待阈值和生命周期关闭事件。模型没有手动 promote 入口。

## Data Flow

先完成参数和能力验证、权限批准，再实际启动。等待阈值到达后进入同 owner 的转换临界区，检查终态/取消/硬截止，再申请额度与提交模式。成功后返回原 jobId；失败则停止当前命令并返回原因与清理事实。进程输出继续进入同一捕获路径。

## Interface Definitions

Bash 增加 wait_ms、auto_background，保留 command/description/timeout/run_in_background。完整参数组合、配置优先级和范围只在 [02](../02-optimization-plan-and-change-scope.md) 维护，避免两份定义漂移。

内部 Registry 转换结果须能区分 converted、already_finished、capacity_rejected、cancelled_before_commit、persistence_error，不能都压成布尔 false。对外仍用工具执行结果与 ShellJob 快照，不为这些内部路径增加状态枚举。

转换成功正文说明“已转后台”，包含 jobId、命令摘要、当前状态及已知硬截止；返回已有有界输出。停止路径说明停止原因和 cleanup，不能把停止请求受理称作进程已退出。task 后续读取与 UI 后端读取同一记录。

## Data Ownership

Registry 持有进程与硬计时器，Bash 持有本次等待；转换提交把持续管理责任留在 Registry。调度器只回收调用槽和调用资源；进程环境引用与未确认清理保护由原 owner 持续持有。
