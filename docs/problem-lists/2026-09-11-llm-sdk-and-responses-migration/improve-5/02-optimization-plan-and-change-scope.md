# 2. 优化方案与改动面

> 实施合同；实际结果见 [05](./05-implementation-acceptance.md)。按 [00](./00-discussion.md) 的用户确认推进，验收依据为 [04](./04-test-and-acceptance.md)。代码基线见 README，符号优先于行号。

## 2.1 新规则替代范围

本轮直接采用“可信 Step 纳入 session 累计”，删除缓存消费端对整 Run 的共同门槛，不保留旧规则开关、旧算法 fallback 或双轨比例。

替代的是旧 session-cache-hit 的纳入规则与观察入口。`LifecycleTokenUsage`、`aggregateTokenUsage`、Run `usageComplete`、校准与消息持久化原有合同继续保持。**Run 总量仍统计其原本处理的用量，cache 样本只纳入其中可确认读取明细的 Step，两者允许不同。**

术语：Step 是 Lifecycle 接受的一次最终模型结果；Run 是一次任务执行，可包含多个 Step；session 是跨 Run 的累计范围。原始流里的每一帧、每个 complete 标志、每次重试尝试都不是独立 cache 样本。

## 2.2 最小数据合同

### 单步纳入条件

消费 canonical `TokenUsage | undefined`，不重新解析原始 JSON。可信样本满足：

1. 该 Step 已到达 Lifecycle 最终结果的用量处理位置。
2. 存在有效的正常 TokenUsage 与 `inputBreakdown`；总量及分桶符合已有非负整数合同。
3. `observed.cacheRead === true`；不要求 `observed.cacheWrite === true`。
4. 输入大于零，分桶之和等于 inclusive `inputTokens`，读取不超过输入。

不因当前 Run `usageComplete=false` 拒收本 Step。读明细明确为零可以纳入；读明细缺失、仅写明细存在、损坏 breakdown、缺整份 usage 都不纳入。零输入不贡献分子或分母，也不能把空累计变成已知 0%。

```text
对每个可信主代理 Step s：
  accountedInputTokens += s.inputTokens
  cacheReadTokens      += s.inputBreakdown.cacheRead

cacheReadShare = accountedInputTokens > 0
  ? cacheReadTokens / accountedInputTokens
  : null
```

`inputTokens` 已含读/写缓存，不再次相加。没有写明细时，正常归一化的剩余输入包含未进一步区分的部分，但不影响已知读取 / 总输入这个比例。

### 累计与显示例子

| 输入序列                                        | 本序列纳入输入/读取 | 空历史下结果                  |
| ----------------------------------------------- | ------------------- | ----------------------------- |
| 100/read 100；900/read 0                        | 1,000 / 100         | 10%，不是两个百分比平均的 50% |
| 1,000/read 800；2,000/read 未知；1,000/read 600 | 2,000 / 1,400       | 70%，不会当作未知步骤读取为零 |
| 同上，但第二步明确 read 0                       | 4,000 / 1,400       | 35%                           |
| 全部读取明细未知                                | 0 / 0               | `hit —`                       |
| 1,000/read 0                                    | 1,000 / 0           | `hit 0%`                      |

若此前已有输入 2,000/read 1,000，上表第二行加入后的 session 比例为 `(1,000+1,400)/(2,000+2,000)=60%`，不显示该 Run 的 70%。后续全未知不改变已有 60%。

公开 `UiPromptCacheUsage` 继续使用原四字段，不增加状态、时间、覆盖率、缺失数量、最后一轮比例或子代理汇总。Web/TUI 仍在原 `/status` 位置四舍五入显示整数百分比。SDK 继续传输累计值，不要求前端重新累计。

## 2.3 唯一单步观察入口

采用一个窄的、可选的同步内部观察回调，沿现有装配关系传递。名称为 `onStepUsage`，语义不能退回原始流事件或 Run 结果。

