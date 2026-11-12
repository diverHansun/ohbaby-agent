# 实施与验收

2026-11-12。本轮从当时本地 `main` 的 `d70ce643` 新建 `codex/subagent-delivery-20261112`，没有合并回 main、推送或修改原故障会话。规划基线与实施基线不同：main 已包含 model waiting/error feedback 的合并，本轮复用其 Web/TUI 错误组件。00–04 和 design 保留规划时点内容，实际变更以本文为准。

## 1. 实施结果

直接故障已修：后台唤醒和持久输入使用同一个 `runtime:${sourceId}:${runId}` 身份，不再碰撞其他项目的 `message_1`。先建立会跨持久 facade 的真实 SQLite 红测试，再修复 ID；历史消息内容和所属会话不变。

内部 `delivery.ts` 组合现有 execution、runtime input、run/request 和 Goal 历史。没有新增信箱、broker、通用消息总线或独立任务调度器。终态保存 → 输入投递 → 主代理判断 → 成功请求确认，仍走原运行原语及工具。

主要变化：

- `execution-store` 保存可信 Goal 归属、最近唤醒 runId、剩余 3 次入口恢复额度；认领通过 previousRunId 条件更新。请求前故障按 5/10/20 秒恢复，真实模型请求尝试后不再自行重试同一来源。
- `delivery.reconcile` 按稳定 sourceId 找回“已接收、未关联”的输入，检查全部成功请求的精确成员关系，补齐遗漏确认。成功消费不因主代理后续失败而撤销。
- `continuation-coordinator` 不再把顺带接收等同于已尝试。A/B 已完成可先处理，C 后到可以再续跑。新结果／用户新输入可携带未消费的旧结果。
- 主 Stop 不停子代理。准备中的主 prompt 也有取消信号；Stop 将触发批次额度置零，建账前后都生效，并在释放占用前等待持久写入。保留受控 `user-stop` 原因，不弹处理失败通知。
- `process-interrupted`、`service-shutdown` 新写终态保留通知。正常停服时 abort 先完成的竞态不会再误写成 cancelled。手动停止／关闭子代理仍不独立唤醒；旧 delivery=none 不升级。
- 新增 migration `030_subagent_goal_ownership`：字符串表示 Goal，JSON null 表示普通任务，SQL NULL 表示旧未知。运行中控制仍复用 ownedRuns；自动投递依持久归属和既有 Goal 准入。
- SDK 共用 turn 投影显示无输出的自动失败；Web 增加跨多次 execution 汇总的 pendingResultCount，TUI 列表沿用 execution.delivery 提示。Completed 仍只表示子执行完成。

实际模块边界比规划中的统一 facade 更窄：主到子消息继续由已验证的 `execution-message-channel` 受理，终态仍由 execution store 保存，`delivery` 集中结果资格与恢复规则，没有新增只做转发的包装层。补确认直接使用 SQLite 的接收 run 索引查询，而不是逐页加载全部消息。两项取舍都减少重复机制，不改变产品契约。

## 2. 关键改动清单

| 位置／符号 | 改动原因 |
| --- | --- |
| `adapters/ui-inprocess.ts` / `submitPromptWork`、`abortPromptRun` | 统一 runtime ID、交接预留 runId，贯通准备阶段 Stop |
| `adapters/ui-inprocess/subagent-wakeup.ts` / `reserveSubagentWakeup` | 持久条件认领、类型化 completion、保持 Goal 准入和 gate 释放 |
| `agents/subagents/delivery.ts` / `createSubagentDelivery` | 统一自动资格、补关联、补确认和入口重试判断 |
| `agents/subagents/execution-store.ts` / `claimWakeup`、`stopWakeups`、`finishRecord` | 最小恢复元数据、可通知中断原因、幂等无变化不再写库／发通知 |
| `runtime/prompt-scheduler/current-run-inputs.ts` / `listBySource`、`reconcileRequestSuccess` | 从既有输入与成功请求事实恢复，无第二份确认状态 |
| `agents/subagents/continuation-coordinator.ts`、`session-supervisor.ts` | 批量当前可用结果、不等待全完成；沿用现有退避定时器 |
| `adapters/ui-runtime/composition.ts`、`agents/subagent-host.ts` | 从真实 run ticket 保存归属，停止收尾、正常停服原因接线 |
| `runtime/run-manager/manager.ts` / `cancelPreparation` | 准备监听器保留 user-stop，不泛化成运行故障 |
| `services/database/{schema,migrations}.ts` | 增量字段，旧数据库可读，无旧记录批量唤醒 |
| SDK `util/turn.ts`、`contract/subagent-instance.ts`，Web/TUI 现有列表 | 主任务错误可见，子执行状态和待处理结果分开 |

