# 1. 现状与问题

> 2026-09-20，基线 `039dca95`。以下为源码调查，未实施第三轮，尚未执行第三轮全链路模型E2E；2026-09-22独立请求探针见文末。早前运行证据见 [诊断记录](../evidence/2026-09-19-serve-stalled-tools.md)，不能当成本轮验收。

本文代码路径相对于仓库根目录。行号只帮助定位，后续以符号为准。

## 1.1 承重问题

| ID  | 问题                                                                            | 当前证据                                                                                                                                                                          | 对应方案                     |
| --- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| P1  | 后台已结束不等于父模型已收到结果                                                | `agents/subagent-host.ts:999` 保存实例结果；未见对应父任务持久通知与结束门禁                                                                                                      | 02 §2.3–2.5                  |
| P2  | 模型无工具调用就可以结束，不能保证本次子任务收齐                                | `core/lifecycle/lifecycle.ts:873` 正常无工具路径直接 turn:end/return                                                                                                              | 02 §2.5                      |
| P3  | 普通排队和追加当前任务未形成两条明确操作                                        | `runtime/prompt-scheduler/types.ts` 无 Steer 接收状态/目标任务关联                                                                                                                | 02 §2.6                      |
| P4  | 实例的最新 output 不能代表每次历史执行                                          | `agents/subagents/types.ts` 只有 current/lastRunId、output；host 新 claim 清理 output                                                                                             | 02 §2.3                      |
| P5  | 子代理状态/子会话不能独立完整呈现                                               | `adapters/ui-state/persistent-store.ts:287` 默认只保留 primary sessions                                                                                                           | 02 §2.8                      |
| P6  | 长结果缺少可靠入口和针对性只读授权                                              | 现有 read 依赖环境 trusted roots；没有归属明确的结果产物登记                                                                                                                      | 02 §2.7                      |
| P7  | stream、最终答复提取、文件读取契约容易混淆                                      | primary 使用 stream，内部 completion 提取可合并 reasoning；read 限制整文件                                                                                                        | 前置待办、02 Stage 0         |
| P8  | 旧设计分层/事件语义需要与新规则协调                                             | agents 禁止 runtime 依赖具体子代理服务；第二轮 turn endedAt 依赖真正完成                                                                                                          | 02 §2.1/2.9                  |
| P9  | 只给 running 状态不足以支持主代理决定继续等；纯终态等待也缺少中途重新判断的时机 | `tools/subagent.ts::renderStatus` 无实时阶段/近期工具事实；`agents/subagent-host.ts` 新 claim 清空 output，finishRun 才写结果，并非运行中直播；子 deadline 与父复查不是同一种计时 | 02 §2.5/2.8，2026-09-21 补充 |

## 1.2 Agents 与子执行：七维分析

- **goals-duty**：SessionSubagentHost 已统一创建、继续、查询、关闭；缺少可靠向父任务交付结果的责任归属。状态查询不能替代交付。
- **architecture**：`core/agents` 提供执行原语，`agents` 管理子代理领域，runtime 管理执行基础设施。主会话 `agents/service.ts:48` 已走实例 stream，内部子代理仍可使用 waitForCompletion；两者不是两套 LLM 循环。
- **data-model**：`subagent_instance` 保存实例、child session、context scope、parentSessionId 和最新执行状态。它适合恢复实例，不足以表示“某次用户任务派了哪些执行、每次结果交付了没有”。同一 child session 可有不同 scope，不能把 sessionId 当成 subagentId。
- **dfd-interface**：`tools/subagent.ts` → host → instance/runAgent → run coordinator → lifecycle → store.finishRun。foreground await 完整结果，background 先返回实例；持久 finish 与父输入通道尚未连成可证明可靠的链路。
- **use-case**：支持背景执行和 status 查询，不足以保证三个子任务先结束一个就进入父模型下一步，更不能保证模型忘记查询时仍收齐。
- **non-functional**：仅内存 callback 或事件广播容易在忙碌/订阅竞态丢失；重用实例 output 会覆盖历史；记录缺少明确本任务身份会串入昨日任务。
- **test**：已有 `agents/subagent-host.unit.test.ts`、`agents/subagents/database-store.integration.test.ts`、`tools/subagent.unit.test.ts`；新增交付/等待契约尚未存在，不能以旧测试通过证明这些新行为。

## 1.3 Lifecycle、Run 与 Prompt：七维分析