```text
provider → llm-client → Lifecycle.runModelStep 返回最终结果
                              ↓
             Lifecycle 接受 finalEvent.tokenUsage（一次）
                    ├─ 原有 Run aggregate / 校准 / 后续流程
                    └─ 可选单步用量观察（异常隔离）
                         ↓ worker 补 run/session/scope/isSubagent
                         ↓ manager + composition 透传内部端口
                         ↓ ui-inprocess 过滤归属和退休状态
                         ↓ 原 session tracker 按可信 Step 累加
                         ↓ /status 原 DTO → CLI / Web
```

### 接缝与责任

- 在 `Lifecycle.run()` 中 `runModelStep` 正常返回、已有 `aggregateTokenUsage(usage, finalEvent.tokenUsage)` 的位置观察该 Step。基线在 lifecycle.ts 约 593 行；在取消、length 和工具处理之前，每个最终结果只调用一次。无 finalEvent 的分支不伪造观察数据。同 Step 首次尝试即使曾发出 complete，只要随后抛出 context overflow 而进入重试，就不纳入首次尝试；仅记录最终成功返回的重试结果。
- `LifecycleSessionParams` 增加可选回调，只提供 `{ step, tokenUsage }` 等最小单步事实。不在 Lifecycle 维护 session cache 累计、不做主子过滤，不让 core 认识 `UiPromptCacheUsage`。
- RunWorker 在构造 Lifecycle 参数时接入回调，用自身 RunContext 补齐 `runId/sessionId/contextScopeId/isSubagent`。RunManager 与 composition 只透传端口，不重算用量。
- 回调同步执行且异常隔离，不重试、不做 I/O、不改变模型、校准或工具结果。载荷按只读快照使用，不允许观察者修改正在被聚合/校准的 TokenUsage；跨信任边界需要拷贝时复用现有拷贝方式，不造快照框架。
- ui-inprocess 将 cache 记账从 `onRunCompleted` 迁到单步端口，保留 `acceptsPromptCacheUsage`、`isSubagent`、retired-session 过滤及外层 tracker 所有权。
- 移除不再使用的 cache 完成观察接线及仅为它存在的内部声明；常规 Run completion、wait、ledger 与已有 stream 事件合同保留。实施时核对导出消费者，不随便删除仍有独立用途的完成 API。

这里增加的内部回调是让原先丢失的事实到达已有累计器的必要接缝，不是新增产品状态字段。正常累计仍只有原来的两个数字。title/summary/compact 的辅助调用不经过这个 agent-step 接缝，不加 purpose 过滤，也不把辅助请求接进来。tracker 的 sample/record 输入直接改为单步 TokenUsage；旧 Run 级入口及旧拒收测试由新规则替代。经基线检索，onRunCompleted 的唯一生产消费者为 cache，本轮删除其空置端口与类型，保留正常 RunCompletion。

### 一次记账与失败边界

不订阅 UI/SSE 重放，不从 `run.llm.complete` 增量累加，不在 `onRunCompleted` 再记一次。一次性来自 Lifecycle 的最终结果处理点与每个 Run 唯一执行路径，而非永久保存所有 runId/stepId 的 Set。

同一步可能出现多个原始 complete 事件，必须采用 runModelStep 最终接受的结果，不能“第一次 complete 立即收下，再用 Set 屏蔽后续”。04 用多终态、不同用量样本证明只取最终结果。

前面可信 Step 一旦结算，就保留其累计。后续 Step 缺明细、EOF、异常、取消或工具失败均不撤销前面。当前 Step 在最终处理前抛错、只有中间 usage 或没有 finalEvent，则不额外记该步。当前 Step 已接受用量后才 abort/length，仍纳入其可信样本。这定义的是可观测的已结算 Step，不是所有实际收费 HTTP 尝试的账本。

不把所有 Step 数组加进 LifecycleResult 后等待 Run 完成；否则后步异常不返回结果时仍会丢前步，并要求更多缓冲和补偿。

## 2.4 session、子代理与上下文

tracker 保持 backend 外层内存所有权：不同 session 独立；跨 Run、模型切换、runtime 重建、手动/自动 compact 继续累计。切换显示中的会话只读取该会话的桶，不挪动旧会话用量。删除/归档清目标桶并拒绝迟到观察，dispose 拒绝后续观察并清全部。新进程不从 message metadata 重建 cache 累计。

