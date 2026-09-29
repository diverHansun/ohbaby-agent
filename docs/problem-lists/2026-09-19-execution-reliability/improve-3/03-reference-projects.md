# 3. 参考项目与本轮取舍

> 2026-09-20 本地源码调查；2026-09-21 补查等待期限、有限执行事实及 ZCode。路径相对于 `/Users/hansun025/Projects/code-cli/`。本次未运行参考项目，不将注释、示例或实验路径当成所有版本的产品保证。

## 3.1 来源版本

| 项目                     | 本地目录           | 调查 HEAD                                  |
| ------------------------ | ------------------ | ------------------------------------------ |
| Kimi Code                | `kimi-code`        | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` |
| OpenCode                 | `opencode`         | `d4ad650f738aaa986cee5879c581bd4834277577` |
| Pi                       | `pi`               | `57cde86906679fd0581b277a179ab46fa2a09ab6` |
| Claude Code 本地重建版   | `claude-code`      | `987e55034c38497e1081367fdbe2056a6603ebc7` |
| Codex                    | `codex`            | `5c19155cbd93bfa099016e7487259f61669823ff` |
| DeepSeek Harness         | `deepseek-harness` | `47f943859bef60e4160492346772ded9b24f765a` |
| ZCode（2026-09-21 补查） | `ZCode`            | `872ad960de7ec172591f7e1952f7849229f94521` |

当前工作树可能有本地改动；HEAD 是定位快照，不能据此声称每个文件均无修改。下列源码位置以符号为准。

## 3.2 Kimi：结束边界自动等待与文件结果

- `packages/agent-core/src/agent/turn/index.ts:772` 的 `shouldContinueAfterStop` 在 `printDrainAgentTasksOnStop` 开启时检查后台 agent 任务，等待结束、flush Steer buffer，再继续同一 turn。`apps/kimi-code/src/cli/run-prompt.ts:345` 开启 print 场景，普通 agent 默认关闭。
- `agent/background/index.ts:546` 的 `waitForActiveTasks` 使用 Promise.all 等一批 active 任务，再重新枚举。它不因任意一个完成就返回，Steer 也不会唤醒该等待，只会缓冲。判定按 manager active agent tasks，不带 ohbaby 所需的本用户任务关联。
- 补查：该方法没收到总期限时，内部 `wait(taskId, undefined)` 使用 L516 的默认 30 秒，之后再枚举；这是程序定时检查，不是每 30 秒请求主模型。子任务另有 deadline 和 abort 收尾；不能将它们等同为主代理重新判断的期限。
- `session/subagent-host.ts:333` 提取最后 assistant text；过短时可请求同一个子代理补充一次。`agent/background/agent-task.ts:43` 把结果交 sink 写入，再 settle。
- `agent/background/persist.ts:35` 写 `<parentAgentHome>/tasks/<taskId>/output.log`（构造参数虽名sessionDir，实际传agent.homedir；默认会话根下的agents/main，非直接session根）；默认应用 home 来自 `config/path.ts`，会话目录来自 `session/store/session-store.ts`。
- `agent/background/index.ts:753` 自动 `turn.steer`；父忙时缓冲，父 idle 时可新开 turn。有完整文件时通知给路径/大小，不是短正文/长文件分流。
- 读取工作区外文件主要靠通用 Read 默认规则与绝对路径策略，不是“本父任务产物”的专属授权。

**采用**：模型正常结束前由运行时检查；子代理写答复、系统保存；完成自动进入父输入。**调整**：任一终态/Steer 唤醒，限定当前任务、持久待交付、短长分流。**不采用**：普通交互结束后默认另开 turn、等全部完成才处理、通用外部读放行范围、短输出再请求补写的策略。

## 3.3 Codex：输入/通知与等待共享信号

- [父会话投递](../../../../../codex/codex-rs/core/src/session/mod.rs)：约 L1892，InterAgentCommunication、`trigger_turn=false`，交付和另开轮次分离。
- [终态格式化](../../../../../codex/codex-rs/core/src/session_prefix.rs)：L27 起，Completed 携带最终文本；Interrupted 在此明确不生成通知。ohbaby 的中断通知来自自身产品要求。
- [输入队列](../../../../../codex/codex-rs/core/src/session/input_queue.rs)：L49 起先订阅再检查，消息先入队再发布 mailbox activity；Steer 同样先追加 pending input 再发信号。
- [V2 等待实现](../../../../../codex/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)：L178 起等待 activity 或 timeout。借鉴内部机制，不复制模型 wait 工具。
- 补查：V1/V2 默认单次等 30 秒，期限到后返回 timed_out，不取消子代理；在任务仍可继续时，工具返回使主模型有机会重新判断。V2 订阅关闭也返回 timed_out，未将关闭与正常超时区分。参数/默认值见 `core/src/config/mod.rs:209`、`tools/handlers/multi_agents_common.rs:25` 和 V2 wait 的 L50；这不是父 lifecycle 默认自动等待整树的实现。
- `session/mod.rs:3864` 在 active turn 锁内校验 expected_turn_id 与可接受条件；[turn.rs](../../../../../codex/codex-rs/core/src/session/turn.rs) 在下一模型请求前消费输入，不修改已经发出的请求。
- [协议父子关系](../../../../../codex/codex-rs/protocol/src/protocol.rs)：约 L2798，ThreadSpawn 持久 parent_thread_id/depth/path；不能用它代替本次用户任务执行集合。
- [TUI 路由](../../../../../codex/codex-rs/tui/src/app/thread_routing.rs)：约 L606，expected turn mismatch 后可能按 actualTurn 重试。ohbaby 明确不采用，防止 Steer 串入下一任务。

**采用**：信号与数据分离、先订阅再检查、expected target、安全边界消费、用户界面队列项旁的 Steer 交互方向。**调整**：持久幂等输入、严格队列转入、当前任务结果收齐。**不采用**：模型侧 wait、旧目标自动重试新轮、中断不通知。所查内存 mailbox 不构成跨重启恰好一次交付的证据。

## 3.4 OpenCode：最终文本与内部输出读取规则

- [task.ts](../../../../../opencode/packages/opencode/src/tool/task.ts)：L200 起获取子会话最后文本；L216 起后台完成把全文包装为 synthetic prompt 注入父会话。background 模式受实验开关约束，不代表整个 Task 工具受开关约束。
- [tool.ts](../../../../../opencode/packages/opencode/src/tool/tool.ts)：L130 起通用 wrapper 调 truncate；[truncate.ts](../../../../../opencode/packages/opencode/src/tool/truncate.ts) 保存完整长输出到 `Global.Path.data/tool-output/tool_<id>`，默认 2000 行/50 KiB 展示阈值。
- `tool/truncation-dir.ts` 与 `packages/core/src/global.ts` 定义应用数据目录；不在用户项目。截断文件有清理期限，不是永久会话报告。
- [agent.ts](../../../../../opencode/packages/opencode/src/agent/agent.ts)：L296 起加入工具输出目录 external_directory allow；[read.ts](../../../../../opencode/packages/opencode/src/tool/read.ts)：L250 起仍检查 external_directory/read 权限。规则不是按父子归属细分。

**采用**：答复原文可保存应用目录；通用 Read；内部输出有专门读取规则。**调整**：按执行归属登记只读产物、随会话清理、无截断预览、SQLite 为权威。**不采用**：整个工具输出目录的宽范围授权、固定短期清理。

必须区分：通用工具结果截断落盘，与后台完成全文注入是不同路径；不能写成 OpenCode 已经实现 ohbaby 这套后台长结果文件交付。

## 3.5 Claude Code 本地重建版：自动通知和内部路径

- [LocalAgentTask.tsx](../../../../../claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx)：L300 起构造 task-notification，包含 taskId/output-file/status/summary，可带 finalMessage，然后 enqueuePendingNotification。
- [diskOutput.ts](../../../../../claude-code/src/utils/task/diskOutput.ts)：L33 起路径为 project temp/session/tasks/taskId.output；L424 起提供输出符号链接初始化。
- LocalAgentTask 约 L540 把子代理 output 链接到 `getAgentTranscriptPath`；[sessionStorage.ts](../../../../../claude-code/src/utils/sessionStorage.ts)：L248 起子代理会话 JSONL 存档。
- [TaskOutputTool.tsx](../../../../../claude-code/packages/builtin-tools/src/tools/TaskOutputTool/TaskOutputTool.tsx)：L97 起优先取内存中的干净最终答复，而非全部 transcript。
- [filesystem.ts](../../../../../claude-code/src/utils/permissions/filesystem.ts)：读取权限前置检查后，经内部路径规则放行项目临时目录；约 L1693 明确允许同项目其他会话的临时文件。临时根可配置，不能固定写成 `/tmp`。

**采用**：运行时自动终态通知；正文和输出入口可共同存在；内部结果专用读规则。**调整**：ohbaby `.output` 只存最终答复，放现有应用 storageRoot，按父会话归属授权。**不采用**：将最终报告路径链接到全部会话日志、同项目所有会话临时目录一概放行。不能把这份重建源码的行为描述为官方保证。

## 3.6 DeepSeek Harness：自动终态通知与访问边界

- [continuation.ts](../../../../../deepseek-harness/packages/subagent/subagent/src/continuation.ts)：L1382 起 runtime 在完成、错误、取消、teardown 时发送 settlement，不要求 child 主动 report；L1400 起带 senderSessionId 和 closing message，父 busy 时 steer，idle 时 followup。
- 同文件 L1206 起控制权限同时检查 live parent 对象和 durable parentSession；持久关系值得借鉴，但不能让 JS 对象是否相同决定 ohbaby 历史结果可读性。
- 补查：L1233 的 settlement 等待依赖 whenIdle/poke，没有定时模型复查；L1094 明确顶层主 Agent 不在 continuation Activation 的等待图中。另一条 one-shot job 路径的 [job_output](../../../../../deepseek-harness/packages/jobs/tool-jobs/src/index.ts) 默认一次等 30 秒、最长 10 分钟，超时返回状态而不取消任务；不可把两条路径混成一个统一自动等待机制。
- [workspace-access.ts](../../../../../deepseek-harness/packages/session-query/tool-session-query/src/workspace-access.ts)：L73 起历史会话访问可按同 cwd 授权；[operations.ts](../../../../../deepseek-harness/packages/session-query/tool-session-query/src/operations.ts)：L216 起读取完整事件。

**采用**：终态由运行时交付、来源明确、父忙时输入缓冲。**调整**：持久待交付、按任务归属、已结束父任务不自动开新轮。**不采用**：运行中 report/A2A、广泛 session-query、同 cwd 即可访问、失去 live parent 就丢交付。完整事件读取也不等于按需读取最终报告。

## 3.7 Pi：UI 过程与模型结果分离

- [subagent 扩展示例](../../../../../pi/packages/coding-agent/examples/extensions/subagent/index.ts)：L294 以 `--mode json -p --no-session` 启动进程；L390 等 close；L624 起并行结束后合并。它是示例，不是持久后台子代理平台。
- 同文件 `getFinalOutput` L170 取最终 assistant text；L313/L347 收集 onUpdate 和过程 details；L744 展开详情供 UI 显示。模型最终输出和用户过程展示可以不同。
- 补查：这个子进程示例没有整次执行期限或定时主模型复查；L399 的 5 秒计时是 abort 后尝试 kill 的收尾。用户进展刷新不能当成主模型中途获得执行事实的证据。
- [agent.ts](../../../../../pi/packages/agent/src/agent.ts)：L275 起 steer/followUp 分队列；[agent-loop.ts](../../../../../pi/packages/agent/src/agent-loop.ts)：工具批次完成后处理 steering、结束边界处理 follow-up。

**采用**：用户看到过程不等于主模型收到全部过程；普通后续任务与当前输入区别；安全边界消费。**调整**：服务端原子队列转 Steer、持久归属、等待可唤醒。**不采用**：无持久子会话的进程示例、等全部并行结束后才返回、把内存 details 当作可恢复历史。

## 3.8 对本轮方案的具体影响

| 02 决策                  | 主要借鉴                       | ohbaby 自身补足                                                                    |
| ------------------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| 正常结束前有期限自动等待 | Kimi print hook、Codex有界等待 | 任一终态/Steer或60/120秒到期唤醒、本次任务过滤、无模型wait、程序核对与模型复查分开 |
| 可靠终态交付             | Codex/Claude/DeepSeek          | SQLite 结果和待交付、幂等接收、终态含中断、失败不静默丢失                          |
| 队列项 Steer             | Codex/Pi                       | 原子从 queued 转入、目标过期不转投下一轮、普通消息不提前泄漏                       |
| `.output`＋通用 read     | OpenCode/Kimi/Claude           | 最终正文派生文件、归属只读、随会话清理、不暴露全部日志                             |
| 用户子过程与模型输入分离 | Pi及各项目独立会话思路         | SQLite scope 隔离、只读子树、根审批、刷新与实时同源                                |

参考项目各解决了一部分问题，没有一个可不加区分地整套搬来。父任务必须收齐结果、`.output` 扩展名来自本次讨论；不是从这些仓库“证明出来”的统一标准。此前 10,000 token 分流建议已撤下，见 00 §13。

## 3.9 ZCode 与本次等待取舍的补充

- [子代理执行器](../../../../../ZCode/apps/zcode-cli/packages/core/src/subagent/runner.ts)：L211 设置 activity watchdog，L1191 起按最近活动重新计时；默认值沿 contracts 的 600,000 ms。L318–320 转后台后分离父 signal 并停止这层 watchdog，因此不能宣称所有后台子代理都有这项静默保护。
- [子 runtime 事件接线](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts)：L334 收到事件时 reportActivity；观察到事件不等于证明任务在有效推进。
- [后台通知队列](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts)：L317 合并 eligible 通知并调用 executeTurnCommand；这能触发后续模型处理，但不同于 ohbaby 保持同一原任务等待的约束。
- [TaskOutput 协议](../../../../../ZCode/apps/zcode-cli/packages/contracts/src/tools/task-output.ts)：默认 block 等 30 秒、最多 600 秒，已标记 deprecated。[处理器](../../../../../ZCode/apps/zcode-cli/packages/core/src/tool/handlers/task-output.ts) L229 起每 100 ms 查询 registry，到期返回当前状态，不取消任务；不能把已弃用工具当成推荐的新接口。
- 其通知命令主要在内存队列中，持久 admission 记录也不等于重启后必然补投；不要把这条路径当作 ohbaby 可靠交付的完整依据。

**采用**：区分运行活动、任务结果、父模型处理；检查超时保护究竟覆盖前台还是后台；合并通知避免重复模型请求。**不采用**：新增已弃用 TaskOutput、依赖完整 JSONL 输出、以普通事件持续产生作为无限延期理由。

本次确认采用的组合是 ohbaby 自身决策：程序核对并补投结果；主代理首次最多等 60 秒、后续每次最多等 120 秒，到期取得有限执行事实再决定。它借鉴 Codex“有期限交还决策权”和 Kimi“程序检查不必调用模型”的区分，不照搬任何项目的默认时间。增强 `subagent_status` 与到期快照同源、不开放完整中间过程，也属于本次讨论确定的范围。

## 3.10 通知实际进入模型的格式：补充核验

以下追踪到模型请求转换路径，仅读源码及已有测试，未执行参考项目测试。角色名是协议承载方式，不等于用户发言，也不自动决定是否新开任务。

| 项目/路径        | 实际格式与来源                                                                                                                                                                                                                                                                                                                                                                       | 实现边界                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Codex V1         | [codex_thread.rs:455](../../../../../codex/codex-rs/core/src/codex_thread.rs) 构造 user-role 的 subagent_notification，并 inject_no_new_turn                                                                                                                                                                                                                                         | multi_agent 在本地功能表为 stable/default true；消息不创建用户轮次                                               |
| Codex V2         | [protocol.rs:813](../../../../../codex/codex-rs/protocol/src/protocol.rs) 的 to_model_input_item 生成专用 AgentMessage；[请求断言:1404](../../../../../codex/codex-rs/core/tests/suite/subagent_notifications.rs) 检查 type=agent_message                                                                                                                                            | 功能表 multi_agent_v2 为开发中/default false；这是已接通路径，不能假设任意provider支持。仓库默认值不代表线上配置 |
| Kimi             | [context/index.ts:65](../../../../../kimi-code/packages/agent-core/src/agent/context/index.ts) 保存 user+background_task origin；[projector.ts:437](../../../../../kimi-code/packages/agent-core/src/agent/context/projector.ts) 移除内部origin；[notification-xml.ts:26](../../../../../kimi-code/packages/agent-core/src/agent/context/notification-xml.ts) 将来源写入模型可见正文 | 忙时缓冲，闲时可新开turn；通知失败存在吞异常路径，不能据此保证可靠补投                                           |
| DeepSeek         | [continuation.ts:1406](../../../../../deepseek-harness/packages/subagent/subagent/src/continuation.ts) 构造user+subagent-settled source并在正文说明子身份；[serialize.ts:129](../../../../../deepseek-harness/packages/llm/llm-deepseek/src/serialize.ts) 实际请求仅role/content                                                                                                     | busy steer、idle followup；交付失败日志后丢弃，本轮不能照搬                                                      |
| OpenCode         | task.ts 的 injectBackgroundResult 经 synthetic prompt，在 [prompt.ts:658](../../../../../opencode/packages/opencode/src/session/prompt.ts) 建user消息，[message-v2.ts:198](../../../../../opencode/packages/opencode/src/session/message-v2.ts) 投影user正文                                                                                                                         | 后台受实验开关限制；前台返回工具结果；已有task测试覆盖后台路径，本次未运行                                       |
| Claude本地重建版 | [messages.ts:4168](../../../../../claude-code/src/utils/messages.ts) 将queued_command任务附件转为user，保留origin和isMeta；system-reminder是正文标签，不改变role                                                                                                                                                                                                                     | 只说明所查重建版；不能推定官方闭源实现相同                                                                       |
| Pi所查示例       | [agent-loop.ts:773](../../../../../pi/packages/agent/src/agent-loop.ts) 构造toolResult，绑定真实toolCallId；OpenAI映射tool，Anthropic映射user外层中的tool_result块                                                                                                                                                                                                                   | 前台工具结果，不是后台自动通知；不能仅凭Anthropic外层user误判为普通通知                                          |

采用本次确认：内部真实来源与对外user投影分离，正文说明来源，安全边界追加同一任务，UI/压缩按来源分类。保留自己的持久交付与补投契约。Codex V2专用消息、Kimi/DeepSeek空闲时另开turn、Pi前台示例不作为本轮新增要求。

## 3.11 固定 10,000 token 撤下后的大小策略补查

本次只读核验，未运行参考项目或 E2E。以下限制作用于不同层，不能互换成子代理报告上限。

| 项目     | 所查实际策略                                                                                                                                                                                                                                                                                              | 本轮可借鉴与不照搬的部分                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| OpenCode | [truncate.ts](../../../../../opencode/packages/opencode/src/tool/truncate.ts) 通用工具输出默认 2,000 行/50 KiB，可配置，全文落盘后给预览；task.ts 后台 injectBackgroundResult 则直接注入最终文本，未经过该工具返回截断器                                                                                  | 区分通用工具返回与后台通知；不能把50 KiB当其统一子报告限制                                   |
| Pi       | [subagent 示例:36/193](../../../../../pi/packages/coding-agent/examples/extensions/subagent/index.ts) 并行每份结果50 KiB，裁剪后全文保留tool details；单任务与chain最终结果走另一返回路径。通用[Bash输出累积器](../../../../../pi/packages/coding-agent/src/core/tools/output-accumulator.ts)另有完整文件 | 示例details不等于父模型可按路径读取的持久报告；不照搬截断预览                                |
| Kimi     | [background/index.ts:783/982](../../../../../kimi-code/packages/agent-core/src/agent/background/index.ts) 有完整文件即给路径+bytes；无文件才最多3,000 UTF-8 bytes尾部预览，不按token短长分流                                                                                                              | 文件优先简单但会增加短报告回读；1 MiB内存环、16 MiB command输出限制不等于agent报告限制       |
| ZCode    | [runner.ts:1504/1923](../../../../../ZCode/apps/zcode-cli/packages/core/src/subagent/runner.ts)先保存完整文件再将全文放通知；[notification.ts:18/380](../../../../../ZCode/apps/zcode-cli/packages/core/src/runtime-task/notification.ts)把渲染后整条通知按JS string.length截到120,000，另加截断标记      | 保留原文与投影分开；不照搬字符截断。该单条限制不看剩余模型窗口，同批合并路径未见独立总量额度 |

没有一个上述数字证明 ohbaby 应设固定10,000 token。候选方向是复用当前模型请求的真实可用输入预算，能安全容纳完整结果时直接交付，容纳不了时提供完整文件入口；这仍是讨论建议，不是用户已确认的动态算法。用户所述1M是本次模型窗口，仍须扣除已有输入、输出预留和安全余量。后续按04实测最终正文与父请求增量，不能用子代理累计usage推断报告长度，也不以固定百分比未经测量替代固定10,000。后续用户指定先记录OpenCode/Pi的50 KiB参考限制并测试，见00 §14；这是新增验证基准，不应被本节此前的动态策略建议覆盖。

## 3.12 步数上限与触顶方式（2026-09-22 补录）

只读源码与已有测试，未运行参考项目。ohbaby现有主代理build/plan为1,000步，子代理explore为50步、generic/research为100步；父子各自执行循环。不能用未量化的“一般达不到”声称触顶永不发生，也不因此扩大本轮为预算系统重写。

| 项目     | 所查默认与触顶行为                                                                                                                      | 证据                                                                                                                                                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi       | 核心循环没有内置固定步数上限；工具/输入继续驱动循环，提供自定义shouldStopAfterTurn，无统一最后一步总结                                  | [agent-loop.ts:164](../../../../../pi/packages/agent/src/agent-loop.ts)、[types.ts:217](../../../../../pi/packages/agent/src/types.ts)                                                                                                                          |
| OpenCode | prompt路径未配置steps时Infinity；到限加入总结提示但仍传工具。另一core runner明确清空工具且toolChoice=none，不能把两条路径混成统一硬保证 | [prompt.ts:1178/1281](../../../../../opencode/packages/opencode/src/session/prompt.ts)、[runner/llm.ts:202](../../../../../opencode/packages/core/src/session/runner/llm.ts)                                                                                    |
| Kimi     | 不设或0为无上限；设置上限后每轮头检查，最后允许的一步仍可调工具，需下一步时抛超限；不额外请求模型总结。恰好最后一步正常结束不必判失败   | [配置说明:200](../../../../../kimi-code/docs/zh/configuration/config-files.md)、[run-turn.ts:131](../../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts)、[turn/index.ts:924](../../../../../kimi-code/packages/agent-core/src/agent/turn/index.ts) |

取舍已经用户确认：ohbaby本轮保持原上限及最后步骤机制；等待本身不计step，真实续模型计入原任务；触顶只补齐子执行收尾、结果保留和真实未完成状态，不额外新增请求/预留机制。上述项目的无限默认值不作为本轮改配置依据。

## 3.13 本次可靠性补充与参考边界（2026-09-22）

- Codex input_queue的先订阅后检查，以及下一请求前消费输入，可借鉴为安全边界；ohbaby还需要实际请求纳入集合和持久交付状态，不能将所查内存队列当作这项保证已经齐全。
- Kimi wait的30秒程序检查说明“检查状态”不必请求模型。ohbaby的纯审批例外另要求独立检查不被模型复查暂停带停；周期未因参考默认值自动定为30秒。
- Kimi设置steps后的退出行为帮助区分模型一次输出与任务完成；ohbaby仍按用户确认保留自己原有限额与最后一步机制，仅补结果链上的准确终止原因。
- OpenCode/Pi的50 KiB适用层不同，见§3.11。[独立请求探针](evidence/2026-09-22-model-request-probes.md)验证三种协议接受user通知和单一模型的文件回读，未运行这些参考项目，也未验证ohbaby的整条交付链。

本轮不复制参考项目的功能集合。对请求/压缩、审批前序及一层派遣的修订来自ohbaby自身源码与已确认规则，不能写成某个参考项目已经提供相同实现。

## 3.14 Fable 5.1 后续审核：采纳、调整与保留边界

来源是用户提供的本地导出，定位见00 §18；浏览器[分享页](https://opncd.ai/share/HPysIvuJ)当次只展示旧审核。本表针对后续正式答复，不将早期“额外赠一步”等已撤回建议重新带回。

| 后续审核意见                                    | 本轮取舍               | 原因及文档落点                                                                                                                                     |
| ----------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 明说等待留在lifecycle循环内                     | 采纳                   | 同一次调用、同一计数/usage/资格，等待自身不推进step；02 §2.1、T62                                                                                  |
| 未处理消息打标禁止压缩                          | 采纳保护目标，调整手段 | 以输入账本为依据，优先压缩后纳入；仍计总预算，不能永久pin住无界正文；02 §2.4、T52                                                                  |
| 30分钟审批暂停依赖第二轮真实phase/前序关系      | 采纳并补交接要求       | 第二轮当前waitReason只保证已知原因，不自动保证结构化前序ID；S0要核对并由原owner补最小事实，host不解析展示字符串；02 §2.9                           |
| 60/120秒复查有成本与界面噪音                    | 采纳风险，保持用户节奏 | 快照足够不重复status、无变化简短回复；实际缓存/传输由provider决定，不能说每次都按全量无缓存收费或仅新增token收费；02 §2.8、T61                     |
| 同会话一个活动任务，所以取消可沿parentSessionId | 不采纳该简化           | 迟到cancel(A)遇到B接班及A创建中委托是反例；身份同时约束交付、取消与启动资格。复用现有协调器增加目标约束即可，不另建取消平台；01 §1.9、02 §2.4、T58 |
| 收齐检查排除状态观察                            | 有条件采纳             | 过期/已被终态或新事实替代的观察可撤销；有效到期观察仍要交还主模型判断，不能一律丢弃；02 §2.5、T57                                                  |
| S3拆成S3a/S3b                                   | 采纳为内部验收批次     | S3a先验证交付/压缩/结束，S3b接复查与额度；S3a仍依赖前两轮的身份/工具批次/错误清理，不能提前发布无复查版本；02 §2.9                                 |
| 集中S0上游接口清单                              | 采纳并增加1.1/C        | 明确真实身份、审批、会话提交、请求attempt、前序事实、结果提取与Read；不能将文档字段当完成接口；02 §2.9                                             |
| >1MB只是少见边角，S0确认即可                    | 不以频率假设降低契约   | 本次探针没有测出自然报告分布；超长单行即使文件小于1MB也可能丢尾。B的Read验收与本轮权限校验分别落实；已知不可读须明确交付错误；02 §2.7、T60         |
| 独立执行表及foreground指引仍需明确              | 采纳并限定职责         | 当前基线新增execution结构；foreground是等待工具直接返回的显式选择，有依赖不等于必须foreground；02 §2.3/2.8、T59/T07                                |

### 本地参考实现与SWE取舍

- **Kimi：同一循环等待、压缩后注入。** [run-turn.ts:107–185](../../../../../kimi-code/packages/agent-core/src/loop/run-turn.ts)保留steps/usage并await shouldContinueAfterStop；[turn/index.ts:753–763](../../../../../kimi-code/packages/agent-core/src/agent/turn/index.ts)先beforeStep压缩、再flushSteerBuffer。采用局部钩子与顺序，避免worker另起循环及重复预算；不复制其print-only、等待全部任务的条件，也不假定其已提供ohbaby的持久认领保证。 同文件:777/:812的stop hook另有提前flush分支，下一步[full.ts:255–260](../../../../../kimi-code/packages/agent-core/src/agent/compaction/full.ts)仍可能压缩，而[handoff.ts:61–81](../../../../../kimi-code/packages/agent-core/src/agent/compaction/handoff.ts)将background_task分类为可丢弃；这里只借鉴beforeStep的局部顺序，不将其作为首次请求纳入保护的完整证明。
- **Kimi：可复用代理与单次任务分离。** [agent.ts:195–234](../../../../../kimi-code/packages/agent-core/src/tools/builtin/collaboration/agent.ts)、[background/index.ts:302–345](../../../../../kimi-code/packages/agent-core/src/agent/background/index.ts)每次registerTask生成taskId；[persist.ts:31–69](../../../../../kimi-code/packages/agent-core/src/agent/background/persist.ts)按taskId保存。符合instance与execution不同生命周期；ohbaby复用SQLite而不改存JSON。
- **Kimi输出根纠正。** [agent/index.ts:218](../../../../../kimi-code/packages/agent-core/src/agent/index.ts)传入this.homedir；[session/index.ts:525](../../../../../kimi-code/packages/agent-core/src/session/index.ts)默认`<sessionRoot>/agents/<agentId>`，顶层后台产物通常为`<sessionRoot>/agents/main/tasks/<taskId>/output.log`。上文§3.2已同步纠正。
- **Codex：显式执行上下文与目标核验。** [tools/context.rs:59](../../../../../codex/codex-rs/core/src/tools/context.rs)把turn/step/call/cancellation分开；[session/mod.rs:3864](../../../../../codex/codex-rs/core/src/session/mod.rs)在锁内核验expected_turn_id。采用明确身份、在接收边界核验的原则，不把整个Session对象传入ohbaby scheduler，也不以session等价run。该Steer实现不是ohbaby取消接口的直接模板。
- **OpenCode：前后台交付有区别，job不等于独立执行账本。** [task.ts:200/216/273/317](../../../../../opencode/packages/opencode/src/tool/task.ts)前台返回工具结果、后台synthetic prompt；job ID复用子session。[background-job.ts:210](../../../../../opencode/packages/core/src/background-job.ts)终态后可替换同ID内存项。复用会话有价值，但不能替代本轮逐次报告与待办身份。
- **Claude本地重建版：续派复用身份/输出路径。** [resumeAgent.ts:199](../../../../../claude-code/packages/builtin-tools/src/tools/AgentTool/resumeAgent.ts)、[LocalAgentTask.tsx:465/540](../../../../../claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx)复用agentId、最新result及transcript入口；不能称其提供每次独立最终报告。其后台取消脱离父signal也不符合本轮父终止约定。只说明本地重建版。
- **Pi：消费边界与工具串联。** [agent-loop.ts:155–274](../../../../../pi/packages/agent/src/agent-loop.ts)在同一runLoop消费steering/follow-up；[subagent示例:534–575](../../../../../pi/packages/coding-agent/examples/extensions/subagent/index.ts)chain明确await上个结果。借鉴“没有结果不执行依赖动作”，不照搬示例前台默认或推导必须foreground。
- **DeepSeek：结果来源与关闭期间抑制唤醒。** [continuation.ts:1406–1443](../../../../../deepseek-harness/packages/subagent/subagent/src/continuation.ts)以source标识user通知，teardown时不再followup。采用关闭资格优先的原则；不采用idle自动开新turn或失败后只记警告，保留本轮持久结果与严格原任务归属。

这些补充服务于单一事实来源、明确身份、局部控制流和分批验证。没有证据要求新增消息代理、通用依赖图、第二个模型循环或额外预算系统。本次只读参考代码，未运行参考项目或新增API请求。
