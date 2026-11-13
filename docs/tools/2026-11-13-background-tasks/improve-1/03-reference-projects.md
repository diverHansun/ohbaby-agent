# 参考项目与采用范围

2026-11-13 由子代理只读核查本地源码，主代理汇总；本次补充主代理实读 Pi 与已安装插件的证据。路径均在 `/Users/hansun025/Projects/code-cli/` 下（pi-background-tasks 除外）。行号是调研时的快照。参考项目行为不能替代用户决定，采用范围以 00 为准。

## 1. 来源

| 项目 | 位置 | 调研范围 |
| --- | --- | --- |
| Claude Code | `claude-code/` | Bash `run_in_background`、TaskOutput/TaskStop、任务通知、`/tasks` |
| Codex | `codex/codex-rs/` | unified exec（`exec_command`、`write_stdin`）、进程存储、`/ps` |
| dsh | `deepseek-harness/` | `packages/jobs/*`、`tool-bash`、`job_output`/`job_list`/`job_kill` |
| kimi-code | `kimi-code/packages/agent-core-v2/` | Bash 后台、TaskList/TaskOutput/TaskStop/WaitFor、notify 收件箱 |
| ZCode | `ZCode/apps/zcode-cli/packages/` | 后台生命周期、task-notification、状态面板 |
| Pi | `pi/packages/coding-agent/src/`，基线 `682c7b93` | Bash 可选超时、进程跟踪、消息注入与唤醒 |
| pi-background-tasks | `/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/`，版本 `2.6.10` | 显式后台、通知、状态、用户停止、输出上限和回收；已对照 src 与 dist 入口 |

## 2. 做法与分歧

| 主题 | 做法 | 本议题 |
| --- | --- | --- |
| 后台寿命 | Claude Code、Codex、dsh、ZCode 后台不限时；kimi 默认 10 分钟、最长 24 小时、可关闭 | 采用：D01 后台默认不限，可选 timeout 最长 24 小时 |
| 失控兜底 | 不是所有项目都用输出量杀开关：ZCode 5GiB、kimi 16MiB、Pi 插件默认 20MiB 会终止；dsh 日志溢出后停止落盘，不因此杀任务 | D09、D23 是 ohbaby 自己的产品策略，不是统一标准 |
| 前台等待与后台 | dsh、kimi、ZCode 有自动转换路径；Codex interactive 的 yield 等待不等于进程寿命；Pi 核心无自动后台，插件使用显式后台入口 | 修订 D13：本轮仅显式后台，自动转换延期至 improve-2 |
| 结束通知 | Claude Code、dsh、kimi、ZCode 都推送：忙时下一步注入，空闲时开新一轮。Codex 只给客户端发事件，调研判断这是它的缺口 | 采用：D03、D16 |
| 去重 | Claude Code、ZCode 用 `notified` 标记，主动读到终态或主动停止后不再推送；dsh 对自己 kill 的、已经 wait 到的不推送（`tool-jobs/src/index.ts:413-430`） | 采用：data-model 的 `notice_state` |
| 用户停止 | 多个项目提供任务查看和单停；Codex 需区分 TUI 的停止入口与 app-server 的单命令停止 API。dsh、kimi 会向模型说明用户停止 | 采用：Web 可单停，`user` 原因要通知 |
| 进程回收 | 广泛使用进程或进程组跟踪，但信号升级、结束时机、平台支持各有差异，不能概括为同一套 TERM/KILL 保障 | 沿用并验证 ohbaby 的终止与清理确认合同 |
| 崩溃残留 | 五个都没有在重启时清理残留进程；kimi 只把仍在运行的任务标成 `lost`（`taskService.ts:50`） | D10、D26：我们多做一步，并加三项核对 |

## 3. 各项目值得借鉴的点

**dsh**
- 每个归属方最多 10 个任务，超限报错里直接告诉模型用 `job_kill`（`jobs-local/src/index.ts:34, 220-225`）。对应 D08。
- 通知里内联最多 2KB 的输出（`tool-jobs/src/index.ts:153-182`）。D17 改为总是附结尾最多 2KB。
- 用户发新消息会提前结束 `job_output` 的阻塞等待，并说明原因（`tool-jobs/src/index.ts:471-530`）。对应 D19。
- 归档会话时杀掉任务（`archive-admission.ts:33-41`）。对应 D24。
- 前台命令也登记为 job，只是调用方原地等待（`tool-bash/src/index.ts:511-525`）。对应 D15。

