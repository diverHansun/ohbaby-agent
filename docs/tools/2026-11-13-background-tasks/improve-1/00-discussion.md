# 讨论记录与已确认要点

范围衔接：用户已确认并开启 [improve-3 工具收拢](../improve-3/00-discussion.md)。本轮下文保留讨论时的 task_list/task_output/task_kill 名称；采用 improve-3 后分别由 task 的 list/output/stop 承接，不改变此处已确认的生命周期规则。前端实现仍暂缓。

2026-11-13 与用户讨论，逐项更新。这里只记录用户已经确认的结论，推理和证据放在 01 和 03。

## 1. 背景

用户在会话“查后台长期任务支持”里实测后台 Bash，发现了下面几个问题。

- 后台任务最长只能跑 10 分钟。不传 timeout 时，默认 2 分钟就会被杀。
- 后台任务结束、失败或超时，主代理都收不到通知，只能自己调 `task_output` 去查。
- Web 上看不出哪个 Bash 调用启动了后台任务，用户也没有办法列出或停止后台任务。
- 已经结束的任务，主代理读到的信息不够自解释，容易误读。

用户要求先读本地的 Codex、dsh（deepseek-harness）、kimi-code、ZCode，再逐项讨论方案。Claude Code 也一起作了参考。

### 本次范围确认（2026-11-13）

用户选择：

> 先完成显式后台的不限时、准确状态、结束通知、用户单停和可靠回收；自动转换后续单独做。，可分配完成，转后台留到improve-2

随后明确当前会话范围：

> 先定文档范围，继续逐项讨论

据此修订 D02、D05、D13、D15、D21。当前只同步文档，不实施代码；当时提出的“根会话树共享 10 个名额”未获确认，随后按下文用户反馈放弃。

用户随后要求：

> 子代理不能派遣孙子代理，那么子代理能派遣bash后台任务吗？看看code-cli/下的优秀项目是如何定的？以后你每次问我问题时都先去调查，这样问出来的问题也比较符合实际情况