子代理经过同一观察接缝，但主界面入口必须过滤 `isSubagent=true`。不把子代理 `wait`、task 返回值或 child metadata 再折入父桶。工具输出作为父代理下一次输入时，只按该次父请求供应商实际返回的 usage 正常计量，不手动扣减或额外加子代理内部消耗。

子代理静默验证复用现有事件与 Part metadata：正常 text、tool-only、hybrid 路径经 production reader 读取，保持缓存数值与 observed；每步至多一个已有 Part 携带 usage。两个子代理共用 child session 时，按 `contextScopeId` 区分，不仅按 sessionId。

主子共用 ContextManager 的预算、校准、压缩机制，分别隔离状态。本轮仅补回归证据，不改 system prompt、memory 策略或压缩算法。缺 usage 不补零，无承载 Part 不造记录；运行时观察与持久化 metadata 不承诺覆盖完全相同，不新增 child cache tracker、用量表或 logger。

## 2.5 分阶段实施与改动面

### Stage A：单步事实和累计纵向贯通（P1–P3）

先写在基线能暴露“混合 Run 丢已知 Step”和“按原始 complete 重复计数”的确定性测试。增加单步观察接缝，接入原 tracker，切断 cache 的旧完成回调累计。parser 正常规则尽量复用，只有测试证实与本合同矛盾时做最小修复。

完成定义：04 T1–T6 通过；可信/未知任意顺序都只累计可信 Step，重复流终态只采用最终用量，Run 总 usage 与校准保持旧合同。

### Stage B：身份、生命周期与静默记录（P4）

沿新入口核对不同 session、主子代理、兄弟 scope、runtime 重建和退休行为。扩展已有 metadata 与上下文回归；不新增存储架构。

完成定义：04 T7–T10 通过；主桶排除 child，正常 child metadata 可核对，压缩不清统计也不混 scope。

### Stage C：公开消费者、真实观测和文档同步（P5）

验证 SDK DTO、CLI/Web 文案一致。扩展已有 Responses migration 三协议 real E2E 的观测证据：在生产 Lifecycle 参数挂生产单步回调并接生产 tracker；该 live harness 不冒充完整 ui-inprocess，完整装配另由确定性集成验证。按用户最新授权增加 ZenMux 多模型、智谱与阿里百炼可用接口的真实观察；不改变缓存控制。同步当前权威说明，跑定向与最终 preflight，另写本轮 05。

完成定义：04 T11–T14 通过或按 04 明确记录尚未满足的门，不能将未运行/跳过写成通过。

| 改动面          | 具体入口                                                                                                                                                                                       | 范围                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Lifecycle       | `packages/ohbaby-agent/src/core/lifecycle/{types.ts,lifecycle.ts}`                                                                                                                             | 可选最终 Step 观察；不改 aggregate/校准算法                |
| Run 装配        | `packages/ohbaby-agent/src/runtime/run-manager/{types.ts,index.ts,worker.ts,manager.ts}`                                                                                                       | 透传端口、补运行身份、清除无用旧接线                       |
| backend         | `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`、`adapters/ui-inprocess.ts`、`adapters/ui-inprocess/prompt-cache-usage.ts`                                                      | 可信 Step 取样、原 session Map 与过滤                      |
| Provider / 消息 | `services/interface-providers/token-usage.ts`、`core/message/token-usage-metadata.ts`                                                                                                          | 优先只补测试；不为已有正确路径重写生产实现                 |
| SDK / CLI / Web | `packages/ohbaby-sdk/src/prompt-cache-usage.contract.test.ts`、CLI status-panel 与 Web slashCommands 相关测试                                                                                  | 原 DTO 和极简显示的回归，无新 UI 字段                      |
| 集成 / real     | 既有 usage-calibration、子代理 scope、ui-inprocess；新增 `tests/integration/runtime/prompt-cache-step-accounting.integration.test.ts`；既有 `tests/smoke/responses-migration.real.e2e.test.ts` | 真实组件配受控网络；live 显式 opt-in                       |
| 文档            | `docs/core/context/{data-model.md,architecture.md,goals-duty.md}`，旧 session-cache-hit README，本轮 05                                                                                        | 实施后把当前说明及指针更新为可信 Step；旧冻结 00–05 不回写 |