**kimi-code**
- 恢复时把仍在运行的任务标成 `lost`，未送达的终态通知按 `task:<id>:<status>` 去重后重新注入（`completionRestore.ts:8-43`）。对应 D20 和 `notice_state`。
- 后台启动的返回里明确写“不要等待、不要轮询”（`bashTool.ts:512-514`）。对应 D08 的提示词。

**Claude Code**
- 提示词“Do not poll”“Use background when you have genuinely independent work”（`AgentTool/prompt.ts:176-177`、`BashTool/prompt.ts:317`）。
- 子代理结束时杀掉它启动的 shell（`runAgent.ts:874-877`）。对应 D07。

**ZCode**
- 转后台是一步完成的：清前台计时器、解除本轮中止监听、改为后台登记（`node-execution-adapter-lifecycle.ts:186-219`）。这是 improve-2 的参考，本轮不实现该转换路径。
- 子代理的后台命令默认最长 1 小时。本议题不采用，改由 D07 在子代理结束时清理。

**Pi 与 pi-background-tasks**
- Pi 核心 `packages/coding-agent/src/core/tools/bash.ts:26-41` 的 timeout 可选、无默认值；到期停止，不自动转后台。后台能力来自插件的显式入口，不能把核心与插件混为一体。
- 状态只有 `running / completed / failed / killed`，谁停的另外用 `killKind` 记录（`src/core/common.ts:9-14`）。可借鉴“状态与原因分开”的思路；ohbaby 按用户最新决定保留 timed_out/cancelled 并新增 lost，不直接照搬其四态集合。
- 插件 `bg_run` 默认通知并唤醒模型（`src/extension.ts:959-1040`）；用户 `/bg` 默认通知但不自动开启模型新一轮（`:781-792`）。ohbaby 当前没有用户手动启动后台命令的入口，不为此预加参数。
- `src/core/registry.ts:3965` 的结束处理等待停止和输出关闭、保存终态元数据后再发布状态；输出文件的关闭不等于每份普通日志都执行了 fsync（`src/core/task-durable.ts:42`）。
- 默认累计输出上限 20MiB，达到后停止；最近 100 个任务是终态内存留存限制，不是活动任务并发上限。`surviveReload` 只支持特定同进程重载，不支持服务崩溃或重启续跑（README:210）。

## 4. 明确不借鉴

| 做法 | 来源 | 不采用的原因 |
| --- | --- | --- |
| 不区分前后台，统一用 `yield_time` 交还控制权 | Codex | 改动工具形态太大；ohbaby 已有 `run_in_background` 和 `task_output` |
| 增量输出游标 | Codex、dsh | D19 保持结尾快照，模型需要全文时读日志文件 |
| 子代理和 shell 统一成一种 Task | Claude Code、kimi | 00 边界：不合并，子代理已有独立的执行与投递模型 |
| 用户停止不通知模型 | Claude Code | 模型可能把它当成失败去重跑 |
| 超过数量上限时按最久未用淘汰正在运行的进程 | Codex | 静默杀进程，模型不知道；改为启动时报错 |
| Ctrl+B 把前台命令转后台 | Claude Code、kimi | 随自动转换留 improve-2 讨论，本轮不预建转换能力 |

## 5. 对 02 的约束

- 通知必须带结局、退出事实、时长和结尾输出，避免模型再调一次 `task_output`。
- improve-1 仅显式后台；自动转换的时限、取消与清理归属竞态留 improve-2，本轮 04 验证前台超时仍停止。
- 清理残留进程是参考项目都没做的部分，必须保守，核实不了就不杀。

## 6. 子代理能否启动后台 Bash：专项核查

2026-11-13 因用户质疑配额讨论的前提而补查。以下是当前本地源码的静态证据，未运行真实任务测试；不是对项目所有版本和所有配置的保证。ohbaby `f42608d4`、Codex `5228d94a`、kimi-code `bb5284cf4`；ZCode 当前 checkout 的本地 freshness 检查显示比本地 origin/main 落后 1 个提交，未为此次调研更新代码。

