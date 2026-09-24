# 03 六个项目的实际做法与取舍

> 2026-09-20 对本地 checkout 只读调查，未运行这些项目的测试/E2E。源码与测试内容是设计证据，不是运行通过声明。路径以 `/Users/hansun025/Projects/code-cli/` 为根；行号为该 revision 快照。

## 3.1 基线和整体结构

| 项目 | Revision | 与本轮相关的结构 |
|---|---|---|
| kimi-code | `19c5aa64e` | agent loop准备/调度/有序提交，独立background manager与Kaos进程能力，Web/TUI分别投影 |
| opencode | `d4ad650f73` | 调查的V2 core采用Effect、fiber、scoped process与文件锁；Web由timeline projection驱动。V2为迁移路径，不推广成仓库所有入口 |
| pi | `57cde8690` | agent-loop工具生命周期事件与模型消息分离；工具拥有执行能力，文件mutation queue保护写入，TUI消费事件 |
| claude-code | `987e5503` | 本地CCB重建版，query＋StreamingToolExecutor＋ShellCommand＋REPL；不是官方开源核心实现，结论仅适用于此checkout |
| codex | `5c19155cbd` | turn中的有序工具结果集合、独立工具事件、shell runtime及TUI状态投影 |
| deepseek-harness | `47f943859b` | agent-loop有序提交/并发池，timeout guard，subprocess provider负责进程清理，UI独立投影日志 |

## 3.2 Pi：直接借鉴结果事件与模型顺序分离

证据：`pi/packages/agent/src/agent-loop.ts:522`；`packages/agent/test/agent-loop.test.ts:586`；`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3090`。

- 工具各自完成即发 tool_execution_end，模型结果按原调用顺序保存。测试明确验证 tool2先完成、UI事件tool2→tool1，而模型结果tool1→tool2。**采用**这一分离和测试思路，对应02 §2.3。
- 其prepare仍顺序等待，不能用Pi证明“已获批工具能越过其他审批立即执行”；ohbaby在不冲突调用间的独立preflight是本项目明确的新行为。
- `packages/coding-agent/src/core/tools/write.ts:203` 明确不从abort listener提前reject，以免写盘未完就放锁；`file-mutation-queue.ts:52` await底层后finally放行，测试 `test/file-mutation-queue.test.ts:176,221`。**采用**保护原则，不照搬成整个仓库都具有细粒度文件锁。
- Bash `src/core/tools/bash.ts:96`、`src/utils/shell.ts:200` 超时/abort直接SIGKILL组；`src/utils/child-process.ts:17` 的100ms是退出后管道空闲期，不是TERM宽限。**不采用**直接强杀策略，ohbaby按用户决定先TERM再KILL。
- TUI `interactive-mode.ts:2916,3113` 默认Working覆盖整轮；reasoning隐藏时静态Thinking标签不是实时阶段。**不采用**全程Working，也不宣称Pi已有统一运行计时。

## 3.3 OpenCode：轻量工具行、完成耗时和清理作用域

证据：`opencode/packages/core/src/session/runner/llm.ts` :243–274,300、`packages/session-ui/src/components/basic-tool.tsx:93,205`、`tool-status-title.tsx:23`、`packages/ui/src/components/text-shimmer.css:103`。工具行TextShimmer、按需展开，并有 reduced-motion 退化；**采用**轻量文字动效及减少动态效果处理，不照搬其 pending/running 共用 shimmer 的阶段判断，也不把后台枚举变成一排标签。

V2 runner 的工具 fiber 逐项发布结果、整批 join 后继续模型；以上路径已核对，不把迁移中架构视作所有入口统一实现。

Web真实接线：`packages/app/src/context/settings.tsx:193` 默认showReasoningSummaries=false；`pages/session/timeline/rows.ts:191`、`message-timeline.tsx:333`据该设置决定Thinking。**默认busy时正文出现仍显示**；独立SessionTurn组件fallback=true不代表App默认。另一配置有可见内容后隐藏。ohbaby采用自己的“正文开始隐藏、工具不Thinking”规则。

总耗时：`message-timeline.tsx:966,1052` 由用户消息created到该轮assistant completed；`packages/session-ui/src/components/message-part.tsx:1678,1750`完成后元数据显示。**采用**完成后轻量显示，时间口径改为ohbaby持久prompt createdAt→endedAt；格式扩到小时/天。

终止：`packages/core/src/tool/bash.ts:158` forceKillAfter=3秒，经`process.ts:146,259`实际CrossSpawnSpawner；`cross-spawn-spawner.ts:374` scope清理TERM→等待→KILL→等待。该路径的 ExitSignal 实际在 direct child 的 close 事件完成，exit 只记录参数；KILL 后没有第二个有限等待期限，不能将其写成有界进程组停止确认。`file-mutation.ts:78` KeyedMutex包住不可中断写临界区。**采用**清理与资源生命周期连接，不在底层写完前放锁。其等待不构成所有脱组后代已死的证明。

## 3.4 Codex：独立工具事件、流式正文提示和时长格式

