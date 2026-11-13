# 自动转换参考项目

2026-11-13 本机源码核查，结论不代表所有上游版本。已确认的产品选择优先，参考实现用于检查边界。

| 项目 | 事实 | 取舍 |
| --- | --- | --- |
| ZCode | commitBackground 在同一提交段改状态、清前台计时、移除 externalAbort、登记后台任务 | 借鉴提交点；本项目独立硬超时不能在这里清除。 |
| dsh | 可自动后台的命令在启动前注册 job 并占额，注册失败回退普通前台路径 | 本项目前台不预占后台额度，不能照搬满额分支。 |
| Kimi | Bash.allowBackground 检查 TaskList/TaskOutput/TaskStop，超时路径可 detach | 借鉴完整管理能力准入；其前后台超时规则不同，不套用默认值。 |
| Codex | exec_command 等待与持续进程分开，write_stdin 可读取/等待；池满可能淘汰旧进程 | 借鉴等待与进程分离；不采用淘汰旧任务或临时超额。 |
| Pi 插件 | bg_run 显式派发，status/logs/kill 管理，logs 本身不阻塞 | 可借鉴归属和停止责任，但不是本轮自动转换策略的直接依据。 |

源码：[ZCode 提交](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-lifecycle.ts:209)、[dsh 注册](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/shell/tool-bash/src/index.ts:511)、[Kimi 准入](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:87)、[Codex 进程管理](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/unified_exec/process_manager.rs)、[Pi 插件](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/extension.ts:959)。

默认 120 秒、满额停止当前命令、独立配额均是用户选择，不伪装成参考项目的一致结论。