## 3. 验证证据

完整相关回归命令覆盖 `ui-inprocess.contract`、`ui-persistent.integration`、父子投递／监督、execution stores、输入与恢复、Goal、RunManager、SDK turn、Web 子代理页面及 TUI 列表。最终合并执行为 **43 文件、828 项通过**。停服重开数据库的持久 facade 验证通过：关闭过程中不发新主请求，重开同一数据库并由运行时进入原会话后，中断通知被成功请求消费。未运行整个仓库全量测试，不能把相关回归表述为全仓通过。

针对本轮风险的覆盖：

| 04 场景 | 实际证据 |
| --- | --- |
| T01–T02 身份和历史隔离 | persistent wakeup 集成包含另一项目历史 message_1，主请求收到结果、旧消息不变；input store 保留真实内容／scope 冲突检查 |
| T03–T05 合并、Stop、结束交接 | supervision/coordinator 回归与真实 API 的 A/B 先处理、C 后续；Stop 前后的输入请求边界；新的结果可启动下一轮 |
| T06–T08 入口与确认断点 | persistent facade 注入入口失败后实际 5 秒重试；建账前／建账后准备 barrier Stop 均不发模型请求，额度为 0，下一用户输入可收结果；真实 SQLite 关闭重开补关联／成功确认；fake clock 验证 5/10/20 秒与额度跨 reopen 不重置 |
| T09 不重复消费／不忙循环 | 同一输入首次失败、后一次请求成功的补确认；已尝试失败不再独立唤醒；supervisor 无外部事件时不重复写库或自通知 |
| T10–T11 故障与 owner 恢复 | execution-store 两类受控中断、Host closeAdmission 先于 dispose 的竞态；既有 session recovery 与真实进程 crash evidence 测试；纯读监控回归 |
| T12 Goal 与 Rewind | string/null/undefined 三态持久化；旧未知历史保守判断；预算封禁后普通结果可运行，Goal 结果仅在新用户请求或有效同 Goal ticket 中交付；Rewind 暂停后不冒用普通自动轮次 |
| T13–T14 UI | SDK 无消息自动失败可见；静默成功与 Stop 隐藏错误；Web 13 项、TUI 列表 7 项回归；多次 execution 的待处理数不只看最新一条 |
| T15 主到子消息 | 既有 execution-message-channel、Host 隔离／重复／迟到终态回归；真实 API 在同一会话复用子代理 send 并自动回传 |

`pnpm exec tsc -b packages/ohbaby-agent packages/ohbaby-cli apps/ohbaby-web --pretty false` 通过（包含依赖 SDK）；提交钩子另运行全仓 `pnpm run typecheck`，发现并修正 Host 新增测试夹具的失败结果类型，随后通过。改动 TS 文件 ESLint 检查没有错误，保留 15 个 warning；全仓提交钩子的 `pnpm run lint` 为 0 error、125 warning，不作为“全仓零 warning”宣称。`tests/integration/core/context-improve-6-failure-delivery.integration.test.ts` 不在现有 ESLint project service 配置内，单独运行 Vitest 通过，没有为此扩大全局 lint 配置。

真实 API 验收使用 Node REPL 交互式调用当前源码的 persistent backend，未生成或提交 E2E 脚本。凭据仅从 `.env` 载入进程，不记录值。使用测试清单中的 `openai/gpt-6.1-terra`、`openai-responses`、medium，独立临时工作目录和 SQLite：

1. 三个真实子代理分别返回 DELIVERY_CHILD_A/B/C 与 56。A/B 已 processed 时 C 仍被受控 barrier 阻塞；释放 C 后自动续跑并 processed。
2. 在原主会话复用 A 的真实 agent_id，通过 `agent send` 发送 DELIVERY_FOLLOWUP；随后停止同一主会话的主 run，子执行仍 running。释放子请求后得到 `144 DELIVERY_FOLLOWUP`，主代理自动输出 `FOLLOWUP_RECEIVED_144`，该 execution processed。
3. 独立故障场景在子 provider 边界注入受控 HTTP 400，真实父模型收到保存的失败原因，主动补救输出 `RECOVERED_81`。这是故障注入，不声称制造了真实上游宕机；provider retry 耗尽／超时由确定性回归覆盖。
4. 初始 REPL reasoning wire 配置错误已修正；两次未带 sessionId 的 send 正确被跨会话隔离拒绝，最终使用原 rootSessionId 验收。没有把这些失败计为成功闭环。首次 Stop 探针发生在另一主会话，最终已用原会话重新验证，以上结论只依据同会话结果。