`codex/codex-rs/core/src/session/turn.rs:1893,2470`用FuturesOrdered按序收结果；工具事件独立派发。**采用**观测与模型结果分离，不迁移Rust调度实现。

TUI `src/chatwidget/streaming.rs:327` 正文持续刷出时隐藏底部状态，有条件恢复；`turn_runtime.rs:59`从task开始显示Working。**借鉴减少重复提示**，ohbaby不引入流空闲后自动恢复机制，只有下次模型请求重新显示。

`tui/src/status_indicator_widget.rs:65,169`使用紧凑秒/分/时格式和可暂停累计；`bottom_pane/mod.rs:1387,1556`审批实际暂停/恢复。ohbaby的整轮耗时**包含审批和排队**，不复制暂停口径；天级格式为本项目补充。

Shell `core/src/exec.rs:1011`超时直接kill组；`:1019`主动取消先TERM，50ms后KILL；`:1064`输出reader收尾有界。`tools/parallel.rs:131,168`配合runtime teardown释放guard。**借鉴**有界管道收尾和清理所有权，**不采用**超时立即KILL的策略。组终止只覆盖仍留在组内的后代，非Unix路径不能由killpg实现外推。

## 3.5 Kimi：进度与最终提交不同，后台拥有清理

`kimi-code/packages/agent-core/src/loop/tool-call.ts:139,156,560`顺序prepare、有序finalize，progress可提前推送。**借鉴**进度通道，不声称它逐项按完成顺序发布所有terminal结果，也不据此证明同wave独立审批。

`apps/kimi-web/src/components/chat/ChatPane.vue:181,187,662`实际showWorking=sending||running，全程月亮动画；`:636`结束显示durationMs。设计系统注释“仅首响应等待”与实际接线不同，以组件为准。`ToolRow.vue:11,67`用少量状态和图标。**采用**工具行的克制表达，不采用全程活动提示，也不复制只有分秒的格式。

Shell `packages/agent-core/src/tools/builtin/shell/bash.ts:271`注册后台任务；`agent/background/index.ts:894` abort→等5秒→forceStop；`process-task.ts:49,80` TERM/KILL；`packages/kaos/src/local.ts:66,122,149` POSIX组/Windows taskkill。**采用**job manager继续负责清理。

通用工具 `loop/tool-call.ts:45,571` abort最多等2秒再合成错误，包装Promise结束不证明副作用停了；`loop/tool-scheduler.ts:75`随包装settle释放active。**不采用**将宽限结束视作安全解锁。FetchURL `tools/builtin/web/fetch-url.ts:84`未将signal送入fetcher，不能用它证明网络取消完整。

## 3.6 DeepSeek Harness：清理所有权、刷新计时与明确边界

`deepseek-harness/packages/core/agent-loop/src/tool-calls.ts:147,225`按原序commit已完成slots，inFlight随dispatch settle释放。后项先完成不必立即发布最终结果。**借鉴**有序模型记录，ohbaby另外实现即时UI交付。

`packages/guard/timeout-policy/src/index.ts:56`只派生deadline signal，仍await next；忽略signal的工具可能一直不返回。**借鉴**真实取消链路，不宣称它具备任意工具有界强停。

Shell `packages/shell/bash-local/src/index.ts:35,191,223`默认3秒升级；`packages/subprocess/subprocess-local/src/spawn.ts:380,417,439,507`观察组存活、TERM→KILL，leader退出不取消组清理；`src/index.ts:154`直到waitForExit才移除live handle。**重点采用**调用结果与后台清理所有权分开。bash实际await handle.done，不是完整waitForExit，故不能断言结果返回时全树已结束，也不能把后台清理owner等同于所有调度锁仍持有。

`packages/web/tool-web/src/fetch.ts:479`将signal传能力层，`packages/web/web-fetch-http/src/provider.ts:46,103`传到HTTP和body。**采用**贯通signal；远端副作用仍不可据此撤销。

UI `packages/client/ui-conversation/src/client/chat/ChatView.tsx:107,116,129,401`整轮Deep diving，15秒后显示时间，起点来自turn/start日志；`TurnTailNodeView.tsx:26`结束耗时来自日志起止。**采用**后端时间恢复及完成时长，**不采用**全程状态词和组件挂载时间fallback，ohbaby缺事实时不造时钟。

## 3.7 本地 Claude 重建版：逐项更新与模型请求阶段

`claude-code/src/query.ts:1669,2042`逐项yield工具更新、整批结果进入下一模型轮；`src/services/tools/StreamingToolExecutor.ts:393,480`可被进展/完成唤醒。**采用**事件流思路，保持ohbaby hook原顺序，不移植执行器。

`src/utils/messages.ts:3348,3383,3400`区分requesting/thinking/responding/tool-input/tool-use。tool-input指模型生成参数，**不是审批**。`src/components/Spinner.tsx:140,239`及`Spinner/SpinnerAnimationRow.tsx:101,198`有暂停扣除、显示阈值；`src/utils/format.ts:34`支持天但省略秒。**借鉴**阶段与计时区分，ohbaby采用用户已确认的独立attempt计时和完整d/h/m/s。