后续每个产品问题先核查 ohbaby 与参考项目的实际权限、运行时准入和生命周期，再提供建议。此次只读核查见 [03 §6](03-reference-projects.md#6-子代理能否启动后台-bash专项核查)；禁止孙子代理不等于禁止后台 Bash，不能跳过这个能力边界就让用户决定共享配额。

### 子代理能力与独立配额（2026-11-13）

用户明确保留子代理启动后台 Bash 的能力，为主、子代理补齐管理工具；子代理任务归启动者负责，本次执行结束时回收；子代理交付前收齐必需结果，需要继续运行的服务由主代理启动。用户提出每个子代理最多 5 个正在运行的后台任务，并明确不要共享 10 个。

核查当前代码：主、子代理均没有活动后台任务的数量准入上限；`MAX_RETAINED_SHELL_JOBS = 100` 用于结束记录的内存淘汰，不是运行额度。原 D08 的 10 是尚未实施的规划值。此次方案采用子代理 5 个、主代理 10 个，分别配置、独立计算；用户随后明确回复“确认！继续讨论！”。D08 的数值和独立计数规则已确认，尚未实施；这些是产品默认值，不是参考项目的统一标准。

## 2. 已确认规则

| 编号 | 结论 |
| --- | --- |
| D01 | 前台和后台分开设时限。前台保持默认 2 分钟、上限 10 分钟。后台默认不设寿命上限；模型可以显式传 timeout，上限 24 小时。 |
| D02 | 能看出启动后台任务的那次工具调用。Web 在右侧侧栏做 Background tasks，交互上和 Subagents 一致。查看状态和用户停止单个任务的最小闭环纳入 improve-1。面板覆盖当前主会话及其所有子代理的后台任务，标明启动者，允许用户逐个停止；不混入其他独立主会话。用户补充：重点关注主代理启动的任务，提供按需筛选，借鉴资源监视器的信息组织但保持友好；具体默认筛选见 §5。 |
| D03 | 后台任务结束时通知主代理，使用独立的通知来源，不和 `subagent-result` 混用。可以复用底层“注入当前轮或空闲时唤醒”的能力，具体复用到哪一层由 01 核实。 |
| D04 | 主代理 Stop 不杀后台任务。 |
| D05 | 用户最新调整分工：“前端部分你先不做，你只负责后端实施即可”。当前代理负责后端管理能力、供前端查询/读取输出/单停的接口和状态事件；Web 设计与实施暂缓，已确认的用户侧需求保留，后端交付不宣称完整 UI 已交付。TUI 仍留后续议题。用户同时要求接下来讨论 improve-2，因此当前步骤继续设计讨论，尚未开始代码实施。 |
| D06 | 状态按用户最新纠正采用六种：running/completed/failed/timed_out/cancelled/lost，详见 §3；保留 timed_out 和 cancelled，不再采用合并为 stopped 的旧草案。stop 是操作，stopReason 说明原因；旧会话状态原样兼容。 |
| D07 | 保留子代理启动后台 Bash 的能力，任务归启动它的子代理负责。子代理本次执行无论正常交付、失败还是被用户/主代理停止，都回收所属后台任务，停止原因记为 `owner-ended`；交付前须收齐必需的后台结果，需要在交付后继续运行的服务由主代理启动，不自动移交任务归属。停止整个子代理与单停一个 Bash 不同：前者级联清理其任务，后者仅影响目标 Bash、原因记为 `user`；已先确定的停止原因不覆盖。 |
| D08 | 按启动者独立限制显式后台任务：主代理默认 10 个；每个子代理默认 5 个，均可配置，用户已确认。不共享根会话树的 10 个名额，也不把所有子代理合并成一份 5 个额度。按可信归属 `(sessionId, contextScopeId)` 计数，运行中及停止后尚未确认进程清理的任务占名额；超限拒绝启动并说明额度与处理方式，不淘汰旧任务。提示词同时提醒主、子代理不要把工作切得太碎。 |
| D09 | 输出超过日志上限时不杀任务，只在状态里标出“输出已截断”。 |
| D10 | 服务崩溃留下的残留进程本轮一起处理：重启后把仍记为 `running` 的任务标成 `lost`，并清理残留的进程组。清理前必须确认进程组仍属于原任务，防止 pid 被复用后误杀别的进程。 |
| D11 | `bash` 增加一个可选的 `description` 参数，用作侧栏和通知里的标题。 |
| D12 | 文档放在关键模块 `docs/tools/` 下，并链接到相关模块。02 只写简要的关键改动清单。 |
| D13 | improve-1 只支持显式 `run_in_background: true` 启动后台任务；前台到达 timeout 仍停止，不自动转换，不引入 `sleep` 特判。自动转后台移至 improve-2，用户手动转换入口随该议题再讨论。 |
| D14 | 安全删除调度层里不起作用的子代理派发上限：`maxSubagentConcurrency: 3` 和 `dispatch` 名额类别。生产代码里没有工具声明 `capacity: "dispatch"`，模型实际只受 6 个子代理执行名额限制。相关测试和 `docs/core/tool-scheduler/data-model.md` 同步修改。 |
| D15 | 所有 shell 任务（前台和后台）都写持久记录，记录里标明启动时的模式，供查询和崩溃后清理残留进程使用。本轮模式不变，侧栏只显示显式启动的后台任务。 |
| D16 | 通知送达：主代理忙时，在它下一次模型请求前注入；空闲时唤醒一轮。差不多同时结束的多个任务合并成一次送达。防抖沿用子代理投递议题的 D06：被通知唤醒的那一轮失败或被 Stop 后不立即再唤醒，等新的通知或用户输入时把未处理的通知一起带上。不另设连续唤醒上限。 |
| D17 | 通知内容：每个任务一段，包含说明（没有 description 时用命令摘要）、jobId、状态和停止原因、exit code 或 signal、运行时长、输出字节数、日志路径，以及最后最多 2KB 的输出。 |
| D18 | 为主、子代理都提供 `task_list`、`task_output`、`task_kill`；新增 `task_list` 时同时补齐允许后台 Bash 的角色工具集。每个代理只管理自己启动的任务，默认列出运行中的任务和最近结束的若干个。后台启动能力与查询、读取、停止能力保持完整。 |
| D19 | `task_output` 仍然返回输出结尾的快照，不做增量游标。每次返回都在开头加一行状态：状态和停止原因、时长、exit、捕获字节数、日志路径。`block` 等待保留，用户发来新消息时提前结束等待，并说明是被用户消息打断的。 |
| D20 | 服务崩溃后标为 `lost` 的任务，重启时不主动唤醒会话，等这个会话下一次开始新的一轮时，把通知一起带上。 |
| D21 | 原“转换后取消前台 timeout”规则随 D13 延期，本轮不生效，也不作为 improve-2 的默认结论。improve-2 再讨论等待阈值与进程硬超时的独立语义。 |
| D22 | 任务记录和日志文件随会话一起删除。已结束的记录在数据库里不按数量淘汰；内存保留运行中及尚有输出收尾、进程清理或资源释放责任的任务。只有清理确认、输出收尾完成且保留资源释放成功后才释放内存管理对象；未确认不能视作完成。历史结果从数据库读取。 |
| D23 | 增加输出量兜底。日志写满 10MB 时仍按 D09 只截断、不杀；同时持续统计输出字节数，累计达到 1GB 时杀掉任务，停止原因记为 `output-limit`，并通知模型。 |
| D24 | 归档会话时也杀掉它的后台任务。停止原因 `session-removed` 改为 `session-closed`，同时覆盖删除和归档；回滚杀掉被回滚轮次启动的任务时，停止原因记为 `rewound`。 |
| D25 | 本轮不做跨服务重启存活：服务正常退出时任务按 `shutdown` 结束。后台任务提示词补一句：任务会随服务停止而结束，必须跨重启存活的工作要先告诉用户。 |
| D26 | D10 清理残留进程组前，必须同时确认三件事：记录里的所属服务进程已经不在；这个进程组仍然存在；组长进程的启动时间和记录一致。任何一条无法核实就不杀，只标 `lost`，并在通知里写明可能残留的 pid，交给用户处理。 |
| D27 | 用户确认区分“操作反馈”和“结束结果”：收到停止请求立即反馈正在停止；正常结束结果在退出事实及已捕获输出收尾、保存后发布。终止观察与输出收尾均有限等待；无法确认时明确报告已知事实、清理未确认及输出不完整，不能无限等待或伪装成功。晚到事实可以补齐记录/UI，不重新触发同一任务的自动唤醒；是否通知与通知对象仍遵守 D16–D20，不复活已结束子代理。 |
| D28 | 2026-11-13 用户确认本轮先完成已登记任务的可靠回收，身份无法核验时不误杀；明确保留 spawn 与登记之间被强杀可能留下未登记进程的极端窗口，不扩大到系统级进程托管。不得把这个有限保证描述成任意崩溃下绝无残留。 |

### 复审后补充确认（2026-11-13）

用户已确认以下两项：

| 编号 | 结论 |
| --- | --- |
| D29 | 清理未确认任务按需复查：查列表、申请名额、停止、删除或归档前，确认托管进程组已消失就更新清理事实并释放名额，不要求用户重启服务。仍无法核实时，提供仅用户可调用的“放弃追踪”后端接口；它不杀进程、不伪装清理成功，模型无权调用。具体适用范围见 design。 |
| D30 | 独立 TUI 和 Web 后端共享数据库但不共享句柄。原管理后端仍活跃时，其他后端可以查询及读取已保存输出；停止或需要清理该任务的删除/归档操作，明确提示回到原后端操作。本轮不增加跨进程控制转发。原后端已确认退出时，按保守恢复合同处理。 |

工程修订：先提交同一任务表中的启动占位，再 spawn 并补写进程身份；保留 D28 的“启动与完整身份登记之间可能崩溃”边界。macOS 复用现有 JXA 桥接模式读取内核出生时间，不放宽为秒级 ps 猜测。前台仅持久保存必要元数据，后台才保存尾部检查点。预登记尚未启动时只有内部占位，恢复时同样用 lost 表示启动/结局未知，不新增第七种公开状态或第二套任务运行时。

## 3. 状态模型（D06）

任务的信息分成五个互不干扰的维度。

| 维度 | 回答的问题 | 取值 |
| --- | --- | --- |
| `status` | 任务现在怎样了 | 见下表 |
| `stopReason` | 如果被停掉，是谁、为什么停的 | `timed_out` 对应 timeout；`cancelled` 对应其他停止原因；旧记录缺原因时保留未知 |
| 进程事实 | 进程本身是怎么退出的 | `exitCode`、`signal`、`error`（启动失败的原因） |
| `cleanup` | 进程树确实已经没了吗 | `in-progress`、`confirmed`、`unconfirmed`（沿用现有含义） |
| 通知状态 | 主代理知道了吗 | 见 [design/data-model](design/data-model.md) |

`status` 的取值：

| status | 含义 |
| --- | --- |
| `running` | 正在运行 |
| `completed` | 自己退出，退出码为 0 |
| `failed` | 自己退出但退出码不为 0，或者被外部信号杀掉，或者没有启动成功 |
| `timed_out` | 到达进程硬超时，被系统停止；原因 timeout |
| `cancelled` | 被用户、模型或生命周期策略叫停，原因见 stopReason |
| `lost` | 原服务退出后发现旧 running 或启动身份未补齐的内部占位，执行/结局未知 |

`stopReason` 的取值，以及要不要通知主代理：

| stopReason | 谁停的 | 是否通知主代理 |
| --- | --- | --- |
| `timeout` | 到了模型给的 timeout | 通知 |
| `user` | 用户在界面上停止 | 通知，写明是用户停止的 |
| `model` | 主代理或子代理调用了 `task_kill` | 不通知，属于模型主动停止的既定策略；不把工具返回等同于成功请求已消费 |
| `owner-ended` | 启动它的子代理已经结束（D07） | 不通知 |
| `output-limit` | 输出累计达到 1GB（D23） | 通知 |
| `rewound` | 启动它的轮次被回滚（D24） | 不通知 |
| `session-closed` | 会话被删除或归档（D24） | 不通知 |
| `shutdown` | 服务正常退出（D25） | 不通知 |

`completed` 和 `failed` 都通知。主代理的 `lost` 随恢复后的下一轮输入通知；不在重启时主动唤醒，说明上次服务异常退出、结果未知。工具读取终态不抑制通知；只有运行时输入实际进入成功的模型请求后才确认消费。

兼容要求：保留现有 `timed_out` 和 `cancelled`，不将它们折叠成 stopped；旧 cancelled 缺少停止原因时保留未知，不臆测为 user。新增 lost 表示结果未知。2026-11-13 用户在 improve-3 讨论中再次提供六状态表并明确要求状态在接口中体现，本节与后续设计、测试据此同步修订。stop 是操作名称，不是第七种 status。

## 4. 后台任务提示词（D08）

参考项目的共同做法是：只把真正独立的工作并行起来；关键路径上的事自己做；等完成通知，不轮询、不 sleep；给出最终回答前收齐需要的结果，停掉没用的任务；碰到上限时，报错里要说清楚该怎么做。

主代理 `base.md` 新增 Background jobs 一节，以下面的最终工具名文案为基础，在 02 里定稿；子代理提示词同时补充下面的专用规则，不能照搬主代理“结束这一轮后等待唤醒”的建议：

> - Use `run_in_background` only for long-running commands whose result you do not need right away, such as dev servers, long builds or test suites. Run short commands in the foreground.
> - Start one job per genuinely independent long task. Do not split one piece of work into many jobs, and do not default to filling the job limit.
> - You are notified when a job ends. Do not repeatedly poll `task(action="output")` or sleep to wait; continue other work, or give a brief progress response and end this turn.
> - Before claiming the task complete, make sure each job you started has ended, or say which ones you are intentionally leaving running and why.
> - Jobs end when the ohbaby service stops. If work must survive a service restart, tell the user first.

子代理专用规则：

> - Background jobs belong to you and are stopped when this execution ends. Before your final handoff, collect every background result needed for your assignment. Use bounded `task(action="output", block=true)` waits and completion inputs while continuing other useful work; do not use sleep polling.
> - If a service must continue after your handoff, ask the primary agent to start and own it. Your jobs are not automatically transferred.
> - Your background-job quota is independent of the primary agent and sibling agents. The default is 5; stop unneeded jobs or await completion before starting more.

超过上限时返回的报错：

> Background job limit reached for this owner: {active}/{limit} jobs are running or awaiting confirmed cleanup. Stop an unneeded job with `task(action="stop")`, or wait for a slot to be released. Do not retry immediately.

`limit` 按实际配置填写，主代理默认 10、子代理默认 5。已发停止请求不代表名额立即释放；正常退出或停止后的进程清理确认才释放名额。启动前的名额检查与占用须保持原子性，避免并行调用同时通过。

## 5. 收尾边界

| 问题 | 当前建议 |
| --- | --- |
| 后台任务筛选的默认视图 | 前端暂缓。主代理优先和可筛选已确认；“主代理 + 状态分组”是最新候选，未定稿，不阻塞当前后端交付 |

模型权限沿用已确认的 D18，各代理只管理自己的任务。本轮不另增父代理跨子代理只读权限，不因用户面板聚合而扩大模型权限。

退出事实补齐及清理、输出、资源释放完成前保留责任，已按 D22/D27 同步设计。本次规划收尾将这些约束落入 design/02/04：持久32KiB尾部；各来源汇总后统一关闭；读取不抑制通知；恢复覆盖终态但未确认清理；全树归属索引；会话删除前确认回收。尚未实施，不把文档修订视为代码完成。

## 6. 边界

| 项 | 处理 |
| --- | --- |
| Web 起始卡片、Background tasks 侧栏、单任务停止 | 用户需求保留，前端暂缓；当前代理交付后端接口及事件，按 D05 区分后端与完整 UI 完成状态 |
| 前台自动转后台、用户手动转换 | improve-2，本轮不预建转换接口或字段 |
| TUI 显示 | TUI 议题，参考 pi 和 pi-background-tasks |
| 后台任务和子代理合并成同一种 Task | 不做，两者各自保留 |
| 子代理的结果投递 | 不改，沿用 [子代理投递议题](../../../agents/2026-11-12-subagent-delivery/README.md) |
| 任务跨服务重启存活 | 不做（D25）。真要做需要交给 tmux 或 launchd 托管，另开议题 |
| 所有会话合计的后台任务上限 | 不做。主代理与各子代理按归属分别计数（D08），合计不设上限，作为已知限制写进 02 |

## 7. 与已有决定的关系

- improve-1 保持执行可靠性第二轮“不新增……自动后台化命令”的边界；本议题旧 D13 的转换方案延期至 improve-2。
- 修订 [执行可靠性第二轮 D14](../../../problem-lists/2026-09-19-execution-reliability/improve-2/00-discussion.md)：当时“Bash 默认 2 分钟、最大 10 分钟”同时约束前台和后台，现在只约束前台，后台改由 D01 规定。
- 第二轮决定当时不新增任务面板（见第二轮 02 §2.5）。这次用户明确要用户单停，最小 Web 闭环纳入 improve-1。
- 主代理 Stop 不杀后台任务（D04），和子代理投递议题的 D05“主代理 Stop 不停止后台子代理”保持一致。
