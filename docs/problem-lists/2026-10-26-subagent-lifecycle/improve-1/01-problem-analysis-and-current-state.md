# 1. 现状与问题分析

> 核查日期：2026-10-28。ohbaby 基线：`94abaa64e8b21d93ccc88bbad69de0b486483004`。
> 本文描述当前实现，不把目标设计当作已有能力。源码行号是此次快照，后续按符号定位。
> 本轮只修改规划文档；没有运行实现测试，也没有修改产品代码。

## 1.1 问题与目标

用户需要后台子代理跨主代理轮次继续工作：主代理可以结束输出、处理下一条用户消息，也可以被手动停止，而后台子代理继续完成已交办的工作。结果回来后，空闲主代理被唤醒，忙碌主代理在下一次模型请求中收到结果。前台子代理仍随正在等待它的主轮次停止。

当前系统已有实例、执行、保存的会话历史、前后台派遣、执行预算和实时详情读取。这些基础应当复用。主要矛盾是后台工作的生命周期、结果交付和工具资源仍围绕原主 run 组织；单纯改工具名、取消一处 abort 或把并发常量改为 6，不能完成这次改造。

目标行为以 [00 的 D01–D54](00-discussion.md) 为准；实施契约见 [02](02-optimization-plan-and-change-scope.md)，验收见 [04](04-test-and-acceptance.md)。

## 1.2 当前调用链

1. 模型调用 `subagent_run`，工具调用调度器先取得 dispatch 类调用名额。
2. `SubagentHost` 创建或复用实例，创建 execution；后台模式在受理后返回，前台等待结果。
3. execution 记录派遣来源 `rootRunId`。子代理工具资源也沿用原主 run 的 root owner。
4. 主代理收尾时，continuation coordinator 按原 `rootRunId` 查询子执行，并要求 `requesterRunId`、会话和 scope 都与当前 run 一致，再等待并投递结果；RunManager 的收尾也等待子 run。
5. 原主 run 关闭输入时，正常结束则 seal shell root（拒绝新命令，已有命令继续），其他情况 cancel shell root；**无论哪种情况**都会调用 `interruptByRootRun`，中断该 root 下的子执行。
6. Web 将 `subagent_run` 的工具卡替换成派遣行；点击后打开输入框上方的子会话浮层，展开时会隐藏主会话。

这条链适合“主轮次一直等到关联工作结束”的旧约定，与现在允许主轮次提前结束的要求冲突。

## 1.3 主要问题与源码证据