`src/utils/ShellCommand.ts:135,337`超时可能转后台；实际treeKill始终SIGKILL，doKill传入SIGTERM只是合成原因/退出码，且不等待kill回调就resolve。**明确不采用**自动后台化及发送kill就结算为已停止。`src/services/mcp/client.ts:3165`signal/SDK timeout只证明本地请求取消，不代表远端执行已停。

## 3.8 对02的直接影响与不照搬项

| 02决策 | 来源及取舍 |
|---|---|
| 逐项UI交付、模型整批有序 | Pi直接参考测试，Codex/CCB参考结构；Kimi/DeepSeek只提供部分进度参考 |
| 无冲突调用独立审批 | ohbaby 用户决定；依赖前置 C 的资源准入和必要顺序，不冻结旧全局 wave/互斥；不能归称六项目共同实现 |
| 写操作未停不放保护 | Pi/OpenCode 的写队列作为参考；前置 C 补 ohbaby 所需的共享读写保护，本轮消费其事实 |
| TERM→KILL＋后台清理 | 前置 C 借鉴 OpenCode/Kimi/DeepSeek，明确各自确认范围，沿 ohbaby 既有200ms升级参数起步；本轮负责状态交付和组合验收 |
| 时间由后端恢复、最终一次总耗时 | DeepSeek/OpenCode/Kimi；prompt提交到终态口径由用户决定 |
| 正文后隐藏提示 | Codex提供实际先例，但不复制闲置恢复；其他项目默认多为全程提示 |
| 固定deadline、无闲置延期 | 保持ohbaby现有执行规则；不引入自动后台化或活跃日志续命 |

**后续决定已修订：**9月21日未采用异常清理后结束受阻调用的提案；9月22日用户已确认前置 C.5 的窄规则：清理失败或有限观察后未确认且实际阻塞新调用时，该尚未执行调用返回普通资源错误，旧资源保护继续保留。正常竞争仍等待，不自动重放。已查 Pi/OpenCode/DeepSeek 路径没有这套完整机制，它是 ohbaby 自己的取舍；DeepSeek 的 aborted-before-dispatch 也不能冒充该机制。

## 3.9 2026-09-21：文件保护与调度范围复核

本地 revisions 同上，以下为源码和测试阅读，未运行参考项目测试。用户确认采用 OpenCode/Pi 的文件级保护、Kimi 的访问范围区分，以及 Bash 各自批次内保守调度方向。不要将“不同代理可并行”解释成“已保证跨代理文件无冲突”。

| 项目 | 已核实做法与限制 |
|---|---|
| Kimi | `packages/agent-core/src/loop/tool-call.ts:132` 每批 new ToolScheduler；`tool-access.ts:67,98` 检查读写与路径/目录重叠，不同目标可并行；未声明 accesses 默认 all（tool-call:322），Bash 落入该规则。该 scheduler 不提供跨代理文件互斥 |
| OpenCode V2 | `packages/core/src/file-mutation.ts:78,144,196` 为 Location-scoped 服务提供按 canonical target 的写锁及 edit 内容重验；不同目标独立。同 Location session 可共享该服务，普通 read/Bash 不参与；legacy 工具路径不能自动套用 V2 结论 |
| Pi | `packages/coding-agent/src/core/tools/file-mutation-queue.ts:4,32,52` 同进程模块级按路径队列，真实 fn 结束才释放；write/edit参与，read/Bash不参与。示例 subagent 为独立子进程（examples/extensions/subagent/index.ts:335），不共享这份内存锁 |
| Codex | `codex-rs/core/src/tools/parallel.rs:52,133` 每 ToolCallRuntime 新建局部调度锁，不按文件路径调度；shell/shell_command.rs:152、unified_exec/exec_command.rs:96 声明支持并行。没有据此保证跨代理同文件写入互斥 |
| 本地 Claude 重建版 | `src/query.ts:761` 每轮建 executor，StreamingToolExecutor.ts:156 只检查自己的 executing 列表；BashTool.tsx:570 用只读判断决定并发。FileEdit/FileWrite 的 mtime/content 校验不能等同跨代理原子文件锁 |
| DeepSeek Harness | `packages/core/agent-loop/src/tool-calls.ts:59,124` 为局部批次池；文件 provider `packages/fs/fs-local/src/index.ts:77,91,172,227` 有 targetKey 写锁和版本检查。跨代理仅在共享同 provider 实例时成立，read/Bash不加入该写锁；默认写/Bash在当前步骤保守执行 |

前置 C 借鉴的是分层：批次决定执行顺序，共享文件能力保护已知资源；第二轮负责接入独立审批和可靠交付。ohbaby 目标中的同文件读写互斥比 Pi/OpenCode 写队列更强，需自行完善 read 接入，不能称为照搬已有完整读写锁。Bash 跨批次的任意文件副作用仍不受这些 JS 文件锁普遍保护。

## 3.10 Bash 停止未确认后的后续准入（2026-09-21 复核）

以下仅为所列 Bash 执行链的源码核验，未做残留进程实测；没有找到自动冻结工作区或跨批次封禁来源会话的完整机制，不宣称全仓库绝无其他控制路径。