- **goals-duty**：lifecycle 管模型步骤与工具循环；run-manager 管运行状态；prompt-scheduler 管用户提交的排队与执行。当前没有让三者共同遵守“结束前收齐本次子执行”的接口。
- **architecture**：`runtime/run-manager/worker.ts` 驱动 lifecycle 并投影事件。结束前等待应是注入的 continuation 接口，不能让 core lifecycle 直接查询子代理数据库。
- **data-model**：`PromptSubmissionRecord` 已有 promptId/userMessageId/runId、queued→starting→running→终态；暂无“该排队项已追加到目标任务”的互斥归属和幂等接收记录。
- **dfd-interface**：`/v1/prompts` 接受正文及 reasoning 配置并返回 202；队列执行结束后才推进下一项。现有接受普通消息不等于支持 Steer。
- **use-case**：需要“模型当前无工具要做→有期限等待→任一终态、Steer 或单次等待到期→继续同一任务”，而不是结束旧任务再默默创建新任务；状态/交付核对与到期模型判断分开。
- **non-functional**：检查未完成任务和订阅唤醒之间存在潜在丢事件窗口；模型请求不能被新消息就地修改；任意安全边界也不能绕过第二轮原工具批次完整性和副作用保护。
- **test**：已有 `runtime/prompt-scheduler/scheduler.unit.test.ts`、database-store integration、`core/lifecycle/lifecycle.unit.test.ts`。需增加消息接收与结束竞争、重复 Steer、无忙轮询、错误终止优先等跨模块测试。

## 1.4 结果文件、Session 和 UI：七维分析

- **goals-duty**：session 管结构化会话；storage 管文件；权限决定访问；UI 展示真实状态。导出与清理由 agents/application 装配层衔接，不让 session store 接管业务报告生成。
- **architecture**：`services/storage/storage.ts` 已支持原子 bytes 写入；`services/storage/path-resolver.ts` 使用可配置 storageRoot。scheduler 与 sandbox lease 均参与文件访问，不能只修改一层 allow 判断。
- **data-model**：父子会话在 SQLite；没有本次结果的稳定 artifact key/归属/大小/准备状态。前端当前 primary 过滤并不意味着数据库没有子会话。
- **dfd-interface**：UI persistent/live 投影需要同时获得子状态；现有消息/工具流可以复用，但订阅与快照必须按 child session/context scope 过滤，不能套父 runId。
- **use-case**：用户只读查看完整子过程、返回根会话处理审批；主模型接收最终文本或文件入口，并在复查/状态查询时取得有限执行事实，不获得完整中间正文和日志。两种访问面的范围不同。
- **non-functional**：信任整个应用目录会暴露无关会话；`.output` 成功通知早于文件写入会产生坏入口；会话删除与迟到写文件竞争会留下孤儿文件。
- **test**：现有 `adapters/ui-state/persistent-store.integration.test.ts`、`adapters/ui-inprocess.contract.test.ts`、Web `App.unit.test.tsx` 可扩展；必须增加范围隔离、刷新恢复、子会话禁写的服务端验证，不能只禁用输入框。

## 1.5 文档与实现对照

| 既有文档                                                                       | 文档口径                                                   | 当前事实/本轮影响                                                                              |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [agents 架构](../../../agents/architecture.md)                                 | primary 切换 stream 留以后；runtime 不放 subagent 专属编排 | primary 已 stream，前者滞后；后者保留，以端口注入连接自动等待                                  |
| [2026-07-09 子代理设计](../../../agents/2026-07-09-subagent-context/README.md) | 实例/scope 隔离、SQLite、重启不自动续跑                    | 保留；补每次执行与当前任务归属，而不是重建实例体系                                             |
| [lifecycle 架构](../../../core/lifecycle/architecture.md)                      | 无工具调用则正常结束；错误/length/filter 不自动续写        | 仅正常结束边界增加 continuation 判断；错误规则保持                                             |
| [session 架构](../../../services/session/architecture.md)                      | session 存 SQLite，不依赖 storage 存会话                   | 保留；报告是派生文件，清理由上层协调                                                           |
| [第一轮方案](../improve-1/02-optimization-plan-and-change-scope.md)            | 根范围审批、真实身份、刷新恢复                             | 尚未实施，是第三轮依赖                                                                         |
| 第一轮方案 §2.8                                                                | 早期曾将“子代理单独停止”登记到第三轮后续范围               | 用户后续明确禁止单独停止，生命周期由主代理管理；第一轮范围说明已同步修订，不转为第四轮用户入口 |
| [第二轮方案](../improve-2/02-optimization-plan-and-change-scope.md)            | 整批工具交模型、工具阶段、模型/整轮计时                    | 尚未实施；等待不冒充模型请求，endedAt 不在中间回复结束                                         |

旧文档不是全部失效；上表限定冲突范围。本文不回写旧模块权威文档，也不把模块侧 improve 编号等同于本议题轮次。

## 1.6 SWE 取舍

1. **单一职责**：子代理业务归 agents；等待/唤醒通道是通用运行基础设施；core 只消费端口。避免 runtime 直接 import SessionSubagentHost。
2. **一个事实来源**：SQLite 中的执行结果为依据；文件是可重建投影；UI 与模型消费同一来源但取不同字段。
3. **减少模型责任**：等待正确性放代码，模型负责分析结果。移除 wait 工具不会消除等待状态，但能减少一个模型必须主动调用的接口。
4. **可靠性而非理想化 exactly-once**：记录先持久化、接收幂等；不能承诺模型一定理解结果，更不能承诺崩溃后外部副作用恰好一次。
5. **控制范围**：结果提取/四文件工具另记待办；不引入通用 A2A、全会话历史搜索、第二套会话存储或多进程接管。