路径均相对仓库根；本表为包/文件级改动面，不是逐项进度表。仅必要文件发生生产改动；不要为了让表中每一行有 diff 而改文件。

## 2.6 API、迁移与历史合同

SDK `/status` 的字段、数值类型、null 语义及现有 stream schema 不变。仅增加可选内部观察端口，调用者不接入时 Lifecycle 行为保持。已有 TokenUsage、LifecycleResult、RunCompletion 的总用量数据不改为 cache 专用含义。

本轮没有数据库 schema 迁移、历史重算或在线混合算法升级。新启动的 backend 使用新规则，沿用原来进程内累计的生命周期。

旧 session-cache-hit 00/02/04、Context improve-6 的旧 cache 候选以及 improve-4 的统计不变约束，只作为当时范围的历史证据。2026-09-15 用户已明确授权本轮新统计行为，实施不需要再次申请“是否可以改变整 Run 筛选”。规划期用 README 后继指针说明覆盖关系；实施完成后才把当前模块数据模型改成已实现描述。

## 2.7 风险与回滚

| 风险                                       | 防范与验证                                           |
| ------------------------------------------ | ---------------------------------------------------- |
| 原始终态重复或第一个终态用量非最终         | 在最终 Step 处理点观察；T3 不同终态 fixture          |
| 新 Step 入口与旧 Run 入口双记              | 移除 cache 的旧累计接线；T5 跨 Step/Run 精确分子分母 |
| 为了 cache 放松 Run 完整性，影响校准或总量 | tracker 改为单步输入；总量/校准旧测试继续通过，T6    |
| 子代理迟到事件进入主桶或退休桶复活         | 复用原过滤与外层所有权，T7–T9                        |
| 观察回调抛错阻断主任务                     | 同步异常隔离，T4；回调不承担关键业务副作用           |
| live 无明细被当成实现失败或当作 0          | T13 依据实际字段验证未知分支；非零命中不作为门       |

变更可按单步观察及 adapter 接线整体回退，无存储迁移。但若回退为旧 Run 筛选，应明确回退后的产品行为并更新发布/验收说明，不能静默保留两套策略。既有可用数据的持久化格式不受回退影响。

## 2.8 不在本轮

提高命中率、前缀重排、请求控制、key/TTL、原生 Responses stateful/continuation、窗口占用和压缩算法改造、所有 HTTP 尝试估算计费、主子合并展示、缓存跨重启持久化、覆盖率诊断 UI 均不在本轮。它们只作为既有后续候选，不提前创建 improve-6。

## 2.9 实施中经真实证据确认的最小归一化修复

2026-09-15 的 ZenMux/Qwen 与百炼/Qwen Anthropic 流先在 message_start 报未拆分输入，随后在 message_delta 报重新分类后的输入及缓存。例子为 start input=5,341；final uncached=402、read=4,992、write=0。旧逐桶 max 会得到 10,333，正确 inclusive input 是 5,394。该问题属于本轮允许修复的确定统计错误。

`createAnthropicUsageAccumulator` 的三个输入分桶改为合法字段存在则覆盖，缺失/null/非法字段不覆盖；显式单字段零也生效。仅三个输入字段均明确为零、而已有正输入时，保留完整旧输入组，延续本仓库既有“全零占位”兼容例外。output 仍沿用原单调策略。诊断只报告实际拒绝下降并保留旧值的情况。

安装的 Anthropic SDK 0.124.0 `MessageStream.ts` 对存在的输入/缓存字段直接覆盖；[官方源码](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/MessageStream.ts) 同样如此。全零例外是本项目兼容约定，不是 Anthropic 标准要求。本修复替代旧 Context improve-5、migration improve-4 对**输入逐桶单调合并**的描述，其余 Run aggregate/usageComplete/校准算法及旧验收历史保持原义；只让它们收到修正后的 canonical 输入。请求前缀、cache_control、key、TTL 均未改变。