| 项目 | 实际返回/清理边界 | 后续准入含义 |
|---|---|---|
| Pi | `tools/bash.ts:111,133` kill 后等待 child；`utils/child-process.ts:88,116` 在 child exit 后输出空闲100ms收尾，输出会重置该计时；未复核组内全部成员消失 | 工具不返回则当前批次继续等；返回后无已核实的额外 workspace/session 冻结 |
| OpenCode V2 | `cross-spawn-spawner.ts:276,391,401` TERM→3s→KILL，等待 close 而非仅 exit；KILL后无第二个有限等待期限，清理错误被 ignore；close不证明整个组消失 | 当前 fiber/批次等待；未发现将未确认清理登记为跨会话准入限制 |
| Codex | `core/src/exec.rs:1011,1019,1087` 超时KILL、取消TERM后升级；reader各有有限等待。发信号及管道收尾不等于所有后代退出 | `tools/parallel.rs:131,168` guard随dispatch结束释放，后续runtime另建锁；未发现转交workspace冻结状态 |
| 本地CCB | `src/utils/ShellCommand.ts:337` treeKill后即结算，不等待kill回调；`StreamingToolExecutor.ts:381` Bash错误还会取消当前兄弟工具 | 批内失败传播不是跨批次冻结；不采用其兄弟工具一并取消行为 |
| Kimi | `agent/background/index.ts:894,941,961` abort、有限宽限、forceStop后结算；`loop/tool-scheduler.ts:75` 随包装结果释放 | 未发现因残留清理而建立跨批次/session/workspace栅栏 |
| DeepSeek | `shell/bash-local/src/index.ts:223` await handle.done；`subprocess-local/src/spawn.ts:439,472,490` 继续组清理且输出收尾有界；provider `index.ts:154` 持有handle直到waitForExit | provider `index.ts:146` 的新spawn不检查旧清理集合；后台清理owner不等于后续调用禁入 |

**用户已确认：**已知文件按资源保护；未知残留 Bash 限制来源主会话及其子代理，其他独立主会话继续。该额外限制是 ohbaby 自己的折中，不是六项目的共同实现；其他主会话继续意味着不保证它们与未知 Bash 副作用无冲突。限制跟随真实 rootSessionId 跨批次/run 保留，各残留分别确认、分别解除；观察与清理入口保留。具体职责和验收见[前置 C](../prerequisite-follow-ups.md)，第二轮只接状态、审批、交付和计时，不重复实现基础层。

## 3.11 2026-09-23：审核意见与持久化边界补核