脱敏证据在本机 `/tmp/ohbaby-delivery-live-evidence-20261112.json`；临时 backend 已 dispose，临时数据库与工作目录已删除。此文件不是运行依赖，不提交仓库。没有重启或改写 4096 上的原会话，没有浏览器视觉验收；UI 以现有组件集成测试验证。

## 4. 审查与取舍

用户确认 Pi 实际路由为 `magpie/claude/claude-opus-5-5`，thinking high；实现审查会话 `ohbaby-delivery-impl-20261112-c48d`，工作目录为本仓库。完整原文在对话呈现，不复制进设计文档。

子代理审查发现并推动修复了无变化 claim 导致 supervisor 自激、Stop 被误报失败、建账前 Stop 无效三项。最终只读复核无新阻断缺陷，重跑 4 文件 71 项通过。

Pi 执行中意见的处理：保留用户新输入读取旧 Goal 结果；把已知准入检查前移；删除整条没有生产者的 excludedSubagentRoots 机制；收窄 wakeup 所需接口；重试上限集中常量。查询按接收 run 的既有表达式索引限制，不新增容易过期的“已核对”负缓存，避免请求稍后成功时漏补确认。幂等无变化不发事件，使核对可收敛。

“顺带接收但尚未请求的结果不被主 Stop 永久取消”保持已确认的产品规则；因此其他未尝试结果仍可在 Stop 后触发新一轮，并携带旧未消费结果。不是 Stop 后无限恢复同一来源，每份结果都有持久额度和请求尝试门槛。

Pi 第二轮未发现阻断问题，另提出 Goal 打断原因与停止落盘失败两项非阻断意见。已修前者：Goal 原因沿取消接口透传，仅明确 user-stop 清零普通触发批次，Goal ticket 的 stopIntent 用于取消结果归类。后者未采用静默忽略：若 Stop 的持久写入失败，当前仍向调用方报告存储错误；这可能覆盖这次 completion 的呈现，虽然打断已经发出。尤其建账前没有 ledger 兜底时，不能声称 Stop 已可靠保存。没有为这个故障边界再造持久状态或无限重试。

`checkWakeup` 的决策表（按顺序）：

| 已有事实 | 决策 |
| --- | --- |
| 精确成功请求含 inputId | 补确认，结束，不请求模型 |
| 已 rewind／非后台／无待处理结果 | 不唤醒 |
| 输入已有请求尝试，或仍被未封口 run 持有 | 不独立唤醒 |
| 从未认领且无请求尝试 | 可进入会话与 Goal 准入 |
| 旧 attempted 无可靠 run 关联，或额度耗尽 | 保留结果，等待新触发 |
| 关联 run 活跃、被用户 Stop／取消，或该 run 任何输入已尝试请求 | 不重试 |
| 无请求的入口失败，剩余额度且无 Stop | 到退避时间后进入准入；重试认领前持久扣减 |

Pi 第三轮限定复核结论为“这几处改动没有引入明显错误，可以收尾”，未运行测试；建议的注入时钟统一已采纳。

## 5. SWE 与边界

职责收敛于一个小型内部模块，存储仍是原来的四类事实。运行创建与取消继续由现有 AgentService/RunManager、SessionExecutionGate 负责，没有新增消息状态机、分布式锁、故障分类框架或模型巡查任务。必要的复杂度来自输入和确认分步落盘、停止准备窗口与 Goal 归属，分别有真实存储／阻塞点验证。

没有自动重放不确定工具，也不自动重派子代理；补救由已获原任务授权的主代理使用现有工具决定。旧 attempted 不能证明安全恢复时保持未消费，等待新输入／新结果；旧 delivery=none 不追溯唤醒。UI 的 processed 仅证明成功请求含该输入，不保证任务完成。

交付只包含本地开发分支与分批提交；main 保持原状，等待用户审查。

## 6. 本地提交

- `551ba36d` — 后端投递、恢复、Stop、Goal 归属与正式回归测试。
- `6a1df801` — SDK/Web/TUI 的待处理结果与无输出失败提示。
- 本文所在文档提交 — 设计、实施证据及权威模块文档同步。

两批代码提交均通过仓库原有 pre-commit 全仓 lint/typecheck，未绕过钩子。最后统一时钟和删除无意义 catch 后，补跑唤醒集成 11 项通过；Host 测试夹具类型修正后，目标中断测试也通过。
