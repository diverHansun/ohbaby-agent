# 3. 参考项目与取舍

> 调查期间：2026-10-26 至 2026-10-28。下列是本地源码快照，不代表所有线上客户端和后续版本。
> 采用结论以 [00](00-discussion.md) 和 [02](02-optimization-plan-and-change-scope.md) 为准。这里区分实际实现、用户观察和 ohbaby 自己的选择。

## 3.1 核查版本

| 项目 | 本地位置 | HEAD |
| --- | --- | --- |
| DeepSeek Harness（DSH） | `/Users/hansun025/Projects/code-cli/deepseek-harness` | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| Codex 开源核心 | `/Users/hansun025/Projects/code-cli/codex` | `9a8a85bc539325f2819dd0717f88b6ba6286495e` |
| Kimi Code | `/Users/hansun025/Projects/code-cli/kimi-code` | `759958afdfeb0f8c7d09cb03cbc2cf85b6255e9e` |
| ZCode | `/Users/hansun025/Projects/code-cli/ZCode` | `3c5b227649371507ddc4eb46ac5133afe6db1cab` |
| OpenCode | `/Users/hansun025/Projects/code-cli/opencode` | `62c9002819d06dd48b673a1f84e94ce3e51e50e0` |

## 3.2 生命周期、消息与结果交付

| 参考事实 | 源码 | ohbaby 采用方式 |
| --- | --- | --- |
| DSH 完成后的通知查找仍注册的原父代理对象，idle 用 queue、忙碌用 steer；调用方直接等结果的路径不重复通知 | [manager.ts:1187](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:1187) | 采用忙闲分流和直接结果/后台通知分开；接到 ohbaby 已有主会话执行门，不照搬 DSH 代理运行时 |
| DSH SendMessage 是发消息，不是等最终回答；运行中消息可进入后续模型步骤 | [控制工具](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/tool-subagent-control/src/index.ts:29)、[manager.ts:543](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:543) | 对应 agent send：运行中投递，空闲可启动；不延用 ohbaby 原 execution FIFO |
| OpenCode 同一子代理工具用 sessionID 复用，background 控制是否等结果；后台 job completion 送回 parentSessionID | [subagent.ts:200](/Users/hansun025/Projects/code-cli/opencode/packages/core/src/tool/plugin/subagent.ts:200)、[subagent-job.ts:30](/Users/hansun025/Projects/code-cli/opencode/packages/core/src/session/subagent-job.ts:30)、[subagent-completion.ts:37](/Users/hansun025/Projects/code-cli/opencode/packages/core/src/session/subagent-completion.ts:37) | 采用会话归属、前后台同一套执行能力、事件驱动交付；ohbaby 默认后台是用户选择，不能说完全照搬它的默认值 |
| Kimi 的后台终态通知是非 turn scoped，可让空闲主代理进入 active | [taskService.ts:1085](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/task/taskService.ts:1085) | 采用后台通知不绑最初 turn 的思路；请求消费与恢复沿用 ohbaby 的持久机制 |
| ZCode 子代理结束入父命令队列；已有测试覆盖无需额外 timeout 即唤醒空闲父代理 | [runner.ts:1338](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/subagent/runner.ts:1338) | 采用结果到达就处理，不依赖周期轮询才发现结果 |
| Codex 的不同多代理实现、开关与唤醒路径并不相同；v2 完成通知存在 trigger_turn=false，是否唤醒还受主执行状态约束 | [completion.rs:112](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/agent/control/completion.rs:112)、[turn_input.rs:705](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/session/turn_input.rs:705) | 不把开源某条路径概括为所有 Codex 客户端行为；ohbaby 的“Stop 后结果仍唤醒”按用户明确选择实现 |

DSH 的上述通知会核对当前注册对象仍是原 parent；父对象缺失或被替换时不会从持久库重建，也不等于可靠补投。ohbaby 的跨轮持久交付要求需由自己的 store 与请求确认机制承担。

统一 `agent` 六 action 是本轮的接口取舍，并不是以上项目一致采用的现成接口。借鉴执行与消息边界，不为模仿名称引入未定义的 task 概念。

## 3.3 名额与清理：主要借鉴 DSH