本次浏览[分享页](https://opncd.ai/share/lmhI6aTg)只看到9月21日11:49的一轮七项审核；随后按用户指示读取本机OpenCode同名会话，找到针对修订稿的新增回复，另见§3.12。以下是旧七项反馈的补核，六项目revision与§3.1相同，未运行参考项目测试。

| 议题 | 核验与取舍 |
|---|---|
| 锁等待原因 | 当前ohbaby ConcurrencyController只有计数、writeInProgress和等待队列，没有完整持锁owner；“已知道谁占锁，只补展示”不准确。由C建立真实资源/owner事实，本轮授权过滤后展示，见02 §2.3 |
| 独立审批收益 | 当前合同已改为无资源冲突调用可独立推进，不能再用旧wave推导收益。Bash批次内保守及子代理派遣独立路径已落02 §2.2/T02–T03；Codex/CCB的执行器准入仍可能覆盖审批等待，不能直接当作ohbaby“不占执行容量”的先例 |
| 父调用与子阶段 | 本轮保证真实身份及根审批入口；父工具关联子代理具体阶段由第三轮完成。CCB有agent_progress，但未核实将子审批自动映射为父工具阶段的完整显示链，不据此扩大第二轮 |
| SQLite忙等待 | 已有WAL、busy_timeout及有限BEGIN重试；observer不叠加重试。但同步驱动/Atomics.wait会阻塞事件循环，02 §2.7和T08补实际响应延迟核验，不宣称已有运行证据 |
| 内存队列 | 不采用无界堆积的处方；沿现有每call最新通知及一次终态的小集合。它合并的是已保存后的通知，不降低写库次数，也不引入新的持久事件平台 |
| 模型attempt记录 | 保留后台最小开始/首正文/结束事实以满足用户已确认的逐请求计时及恢复，秒表本地计算。不增请求历史页面；仅live状态无法替代已要求的后台记录 |
| 插件hook | 保持ohbaby现有before/after语义，用真实execute阶段计时。参考项目的tool start、hook与OS启动也不是同一时点，不能只照名字替换 |

补充源码锚点（路径仍相对code-cli）：

- **Pi**：`packages/coding-agent/src/core/agent-session.ts:548,619`通知界面与message_end保存分开；`session-manager.ts:1015`同步append；`packages/agent/src/agent.ts:403,577`直接await事件sink。`packages/ai/src/utils/event-stream.ts:5`的无界数组不是实际Agent工具通知链的统一实现。`file-mutation-queue.ts:52`真实操作结束后释放，随后才进入工具结果交付。
- **OpenCode V2**：`packages/core/src/session/runner/llm.ts:242,260`发布调用/结果；`event.ts:379,407`durable事件commit后notify且等待直接listener，`:175`普通PubSub无界，`:567–606`耐久订阅用sliding(1)唤醒后按序读取。借鉴提交与通知分离，不为本轮复制整套耐久事件存储。
- **Kimi**：`packages/agent-core/src/loop/events.ts:135,175`区分live-only与recorded，后者append后emit；`tool-call.ts:153`终态仍按原序提交。`turn-step.ts:312`保存step结束指标，不能替代同step多attempt和首正文计时。
- **DeepSeek**：`packages/core/session/src/index.ts:604`append先写内存日志和observer；`packages/session/session-persistence/src/coordinator.ts:1123`入队，`write-behind.ts:40,61`另有批量持久化及flush。不能把append返回解释为SQLite已提交。`packages/client/runtime/src/client/sessions/assistant-timing.ts:35`派生step时长，`packages/core/agent-loop/src/agent.ts:339`同step内重试，不是独立attempt记录。
- **Codex**：`codex-rs/core/src/tools/registry.rs:493,575`start/pre/post与handler的先后关系；`tools/parallel.rs:133`gate先于handler内审批。其时点不是本项目execute时间的直接替代。
- **本地CCB重建版**：`src/services/tools/toolExecution.ts:842,963,1257,1552`pre→permission→call及不同类型post/result处理；`StreamingToolExecutor.ts:156`先准入。`packages/builtin-tools/src/tools/AgentTool/AgentTool.tsx:940`有父工具进度，`runAgent.ts:448`的后台审批另有条件，不推断所有后台子代理都能弹审批。

SWE取舍：C独占资源生命周期规则；lifecycle承担可靠保存和交付；浏览器只消费投影。资源释放、结果落盘、界面消费三个事实各有负责人，不互相冒充。保留满足已确认需求的最小状态，不因参考项目采用事件总线、写回队列或更细指标，就引入本项目尚不需要的框架。

## 3.12 本机 OpenCode 新一轮审核：建议与待确认取舍

2026-09-23 按用户指示，通过本机 OpenCode 的“improve-2模块问题分析与方案讨论”读取后续回复（界面显示 Claude Fable 5.1，7分17秒）。回复已核对修订稿与前置 C，确认前五项旧问题已回应，新增建议集中在 C2 规模、交付依赖、长期清理未确认及模型错误提示。分享页当时未包含这条回复；本节不是新的用户确认。

| 新建议 | 代码核验与本次建议 | 决策状态 |
|---|---|---|
| 每根任务树一个 ConcurrencyController，修现有文件锁即可缩小C2 | 能减少独立主会话间阻塞，但父子仍共享同树锁，不能同时声称父子不同文件互不拖。现有read未加锁，C1只修写锁释放，不能补出同文件读写互斥。推荐保留用户已确认行为，缩小内部抽象，而非仅按root复制旧controller | 2026-09-23用户确认不采用根树大锁减配；保留全部并发目标，三项职责分别处理 |
| improve-2通过准入接口接入，允许旧类别波次先实现 | 窄接口合理，C.7已规定事实边界；可以分别验证交付/计时逻辑。但接口解耦不自动满足不同文件并行，先交付旧波次会改变既定顺序和验收目标。推荐先保持C→2总验收；不为可能延误预建双策略/长期兼容层 | 维持已确认C→improve-2验收顺序，不新增旧策略提前交付分支 |
| 永久unconfirmed的代价应明说，直到重启 | 长期无法确认会持续限制该来源范围，这是实际代价；重启丢失内存owner/锁并不证明Shell后代停止。第四轮冷恢复不接管外部进程，不能把重启描述为安全解禁方案 | 明确事实；人工解除或新恢复能力尚未授权 |
| D23错误应指导模型查询/清理，避免重试 | 赞同错误可操作；但现有工具接收job_id，且严格检查session/context scope。父代理受子job限制不等于有权kill该job。terminal job的旧kill实现也直接返回，不能许诺再调用一次就会重新清理 | D31已确认：给普通错误及有权使用的查询指引，不默认反复kill；不扩跨会话控制权限，不新增终态job的强制重新清理能力 |
| attempt只保存当前一条 | 当前方案只存三个转折，不写逐秒数据，也不做历史查看器。仅当前一条会失去此前尝试的后台计时事实。暂无运行数据证明最小数组构成瓶颈，推荐保留已确认记录 | 不重复打开已确认产品计时范围 |

进一步源码依据：

- Kimi `packages/agent-core/src/loop/tool-call.ts:132`按批次新建scheduler；Codex `codex-rs/core/src/tools/parallel.rs:52`的局部runtime锁在`session/turn.rs:1128`创建；CCB `src/query.ts:761`新建executor，子代理`packages/builtin-tools/src/tools/AgentTool/runAgent.ts:776`另走query。这些是局部执行范围，不是父子共享root树大锁的先例。
- Pi/OpenCode/DeepSeek的文件能力保护见§3.9，普通read不参与其写队列，不能直接满足ohbaby较强的读写互斥目标。最小结构可沿“批次必要顺序＋共享文件读写准入＋独立容量/来源检查”组织；不必建立泛用资源图、策略注册器或Shell访问推断器。不同文件并行、路径规范化、等待取消和真实释放仍须实际证明。
- ohbaby `packages/ohbaby-agent/src/tools/read.ts:51`直接读取，`tools/utils/file-locks.ts:5,11`为内存路径队列；修C1不等于新增read保护。`tools/shell-job-registry.ts:357–369`校验job所属session/context scope，`:493,540`工具参数为job_id，`:305`逻辑terminal时kill直接返回。错误提示不能把callId当job_id，不能越权引导父代理管理子job。
- 路径处理已有可复用能力：ohbaby `packages/ohbaby-agent/src/sandbox/lease.ts:78–87`分别走realpath和canonicalizePathTarget，`utils/path-canonicalize.ts:18–43`处理缺失目标的真实父路径。C2应复用这些可信结果，统一调度/直接工具入口的锁key，而非新写一套路径解析器。保留旧类别write单项wave仍不满足C04的同批不同文件并行，不能作为最终验收方案。
- 同registry的内存Map和`runtime/run-ledger/database.ts:252`按owner进程存活修复run的现状，均不构成Shell后代停止证明。DeepSeek `packages/subprocess/subprocess-local/src/index.ts:154`持有handle直到waitForExit可借鉴为清理责任，不能扩展为跨重启接管保证。

2026-09-23用户已确认C2行为范围保持不变，采用批次顺序、共享文件保护、执行容量分开处理。后续细化执行容量，再讨论交付依赖及D23的模型可见文本和清理恢复边界。不要把上述几项一次打包成用户同意，也不根据“模型很少同时写两个文件”的未验证频率推断删除已确认能力。

## 3.13 普通工具数量上限：数值参考与建议

2026-09-23 用户最新决定采用每个会话独立的普通工具上限，默认10、后台可调整，替代此前工作区共享方案，等待审批/文件及父调用等待子汇报不占该名额。以下只读核对本地源码，未跑并发负载测试；不能将局部上限直接当成所有项目共有的workspace上限。

| 来源 | 实际规则 | 参考边界 |
|---|---|---|
| ohbaby当前 | `packages/ohbaby-agent/src/core/tool-scheduler/constants.ts:5–6`：maxReadConcurrency=5、maxSubagentConcurrency=3 | 原5仅读类（含network/skill），原写类还有互斥；不是改造后的统一普通工具上限 |
| DeepSeek Harness | `packages/core/agent-loop/src/constants.ts:6`默认maxParallelToolCalls=10；`tool-calls.ts:199`按inFlight数量补入新调用 | 一个agent step内parallel-safe工具的滚动池，不是整个工作区共享10 |
| Kimi | `packages/agent-core/src/loop/tool-scheduler.ts:38–61`按active/queued访问冲突判定 | 所查局部调度器没有统一数值上限；不能据此推荐无限执行 |
| Pi | `packages/agent/src/agent-loop.ts:411,539`选择顺序/并行，并行用Promise.all启动准备好的调用 | 所查路径未设固定普通工具数量上限 |
| Codex/本地CCB/OpenCode V2 | Codex `tools/parallel.rs:133`读写gate；CCB `StreamingToolExecutor.ts:156`按concurrency-safe准入；OpenCode `session/runner/llm.ts:271`工具fiber集合 | 所查路径没有可直接引用为工作区普通工具总量的默认数字，不拿agent数、线程数或其他专用限制代替 |

2026-09-23最新取舍：每会话默认10、后台可配置，实现限于简单计数和排队；没有工作区共享数量池。借鉴DeepSeek的局部滚动执行池，但ohbaby按会话计数，不能在换批次时遗忘仍占用名额的旧执行。结合Kimi局部顺序与Pi/OpenCode文件保护，数量控制不替代跨会话文件保护。所查参考项目不共同提供ohbaby的全部目标，10也不是性能最优结论。实施时验证单会话第11项排队、其他主/子会话仍可执行、同文件冲突仍受保护，以及取消/释放不漏计；不引入动态加权或自动调参。

## 3.14 名额归还与清理分开：D29的参考与最小改动

2026-09-23用户确认正常调用结束归还、后台Bash派遣成功归还，超时调用在清理责任和必要保护已经建立后也归还；文件保护和来源限制继续保留。这是ohbaby的组合取舍，不能宣称任一参考项目完整实现了同样的规则。

| 本地源码 | 可借鉴的事实 | ohbaby的取舍与边界 |
|---|---|---|
| DeepSeek `packages/core/agent-loop/src/tool-calls.ts:225`、`packages/subprocess/subprocess-local/src/index.ts:154` | 执行池随dispatch结算移除inFlight；进程provider保留live句柄直到waitForExit确认 | 借鉴调用名额与清理责任分开。其Bash等待handle.done、通用timeout仍await next，不代表它支持任意不合作工具按时返回，也没有我们的来源限制合同 |
| Pi `packages/coding-agent/src/core/tools/file-mutation-queue.ts:52` | await真实修改函数，finally才放开同目标写队列 | 保留真实操作结束才释放文件保护；Pi这段本身没有普通调用数量池，也没有ohbaby完整读写保护 |
| OpenCode V2 `packages/core/src/file-mutation.ts` / `writeIfUnchanged` | 在目标锁内读取、校验和写回 | 复用文件保护思路，不能把工具结算当作安全解锁；不将其写保护外推到任意Bash |
| Kimi `packages/agent-core/src/loop/tool-scheduler.ts` | 局部active/queued配合完成回调推进 | 借鉴局部简洁排队；包装Promise结算不证明副作用停止，不照搬为文件解锁信号 |
| ohbaby `core/tool-scheduler/scheduler.ts:1361,1416` | 现有deferredRelease在原toolPromise结束后才归还concurrency名额 | C需分开普通名额归还和真实资源释放，不能只删除延迟回调而漏掉清理所有权 |

SWE取舍：让原调度器只负责名额及等待推进，原文件保护只负责冲突，原后台任务/执行持有者继续负责清理。复用已有call/owner及取消链路，补最小内部责任交接；不建立通用资源图、第二套清理服务、动态配额、独立还槽计时器或专门前端状态。不能仅靠数量限制解决进程残留；也不能为了限制残留而长期占满普通调用名额。代价明确：后台job和已接管残留可能使物理操作数量超过每会话10。

## 3.15 有限清理观察时间：D30

用户确认Bash退出宽限200ms、强杀后最多观察1000ms；其他工具取消后观察最多1000ms。ohbaby的`shell/constants.ts:2`已有200ms，`tools/shell-job-registry.ts:18,447`已有1000ms等待；当前registry随后合成终态并不证明进程已停止，不能直接当作目标清理语义。OpenCode的`packages/core/src/shell.ts:12`辅助路径同为200ms，但V2 spawner另有forceKillAfter和等待退出逻辑，不能说所有路径统一200ms。DeepSeek的`packages/shell/bash-local/src/index.ts:35`默认为3000ms退出宽限，也不能与强杀后观察时间混为一谈。

本次沿用本地初始值并补齐到期未确认、保留保护的行为，不宣称竞品共同采用该时间组合；其他工具1000ms为本项目明确取舍。参数可注入测试，不新增前端倒计时、不增加还槽计时器、不自动续期；到期后的模型提示按D31。

## 3.16 资源阻塞后的模型提示：D31

Kimi `packages/agent-core/src/tools/builtin/collaboration/agent.ts:310`的USER_INTERRUPTED_SUBAGENT_MESSAGE明确说明用户主动中断，并直接要求不要自动重试。它处理的是用户中断，不是ohbaby的残留资源限制；可借鉴的是“说明原因并给出适当下一步”，不能混淆两种结果。

ohbaby `tools/shell-job-registry.ts:305,357,493,540`现状：task_output/task_kill接收job_id并检查session/context归属；terminal job的kill直接返回。故D31不向父代理许诺能控制子job，也不将重复kill作为通用恢复办法。沿普通工具结果给行为指引，真实资源准入仍由后端保证；先做不冲突工作，无法继续则说明原因，无需再建自动重试/轮询系统。

## 3.17 2026-09-23：Full Access、工具动效与 SQLite 忙等待

Full Access 免 MCP 人工审批是本项目用户确认的权限目标，不把参考项目的默认信任策略当作它的依据；第一轮 D22 已更新，第二轮只消费实施后的策略。界面借鉴 OpenCode 的简洁工具文字和 reduced-motion CSS，但其 `packages/session-ui/src/components/basic-tool.tsx:93` 把 pending/running 一起显示 shimmer；ohbaby 只在真实 executing 显示。OpenCode TUI `packages/tui/src/routes/session/index.tsx:2043` 的 Bash spinner 与 running 绑定，可借鉴这一阶段区分；ohbaby 当前 `packages/ohbaby-cli/src/tui/components/message/message-row.tsx:180` 仍将 pending/running 共用 spinner，需要调整。Pi 的工具行同样保持轻量，不把所有内部阶段铺到默认行。

下表只比较本地查到的实际存储路径，不把“用了异步 API/worker”直接等同于“SQLite 不会阻塞 Stop”：

| 项目 | 实际存储/线程边界 | 能借鉴什么；不能误读什么 |
|---|---|---|
| ohbaby 现状 | `services/database/connection.ts:91` 使用 `DatabaseSync`；`database/index.ts:111` 设 `busy_timeout=5000`；`database/busy-retry.ts:36–51` 有有限重试和 `Atomics.wait`；message、run-ledger、prompt、session 等写路径调用该辅助，snapshot/workspace-registry 还有直接 `BEGIN IMMEDIATE` | 保留结果先提交后发布；同步 SQLite 等锁及重试睡眠会堵住同一事件循环上的 Stop 和计时器。async 包装不改变执行线程；只改消息库的重试不能覆盖全部阻塞入口 |
| OpenCode V2 | `opencode/packages/core/src/database/sqlite.node.ts:1,49–66,151` 也是 `DatabaseSync`，`database/database.ts:29` 同设 `busy_timeout=5000`；`opencode/packages/opencode/src/cli/cmd/tui.ts:210` 为 TUI/后端 RPC 建 Worker | UI 与后端分开可避免 UI 线程一起卡；该 Worker **不是专门数据库 Worker**，后端自己的事件循环仍可能被 SQLite busy 等待堵住，不能当作 Stop 已解决的证据 |
| DeepSeek Harness | `deepseek-harness/packages/session/session-persistence-sqlite/src/schema.ts:82` 使用 `DatabaseSync`；同包 README §Limitations 明确同步 append 阻塞事件循环、无 busy timeout/retry；上层 `session-persistence/src/coordinator.ts:1123` 另有 write-behind | 明确揭示同步存储的代价；write-behind 是先内存接受、后批量持久化，不能满足 ohbaby 每项工具结果落盘后再宣告完成的既定合同 |
| Kimi | `kimi-code/packages/agent-core/src/agent/records/persistence.ts:99,112` 先追加内存 pending，再用 `node:fs/promises` 异步写文件 | 减少 JS 线程同步等待的思路可借鉴；append 返回不代表持久化已完成，不能原样用于 ohbaby 的结果可靠交付 |

2026-09-23 隔离临时 SQLite 两连接探针：一连接持 `BEGIN IMMEDIATE`，另一连接 `busy_timeout=1000` 再尝试 `BEGIN IMMEDIATE`，计划 100ms 的计时器约 1057ms 才运行。它证明 ohbaby 所用同步调用的阻塞机理，单靠这个探针不是 serve Stop 的 E2E。SWE/KISS 建议先测真实竞争，再尝试降低单次同步 busy 等待并核对争用失败率；若短争用因此频繁失败，才考虑事务开始前的非阻塞、有界重试；仍不达 Stop 响应目标，再考虑专门数据库 worker。专门 worker 需要跨线程传递请求、按原序提交、传回持久化确认及错误，停服时协调未完成事务；迁过去也必须等待提交确认后才能对外发布工具结果。这是候选方案，未把用户确认的 UI/权限决定扩写成对 worker 的授权。

同日已进一步运行[真实 serve SQLite 锁竞争诊断](../evidence/2026-09-23-sqlite-stop-contention.md)：前置 prompt 写入同步等锁时，假模型流的关闭时间从无锁约7ms延至持锁2.5秒时约2.6秒；只有锁、没有前置写入时，流约10ms关闭，但Stop RPC仍约2.54秒才回复。这是ohbaby当前代码的反例，未完成改造后T08验收。D34已明确取消信号与RPC/按钮等待的区别：1秒只验收取消受理及信号发出，界面原位反馈并等待可靠终态，不要求RPC同样在1秒内回复。

## 3.18 Stop反馈：借鉴执行事实，保留本项目的简洁界面

2026-09-23复核的checkout revision与§3.1相同。以下为源码证据，未对参考项目实测停止耗时，也不从Codex的TUI/app-server代码推断桌面按钮的具体动画。

| 项目 | 实际做法与锚点 | 本项目取舍 |
|---|---|---|
| Codex | `codex-rs/app-server/src/request_processors/turn_processor.rs:1346`登记pending_interrupts，提交Interrupt；收到TurnAborted后回复，见`bespoke_event_handling.rs:1045,1498` | 借鉴以真实结束事实收口，不要求整个Stop RPC在1秒内完成；不照搬Rust线程或另造协议 |
| Pi | `packages/agent/src/agent.ts:312`立即abort；`packages/coding-agent/src/core/agent-session.ts:1542`随后waitForIdle；TUI `interactive-mode.ts:3109`收到agent_end才移除Working | 借鉴发出取消与等待结束分开；ohbaby仅在现有Stop控件提供反馈，不恢复全程Working |
| OpenCode | App的`components/prompt-input/submit.ts:250`调用session.interrupt；`prompt-input-v2.tsx:130`的stopping实际是working且输入为空；`packages/session-ui/src/v2/components/prompt-input/index.tsx:663`显示Stop图标，没有独立“已点击、正在停止”spinner | 不把变量名stopping误读为后端正在停止。ohbaby补一个绑定本次run的本地操作等待，仍以后台事实结束 |
| Kimi Web | `apps/kimi-web/src/components/chat/Composer.vue:1130`按running显示Stop；`composables/client/useWorkspaceState.ts:1400`发abort并报告失败；查到的按钮没有单独停止spinner | 借鉴现有控件和错误入口；不把点击或RPC返回当作完整停止证明 |
| DeepSeek Harness | `packages/client/runtime/src/client/sessions/session.ts:302`取消返回accepted；`packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:544`及同包`chat/ChatView.tsx:401`继续按running驱动界面，失败写入promptError | 借鉴受理回执与运行事实的区别，复用错误展示；不采用全程Deep diving |

D34的原位spinner是用户确认的ohbaby交互，不是声称参考项目共同采用同一方案。可靠终态结束按钮等待、清理继续保留责任及保护；迟到回执按原run隔离。几秒后换提示文字属于可逆显示细节，不再另定执行期限、轮询服务或Stop持久状态表。
