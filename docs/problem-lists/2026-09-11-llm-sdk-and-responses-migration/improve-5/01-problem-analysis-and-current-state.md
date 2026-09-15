# 1. 问题分析与代码基线

> 2026-09-15 核对；代码基线 `114f1e512fb77a3ffef144a9886414fc37a0bd80`。下列是改造前行为，未把目标态写成已实现。行号为基线快照，定位以符号为准。

## 1.1 核心问题

| ID  | 基线事实与本轮缺口                                                                                             | 对应方案        |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| P1  | Responses 已解析缓存明细，但消费端仍按完整 Run 筛选，不满足用户新确认的可信 Step 累计。                        | 02 §2.1–2.3     |
| P2  | Run 聚合会丢弃混合明细，完成回调无法恢复其中的可信 Step；只改 tracker 的判断不够。                             | 02 §2.3         |
| P3  | 原始 `llm:complete` 事件不保证一次 Step 只出现一次。直接订阅可能重复相加，或在第一次出现时锁定非最终用量。     | 02 §2.3         |
| P4  | 子代理存在用量事件及 metadata，但主桶有意排除它；需要验证已有记录与 scope 归属，不能把缺少 UI 等同于没有数据。 | 02 §2.4         |
| P5  | 旧文档、测试与本次新规则有明确冲突；实际接口未知/零、异常后累计、跨 UI 的组合证据仍需补齐。                    | 02 §2.5–2.7、04 |

## 1.2 职责：统计与控制已分离

Provider adapter 负责原生字段归一化；llm-client 传递单步 TokenUsage；Lifecycle 汇总 Run 用量、更新校准及保存消息 metadata；外层 ui-inprocess tracker 持有 session 缓存累计；`/status` 提供投影，CLI/Web 格式化显示。

这条职责划分适合继续使用。Context 负责窗口预算和压缩，不负责用户缓存账本；命中统计不会从窗口占用中扣除缓存 token。[Context 数据模型](../../../core/context/data-model.md)已有独立 `UiPromptCacheUsage` 说明。

实际缓存控制另在 [prompt-cache.ts](../../../../packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts)；Responses 当前为 observe-only。改变统计纳入粒度不会改变供应商是否命中缓存。

## 1.3 数据模型：已有未知语义应保留

基线安装 OpenAI SDK `7.13.0`、Anthropic SDK `0.124.0`。本轮以本地安装包与实际 adapter 为事实来源，不推断所有兼容网关都会返回 SDK 类型声明的必填字段。

[token-usage.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/token-usage.ts)中的 `normalizeOpenAIResponsesUsage`（基线约 254 行）已处理：

- `input_tokens`、`output_tokens` 为有效非负整数才形成正常用量，总量采用二者之和。
- `input_tokens_details.cached_tokens` 和 `cache_write_tokens` 分别映射读取、写入；通过字段是否存在保留 observed。
- 两种缓存明细都缺失时不生成 breakdown；只有读取明细时写入值可为 0，但 `observed.cacheWrite=false`。
- 缓存数值非法或分桶超过总输入时不保留不可信 breakdown，保留有效输入/输出总量并走既有诊断。

Chat parser 使用对应的 prompt 字段；Anthropic accumulator 处理独立 uncached/read/write，再归一成 inclusive input。内部单步合同为：

```text
inputTokens = uncached + cacheRead + cacheWrite
totalTokens = inputTokens + outputTokens
```

`observed.cacheRead=false` 与 `cacheRead=0, observed.cacheRead=true` 含义不同。SDK 的类型声明、数字默认值或“这个模型通常会缓存”都不能替代实际观测。

## 1.4 架构与数据流：旧门槛在哪里

当前主链路：

```text
provider usage → 单步 TokenUsage
  → Lifecycle aggregateTokenUsage → Run usage
  → RunManager.onRunCompleted
  → ui-inprocess tracker.record → /status → SDK / CLI / Web
```

[aggregateTokenUsage / combineBreakdown](../../../../packages/ohbaby-agent/src/core/lifecycle/token-usage.ts)保持 Run 总输入/输出的已知小计。非零输入 Step 缺 breakdown，后续 Run breakdown 就无法继续保持完整；缺整个单步 usage 会令 `usageComplete=false`。这些是总用量聚合合同，不只是缓存 UI 的实现细节。

[promptCacheUsageSample](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.ts)要求 Run `usageComplete=true` 且读取 observed。因而一个混合 Run 会整体拒收。当前 `record` 对无效样本返回已有累计；这已满足“最新未知不覆盖历史”。

[RunManager.finalizeRun](../../../../packages/ohbaby-agent/src/runtime/run-manager/manager.ts)约 304 行调用完成观察者；重复 `waitForCompletion` 共用完成 promise，原路径不是每次读取状态都重复记账。但是 [RunWorker.start](../../../../packages/ohbaby-agent/src/runtime/run-manager/worker.ts)异常分支可能没有 LifecycleResult，无法只靠完成时收集结果恢复前面 Steps。

另一个陷阱在 [streaming.ts](../../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts)约 397 行：finishReason 已设置后，后续非 usage-only 输出仍可能 `isComplete=true`。[Lifecycle.runModelStep](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts)约 1012 行每次都可发出 `llm:complete` 并更新 finalEvent。真正采用最终用量只在 runModelStep 返回后、约 593 行 `aggregateTokenUsage` 执行一次。事件名包含 complete 不等于适合直接增量记账。

## 1.5 用例与生命周期现状

用输入 1,000/read 800、输入 2,000/read 未知、输入 1,000/read 600 三步举例：旧规则不纳入整轮；新规则应保留 2,000 输入和 1,400 读取，贡献 70% 的样本。它仍与该 session 其他已知步骤一起加权，不把 70% 直接覆盖历史值。

[ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)外层持有 tracker，约 505 行过滤子代理、已退休 session 和不再接受观察的 backend。tracker 不随内部 runtime 重建而重建，所以换模型与 compact 不清桶。删除/归档清目标桶并防止迟到回调恢复它；dispose 清全部。进程重启归零是已有约定，消息持久化并不自动意味着缓存累计恢复。

`usageComplete` 仅覆盖进入聚合的 Step 结果，不是“所有 HTTP 尝试都被观察到”的证明。某一步没有终态或抛异常时未必经过聚合；本轮不能借改 cache 之名修订总用量完整性或补算失败计费。

## 1.6 子代理、持久化与跨模块边界

[subagent-host.ts](../../../../packages/ohbaby-agent/src/agents/subagent-host.ts)约 353 行表明，兄弟子代理可能共用 child session，`contextScopeId=subagentId` 才区分各自历史。它们通过 [agent runner](../../../../packages/ohbaby-agent/src/core/agents/runner.ts)进入同一 RunWorker、Lifecycle 和 ContextManager。

[context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts)按 session+scope 隔离历史、校准因子和压缩状态；主子都经过预算测量、reduceContextForModel 与 runCompaction。子代理使用自己的 system prompt，跳过主 memory 加载，但没有跳过窗口管理。相同机制不表示共享历史或共享压缩状态。

单步已有两类验证来源：

- worker 将 `llm:complete.tokenUsage` 传到 `run.llm.complete`，携带运行及上下文归属。它是观测来源，不是新的统计入口。
- [token-usage-metadata.ts](../../../../packages/ohbaby-agent/src/core/message/token-usage-metadata.ts)保存/读取原有 Part metadata：text 步在文本 Part，tool-only 正常路径在第一个工具 Part；hybrid 不再给工具重复附加。writer 保留 observed；reader 兼容旧键并校验数据。

持久化范围存在明确限制：缺 usage 不造零；reasoning-only 或无承载 Part 不造空消息；tool-only 在 usage 处理后立刻 abort/length 时可能尚未创建工具 Part。因此“运行时有 usage”不等于“数据库恰有一条 usage”。子代理静默验证应覆盖已有正常落盘路径，不扩展为全失败账本。

## 1.7 展示与工程约束

现有 [SDK DTO](../../../../packages/ohbaby-sdk/src/prompt-cache-usage.contract.test.ts)只包含 sessionId、accountedInputTokens、cacheReadTokens、cacheReadShare；后端算比例，两个前端进行结构校验和格式化。

[CLI status-panel](../../../../packages/ohbaby-cli/src/tui/render/status-panel.ts)与[Web slashCommands](../../../../apps/ohbaby-web/src/ui/slashCommands.ts)保持 `null → hit —`、零 → `hit 0%`、比例四舍五入为整数。不需要因为后端筛选粒度变化扩展 UI 状态。

新增观测不能影响模型执行、取消、校准或工具结果；应保持同步、短路径、不做 I/O。外层仍只维护两个累计数，不建立永久的 run/step 去重索引，不为统计保存完整请求。

## 1.8 测试现状与缺口

| 现有证据                                             | 已保护内容                              | improve-5 缺口                                                   |
| ---------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------- |
| provider token-usage / responses-token-usage unit    | 原生字段、零/未知、损坏明细             | 补三协议混合明细进入新累计链的组合                               |
| lifecycle token-usage unit                           | Run 已知小计与完整性                    | 旧合同保留；另测新 Step 观察次数与时机                           |
| prompt-cache-usage unit、ui-inprocess contract       | 旧 Run 筛选、session 生命周期、极简显示 | 将旧筛选期望替换为可信 Step；保护迟到、异常、重复终态            |
| usage-calibration integration、token-usage-roundtrip | 原生归一、校准、metadata/bridge         | 接上真实 Step 观察至 session 投影，避免只测 fake canonical usage |
| context-state-machine、context-subagent-scope        | 主子预算、压缩、隔离                    | 子代理缓存 metadata 的正常落盘及主桶排除                         |
| Responses migration real E2E                         | 三协议真实生产 Lifecycle 与工具往返     | 新统计链和实际读取字段证据；不得要求非零命中                     |

旧 `test:cache:real` 脚本含必须观察正缓存读取、缓存控制 epoch 等验收，服务于原缓存控制议题；不能将其整体当成本轮 cache 观测的通过门。04 单独说明复用哪条 live 路径及断言。

## 1.9 文档对照与 SWE 判断

| 文档说                                      | 基线代码做                         | 本轮关系                                     |
| ------------------------------------------- | ---------------------------------- | -------------------------------------------- |
| 旧 session-cache-hit：整 Run 可信才记       | aggregate + tracker 正在实现旧约定 | 用户明确改规则，02 替代该条                  |
| improve-4：总 usage、校准、完整性保持       | 当前按 final Step usage 聚合/校准  | 继续保持，不把 Run 改成只汇总可信 cache Step |
| Context 数据模型：可信 run 累计，指向旧方案 | 与旧 tracker 一致                  | 实施后应改为可信 Step 并更新当前指针         |
| 用户：子代理静默、有可验证记录              | 主桶过滤；事件/metadata 已存在     | 补归属与可读性验证，保留覆盖限制             |

最小改动应放在已有职责边界上：Lifecycle 暴露最终单步用量事实，runtime 补身份，adapter 决定是否纳入主界面。把缓存规则放进 Context、把 Step 数组塞进 RunResult、重放 UI 事件算账或引入跨进程账本，都会增加本轮不需要的复杂度。这里是可逆的内存观察与累计调整，无数据库迁移需求。