| ID | 当前事实 | 对新需求的影响 | 主要定位 |
| --- | --- | --- | --- |
| P1 | 正常收尾等待所有子 run；输入关闭（包括正常结束）会中断原 root 下的子执行；`interruptRunTree` 对子 run 会上溯 root，再取消 root、shell root 和全部兄弟子执行 | 后台无法独立跨轮；单独停止一个子代理会误停主代理和兄弟子代理 | [composition.ts:706](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:706)、[输入关闭:734](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:734)、[停止入口:903](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:903) |
| P2 | 子工具 owner 的 root 来自原主 run；主结束 seal、主中断 cancel shell root | 即使 agent 没 abort，后台后续 shell 仍可能被拒绝，已有命令可能被杀 | [owner:408](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:408)、[shell-job-registry.ts:204](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/shell-job-registry.ts:204) |
| P3 | 结果按原 `rootRunId` 加 `requesterRunId` 查询；输入存储要求目标 run 活跃，关闭时结束未处理输入。execution 上已有交付状态（见 1.4），问题在查询键和投递目标绑死原 run | 结果不能可靠跨 turn 交付；换一个通知 ID 仍不足以解决丢失或重复 | [coordinator:123](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.ts:123)、[current-run-inputs.ts:212](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.ts:212) |
| P4 | 当前默认 3（`maxSubagentConcurrency`）是按会话的工具调用并发；后台受理回执返回后便释放调用 lease。除每次执行 30 分钟超时外，没有别的实际执行上限 | 不能限制实际仍在运行的后台子代理数量 | [constants.ts:6](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/constants.ts:6)、[scheduler.ts:1666](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:1666)、[归还:1771](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:1771) |
| P5 | 对运行中实例的旧 `run` 会追加到持久化的 `pendingQueue`，当前执行完成后再取队列；`interrupt: true` 则中断当前轮再跑队列。执行失败或中断后，剩余队列持久化并暂停 | 不符合运行中 send 在下一次模型请求加入消息的要求，且会隐含自动启动后续执行 | [subagent-host.ts:1096](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:1096)、[队列消费:1269](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:1269)、[暂停:1383](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:1383) |
| P6 | close 已写 `closedAt` 并拒绝再次运行，但不等待清理：清理任务登记到 `pendingLifecycleCleanups`，要到会话 dispose 才统一等待；status 可列出关闭记录，按 execution 查询还会生成 artifact | close 回执不等于清理完成；旧 status 不能直接包装为纯读取 monitor | [close:659](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:659)、[status:636](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:636)、[清理:801](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:801)、[登记:894](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:894) |
| P7 | 60/120 秒监督位于仍存活的主 run 的 beforeFinish；Goal active 时连续调用 runTurn | 主轮次改为结束后，监督需要改变归属；Goal 可能绕过等待直接空转 | [coordinator:258](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.ts:258)、[goals/driver.ts:22](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/goals/driver.ts:22) |
| P8 | Web 替换原 ToolCard；旧详情浮层展开时隐藏审批面板并锁主输入；列表按 execution，统计只覆盖 activeRootRun；AppShell 只有左侧栏加主区两栏，没有右侧栏基础 | 不符合保留工具输出、右侧独立查看、跨轮实例列表的要求。按 D46 由 improve-2 到 improve-4 解决 | [SessionConversation.tsx:56](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/session/SessionConversation.tsx:56)、[审批隐藏:265](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/session/SessionScreen.tsx:265)、[输入锁:334](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/session/SessionScreen.tsx:334)、[浮层:421](/Users/hansun025/Projects/code-cli/ohbaby-agent/apps/ohbaby-web/src/ui/session/SessionScreen.tsx:421)、[subagent-views.ts:76](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.ts:76) |
| P9 | `subagent_run` 的 JSON schema 写 `mode` 默认 `foreground`，实际解析 `runMode()` 和工具说明默认 `background` | 模型看到的默认值与实际行为相反，属于现存 bug；新 `agent` schema 必须三处一致 | [schema:184](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/subagent.ts:184)、[runMode:59](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/tools/subagent.ts:59) |

## 1.4 按职责核对现状

| 维度 | 可复用的基础 | 本轮需要改变的部分 |
| --- | --- | --- |
| 模块职责 | Host 管实例与执行，store 保存事实，RunManager 管执行，SDK reader 管读取 | 后台存活由主会话持有；追溯 root 不再兼任停止与资源 owner |
| 架构 | 已有 `SessionExecutionGate` 与主输入调度 | 结果、用户消息、监督共用主会话执行门；不另造第二套主代理启动器 |
| 数据 | 实例与 execution 分开；实例已有 `closedAt`；execution 已有交付状态 `delivery`；MessageManager 保存子会话 | 保留关闭标记及历史，注销运行控制入口；交付状态改为按主会话查询和投递，不再只挂在旧 run 输入上 |
| 流程与接口 | 前后台模式、按执行的工具元数据、成功请求后的输入确认 | 新统一 action schema；send 区分运行中投递与启动新执行；执行名额覆盖真实存活时间 |
| 用户用例 | 停止、详情查看、执行锚点、分页和断线恢复已有基础 | 主停止保留后台，子停止不向上停止主，列表复用同一实例，右侧查看不锁主输入 |
| 非功能 | 权限校验、执行预算、结果 artifact、恢复机制已存在 | 清理可等待、名额不提前归还；monitor 有内容上限；关闭后 UI 投影失效；避免空转模型调用 |
| 测试 | Host、coordinator、持久化、SDK reader、Web 派遣行已有测试 | 改掉固化旧收尾/浮层行为的断言，新增跨轮、真实容量、下一模型请求和资源清理用例 |