DSH 的 `ActivationPool.reserve()` 在异步 materialize 之前占用容量，release 幂等；无空位直接返回容量错误，不用容量等待队列。创建失败有回滚，close 合并同一次清理 Promise。

源码：[activation.ts:24](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/activation.ts:24)、[启动与失败回滚:739](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:739)、[close:774](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:774)、[清理后归还:1153](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/subagent/src/manager.ts:1153)。

采用三个结构：**先预占、单执行持有、清理路径统一幂等归还**。ohbaby 额度按主会话的实际子执行计数，不复制 DSH activation 默认数量及完整树运行时。清理异常仍必须核实资源事实：DSH 的释放代码也不能证明任意 dispose Promise 一定结束，或抛错后物理进程一定退出；ohbaby 应复用现有 shell confirmed/unconfirmed，不做超时即释放的虚假保证。

Codex 某些版本的上限约束注册实例，另一些同时区分活跃和驻留数量；Kimi Swarm 的批量/排队也不等同普通子代理并发。它们的“6”“线程数”或批处理规模不能直接证明 ohbaby 的目标应怎样计数。ohbaby 的六个运行名额、无自动排队、单次调用独立成功是已确认契约。

## 3.4 monitor：借鉴按需读取，拒绝名字相似但行为不同的方案

| 项目能力 | 实际行为 | 本轮取舍 |
| --- | --- | --- |
| DSH ListAgents | 返回身份、标签、状态等概况，不调用模型 | 对应 list，避免默认塞满轨迹；[实现](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/subagent/tool-subagent-control/src/list-agents.ts:85) |
| DSH 实验性 session query | 读取保存的 session 事件、相邻记录等 | 借鉴记录读取；它是实验性工具，不能宣称普通子代理控制已默认提供完整 monitor；[实现](/Users/hansun025/Projects/code-cli/deepseek-harness/packages/experimental/tool-session-query/src/index.ts:108) |
| Kimi TaskOutput | 单目标即时输出/快照，运行中可 not_ready，输出有上限；子代理输出文件主要在终态写入 | 借鉴有界读取、完整输出引用；不能把最终输出文件等同实时完整轨迹；[工具](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/task/task-output/taskOutputTool.ts:66)、[子代理输出](/Users/hansun025/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/agent/subagent-task.ts:127) |
| ZCode TaskOutput | 支持 block/timeout；终态读取还有通知标记处理 | 不复制阻塞、轮询与读后确认副作用；[schema](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/contracts/src/tools/task-output.ts:25)、[handler](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/tool/handlers/task-output.ts:59) |
| ZCode ReadSessionContext | 可调用轻量模型提取上下文 | 不采用额外模型总结；ohbaby monitor 只整理已有记录，不产生隐藏模型费用 |

用户提供的 Claude Code 截图说明该会话工具的自述，不等于所有版本稳定 API，也不等于已实测。其 Monitor 名字不能直接证明与 ohbaby 已确认的一次性记录读取同义。正式接口以明确行为为准，不追求同名。

## 3.5 定时监督：提醒文本不等于唤醒调度

调查中必须区分：模型自己调用一次 wait；UI 刷新状态；在下一次既有模型请求中加提醒文本；主代理空闲后由程序启动新的模型轮次。这四种机制不同。

- **DSH** 普通子代理以完成通知和等待事件为主；另有通用 schedule 能力，但不需要为此移植整套服务。
- **OpenCode** 后台工具说明完成后会通知，可以继续工作或结束当前回复；job completion 负责交付，没有在该路径发现普通子代理固定 60/120 秒的主模型监督钟。
- **Kimi** background task reminder 可以在压缩后的模型步骤加入状态；显式 TaskWait 与界面刷新不等于 idle 后固定唤醒主模型。
- **Codex** 显式 wait 的超时是一次工具调用行为；time reminder 在已有模型步骤注入，不是独立空闲唤醒。源码：[time_reminder.rs:179](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/session/time_reminder.rs:179)。
- **ZCode** 确有从空闲开始计时的提醒，但针对动态 workflow 未处理决定/留白，首次 15 分钟、第二次 30 分钟，次数有限，不能说普通子代理都这样监督。源码：[workflow-blocked-reminder.ts:25](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime-task/workflow-blocked-reminder.ts:25)、[接入条件](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/core/src/runtime/methods/dynamic-workflow-blocked-reminder.ts:66)。

