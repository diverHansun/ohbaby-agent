# 3. 六个参考项目与采用边界

> 2026-09-21 对本地源码再次核验，未运行这些项目的测试。路径相对 `/Users/hansun025/Projects/code-cli/`，行号为调查快照，符号优先。HEAD 不保证工作树没有本地改动；不把局部函数、示例或注释推导成整个产品保证。

## 3.1 版本与调查范围

| 项目 | 目录 | HEAD | 本轮重点 |
|---|---|---|---|
| Kimi Code | `kimi-code` | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` | turn 身份、后台任务停止、失主状态 |
| OpenCode | `opencode` | `d4ad650f738aaa986cee5879c581bd4834277577` | stopping、后台结果 token、遗留工具记录、输入框 |
| Pi | `pi` | `57cde86906679fd0581b277a179ab46fa2a09ab6` | abort/idle、信号退出、队列交互 |
| Claude Code 本地重建版 | `claude-code` | `987e55034c38497e1081367fdbe2056a6603ebc7` | generation、agent 所属 shell、退出兜底 |
| Codex | `codex` | `5c19155cbd93bfa099016e7487259f61669823ff` | 中断与清理、关闭报告、历史封口、输入恢复 |
| DeepSeek Harness | `deepseek-harness` | `47f943859bef60e4160492346772ded9b24f765a` | 树停止与创建竞态、进程清理、冷恢复修复 |

Claude 目录的 [AGENTS.md](../../../../../claude-code/AGENTS.md) 说明它包含反编译/重建与 stub，不是官方实现保证。OpenCode 的 V1 `packages/opencode` 与 V2 `packages/core` 不能拼成一套已经落地的完整能力。

## 3.2 Codex：停止、关闭报告与历史封口

- [session/handlers.rs](../../../../../codex/codex-rs/core/src/session/handlers.rs)：L63 interrupt 与 L67 clean_background_terminals 为不同操作。**采用**取消与清理分开建模；**不采用**默认保留本任务后台工作的产品选择，ohbaby Stop 覆盖所属 job。
- [tasks/mod.rs](../../../../../codex/codex-rs/core/src/tasks/mod.rs)：`handle_task_abort` L834 发取消、有限宽限后 abort handle，并尝试写中断 marker/flush；L789 附近用 `Arc::ptr_eq` 防旧 task 清理新 active turn。**采用**执行身份检查与有界协作停止；**不照搬**其历史保存失败只 warn 的处理作为 ohbaby 停止登记成功。
- [thread_manager.rs](../../../../../codex/codex-rs/core/src/thread_manager.rs)：`shutdown_all_threads_bounded` L898 并发等待，报告 Complete/SubmitFailed/TimedOut，只从 manager 移除已完成者。**采用**关闭结果分类；它不证明服务 OS 进程已经退出，ohbaby `serve stop` 需外部观察。
- [context_manager/normalize.rs](../../../../../codex/codex-rs/core/src/context_manager/normalize.rs)：`ensure_call_outputs_present` L18 为缺少普通工具输出的调用补 synthetic aborted；ToolSearchCall 另有 completed/空 tools 的特殊封口。**采用**历史 tool-call/result 配对修复；**调整**为明确 not-started/unknown 证据和恢复来源，不能认为合成结果证明副作用撤销。
- [session/input_queue.rs](../../../../../codex/codex-rs/core/src/session/input_queue.rs)：清理当前 turn 的缓冲输入/等待者，不等于删除所有用户普通排队消息。**采用**内外队列边界，ohbaby 用户队列按 D2/D6 分别处理。

对 02 的影响：§2.3 身份防护、§2.5 关闭报告、§2.6 协议封口。ohbaby 停止登记失败阻止会话继续，是本方案自己的可靠性要求。

## 3.3 Kimi：旧 turn 防护与 lost 记录

- [agent/turn/index.ts](../../../../../kimi-code/packages/agent-core/src/agent/turn/index.ts)：L259 cancel(turnId) 忽略非当前 ID；L367 附近 finally 通过 launch signal 检查拥有当前 turn。**采用**旧取消/旧 finally 不能影响新执行。
- [session/subagent-host.ts](../../../../../kimi-code/packages/agent-core/src/session/subagent-host.ts)：L239 cancelAll 排除 runInBackground。**不采用**这种 Stop 范围，ohbaby 要取消当前树的前后台后代。
- [agent/background/index.ts](../../../../../kimi-code/packages/agent-core/src/agent/background/index.ts)：L608 loadFromDisk 时 live 优先；L626 将非终态 ghost 记 lost 并持久化。**采用**失去句柄后不冒充仍可运行；lost 不证明外部进程已经死亡。
- 同文件 `settlementForOutcome` L894：abort 后等待宽限，必要时调用可选 forceStop，再结算 killed/timed_out；forceStop 错误可被吞。**只借鉴**分阶段停止，不把 killed 当作清理 confirmed 的证据。该宽限属于单任务，不是整个服务期限。
- [session/index.ts](../../../../../kimi-code/packages/agent-core/src/session/index.ts)：L422 退出时停止后台任务，有 keepAliveOnExit 例外。ohbaby 的服务关闭范围由本轮所属环境定义，不引入该例外开关。

对 02 的影响：§2.2 owner/执行身份，§2.4 清理结果，§2.6 保守恢复。用户 Stop 后自动推进普通消息是 ohbaby 自己确认的规则，不以 Kimi 的具体配置作为契约。

## 3.4 DeepSeek Harness：先停接活、再清理，恢复只修记录

- [subagent continuation.ts](../../../../../deepseek-harness/packages/subagent/subagent/src/continuation.ts)：`dispose` L1281 先安装同一个 disposal Promise 作为 admission cutoff；`finishDisposal` L1297 先向下 cancel，再等子级、idle、flush 和 handle.dispose。**采用**创建/停止的同一资格边界、先停止后释放；ohbaby 在此基础上允许新主 Run 与旧清理并存，不照搬完整树释放前都不可交接。
- 同文件 interrupt 使用 keepInbox，后来唤醒可继续未领取输入。**不采用**：ohbaby D4 要求旧子待办退队，实例复用只执行新指令。最终 flush 含 best-effort 路径，不能把它描述为落盘失败必然阻止释放。
- [subprocess-local/spawn.ts](../../../../../deepseek-harness/packages/subprocess/subprocess-local/src/spawn.ts)：L439 terminate 负责 TERM→KILL，leader 结束不自动撤销对存活进程树的升级；[index.ts](../../../../../deepseek-harness/packages/subprocess/subprocess-local/src/index.ts) L146 附近保留 live 集合直到 waitForExit，而非只看逻辑 done。**采用**清理 owner 活得比调用结果更久，接到 ohbaby 第二轮机制。
- [session/repair.ts](../../../../../deepseek-harness/packages/core/session/src/repair.ts)：L12/L15 区分 TOOL_NOT_STARTED 与 TOOL_OUTCOME_UNKNOWN；`interruptedTurnClosers` 只补未闭合尾部、保留完成结果，不执行工具。**采用**补记录、不重跑的边界；不照搬它按缺少 call 记录判断 not-started 的规则。2026-09-24 补查其 agent-loop 在 prepare/dispatch 前 append 调用，但 session append 先进入内存、持久化层另行写盘，不能据此证明副作用前已经可靠落盘。ohbaby 已确认保留第二轮的实际开始采样、随后保存，不增加执行前持久标记；缺少可靠终态且无法证明未执行的新旧调用都按 unknown 恢复，具体见 02 §2.6/04 T21。
- [session-persistence/coordinator.ts](../../../../../deepseek-harness/packages/session/session-persistence/src/coordinator.ts)：L891 校验并区分格式不支持/损坏；L934 commitPrepared 检查 live owner 与 revision，commitRepair 后重读；L1274 附近 HMR live adoption 不做 cold repair。**采用**先校验、幂等修复、重读、冷热分流。这里的 live owner 主要是进程内协调，不能充当 ohbaby 多进程数据库保护的现成实现。

对 02 的影响：§2.3 停止/创建竞争，§2.4 资源存续，§2.6 恢复顺序与错误类型。不引入其整套事件存储或跨进程子代理驱动。

## 3.5 OpenCode：停止资格与未完成工具记录

- V1 [session/run-state.ts](../../../../../opencode/packages/opencode/src/session/run-state.ts)：L80 取消关联后台工作，L116 附近按关联 metadata 遍历；[tool/task.ts](../../../../../opencode/packages/opencode/src/tool/task.ts) 的中断处理取消子会话。**采用**取消传播到关联工作，ohbaby 改为本次 rootRun/execution 范围。
- V2 [session/run-coordinator.ts](../../../../../opencode/packages/core/src/session/run-coordinator.ts)：L94 设置 stopping、清 pendingWake、interrupt owner。**采用**阻止旧自动唤醒；其等待交接策略不直接证明 ohbaby 的 B 与旧清理并行已安全。
- V2 [background-job.ts](../../../../../opencode/packages/core/src/background-job.ts)：L126 settle 用 token/sequence 防旧结果覆盖；L113 明确 registry 为 process-local/non-durable。**采用**代次防护，**不宣称**它具备跨重启后台任务接管。
- V2 [session/runner/llm.ts](../../../../../opencode/packages/core/src/session/runner/llm.ts)：L119 failInterruptedTools 修复 pending/running 工具状态；L86 注明完整 durable continuation recovery 是未来范围。**采用**会话内状态修复，不能将它描述为完整冷恢复系统。

对 02 的影响：§2.3 资格和迟到事件，§2.6 陈旧工具记录。V1/V2 分开提供局部依据，不据此添加新 execution runtime。

## 3.6 Pi：取消信号与真正 idle

- [agent.ts](../../../../../pi/packages/agent/src/agent.ts)：L312 abort 只发信号；L321 waitForIdle 等 activeRun 及被等待的 agent_end listeners。**采用**取消/逻辑结束/清理的区别；不能推断任意插件工具均能强制停止。
- [interactive-mode.ts](../../../../../pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts)：L3708 起处理 SIGTERM/SIGHUP 并正常 shutdown。**采用**可处理信号走统一退出；Command+Q/断电仍无完成保证。
- [tools/bash.ts](../../../../../pi/packages/coding-agent/src/core/tools/bash.ts) L126 与 [utils/shell.ts](../../../../../pi/packages/coding-agent/src/utils/shell.ts) L200：取消时发进程树终止，再等待直接子进程和输出收尾。[child-process.ts](../../../../../pi/packages/coding-agent/src/utils/child-process.ts) 可在直接 child 退出后按管道空闲结束。**采用**发信号后继续观察，不能把该结果当作全部后代已退出的证明，也不承诺远端工具撤销。
- 子代理扩展示例使用 `--no-session`，不是持久子代理恢复方案，不纳入 ohbaby 冷恢复依据。

对 02 的影响：§2.3 主逻辑结束条件、§2.5 信号/宿主边界。

## 3.7 Claude Code 本地重建版：generation 与退出兜底

- [QueryGuard.ts](../../../../../claude-code/src/utils/QueryGuard.ts)：L74 end 检查当前执行代次，L88 forceEnd 使旧代次失效，防旧轮结束污染新轮。路径/符号以本地重建版为准，属于可借鉴机制而非官方承诺。
- [killShellTasks.ts](../../../../../claude-code/src/tasks/LocalShellTask/killShellTasks.ts)：按 agentId 清理所属 shell；[AgentTool/runAgent.ts](../../../../../claude-code/packages/builtin-tools/src/tools/AgentTool/runAgent.ts) L874 起 finally 清理 agent 所属后台 shell。**采用**精确归属，ohbaby 还需细分同一实例的每次 execution。
- [gracefulShutdown.ts](../../../../../claude-code/src/utils/gracefulShutdown.ts)：L409 起有最终退出计时器，L448 起 cleanup race；部分错误被忽略。**采用**进程退出兜底，**不采用**用忽略错误证明清理成功。其期限随 hook 变化，不复制为 ohbaby 配置面板。
- TERM/HUP 的信号处理可以借鉴到 CLI 宿主；底层可嵌入 runtime 不直接退出整个进程。

对 02 的影响：§2.3 旧 finally 防护，§2.4 所属资源，§2.5 退出上限及错误报告。

## 3.8 输入框交互和术语不能照搬

Codex [input_restore.rs](../../../../../codex/codex-rs/tui/src/chatwidget/input_restore.rs) L145 起中断后把排队输入合并回 composer；[interaction.rs](../../../../../codex/codex-rs/tui/src/chatwidget/interaction.rs) L109 起支持把最近 queued 取回编辑。OpenCode [TUI session](../../../../../opencode/packages/tui/src/routes/session/index.tsx) L604 起的 undo/revert 把消息带回 prompt。它们支持“复用原输入框”的方向，**不证明**与 ohbaby 相同的重启持久队列协议。

ohbaby 不采用 Codex 的 Stop 后合并全部 queued 行为，也不要求用户 undo 会话来修改未发送消息。铅笔/垃圾箱、保存/发送区分、重启仅手动发送一条，来自用户确认 D6/D7。

| 项目术语 | 实际边界 | 对 ohbaby 的启发 |
|---|---|---|
| Codex Turn、内部 StepContext | 一个 Turn 可包含多次模型与工具 | 大致对应一次受管理 Run，不能把所有 turn 当单 Step |
| Kimi turn / step / attempt | 普通后续 prompt 有新 turn 身份；请求重试另计 | 执行身份与请求尝试分开 |
| Pi agent run / turn | 外层 run 可连续消费 followUp，turn 接近一次助手与工具 | followUp 不一定新建外层 run |
| OpenCode V2 外层 drain / 内层 loop | 后续输入可以由同一 drain 接续，step 重置 | 没有与 ohbaby 相同的持久 runId，不能逐字段对齐 |
| Claude query / turnCount | query 内工具后循环增加计数 | turnCount 不是稳定用户任务身份 |
| DeepSeek driver / turn / step | 同一 driver 推进多 turn，step 内可 retry | 长寿命驱动对象与一次任务分开 |

术语证据可结合 [Codex turn.rs](../../../../../codex/codex-rs/core/src/session/turn.rs)、[Pi agent-loop.ts](../../../../../pi/packages/agent/src/agent-loop.ts)、[DeepSeek agent.ts](../../../../../deepseek-harness/packages/core/agent-loop/src/agent.ts) 及上述 Kimi/OpenCode 文件核对。**ohbaby 普通 prompt 新 runId 的直接证据是自己的 submitPromptInternal，不是竞品共识。**

## 3.9 从参考到本轮契约

| 02 内容 | 参考机制 | ohbaby 必须自行补足 |
|---|---|---|
| §2.3 停止整树 | DeepSeek admission cutoff；OpenCode stopping；Kimi/Codex 身份检查 | 本次委托树、旧待办退队、停止登记成功后推进 B |
| §2.4 清理 | Pi abort/idle；DeepSeek waitForExit | 与第二轮锁/lease 接线，不将 cancelled 当 confirmed |
| §2.5 关闭 | Codex shutdown report；Claude 退出计时器 | 外部确认原服务进程结束、token 防误操作、错误不吞 |
| §2.6 冷恢复 | DeepSeek repair/commit/reload；Kimi lost；Codex/OpenCode 工具封口 | SQLite 多 store、入队 owner、失败隔离、禁止重跑 |
| §2.7 消息操作 | Codex/OpenCode 原输入框复用 | retained 单条准入、草稿保护、铅笔/垃圾箱；无继续按钮 |

## 3.10 2026-09-22：正常静默与异常阻塞的取舍

本次补查沿停止后的后继执行、资源等待和实际 UI 接线阅读源码与测试；未运行参考项目。没有在所查六项目路径中找到与 ohbaby 完全相同的“旧清理异常限制新调用，再走专门前端提示”的闭环，不用通用错误组件或看起来安静的界面证明该场景已有答案。

| 项目 | 已查实的后继行为 | ohbaby 采用及限制 |
|---|---|---|
| OpenCode V1 | [runner.ts](../../../../../opencode/packages/opencode/src/effect/runner.ts) L171 cancel先置Idle，再等旧fiber中断；[runner.test.ts](../../../../../opencode/packages/opencode/test/effect/runner.test.ts) L207明确测试A清理未完时B已启动，旧收尾不清B状态 | 采用逻辑交接与旧身份防护；测试不证明未知残留Shell的文件隔离 |
| OpenCode V2 | [run-coordinator.ts](../../../../../opencode/packages/core/src/session/run-coordinator.ts) L67 stopping时等done；[测试](../../../../../opencode/packages/core/test/session-run-coordinator.test.ts) L247/L285覆盖清理期间wake/resume | 作为不同交接选择的对照，不将V1/V2合成同一保证，不照搬等待完整收尾的规则 |
| Pi | [write.ts](../../../../../pi/packages/coding-agent/src/core/tools/write.ts) L203明确取消不得提前释放真实写入的队列；[file-mutation-queue.ts](../../../../../pi/packages/coding-agent/src/core/tools/file-mutation-queue.ts) L32–59等真实操作结束，无等待截止；agent通常等工具返回才清activeRun | 保留真实资源保护；不照搬无限等待，也不声称存在旧清理专用提示 |
| DeepSeek | [bash-local](../../../../../deepseek-harness/packages/shell/bash-local/src/index.ts) L224前台等handle.done；[subprocess-local](../../../../../deepseek-harness/packages/subprocess/subprocess-local/src/index.ts) L146独立保留live直到waitForExit | 采用结果与清理责任分离；未见旧树存活自动限制后续Shell/文件访问的同等入口 |
| Kimi | [turn](../../../../../kimi-code/packages/agent-core/src/agent/turn/index.ts) L308取消清activeTurn，L367检查旧signal；[background](../../../../../kimi-code/packages/agent-core/src/agent/background/index.ts) L927强停异常被吞后仍结算killed | 采用执行身份；不以该结算证明真实停止，不据其UI推导ohbaby异常资源准入 |
| Codex | [handlers](../../../../../codex/codex-rs/core/src/session/handlers.rs) L63/L67分开中断与后台终端清理；[process manager](../../../../../codex/codex-rs/core/src/unified_exec/process_manager.rs) L1437单终端终止返回结果 | 采用操作范围和结果诚实表达；后台清理范围不同，没有可直接复制的来源主会话限制UI |
| Claude本地重建版 | [REPL](../../../../../claude-code/src/screens/REPL.tsx) L2597取消时forceEnd；[QueryGuard](../../../../../claude-code/src/utils/QueryGuard.ts) L74/L88旧generation隔离；[killShellTasks](../../../../../claude-code/src/tasks/LocalShellTask/killShellTasks.ts) L16清理错误只记日志后标killed | 采用代次保护，不把日志/结算当资源退出确认；重建版不代表官方产品保证 |

**已确认的 ohbaby 选择：** 正常清理不新增通知；Stop沿第二轮D34提供原按钮等待反馈，可靠终态后结束，不等残留清理；主执行退出并可靠登记后启动下一普通任务。前置 C 继续持有未释放资源；清理失败或有限观察后未确认且实际阻塞新调用时，仅该尚未执行调用返回普通资源错误，通过第二轮既有工具结果通道交付，不另建清理提示。不是无条件放行，也不是用“未执行”改写旧操作事实。这个异常准入出口是用户确认的本项目取舍，不是六项目共同默认行为。

## 3.11 2026-09-22：停止登记失败、有限重试与恢复入口

补查持久化实现与现有测试源码，未运行参考项目。以下项目都不能直接证明“刷新页面就能修复 Stop 登记并自动推进下一任务”的完整产品行为。D11 是 ohbaby 自己确认的契约，采用的是局部机制。

| 项目 | 实际代码与测试证据 | 采用与不采用 |
|---|---|---|
| Codex | [recorder.rs](../../../../../codex/codex-rs/rollout/src/recorder.rs) L1555保留未写成功后缀，L1603重开文件立即再试一次，L1726后续AddItems/Persist/Flush/Shutdown可再次写入；[recorder_tests.rs](../../../../../codex/codex-rs/rollout/src/recorder_tests.rs) L650/L703覆盖失败保留与重试。Stop的[tasks/mod.rs](../../../../../codex/codex-rs/core/src/tasks/mod.rs) L834两处flush最终失败仍warn，L492的abort结束后可推进pending | 采用失败内容保留、有限重试、后续存储操作触发；不照搬最终保存失败仍推进B。flush成功也不能笼统称作覆盖所有断电风险的fsync保证 |
| OpenCode V2 | [llm.ts](../../../../../opencode/packages/core/src/session/runner/llm.ts) L119的failInterruptedTools在L383每次run前调用，成功后才进入模型；[session-runner.test.ts](../../../../../opencode/packages/core/test/session-runner.test.ts) L2198验证resume前持久补齐旧进程遗留工具；[event.test.ts](../../../../../opencode/packages/core/test/event.test.ts) L192验证事务提交失败回滚 | 采用执行入口先补记录、提交成功才继续；其resume/wake不是页面刷新，也没有同等专用blocked恢复状态。V1先置Idle的取消策略见§3.10，不混成V2保证 |
| DeepSeek | [write-behind.ts](../../../../../deepseek-harness/packages/session/session-persistence/src/write-behind.ts) L44新事件可重新触发自动写，L63共享flush，L139失败批次放回队首并暂停自动写；[coordinator.ts](../../../../../deepseek-harness/packages/session/session-persistence/src/coordinator.ts) L974加载活会话快照先flush，L934拒绝对活owner做cold repair，L1154 flush成功后才移除原live状态 | 采用保留内容、并发合并、冷热分流；加载时flush可作补充入口参考，但不证明浏览器刷新闭环。ohbaby仍须自己提供关键登记与队列交接保证 |
| Kimi | [persistence.ts](../../../../../kimi-code/packages/agent-core/src/agent/records/persistence.ts) L99/L112/L134写失败留下持续error，后续append/flush继续throw；[persistence.test.ts](../../../../../kimi-code/packages/agent-core/test/agent/records/persistence.test.ts) L191验证此行为；[turn/index.ts](../../../../../kimi-code/packages/agent-core/src/agent/turn/index.ts) L259取消前先logRecord | 采用保存错误明确暴露；不照搬持续error挡取消的顺序，不宣称重开活会话会清除该错误 |
| Pi | [session-manager.ts](../../../../../pi/packages/coding-agent/src/core/session-manager.ts) L1015同步写文件，L1044先改内存再persist；[agent.ts](../../../../../pi/packages/agent/src/agent.ts) L471 finally清activeRun；[agent-session.ts](../../../../../pi/packages/coding-agent/src/core/agent-session.ts) L1061 finally还有待保存Bash消息可能抛错 | 未发现专门的持久化blocked/重开修复状态；不能以activeRun清除证明保存完成，也不能承诺任何存储故障都能正常idle |
| Claude本地重建版 | [useLogMessages.ts](../../../../../claude-code/src/hooks/useLogMessages.ts) L67异步发起recordTranscript；[sessionStorage.ts](../../../../../claude-code/src/utils/sessionStorage.ts) L1445按消息身份筛选后追加历史 | 仅作历史保存与UI异步的局部对照，不据此宣称可靠重试或Stop持久化交接已有实现，更不代表官方产品保证 |

**对 02 §2.6 的具体影响：** 原执行环境保留停止事实；关键保存有限重试，失败后不重复调度、不吞错误。重连、进入会话和下一次执行入口调用同一后端恢复检查；普通读操作不成为写入循环。原owner可靠补登记后才条件领取仍有效的queued，shutdown/owner结束后不得重新开放。跨环境按冷恢复规则保留待发送，不自动重跑旧任务。对应验收为T09、T38～T40。

## 3.12 2026-09-22：Steer未发送与输入区提示

用户截图与[浏览器回顾的共享对话](https://chatgpt.com/s/cx_6ab227e422d08191b0be5a881230ee12)确定位置和英文文案。截图中的队列暂停/Continue不属于采用范围；用户最新确认优先于共享对话中先前撤回的建议。

- Codex [input_restore.rs](../../../../../codex/codex-rs/tui/src/chatwidget/input_restore.rs) L145/L208在普通手动中断时恢复pending steers及队列草稿到composer；[review_mode.rs](../../../../../codex/codex-rs/tui/src/chatwidget/tests/review_mode.rs) L748测试未确认steer回填、不自动发送、没有对应user历史插入；[user_messages.rs](../../../../../codex/codex-rs/tui/src/chatwidget/user_messages.rs) L577以实际drain后的committed消息确认。另有主动中断以提交Steer的特殊分支，不能与普通Stop混淆。
- Pi [agent-session.ts](../../../../../pi/packages/coding-agent/src/core/agent-session.ts) L1371先放入steering队列，L595在message_start移除pending；[interactive-mode.ts](../../../../../pi/packages/coding-agent/src/modes/interactive/interactive-mode.ts) L4051取消时取回队列文字并合并到editor。该回填是TUI行为，不是core abort的通用保证。

**采用**输入接受与实际消费分开、不丢用户文字；**调整**为ohbaby第三轮持久输入/请求证据。ohbaby已接受Steer本来就保存为原任务用户消息，不照搬合并回输入框或恢复整个队列。新英文提示只表示可确认未送入，不表示模型理解程度；由第四轮展示在queued卡片上方，第三轮负责提供可恢复证据，T56→本轮T41验证。

## 3.13 2026-09-23：迁移与字段保持最小

本次重新核对以下本地实现；未运行参考项目的迁移。借鉴具体机制，不把参考项目更宽的兼容承诺变成 ohbaby 的需求。

| 项目/证据 | 实际做法 | 本轮采用边界 |
|---|---|---|
| OpenCode [storage.ts](../../../../../opencode/packages/opencode/src/storage/storage.ts) L225，旧文件存储迁移 | 读取版本标记、依次执行 MIGRATIONS，成功后更新标记；失败记录并停止后续步骤 | 借鉴按版本推进；其文件迁移不是 SQLite 事务，不照搬失败后返回 storage 的行为作为执行可继续的依据 |
| Codex [state/migrations.rs](../../../../../codex/codex-rs/state/src/migrations.rs) L12，runtime_migrator | 明确允许旧二进制打开已被新版迁移的库，ignore_missing 放宽未知较新迁移检查 | 作为不采用的对照：ohbaby 只支持旧数据升级后由新程序使用，不承担新旧程序混用同库 |
| Kimi [background/index.ts](../../../../../kimi-code/packages/agent-core/src/agent/background/index.ts) L608/L626 | live 任务优先，重载遗留非终态标 lost 并保存 | 采用保留记录、修正失主状态；不能证明 ohbaby 另一个 TUI/serve 已退出 |
| DeepSeek [coordinator.ts](../../../../../deepseek-harness/packages/session/session-persistence/src/coordinator.ts) L934 | 活持久化 owner 存在时拒绝 cold repair，修复前后核对版本并重读 | 采用不误动活执行和幂等核对；进程内 owner 检查不等于全机写入者探测 |

ohbaby 自己已有 `services/database/index.ts::applyMigration/runMigrations` 的事务和版本表，直接复用。普通 prompt 接受与执行由同一 backend/store 承担，因此复用一对 owner 是本项目代码支持的简化，不宣称六个项目都有同样字段。必须保存的业务事实是入队归属、retained 执行资格、本次接受时间和恢复来源；不为这些事实再建通用迁移/恢复平台。对应 02 §2.2/§2.9、04 T19/T20/T26～T29/T43。

返回：[本轮入口](README.md)。
