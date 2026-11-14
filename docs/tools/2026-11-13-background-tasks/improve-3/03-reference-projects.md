# 本机参考项目与取舍

2026-11-13 只读核查。结论限于本机源码，不声称覆盖上游最新版本。调研由主代理及 task_tool_surfaces、task_pi_codex_surface 子代理完成；未运行对比基准。

| 项目 | 本机模型接口 | 借鉴与限制 |
| --- | --- | --- |
| dsh | bash + job_list/job_output/job_kill | 启动与管理分开；output 有可取消的有界等待，owner 来自上下文。它读增量，ohbaby 保留尾部快照。 |
| Kimi | Bash/Agent + TaskList/TaskOutput/TaskStop；WaitFor 单独等待且受实验旗标控制 | 不把 schema 中存在等同于所有角色都可用；它统一多种 task，ohbaby 不照搬运行时。 |
| ZCode | Bash/Agent + TaskOutput/TaskStop；用户 /tasks 不等于模型 TaskList | 读与停止权限分开；当前 TaskOutput 描述已标 deprecated，推荐文件读取和通知，不能忽略弃用说明。 |
| Pi 核心与插件 2.6.10 | 核心 bash；插件 bg_run/bg_status/bg_logs/bg_kill | 本机没有 bg_control(action)。status 合并单查/列表，logs 不阻塞，不能拿它证明统一 task 已是惯例。 |
| Codex interactive exec | exec_command + write_stdin | 同一工具根据参数承担读/等或写输入，但按副作用分流。不是 list/output/stop 任务管理器。 |
| ohbaby agent | agent(action) | 本项目已有动作校验及动态 admission，是此次统一命名最直接的结构参考。 |

## 可复核源码

- dsh：[三个管理工具及等待实现](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/jobs/tool-jobs/src/index.ts:432)。
- Kimi：[TaskList](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/task/task-list/task-list.ts:7)、[WaitFor 准入](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/task/task-wait/taskWaitTool.ts:146)。
- ZCode：[TaskOutput schema 与弃用说明](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/contracts/src/tools/task-output.ts:4)、[TaskStop](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/contracts/src/tools/task-stop.ts:4)。
- Pi 插件：[工具注册](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/extension.ts:959)、[已有终态 stop 行为](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/core/registry.ts:2648)。它会把工具 kill 原因记 user，且重复 stop 报错；ohbaby 保留 model/user 区分与幂等停止。
- Codex：[write_stdin schema](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/tools/handlers/shell_spec.rs:110)、[空输入与写输入分流](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/unified_exec/stdin_approval.rs:190)。

## 本轮取舍

保留普遍存在的“启动、管理、通知各司其职”，采用本项目 agent 的统一动作入口。统一的是工具表面，不是执行实体、归属边界或审批规则。三个动作足够表达已确认需求；没有证据支持再增加 monitor/status/wait，也不因参考项目支持 stdin 就加入发送输入。

## 2026-11-14 实施落实

本轮复核以下本机版本；只借鉴可独立成立的机制，实际实现与测试证据见 [05](05-implementation-acceptance.md)。

| 参考版本 | 本轮落实 | 不照搬的部分 |
| --- | --- | --- |
| dsh `fcc0ad4621` | 取消 output 等待与取消任务分离；task 的有界读取等待交由 Registry，调用取消不发停止信号。 | 参考实现没有进程硬截止，不能替代本项目独立的硬超时；沿用尾部快照，不改成增量消费。 |
| Kimi `bb5284cf4` | 管理能力须对实际角色可用；内置角色提供 task，自定义旧工具配置在激活时明确诊断，Bash 继续按管理能力决定后台路径。 | 不照搬转后台时重置 timeout；同一任务的显式硬截止保持不变，也不合并 ShellJob 与 agent 运行时。 |
| ZCode `b95ebaff` | 保留前轮的转换原子提交、settling 收尾与共享停止 promise；task 复用 Registry，不新建控制运行时。 | 不合并异构 task；收到停止请求不能称为已清理，必须分别报告 stopResult、任务状态与 cleanup。 |

统一入口只发布 `task(list/output/stop)`。旧名称保留历史读取和显式 deny 兼容，新调用只返回迁移错误；本轮不增加前端或迁移目录结构。