| 项目 | 孙子代理与后台 Shell 的实际边界 | 子代理正常交付后的进程责任 |
| --- | --- | --- |
| ohbaby 当前实现 | `SUBAGENT_DISABLED_TOOLS` 只有 `agent`；generic/explore/research 都含 bash、task_output、task_kill。Bash 没有按子代理身份禁止 `run_in_background`，仍需通过命令权限和沙箱准入 | 正常执行结束调用 `observeExecutionCleanup`，明确排除 background；所以现状允许进程活过子代理执行。D07 要求结束即回收是待实施改动 |
| Codex | V1 默认深度 1 限制协作工具，Shell/UnifiedExec 注册独立；V2 不沿用同一深度准入，不能泛称所有子代理都禁孙子。允许 Shell/UnifiedExec 时可启动持续进程 | 普通 turn 完成不清空进程池；Session shutdown 清理。V2 完成的子代理也可能被驻留回收而 shutdown |
| dsh | 默认 maxDepth=1 禁孙子；子代理默认继承父 preset，后台 Bash 能力独立，默认启用，仍受工具过滤和沙箱限制 | 子代理自然完成后会 dispose owner，取消其 jobs、等待 settled，再删除记录 |
| kimi-code | 默认 coder 无 Agent/AgentSwarm，但有 Bash 和任务管理三工具，允许后台；explore 有 Bash、无任务管理三工具，运行时拒绝后台；plan 无 Bash。自定义 profile 可另配派生权限 | 正常 final 不直接 dispose；后台 handler 会阻止 scope 驱逐。真正 close/dispose 会停止 detached handlers。提示词要求需要后台结果时等待，不能提前交付 |
| ZCode | 子 runtime 配置 `subagents.enabled=false`，但保留后台 Bash 能力；子代理后台 Bash 默认最长 1 小时，可配置 | 正常 retire 等既有后台工作结束，不一定等资源释放才返回子代理结果；取消走 close。正常返回后封存晚到通知，不能假设原子代理还会处理 |

### 代码锚点

- ohbaby：[禁用工具集合](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/constants.ts:30)、[generic 工具集](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/builtin/generic.ts:16)、[Bash 参数执行](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/bash.ts:198)、[正常完成豁免后台](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/shell-job-registry.ts:381)、[子代理清理接线](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:958)。
- Codex：[协作深度准入](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/tools/spec_plan.rs:767)、[独立 Shell 注册](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/tools/spec_plan.rs:1289)、[各 Session 新建进程管理器](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/session/session.rs:1985)、[Session 关闭终止进程](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/session/handlers.rs:315)。
- dsh：[默认派生深度](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/index.ts:185)、[子代理继承工具配置](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:187)、[后台 Bash 准入](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/shell/tool-bash/src/index.ts:498)、[自然完成进入 disposal](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:963)、[owner 回收 jobs](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/jobs/jobs-local/src/index.ts:644)。
- kimi-code：[默认角色工具集](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/session/agentLifecycle/profile/profiles.ts:45)、[后台能力检查](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:87)、[运行时拒绝无能力调用](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:433)、[后台任务阻止驱逐](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/session/subagent/subagentScopeCacheService.ts:186)、[子代理等待结果提示](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/task/taskService.ts:102)。
- ZCode：[禁孙子但保留后台配置](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts:361)、[子代理专用后台计时器](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/tool/executor/background-tasks.ts:178)、[正常 retire 与取消 close](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts:551)。

### 对本轮讨论的影响