### 实例、执行、历史不是一个东西

- **实例**保存子代理身份和可复用上下文，可能先后执行多次工作。
- **执行**是某一次运行，具有 run、mode、输入、结果、预算和执行资源。六个名额限制执行，不限制保存了多少实例。
- **历史**是保存的消息、工具记录、执行事实与结果。实例被 close 后仍能保留这些记录，不必保留一个可重新启动的运行对象。

普通持久化运行已经使用数据库存储实例、执行和消息，并非只存在内存里。数据库中的 `closedAt` 是禁止重新控制的依据，不代表一个“仍活着但隐藏”的 agent。in-memory store 则是测试和非持久化配置的实现，不能据此宣传所有模式均可跨进程保留历史。

当前有两套状态：

| 对象 | 状态值 | 定位 |
| --- | --- | --- |
| 实例 | pending、running、completed、failed、timed_out、interrupted、cancelled | [types.ts:5](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagents/types.ts:5) |
| execution | queued、running、completed、failed、cancelled、interrupted、timed_out | [execution-store.ts:12](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagents/execution-store.ts:12) |
| execution 的交付状态 `delivery.state` | none、foreground、pending、delivered、processed，另有 `notificationId`、`inputId`、`deliveredAt`、`processedRequestId`、`processedAt` | [execution-store.ts:89](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagents/execution-store.ts:89) |

没有必要为 UI 的 Active/Done 新增状态。用户 Stop 的目标语义是 interrupted，不能继续用含混的 cancelled 同时表达“中断一次执行”和“销毁实例”。底层取消信号仍可用于实现中断。

交付状态已经是一套完整的“待交付 → 已投递 → 已被成功请求处理”记录：后台执行结束时写成 pending，通知 ID 为 `subagent-result:<executionId>`，投递后写 delivered，请求成功后写 processed。跨轮交付应复用它，只改查询键和投递目标，不另建待交付表。持久化使用 `subagent_instance` 与 `subagent_execution` 两张表（[schema.ts:94](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/services/database/schema.ts:94)）。

### 空闲实例占用什么

实例完成一次执行后，Host 的活动状态会被删除，模型循环对象每轮新建，所以内存里基本只剩数据库记录。按实例 scope 挂着、要等 close 才释放的有：shell 任务、sandbox 上下文、上下文管理器的校准状态、MCP 已选工具菜单、工具序列和 todo 缓存（[cleanupClosedSubagentScope](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:801)）。其中真正的外部资源只有 shell 后台任务（最长 10 分钟，到期自动结束）和 sandbox 上下文（当前只有 host-local、无隔离的实现），其余是可重建的小缓存。

Host 里还有几张只增不删的表：`executionBudgets`、`rootByExecution`、`sealedRoots`、`closedSubagents`（[subagent-host.ts:248](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/agents/subagent-host.ts:248)），长会话会缓慢增长。

### 并发写文件没有隔离

sandbox 类型里虽然有 `worktree`，但唯一的实现是 host-local、`isolation: "none"`。现有保护只有单次工具调用期间的进程内文件锁，以及 edit/write 可选的 `expected_mtime_ms` 检查，都不区分是哪个代理改的（[host-local.ts:15](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/sandbox/adapters/host-local.ts:15)、[resources.ts:115](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/resources.ts:115)）。后台子代理跨轮运行后，主代理处理新任务时与后台子代理改同一文件的机会变多。

### 嵌套派遣

