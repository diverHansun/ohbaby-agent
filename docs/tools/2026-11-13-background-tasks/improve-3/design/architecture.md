# 架构

## Architecture Overview

模型 → task 参数校验 → 调度/权限 → ShellJobRegistry → 持久记录、日志、进程控制。

`bash` 仍调用相同 Registry 启动进程；结束通知仍走 improve-1 的可靠输入与唤醒链路。task 只适配管理操作，不直接写数据库或发进程信号。

## Design Pattern & Rationale

使用现有 `agent` 工具采用的动作分派方式。每个 action 有独立字段白名单和 handler，复用 Registry 的 list/output/stop 能力。只有三个动作，不建立通用插件式 action 注册框架。

工具名统一不等于事务或权限统一。list/output 为 readonly；stop 沿用当前任务控制的 `subagent-control` 调度分类及其权限映射，不意味着它在管理子代理。所有动作使用可信内置工具的 control admission，不消耗普通 Shell 执行额度；长等待仍可取消且有时间上限。工具沿用 `timeoutOwner: "tool"`，由已校验的 wait_ms 管读等待，避免外层默认工具超时提前截断；进程硬超时仍由 Registry 独立执行。不得只凭字符串 `task` 给外部同名工具 control 特权。

## Module Structure & File Layout

- `tools/task.ts`：统一入口的薄适配文件，负责 schema、动作校验、文本/metadata 组装及 admission；不引入第二份 Registry。
- `tools/shell-job-registry.ts`：保留任务事实、等待、停止和归属检查；列表/持久查询由 improve-1 提供。
- `tools/builtin.ts`、内置角色、提示词：只发布一个管理工具。
- permission、上下文投影、rewind：只补 task 动作识别和兼容，不重构整套授权或会话系统。

## Architectural Constraints & Trade-offs

- owner 只从可信上下文取得；输入不接受 session、owner、agent ID 或任意 PID。
- 整个工具不能标注 `readOnlyHint: true`。schema 和运行时均校验；拒绝不认识的动作及动作无关字段。
- output 等待取消只释放读等待器；stop 才进入统一进程清理路径。并发读取、停止和结束需依赖 Registry 的幂等终止与快照边界。
- 读输出不等于模型已消费通知；task 不修改 notice_state，仍由 improve-1 的通知链路确认消费，不能以读调用作替代。
- `task` 是名称与适配层，ShellJob 是唯一事实来源。保留 ID、日志和消息，不批量改写旧历史。
- use-case/non-functional 不另建文件：本轮是三种单步管理动作；编排、资源边界和兼容约束在本文件、接口与测试文档中覆盖。