1. 后台 Bash 是命令执行能力，不等于新建一层 LLM 代理；派生深度和后台权限应分别核查。Pi 核心没有内建 subagents（其 README:19），不能用 Pi 插件的后台支持直接推导一套统一的子代理递归策略。
2. 借鉴 Kimi 的能力闭环：允许后台前，应确保调用者能查询、读取和停止自己的任务。ohbaby 当前三个子代理角色已有相应工具；新 `task_list` 还须接入角色工具集。本条是工程建议，未据此变更角色权限。
3. 生命周期没有行业统一答案。D07 的结束即回收方向与 dsh 相近；若沿用，就应要求子代理在交付前收齐必需结果，长期服务由主代理启动，而非自动转移任务归属。
4. 不能从“子代理支持后台”直接推出根树共享 10 个名额。dsh 的默认 10 按 exact owner 统计 running/stopping job，且包含进入 job 生命周期的前台命令，并非后台 Bash 专属配额；Codex 的 64 是每 Session 进程池软淘汰阈值。这些都不等于整棵会话树共享 10。后续用户明确不要共享 10，提出每子代理 5；当前草案据此按主代理 10、每子代理 5 分开计数，见 00 D08。5 是用户提出的产品默认值，不是从参考项目复制的标准。

## 7. 用户任务视图与模型权限：专项核查

2026-11-13，在主代理 10 / 每子代理 5 的独立配额确认后，只读核查下一项视图范围。核查后用户已确认 UI 聚合范围：统一展示当前主会话和全部子代理任务，标明启动者并允许逐个停止。

- ohbaby 现有 [SubagentsPage](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/side-panel/subagents/SubagentsPage.tsx:23) 以 rootSessionId 组织实例列表和详情；关闭面板或切换会话只释放阅读订阅，不停止子代理。[SubagentInstanceDetail](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/side-panel/subagents/SubagentInstanceDetail.tsx:134) 已支持从主会话停止指定子代理执行，并显示停止中及错误。
- dsh 的 [job-controller](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/api/job-controller/src/index.ts:67) 按请求会话展示自己的及无主 jobs，不是根会话自动聚合所有子代理任务。用户可在所属会话停止单个 job，原因记录为用户停止并通知所属代理；UI 读取不消费模型的通知和输出游标。
- Kimi 的 [Session.listBackgroundTasks](/Users/hansun025/Projects/code-cli/kimi-code/packages/node-sdk/src/session.ts:493) 明确针对当前会话的 interactive agent；[tasks-browser](/Users/hansun025/Projects/code-cli/kimi-code/apps/kimi-code/src/tui/controllers/tasks-browser.ts:319) 提供单任务停止，传入 `User initiated stop`。这能证明列表和单停能力，不能证明它聚合了子代理内部所有 Bash。

对 ohbaby 的建议：复用现有主会话侧栏，在独立 Background tasks 页聚合本会话主代理及子代理的后台 Shell，明确显示归属，允许用户单停；模型工具仍沿用 D18 的各自归属边界。用户单停子代理的一个 Bash 不等于停止整个子代理，停止结果通知任务所属代理。该聚合选择基于 ohbaby 已有 Subagents 交互和用户控制需求，不称为参考项目的统一做法；该范围随后已获用户确认。

## 8. 停止反馈与结束通知的时机：专项核查

2026-11-13，只读核查状态准确性的承重路径，未运行行为测试。

- ohbaby 的 [terminate](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/shell-job-registry.ts:719) 在启动终止后立即调用 `finish`，可能返回尚为空的退出码和信号；[confirmStopped](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/shell-job-registry.ts:670) 才确认清理、释放资源并处理输出收尾。因此设计不能把首次逻辑终态当作全部事实已经到齐，也不能据此立即遗忘清理对象。
- Pi 插件 [finalizeTask](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/core/registry.ts:3965) 等终止观察、关闭输出、写结束元数据后才发布状态和通知；这些步骤也可能失败，代码将失败信息带入结果，不保证所有正常日志均执行 fsync。
- dsh 的 [killJob](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/jobs/jobs-local/src/index.ts:484) 先发布 `stopping`；[settle](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/jobs/jobs-local/src/index.ts:603) 保存结局、整理输出并释放等待者后发布 settled。可借鉴两种反馈的区分，不必复制第六个公共状态。

用户已确认区分操作反馈和结束结果，见 00 D27：用户操作立即反馈“正在停止”；正常结束通知在退出事实和已捕获输出收尾并保存后发送。终止观察和输出收尾都有有限等待，失败时报告已知事实及清理/输出异常，保留责任与适用名额；不得无限等待或将未知退出码/信号伪造为已知。晚到事实可补齐持久记录与 UI，不因此重新触发同一任务的自动唤醒。是否通知仍遵守既有归属和抑制规则；这些要求已同步正式设计，尚未实施。