## 1.7 影响面

涉及 agent host/store、core lifecycle 的 continuation 端口、prompt admission、运行事件、SDK/UI projections、Web/TUI、权限与 storage 装配、system prompt。不是单改工具描述可以解决；分阶段契约见 [02](02-optimization-plan-and-change-scope.md)。

## 1.8 2026-09-22：实施边界的补充证据

下列问题来自对现有源码、前两轮方案及最新讨论的交叉核对，已落实为02的契约和04的反例；不代表对应实现已经存在。

| 问题                             | 可复现的失败条件与源码依据（路径相对packages/ohbaby-agent/src）                                                                                                                                   | 方案/验收                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 当前请求看不到后来到达的通知     | core/context/types.ts 的PreparedModelRequest/PreparedTurn没有请求实际纳入通知集合；不能在响应成功时一次确认所有已交付输入                                                                         | 02 §2.4 请求集合；T51          |
| 第一次阅读前通知被摘要替换       | core/context/context-manager.ts 的commitCompaction及prepare重读历史会改写实际请求；单纯“定位或等价信息”不能证明首次原文交付                                                                       | 02 §2.4 压缩保护；T52          |
| 触顶原因在子结果返回链丢失       | lifecycle可success=true且terminalReason=max_steps_finalized；runtime/run-manager/worker.ts按success映射；core/agents/{types,runner}.ts和agents/subagent-host.ts::successfulOutput无法完整保留原因 | 02 §2.5/S3 全链路原因；T55     |
| 暂停模型复查后没有漏信号补救触发 | 原草案只明确入等待/到期核对，纯审批却停掉到期模型复查；agents/deadline.ts还是一次性墙钟timer，不能拿它代替独立程序检查                                                                            | 02 §2.5 独立有界reconcile；T53 |
| 间接审批阻塞被误当独立排队       | 第二轮保留未知Bash依序A审批→A执行→B审批；B等A时不是自身awaiting-approval，仍可能完全因人工审批无法推进                                                                                            | 02 §2.5 必要前序原因；T54      |
| “现有允许嵌套”不符源码           | core/tool-scheduler/constants.ts的SUBAGENT_DISABLED_TOOLS、agents/manager.ts及scheduler执行前限制共同禁止子代理调用三项subagent工具                                                               | 02 §2.3 保持一层模型派遣；T23  |

本次没有发现需要新增产品能力才能解决这些反例的证据。主要改动是把既有意图落实到请求认领、压缩、计时和结果类型边界，保持职责分层。实际前置接口尚未形成，S0仍需按前两轮完成后的代码复核，不能直接将草案当现成API。

[独立请求证据](evidence/2026-09-22-model-request-probes.md)记录10次真实流式请求：三协议通知内容验证、合成报告生成和文件读取工具往返。它为协议可行性提供证据，不覆盖本节竞态和完整协作E2E。

## 1.9 2026-09-23：后续审核对应的事实复核

复核工作树HEAD `7cdd4a9342e6c67afa9e19b88fa35e01b24704f9`，保留其他轮次既有未提交修改；下列均为源码观察，未运行新增竞态测试。

- `core/tool-scheduler/types.ts::ToolExecutionContext`仍无runId；第一轮D13计划补齐显式身份，第三轮S1不能从callId或当前会话活跃run临时推断。S0新增具体交接门槛。
- `runtime/run-ledger/types.ts::RunLedgerRecord`只表达实际run生命周期；`agents/subagents/database-store.ts::SubagentInstanceRow`只存最新output/currentRun/lastRun。二者都没有accepted委托的逐次结果/交付记录；建议独立execution表有明确缺口依据，不是照搬参考项目表名。
- `adapters/ui-inprocess.ts:618/775/2165`先预留userMessageId，execute时才创建core消息。普通queued当前并未自动进入模型历史；Steer新增路径需用该ID首次创建/关联，避免重复。
- `adapters/ui-runtime/composition.ts:642–658`按旧run查session后调用`interruptByParent(session)`；host `subagent-host.ts:304`只筛当前active的parentSessionId。若A终止、B接班，迟到的cancel(A)可能命中B子执行。现有`composition.unit.test.ts:771`确认manager eviction后的session回退路径，但没有覆盖A/B隔离；这是静态反例，不称已实测复现。
- host创建记录经过多次await才入active Map，旧pending在中断后仍可持久保留。任务级终止还需封闭accepted/creating入口并退出旧pending可执行集合；单纯按session扫一次不足以满足既有第三/四轮约定。
- `core/context/context-manager.ts::assemble/commitCompaction`决定最终请求内容；保护标记本身不能保证正文能放入窗口。需保护首次交付并重新核验总预算，不能无限pin住长输入。

状态观察过期、界面降噪和S3拆批属于新增工程细化，不是已存在产品缺陷的实测结论。它们分别由02 §2.5/2.8/2.9和T57/T61/T62约束，不扩大为新队列、预算或UI折叠系统。
