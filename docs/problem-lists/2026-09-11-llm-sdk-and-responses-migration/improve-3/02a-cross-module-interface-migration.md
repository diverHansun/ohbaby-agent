# 跨模块旧接口与批次依赖

> 基线a18290f3；接口调查与批准的迁移顺序，非实施进度。路径默认相对packages/ohbaby-agent/src。字段含义唯一来源为design/data-model.md。设计已获批准，实施仍须先通过improve-2门禁并合入集成分支。

## 1. 模块接口清单

| 模块 / 文件符号 | 旧依赖 | 本轮适配 | 批次 |
| --- | --- | --- | --- |
| services/interface-providers/types.ts InterfaceProviderRequest | ChatCompletionMessageParam、InterfaceProviderFunctionTool(s) | 自有请求消息和扁平工具；三个具体adapter直接投影 | A |
| core/llm-client/streaming.ts streamChatCompletion 参数 | messages:ChatCompletionMessageParam[]、options.tools | 输入改ModelMessage/工具类型，调用形参形式、retry/signal/options保持；必要回复结构适配随A，不能破坏多轮回传 | A |
| core/message/converter.ts toModelMessages；manager.ts/types.ts 同名接口 | 返回ChatCompletionMessage[] | 只改模型投影输出及公开返回类型；不改Message/Part存储 | A |
| core/context/serializer.ts serializeForLlm/serializeHistoryMessages | tool_calls/function/tool_call_id、reasoning_content | 新请求字段，保持原过滤、summary角色、工具顺序和null | A |
| core/context/types.ts PreparedModelRequest、AssembleModelRequestInput、PrepareTurnInput等实际携tools接口 | Chat消息、InterfaceProviderFunctionTools、tailDirectives | 同批替换所有消息/工具类型；完整冻结request仍唯一事实源 | A |
| core/context/context-manager.ts MeasureContextInput/组装和测量入口 | tailDirectives、Chat类型注解 | 类型跟随；不改压缩、锁、校准或scope清理 | A |
| core/context/token-estimation.ts estimatePreparedRequestHeuristic | JSON.stringify旧消息/嵌套tools | 局部旧口径序列化，保持旧总量 | A |
| 同文件 estimateContextOccupancyComposition / definitionsMatchRequestTools | 重建messages等值、tool.function.name、七桶payload、reasoning_content | 新字段匹配；七桶沿旧序列化；保留“不匹配则composition缺失”语义 | A |
| services/llm-model/tokenCounting.ts HeuristicTokenCounter/estimateTokensForText | string输入，无Chat依赖 | 原则上零生产修改；验证估算调用材料不变 | A回归、C验收 |
| core/context/types.ts TokenCounter | estimateTokens(string)、getBudget/getLimit能力 | 保留接口；不为新ModelMessage改成countMessages | 不改 |
| core/agents/runner.ts toOpenAiTools；core/agents/index.ts | 生成嵌套function工具并导出 | 改扁平工具；已批准中性名toModelTools，生产者类型随A迁移 | A |
| adapters/ui-runtime/composition.ts resolvePromptTools/resolveTools | ReturnType<typeof toOpenAiTools>、ResolvedStepTools.requestTools | 工具定义与schema仍来自同一步解析；同步返回/调用类型 | A |
| core/lifecycle/types.ts ResolvedStepTools/LifecycleSessionParams | InterfaceProviderFunctionTools | 请求侧类型在A改，结果侧在B改 | A/B |
| core/lifecycle/lifecycle.ts 工具名提取、buildMaxStepsFinalizationMessage | tool.function.name、Chat请求消息 | 改name和ModelMessage；不触动工具权限/调度 | A |
| core/llm-client/prompt-cache.ts PromptCacheRequestInput/hasAnthropicExplicitCacheTarget | Chat类型、tool_calls、content检查 | 改读取新字段；空文本/工具目标判断等价 | A |
| services/interface-providers/* 请求构造 | cache_control、function schema等wire字段 | wire保留协议原名；Chat嵌套控制透传、Anthropic策略重建、Responses拒绝边界不统一 | A |
| core/llm-client/streaming.ts buildCompleteMessage/中断结果/输出yield | Chat结果、ParsedToolCall.id、reasoning/Delta | A完成最终内层快照，B改外层messageSnapshot、callId、reasoning字段与函数入口 | A/B |
| core/lifecycle/lifecycle.ts getTextContent/normalizeToolCalls/toParsedToolCall | completeMessage、ParsedToolCall.id | A适配最终内层快照读取，B改外层命名；callId映射到既有ResolvedToolCall.id，不改scheduler内部ID体系 | A/B |
| core/lifecycle/types.ts LifecycleEvent/LifecycleResult；core/agents/types.ts | 事件/结果间接公开旧模型结构 | 同步新字段；观察源缺失snapshot按U4处理 | B |
| runtime/run-manager/types.ts、worker.ts；ui-runtime反向桥 | LifecycleEvent、completeMessage占位 | 更新类型/构造，保持wire载荷；观察源不伪造完整模型结果 | B |
| adapters/ui-runtime/prompt-context.ts；services/session/title-generator.ts | 请求消息、completeMessage.content | 请求在A，响应和调用函数改名在B | A/B |
| core/llm-client/index.ts；根index.ts等公开出口 | Chat类型/旧函数/工具转换导出 | 相应消费者迁移当批更新导出；C验证无遗留，不推迟必要导出 | A/B/C |

符号定位以代码为准，某输入结构的最终命名不在本轮另行清理。上表中的“组装和测量入口”等包含私有调用，不能只改export签名。

## 2. 明确不改的相邻模块

- `services/interface-providers/token-usage.ts`：inclusive归一化及observed语义不变。
- `core/message/token-usage-metadata.ts`：新写和legacy读取合同不变，不因公开usage别名清理删除旧数据库读取。
- session cache累计与UI通道：不改变统计公式、scope归属、partial处理；相关测试回归。
- `services/llm-model/tokenCounting.ts`及modelProfiles：字符权重、模型预算不变。无Chat接口就不“顺便改造”。
- 数据库schema/migrations、Message/Part JSON、scheduler ResolvedToolCall.id、UI SDK DTO：保持；只在LLM边界映射。

## 3. 可运行的批次顺序

### 0 规划门（不是代码批次）

U项设计已获批准，快照与输入闭集确定，真实矩阵见04 §4.6。固定迁移前wire/估算/存储样例；improve-2验收门通过并合入集成分支后建立本轮临时分支。不拿失败的真实预检当成通过。

### A 请求纵切

1. 定义新请求消息/工具值类型及具体adapter映射。
2. 同批迁移生产者：message/context serializer、工具投影和step快照。
3. 同批迁移消费者：llm-client输入、cache目标判断、总量/七桶估算、lifecycle请求侧、summary/title请求侧。
4. 更新必要导出、测试fixture，做unit/integration/contract及子代理审查，修复后提交。

A必须共同适配assistant回复中与请求相关的字段及读取点；外层completeMessage名称、ParsedToolCall.id可以暂留B再迁移。`goals/goal-completion.real.e2e.test.ts:153,248`有将response.completeMessage直接push回messages的用例，必须随A改成仅在既有合法完成条件下构造新assistant请求，不能把部分快照强转为ModelMessage。此类多轮回传需同时有不依赖凭据的本地回归。

不允许全局重指旧alias蒙混新旧形状，也不建立新请求→旧Chat→新请求的通用运行时桥。A/B共享字段一次迁移：A完成design/data-model.md §5.5已批准的最终内层及所有必要读取适配，B改外层命名/事件而不重复设计内层。函数名可在A暂留旧名但使用新参数，B再集中改名，不新增同义双入口。A是可测试的本地迁移切片，不单独发布为完成版本。

### B 结果纵切

1. 累积器、取消/重试输出的外层completeMessage改messageSnapshot、reasoning改reasoningText，ParsedToolCall改callId；沿用A已完成的内层快照，不再重做；provider片段的局部index不强行改造成全新状态机。
2. 同批迁移lifecycle结果/事件/存储映射、AgentRun公开类型、summary/title响应及反向桥。
3. streamChatCompletion→streamResponse在provider方法、llm-client导出和全部调用方同时完成，toModelTools旧入口一并清理。
4. 去掉旧结果导出；测试工具授权、部分结果、wire不变、SQLite reopen、观察缺失；审查修复后提交。

### C 收口验收

检查遗留接口与间接导出、构建包consumer、全部估算/存储回归，更新模块权威文档。C不是修复A/B类型断裂的垃圾桶。全量preflight和本地/真实LLM E2E通过，审查后提交并进入05验收；之后停在临时分支，等待用户审查及improve-4计划确认，不自动合回集成分支。

## 4. 批准的删除边界

消息name保留；旧function角色/function_call及历史custom tool call删除已获最终批准。源码初筛没有发现主流程主动生成旧式function消息，但Chat SDK公开输入允许它们；不能据此证明无外部用户。Responses原生function_call/function_call_output和Chat finish_reason=function_call属于不同语义，绝不能批量删除字符串匹配。

多模态、refusal/audio、cacheControl精确类型、观察snapshot缺失方式和旧usage公开别名以已批准的design/data-model.md与02 U表为准。本清单只整理依赖，不另起字段定义。