子代理目前不能再派遣子代理：三个 subagent 工具都在 `SUBAGENT_DISABLED_TOOLS` 中，`resolveRequester` 也拒绝来自子会话的请求（[constants.ts:32](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/core/tool-scheduler/constants.ts:32)、[composition.ts:853](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:853)）。因此六个名额实际只由主代理的直接子代理使用。

### 当前读取能力及局限

`subagent-conversation-history` 已能从保存的 execution 与消息读取历史，不要求实例正在运行。详情 reader 已支持历史锚点、实时 watch、分页、revision 检查、重连和阅读缓存，应复用。

但执行列表不是实例列表。同一子代理续跑多次会产生多条 execution；SDK 的列表合并还会保留新页中缺失的旧行。因此只在服务端过滤 closed 并不足以让 UI 删除已关闭项。需要实例快照替换或明确移除语义。

详情标题现在可能采用被点击的旧 execution 状态。新界面要分别处理“实例当前状态”和“历史滚动锚点”，否则用户从旧派遣记录进入，会看到已续跑的实例仍显示完成。

源码： [SDK 契约](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/contract/subagent.ts:63)、[列表 merge](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/sync/subagent-reader.ts:63)、[详情 reader](/Users/hansun025/Projects/code-cli/ohbaby-agent/packages/ohbaby-sdk/src/sync/subagent-conversation-reader.ts:483)。

### 清理必须按实际资源核查

当前 close 的 `onClosed` 为异步追踪清理，不能据返回时刻认定 sandbox、shell、MCP 和上下文都已释放。需建立可等待的执行清理完成条件。也不能只写一个 finally：如果内部清理永不返回，finally 同样不会执行。

审批撤销已经按实际 `input.runId` 匹配，不能把它描述成一律随主 run 撤销。保留正确的精确撤销逻辑，仅调整确实沿旧 root 归属的资源。恢复流程根据进程 owner 存活判断异常执行，也不是“主 run 一结束便自动恢复或销毁全部子代理”。

## 1.5 与既有文档的关系

| 既有约定 | 本轮关系 |
| --- | --- |
| [execution-reliability improve-3](../../2026-09-19-execution-reliability/improve-3/00-discussion.md)：主代理收齐关联子结果后才最终结束 | 被 D04、D05、D08 替代：允许主 turn 结束，后台结果跨 turn 交付 |
| 同一历史方案的 60/120 秒模型复查 | 被 D31、D33、D35 调整：空闲开始计时，采用 2/5 分钟设计基线，手动中断仅禁止定时唤醒 |
| 主代理主要只看子代理摘要与事实 | D30 增加按需读取已有详细记录；不把完整轨迹默认灌入主上下文 |
| 原 root 收尾清理全部子执行 | 普通主 turn 收尾/Stop 改为前后台区分；会话销毁和服务退出仍必须清理所有实际资源 |
| [Web 改版](../../../ohbaby-web/redesign-2026-10/README.md)：主区子会话浮层/展开阅读 | 改为右侧 Tab 中列表与详情；保留消息渲染、读取与缓存能力 |
| 持久历史、结果 artifact、权限、预算、异常恢复 | 继续保留；按新归属复核，不另造平行实现 |

本轮不重写历史讨论，把新行为写入本目录；实施阶段再同步模块的权威设计文档。

## 1.6 SWE 取舍

本轮选择一个会话内的实例控制、一套执行名额、一条主输入调度路径、一套详情阅读组件。不扩展全局代理池、通用调度服务、任务业务状态机或插件式 Tab 框架。

需要新增的机制只有解决已确认需求所必需的部分：执行开始前预占名额、清理完成的等待点、现有交付状态改按主会话查询、实例列表投影和右侧容器（后两项按 D46 分别放在 improve-2 和 improve-3）。具体字段应尽量复用现有 stores、请求确认和执行门。参考项目的采用与不采用理由见 [03](03-reference-projects.md)。