## 9. 主代理优先与按需筛选

用户补充：后台任务面板重点关注主代理启动的任务，提供友好的按需筛选；子代理被停止时，应停止其管理的后台任务。

只读参照：[Kimi TasksFilter](/Users/hansun025/Projects/code-cli/kimi-code/apps/kimi-code/src/tui/components/dialogs/tasks-browser.ts:39) 提供 all/active，过滤掉前台任务；[Pi 任务管理器](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/ui/background-tasks-manager.ts:400) 可切换是否包含已结束任务；[ohbaby 实例列表](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/side-panel/subagents/SubagentInstanceList.tsx:59) 已有折叠分组。可复用状态筛选和折叠的交互，不把整个资源监视器的采样体系引入首版。

候选交互：默认主代理 + 进行中；可改看全部启动者、全部子代理或指定子代理，叠加状态和名称/命令搜索。顶部保留简短的运行与异常计数，避免筛选隐藏清理异常；列表展示名称、启动者、状态、时长和停止入口，完整命令及详细输出放在展开详情。具体默认值待用户确认。

子代理取消的现状：[composition.cleanupExecution](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:958) 在 closed/interrupted/cancelled 路径清理所属 root run；正常完成仍豁免后台。D07 的改动是统一正常交付、失败和被停止的回收合同，并关闭该作用域本次执行的新任务准入（不永久禁用后续followup），不能只依赖旧的取消分支。主代理当前轮 Stop 仍沿用 D04，不连带终止其显式后台。

## 10. 规划收尾时补核的边界

以下为对本机源码的补充核查与本项目取舍，不是参考项目的统一规范。

- [Pi插件 captureSpawnedChild](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/core/registry.ts:1325) 从spawn直接捕获进程组信号权；[收尾路径](/Users/hansun025/.pi/agent/npm/node_modules/pi-background-tasks/src/core/registry.ts:3195) 单向释放旧信号权。借鉴不可重新凭旧PID取得权限，不照搬成跨重启所有权证明。
- [Kimi detach](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:279) 转后台时重新armTimeout。ohbaby采用已确认的独立硬截止，不重置timeout。
- 本仓 [terminal/process-tree](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-server/src/terminal/process-tree.ts:16) 使用秒级lstart及tty/sid，sameProcess比较PID和时间字符串；它不是已经存在的强出生身份/PGID核验组件。不能把精确匹配秒级字符串或允许两秒容差写成恢复安全保证。
- [现有子代理投影](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-instances.ts:28) 使用runtimeEpoch/revision失效通知和重新查询。后台任务后端沿用这一模式，避免维护第二份由事件拼出来的任务事实；不在本轮实现界面。
- SideChat关闭保留后台能力，改成清理确认后再删记录和日志；Goal不等待所有活跃ShellJob，防止长期服务阻塞推进。两项均由本仓已有生命周期/驱动行为推导，不扩大产品范围。

## 11. macOS 与多后端边界补核

2026-11-13，只读探测本机 arm64 的 proc_pidinfo：自己启动的短命进程连续两次返回相同秒/微秒出生时间，退出后返回 ESRCH。方式复用本仓 [macos-session.ts](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-server/src/terminal/macos-session.ts) 的 JXA 系统函数桥接；结构见本机 SDK [proc_info.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/sys/proc_info.h:59)，API 见 [libproc.h](/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/libproc.h:96)。这证明能力可用，不是后台恢复实现或跨架构验收；不需要新增原生 npm 依赖，也不采用秒级 ps、多重猜测授权。

本仓 [rewind-shell.ts](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/services/session/rewind-shell.ts:6) 已拒绝清理其他活跃后端的后台任务，本轮沿用该边界。任务的代理 owner 与进程 owner 分开；两个后端可共享数据库但各自保有句柄。

[workspace-move.ts](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/services/session/workspace-move.ts:46) 当前没有运行忙检查，本轮不添加“存在后台任务就禁止移动”。移动不改变已启动任务的 cwd 和归属。
