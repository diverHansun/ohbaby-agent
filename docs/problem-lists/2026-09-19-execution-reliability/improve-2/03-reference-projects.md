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

证据：`opencode/packages/core/src/session/runner/llm.ts` :243–274,300、`packages/session-ui/src/components/basic-tool.tsx:205`、`tool-status-title.tsx:23`。工具行TextShimmer、按需展开；**采用**轻量表达，不把后台枚举变成一排标签。

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

**没有采用的组合提案：**“停止确认超时后，自动让受阻工具返回未执行并恢复主代理，同时保留锁”。本次核对的Pi/OpenCode/DeepSeek路径没有该完整机制，用户已选择不引入。DeepSeek的aborted-before-dispatch是整轮取消后的未派发结果，不能冒充上述机制。

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
