# 改造方案与关键改动

规划基线：`d5625248ea877cee107ee73cec23b146f50be1b5`。这是实施契约，尚未实施；本轮所有 Stage 属于 improve-1。模块结构见 [architecture](design/architecture.md)，术语和恢复判定见 [data-model](design/data-model.md)，验收见 [04](04-test-and-acceptance.md)。

## 1. 方案总览

修复自动主轮次的持久消息身份，随后把父子投递规则收拢到现有 subagents 内部服务。复用 execution、input、run/request，不增加信箱。按“终态落盘 → 输入接收 → 主运行判断和工作 → 成功请求确认”衔接，补齐故障中断通知与无输出失败反馈。

| 决策 | 选择与理由 | 未采用方案及代价 |
| --- | --- | --- |
| 持久身份 | runtime input 使用其稳定命名空间；保留身份冲突检查 | 不使用 UI 序号，不覆盖冲突行；需要统一 UI 投影 ID |
| 内部服务 | 薄组合入口，保留现有两条方向的实现 | 不建通用 broker；只集中实际共用规则 |
| 自动机会 | 与 run/request 关联，请求前且非 Stop 的入口失败有限重试 | 不永久吞掉入口失败，也不无限重试模型；只持久剩余恢复额度，不建错误分类框架 |
| 消费确认 | 精确成功请求成员关系 | 不按事件已发出、run 成功或界面已展示确认 |
| Stop | 主 Stop 不停止子代理，新结果仍可唤醒 | 不新增主会话永久暂停状态；同一失败结果不循环唤醒 |
| 中断 | 自然失败和进程故障通知；主动停止子代理不自动唤醒 | 不一概忽略 interrupted，也不一概把它当故障 |
| UI | 子执行状态与主处理错误分别投影 | 不增加独立信箱页面，不伪造用户消息 |

## 2. 分阶段实施

### Stage 1：修复身份并建立真实回归测试

在 persistent facade + SQLite 的正式集成测试中加入其他目录历史 `message_1`，复现自动轮次失败。先生成 runId，再生成消息 ID；统一 `submitPromptWork`、runtime composition 的 runtime input 身份，使 UI message 与持久接收一致；普通用户输入保持已有 UUID 工厂。