ohbaby 保留 2/5 分钟子代理监督，是用户结合现有能力作出的选择，**不是参考项目共同惯例**。借鉴 ZCode 的空闲计时、到期读取事实及再次检查忙闲；不复制 workflow 业务状态，也不引入通用 schedule。手动中断仅禁定时唤醒、后台结果仍唤醒，是 ohbaby 的明确约定。

## 3.6 stop、close 与历史

Codex 的部分 close 实现会 flush rollout、关闭并从运行注册表移除，保存的历史仍能独立读取；但部分 resume 路径可以从保存记录重建线程。这只能证明“运行对象与历史可分开”，**不能照搬成 ohbaby close 后可恢复**。

源码：[legacy.rs:9](/Users/hansun025/Projects/code-cli/codex/codex-rs/core/src/agent/control/legacy.rs:9)。ohbaby 自己已有 closedAt 与独立历史存储，更适合在现有结构上补齐可等待清理、运行列表过滤和 Web 失效，不引入第三套归档代理状态。

stop 是结束本次执行；close 是注销可运行实例。历史存储无需和 agent 对象一起保留在内存，也不需要把历史删除才能证明销毁完成。关闭后的主模型只读历史与 UI 隐藏，是本产品选择，并非所有参考项目一致如此。

## 3.7 右侧 UI

ZCode 将运行中与已结束的子代理集中列出，点击查看所选子代理的会话，返回只改变 UI 选择。OpenCode TUI 的 Subagents 标签也提供集中列表。这些支持“集中找实例，再看详情”，不必在主会话翻找旧调用。

源码：[ZCode 列表](/Users/hansun025/Projects/code-cli/ZCode/apps/zcode-cli/packages/tui/src/app-sidebar-subagents.tsx:13)、[OpenCode Tab](/Users/hansun025/Projects/code-cli/opencode/packages/tui/src/routes/session/composer/subagents-tab.tsx:26)。

用户给出的 Codex/Cursor 截图进一步确认了右侧多 Tab 容器、默认入口页、添加页面与侧栏开关，以及 Subagents 的 Active/Done 分组。它们是视觉和交互依据，不是桌面客户端内部状态机证据。

本轮采用：主会话保留工具输入输出，启动链接直达右侧详情，同一 Tab 内返回实例列表，Active/Done 仅为视图分组。OpenCode 某些界面的跳转 child session/返回 parent 导航不直接照搬；ohbaby 要保留主会话并在右侧查看。文档/Review/浏览器/终端虽然出现在截图中，已明确不属于本批。

**右侧栏的状态放在哪（2026-10-29 补查，支撑 D46）：** ZCode 和 opencode 的 Tab 容器都只在前端。

- ZCode 用一个页面类型 union 列出所有面板（browser、terminal、subagent-session 等，见 [workspaceSidePane.ts](/Users/hansun025/Projects/code-cli/ZCode/packages/ui/src/lib/workspaceSidePane.ts)），状态放在 React 和一个内存 Map 里，不存服务端。
- opencode 把 Tab 布局存在 localStorage（[layout.tsx](/Users/hansun025/Projects/code-cli/opencode/packages/app/src/shell/state/layout.tsx)）。
- 两家的终端和浏览器都有各自独立的后端：终端是 PTY 服务，浏览器走 Electron 主进程。没有通用的面板后端。
- ZCode 的子代理目录页调用专用的列表接口（`listSessionSubagents`），详情直接复用普通会话的阅读组件，只读。

所以 improve-2 只做子代理实例的读取和控制接口，不建通用面板后端；improve-3 用前端的页面类型 union 给终端、浏览器留扩展位。

## 3.8 证据边界

以上实现细节来自本地版本核查，代码行号随项目变化可能漂移。用户测试与截图用于说明观察到的客户端行为，不据此推断所有版本、所有模式。参考项目提供可借鉴的执行边界，但最终契约仍以用户确认与 ohbaby 现有代码的适配成本为准。