改动集中在 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`、`adapters/ui-runtime/composition.ts` 和相关集成测试。不改掉 input store 的冲突保护，不做全库消息 ID 迁移。

完成定义：T01、T02 通过，跨目录／超出加载窗口的历史消息不再影响自动运行，真正内容冲突仍拒绝。

### Stage 2：统一投递、确认和自动机会

新增 `agents/subagents/delivery.ts` 组合入口，接已有 channel/coordinator/supervisor。调整 `execution-store.ts` 的条件认领，使自动机会带实际 runId；组合层先保留 runId，再认领并提交同一 run。pending 创建仍留在 startSession，reserveRunId 只是内存保留，持久关联放在 execution.delivery。

让 `subagent-wakeup.ts` 接收有类型的 completion，统一处理 resolve-failed、cancelled 和 rejection；每条路径释放 gate，已创建的 run 按既有规则关闭。首个请求前且不是 Stop 的入口错误最多额外重试 3 次，重试前持久扣减剩余额度（新结果初始 3），不被 active/idle 或服务重启重置；退避沿用 supervisor 内存定时器。没有 run 记录时只能在提交已失败或恢复已取得会话所有权后核对，不能抢占仍在提交的 run。收到 Stop 先将触发该 run 的结果的剩余额度置 0，再完成取消收尾；顺带接收的结果不受影响，不为取消在外层新造账本行。请求尝试后不再自动重试同一来源，沿用 provider 自己的 retry。

`current-run-inputs.ts` 提供恢复核对能力：分页检查对应 run 的请求，按精确 inputId 找成功持久请求，补已遗漏确认；不能只看 firstAttemptRequestId。可复用 `adapters/ui-inprocess/steer-recovery.ts` 的有界分页经验，但不能照搬“存在任意成功请求即可”的判断。coordinator 复用底层核对能力，不另写一套消息解释器。

coordinator 移除 markDelivered 后立即 claimWakeup 的处理：顺带接收的结果只有进入请求才消耗自动机会；真正触发本次 run 的结果仍在启动时认领。顺带结果是否已请求，以 input.firstAttemptRequestId 为权威，即使请求后 execution claim 尚未补写，也不能重复唤醒。这样，Stop 收尾窗口顺带接收但尚未请求的 C 仍可在 idle 后唤醒；触发这次已停止运行的 A/B 不会自行重开。忙闲接力、末尾输入关闭与分批消费沿用现有调度边界。

完成定义：T03–T09 通过；无重复主 run、无请求后自动循环，丢事件或恢复时可从持久关系解释每个结果的去向。

### Stage 3：补齐故障中断与恢复

终止原因沿用现有 reason 受控常量，不新增类别字段。`finishRecord` 对 process-interrupted 和 service-shutdown 保留 pending，对手动 stop/close 保持控制回执语义；failed/timed_out 继续原有 pending 路径。正常停服由 `agents/subagent-host.ts` 保存终态，关闭准入期间不启动模型；异常退出由 `runtime/execution-recovery/session.ts` 验证 owner 后补终态。由组合层在会话接管后核对通知，不让读历史的接口做写操作。closeAdmission 先 abort 时，turn 内 markInterrupted 也必须从 lease.stopReason／受控 abort reason 保存 service-shutdown，不能固定写 cancelled。测试两条终态写入路径的竞速，不放宽终态不可覆盖规则。

在 execution 接收事实中保存 goalId：有 Goal 为 string，明确普通任务为 null，旧记录缺失表示未知。来自受信任的运行上下文，沿子派遣继承，不由模型参数或完成时的当前 Goal 推测。子结果自动启动及 coordinator 的排除规则使用这个持久归属，不再仅依赖内存 ownedRuns 或 triggerSource。

故障通知带任务、身份、状态、原因和可取得的输出；复用 `result-artifacts.ts` 的降级输出，文件异常不阻止基本通知。主代理收到后可自行补救，不由恢复模块重放工具或重新派遣。

完成定义：T10–T12、T15 通过。服务存活时自然失败立即通知；服务重启后在会话被运行时接管时补故障通知。Goal 归属不明时不绕过准入，主到子已关闭消息不被隐式重放。

### Stage 4：用户反馈与整体验证

扩展 SDK 投影中的必要投递提示，保持 Completed 只描述子执行。同一子代理被多次使用时，要核对其仍未消费的 execution，不能只看最新一次执行；已有 unprocessedMessageCount 表示主到子消息，不能挪作子结果待消费数量。无可见消息的自动失败也进入共用 turn 视图，并使用现有 Web/TUI 每轮错误组件。正常无输出成功轮次仍可隐藏，用户 Stop 不伪装为 provider error。

改动 `packages/ohbaby-sdk/src/util/turn.ts`、subagent contract/readers，及 Web 子代理列表；TUI 优先接已有共用投影，不另建组件体系。与正在进行的 model-waiting-and-error-feedback 议题核对，避免覆盖它的未提交修改。

完成定义：T13、T14 通过并完成 T01–T15 回归。同步权威文档后，在 05 记录实际命令、结果、偏差及仍未完成项。

## 3. 按包的改动面

| 包／目录 | 新增／修改 | 删除 |
| --- | --- | --- |
| ohbaby-agent / agents/subagents | 一个内部组合入口；投递元数据、核对、通知与相关测试 | 删除收拢后重复的判定，不删现有工具能力 |
| ohbaby-agent / adapters | runtime ID、保留 run 交接、类型化 completion、恢复接线 | 移除使用 UI 局部编号的 runtime fallback |
| ohbaby-agent / runtime 与 Goal 接线 | input 成功核对；恢复原因；Stop 的恢复额度收尾；受信运行上下文传递 goalId | 不替换调度器、Goal driver 或存储层 |
| ohbaby-sdk | 可选投递投影、无输出失败可见性及测试 | 无协议字段移除 |
| Web／TUI | 接现有错误展示及必要子代理辅助提示 | 不重做布局 |
| docs | 同步下列权威约定；实施后写 05 | 不改写历史验收结论 |

## 4. 迁移与兼容

新增 delivery 字段和 execution.goalId 向后兼容，具体是否需 SQLite schema migration 由现有序列化结构决定，不能预先声称无需迁移。终止原因复用已有字段。持久化与内存实现语义一致。

旧记录不批量重置 attempted，也不把已存为 delivery=none 的历史 interrupted 升级为 pending；只对新版本写入的终态建立新投递事实。能用精确身份查出成功消费的补确认；不能核对的保留未消费状态，由新用户输入／新子结果带入。真实故障会话中的最后一份旧结果也遵循这条规则，不假装部署新版本就能安全恢复所有未知历史。

手动打开会话可建立恢复所有权，但读取历史列表、monitor 或浏览器刷新不等于新的运行授权。UI 新字段可选，旧客户端仍能读取执行状态；新客户端对缺字段显示原有状态，不将未知当成已成功消费。

Goal 结果仍由现有 Goal 准入处理。当前不存在足够的持久 Goal/run 关系，不能把它写成现成能力；本轮以 execution.goalId 补齐。旧记录缺失时，只在完整持久 Goal 历史证明该会话从未创建 Goal 时按普通结果处理，否则保留该条并提示无法安全自动续跑；禁止 fallback 为普通结果。新记录 goalId=null 的普通结果不受影响。Goal 已结束或已替换也不改变旧结果归属。

## 5. 风险与回滚

主要风险是：认领后提交未完成；用户 Stop 与顺带交付并发；成功已落盘但确认遗漏；停服终态漏投；Goal 归属丢失；旧 interrupted 原因不明。分别由 T04、T06–T12 覆盖。

外部模型／工具副作用不能与本地事务合并。未知请求结果保持未知，不以“可靠投递”为由自动重放。日志只记录 source/input/run/request 身份、决策类别和错误摘要，不复制整份提示或敏感输出。

按 Stage 保持可独立审查的变更。回滚运行逻辑时保留新增事实和已有结果，不清空 delivery、请求记录或改写终态。若新存储字段老版本无法兼容，先验证读写兼容再回滚二进制；不能靠删库恢复。Stage 1 的安全身份修复与冲突检查应优先保留。

## 6. 关键改动清单

用户已要求列出。行号为规划基线快照，以符号为准；本表不是实施进度表，不在实施时勾选或回写行号。

| ID | 路径／符号 | 行号快照 | 关键变更与原因 |
| --- | --- | --- | --- |
| C1 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` · `submitPromptWork` | 4200、4405 | 自动输入不得使用局部 messageIds；保留并提交相同 runId |
| C2 | `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` · `reserveRunId`、`onInputReady` | 575、1333 | 接相同 runId 的认领／提交；runtime 命名空间是权威消息身份 |
| C3 | `packages/ohbaby-agent/src/agents/subagents/execution-store.ts` · `finishRecord`、`claimWakeup`、`markProcessed` | 218、565、582 | 原因分类、run 关联、有限入口重试和幂等确认 |
| C4 | `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-wakeup.ts` · `reserveSubagentWakeup`、`createSubagentWakeup` | 29、136 | 准入／认领／提交一致；处理 resolved failure；不绕过 Goal |
| C5 | `packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.ts` · `admitRequestAttempt`、`confirmRequestSuccess` | 546、609 | 复用请求成员关系完成崩溃后的核对，保留身份检查 |
| C6 | `packages/ohbaby-agent/src/agents/subagents/session-supervisor.ts` · `check` | 91 | 候选判定不能只排除 attempted；持久恢复额度不会被 idle 重置，内存退避继续复用 |
| C7 | `packages/ohbaby-agent/src/runtime/execution-recovery/session.ts` · 恢复 interrupted | 243 | 标明故障来源，提供组合层后续核对入口 |
| C8 | `packages/ohbaby-sdk/src/util/turn.ts` · 轮次可见性 | 88 | 无消息的自动失败仍可见，保留正常静默成功语义 |
| C9 | `packages/ohbaby-agent/src/agents/subagent-host.ts` · execution 接收、`closeAdmission`／`dispose`／`markInterrupted` | 527、1345、1790 | 接收时保存 goalId；停服各路径保留相同 reason，避免先写 cancelled |
| C10 | `packages/ohbaby-agent/src/agents/subagents/continuation-coordinator.ts` · `reconcile`、`admitRequestAttempt` | 155、176 | 顺带交付不立即耗尽自动机会；核对请求尝试和持久 Goal 归属 |
| D1 | `docs/runtime/prompt-scheduler/subagent-inputs.md` | 按章节定位 | 明确入口重试与一次自动机会、成功确认及恢复的关系 |
| D2 | `docs/agents/goals-duty.md`、`docs/agents/dfd-interface.md` | 按章节定位 | 同步内部服务职责、恢复接线、两方向输入契约 |

连带影响包括 `continuation-coordinator.ts`、`execution-message-channel.ts`、`result-artifacts.ts`、SDK `contract/subagent-instance.ts` 和 `sync/subagent-instance-reader.ts`，以及 `apps/ohbaby-web/src/ui/side-panel/subagents/`。run ledger 若需要补原子或复用端口，范围限于现有 `runtime/run-ledger/`，不得顺带引入通用任务队列。

## 7. 范围检查

本轮覆盖 00 已确认的父子可靠投递、自动续跑、失败补救通知与必要反馈。不建设跨会话消息系统，不恢复定时模型巡查，不自动执行补救策略，不更改 monitor 的只读语义，不实现任意数量服务实例的分布式接管。本轮没有用户可见的永久“暂停接收子结果”开关。
