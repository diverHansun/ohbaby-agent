# 01 · 历史设计、当前状态与问题

调研日期：2026-09-15。代码基线：`openai-responses-migration@5a76738a8f93a2685cf1e4406f16b0917bb09ed2`。以下区分历史计划、实际验收和当前源码；旧文档中的“计划完成”不能自动当作实施证据。

## 1. Context 是怎样逐步形成的

| 历史阶段与原始资料                                                                                                                                                                                       | 建立的合同／当时的状态                                                                                                                                                 | 本轮如何继承                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [improve-1](../../../core/context/improve-1/implementation-plan.md)、[验收材料](../../../core/context/improve-1/acceptance.md)                                                                           | 建立 prepareTurn 与 Lifecycle 接合面；合法切点、工具配对、结构化摘要及文件操作附录；当时提出 usage 锚点                                                                | 保留职责和切点；usage 锚点以后继 improve-3 G12 为准。验收材料不是所有条目已执行的证明                                |
| [improve-2](../../../core/context/improve-2/README.md)、[白名单](../../../core/context/improve-2/tool-metadata-whitelist.md)                                                                             | README 明确 P0 已完成：per-step prepare、overflow recovery、raw metadata 持久化与模型白名单。P1/P2 不全是已实现能力                                                    | 每步测量与有限恢复继续；raw metadata 不能全部送模型，不复活当时延期的 hooks／origin taxonomy／动态预算               |
| [improve-3 决策](../../../core/context/improve-3/gaps-and-decisions.md)、[全景](../../../core/context/improve-3/index.md)                                                                                | 收口编排、投影、估算和策略；G12 放弃“上次 usage＋增量”，采用当前请求启发式 × EMA；统一 mask→prune/summary、反膨胀与防抖                                                | 保留算法及职责；当时 ChatCompletion 类型、历史 reasoning 不回放的阶段限制由迁移 3／5.5 更新                          |
| [improve-4 验收](../../../core/context/improve-4/05-implementation-acceptance.md)                                                                                                                        | 当步真实 tools 同时计量和发送；实际压缩开始才报过程态；Lifecycle→worker→UI。自动化通过，真实 UI 观察有保留                                                             | 不让 Context 解析工具 registry，不新建 UI 事件旁路                                                                   |
| [improve-4.1 讨论](../../../core/context/improve-4.1/00-discussion.md)、[验收](../../../core/context/improve-4.1/05-implementation-acceptance.md)                                                        | 主代理 static/manual 也计 tools；child 依赖实例 scope，不开放仅凭 session 的 static/manual。缓存命中显示最近 prepare/compact 快照，未命中静态估总量                    | 沿用快照约定，不增加每次历史变化都重测的机制；当时 additionalMessages 已被 improve-5 收口                            |
| [improve-5](../../../core/context/improve-5/README.md)、[验收](../../../core/context/improve-5/05-implementation-acceptance.md)                                                                          | immutable PreparedModelRequest 包含 messages/tools/tail directives；inclusive input；辅助 purpose 隔离；run 稳定 system/memory、scope tools 顺序、runtime 附着发起消息 | 同一份 prepared request 计量和发送；不再追加另一条未计量材料通路。其旧 Anthropic usage 合并规则由迁移 improve-5 替代 |
| [4～5 联合回归](../../../core/context/improve-4-to-5-regression/05-implementation-acceptance.md)                                                                                                         | scope 内串行、store 事务内 expectedParts 比较、prune/summary 分别原子提交；有界 overflow、未完成工具重启的“结果未知”投影。条件验收，部分外部／并发矩阵保留             | 不加持久 revision、marker、全局协调器；不把 summary 失败描述为回滚整次 prune；现行 0.95＋4096 取代旧 85%             |
| [improve-5 H1/H2 职责收口](../../../core/context/improve-5/06-token-responsibility-review-and-follow-up.md)、[补充验收](../../../core/context/improve-5/07-token-responsibility-follow-up-acceptance.md) | 文本计数在 llm-model，材料选择在 context，供应商 usage 在 provider；删除无差异 ContextMeasurementPayload 别名；旧库存量 usage 可读，新写 canonical。补充全量门通过     | 不新造重复请求 DTO 或 TokenManager；保留旧库读取。当时旧数字等价要求不阻止本次已授权的旧 Chat 退出                   |
| [历史 improve-6](../../../core/context/improve-6/README.md)、[七类合同](../../../core/context/improve-6/02-optimization-plan-and-change-scope.md)                                                        | 七类 composition 解释最终请求，不驱动压缩；缺来源整体省略，total-only 清旧分类。README 记已实现，源码存在；未发现独立 05                                               | 保留七类及两条 bridge 传递分支，不宣称历史所有手工／实网项都已有验收证明                                             |

这条历史路线已解决很多基础问题。本轮应完成消息格式迁移，而不是重新设计 prepareTurn、计量服务或压缩状态机。

### 1.1 本次迁移 improve-1～5.5 的接续

| 迁移轮次                                                                                             | 当前已具备的能力                                                       | 留给本轮的边界                                                |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- |
| [1](../improve-1/05-implementation-acceptance.md)／[2](../improve-2/05-implementation-acceptance.md) | SDK 升级、独立 Responses provider、受限工具往返                        | Chat Completions 协议继续支持；不用 previous_response_id      |
| [3](../improve-3/05-implementation-acceptance.md)                                                    | 已有自定义 ModelMessage／ModelToolDefinition／ModelToolCall 与结果契约 | legacy-estimation 为保留当时数字而留下，属于本轮删除对象      |
| [4](../improve-4/05-implementation-acceptance.md)                                                    | canonical usage、本次 prepared estimate 与 accepted input 配对         | 保留公式；预算和 estimator 材料当时未改                       |
| [5](../improve-5/05-implementation-acceptance.md)                                                    | 按可信 Step 累计 cache，主子／辅助隔离                                 | 压缩不清 cache；input 包含缓存输入                            |
| [5.5](../improve-5.5/05-implementation-acceptance.md)                                                | reasoning 配置、原生状态持久化和回放、native 压缩单元、opaque 代理估算 | 复用现有结构和来源规则，不从头建设；实网覆盖及限制见其 06／07 |

## 2. 当前数据流与结构

源码路径前缀为 `packages/ohbaby-agent/src/`。

```text
MessageStore 中本 scope 的 active Message/Part
  → serializer + 已有 mask 投影
  → PreparedModelRequest { messages, tools }
  → 旧 Chat 形状的估算材料 + native 估算 → EMA → ContextUsage
  → 现有 prune/summary → 重新组装、重测
  → 最终 PreparedTurn → Lifecycle → llm-client → 三协议 adapter
                                                  ↓
                                本次 accepted inclusive input → 校准
```

定位：`core/context/context-manager.ts` 的 `assembleModelRequest`、`measureUsage`、`prepareTurnUnlocked`；`core/context/token-estimation.ts`；`core/lifecycle/lifecycle.ts`。

| 现有结构                                           | 内容与责任                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------- |
| Message / Part                                     | 持久化会话事实，含 compacted 活动性；不是某个 API 请求                  |
| ModelMessage / ModelToolCall / ModelToolDefinition | 自有推理请求：角色、内容、callId/name/argumentsJson、工具 inputSchema   |
| ModelState                                         | 带版本和 origin 的协议续接数据；output 按协议区分，已有受校验的具体类型 |
| PreparedModelRequest                               | 本步完整 messages/tools 快照，计量与发送的共同输入                      |
| ContextUsage / composition                         | 校准后的输入预算压力／七类未校准解释；均不是上游实际 usage              |

类型位于 `services/interface-providers/{types,native-state}.ts`。SDK 的 Chat 请求类型目前保留在 `openai-compatible.ts` 边界是合理的；问题是 `core/context/legacy-estimation.ts` 又把自有结构转回 tool_calls/tool_call_id/reasoning_content 和嵌套 function。

### 2.1 原生续接数据具体是什么

- Responses：按原顺序保存 reasoning、message、function_call 等支持项；`reasoning.encrypted_content` 是服务端返回的加密数据，客户端不能解读，续接时原样回传。
- Anthropic：`redacted_thinking.data` 是不透明推理数据；`thinking.signature` 是配套签名，两者不同，均不能作为普通正文改写。
- 部分 Chat 兼容路由：原生 reasoning details 中可能包含 `reasoning.encrypted`；仍按该协议的类型保存。

这些字段不进入摘要文本，也不能按密文／签名字符串长度当作普通 token。5.5 已有代理估算：同一 response 的不透明块共用一份额度，来源优先 reasoning tokens，再总 output，最后该次输出上限；可读推理另按现有规则估算并去重。它是启发式，不能证明精确占用。

## 3. 当前压缩机制（需要保留的事实）

1. `prepareTurnUnlocked` 先组装并测量；mask 是纯投影，默认关闭，启用后也不退休持久化历史。
2. `decideCompactionRung` 用输入预算压力选择层级：默认 summary 比例 0.95 或剩余输入少于 4096；mask 门槛 0.50。自动摘要受每 turn 上限和 thrash lock 约束。
3. summary 层级先调用 `pruneHistory`，普通旧工具结果符合保护条件才退休；native assistant 与工具单元整体保留给 summary。
4. prune 后重新测量；若已低于阈值且不是 force，则结束。force 仍遵守单元完整性、候选有效性和事务校验。
5. `generateSummaryCandidate` 排除全部已有 summary，从未摘要的 active history 选旧前缀。小历史按 preserve ratio 0.3；大历史保留最近约 20k token，具体依 `findCutPoint` 边界。未完成 native 单元不得被选中。
6. 摘要请求走可读文本 `serializeHistory(..., {includeModelContext:false})`，排除 reasoning／model-state 和动态 model-context；文件操作附录在生成后追加。
7. 正常 prompt 不够短再尝试 aggressive prompt；overflow 按完整最旧 user round 收缩，保留最近 user round。manager 设 4 次逻辑 `generateSummary` 上限，summary client 另有非空重试，llm-client 另有 transient retry，**不能把 4 次直接写成所有实际 HTTP 尝试的全局上限**。
8. 候选文本先与被选历史比较，再投影完整下一请求与 prune 后请求比较，未变小不提交。成功通过 `commitCompaction` 原子写 summary 与本次选段标记；store 对 selected Parts 做前置快照比较，stale 时不写。
9. prune 和 summary 是两个独立提交阶段。摘要失败时不得退休其候选选段，但之前已成功的 prune 可以保留；不能声称整次 compact 是一个全有或全无事务。
10. 重读提交后历史，重新投影、计量、返回；主请求 overflow 由 Lifecycle 强制 prepare 并有限重试，仍失败则终止。

锚点：`core/context/{constants,compaction-policy,projection,summary-overflow}.ts`；`context-manager.ts::{getActiveHistory,generateSummaryCandidate,commitSummaryCandidate,runCompactionCore}`；`adapters/ui-runtime/prompt-context.ts::createContextSummaryClient`。

### 两个不能隐藏的算法边界

**增量摘要累积**：`getActiveHistory` 将所有活跃 summary 置前；新摘要生成排除旧摘要，提交只退休本次选段。旧摘要不会自动合并或再次压缩。这样避免反复改写旧摘要，但长期运行会有不可回收的摘要前缀，本批保留并测试它。

**摘要 overflow 有损降级**：收缩的是 `summaryHistory`，候选与提交仍使用原始 `historyToCompress`。若成功，被丢弃的旧轮正文不会因而恢复，只有文件操作附录可能保留部分事实。原始记录仍在持久层，但不会继续进入模型请求。此行为不是“无损摘要完整覆盖”，本轮保留策略并把选段／摘要输入／退休范围区分清楚。

## 4. 本轮问题与最小修复

| ID  | 源码事实                                                                                                                        | 本轮处理                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P1  | token-estimation 仍导入 legacy-estimation；自有结构已存在，却为估算重建旧 Chat 格式                                             | 直接选择自有请求中的计量材料，删除旧转换；三协议生产转换测试证明可靠性                                         |
| P2  | `addHistoryMessagePayloads` 对 native 消息整条计入 conversation 并提前 return，绕过 subagent_run/status/close 分类              | 仅拆分计量贡献；子代理调用／结果归既有 subagent-exchanges，普通文本／推理归 conversation，实际原生回放单元不拆 |
| P3  | composition 来源匹配先转 legacy，转换会删除 modelState；原生状态不同也可能通过匹配                                              | 比较有效自有请求，包括 native 内容及影响估算的状态，不能只比较显示文本／旧 Chat 镜像；不匹配则省略分类         |
| P4  | summary client 只要求 isComplete 和非空；streaming 对 length/content_filter 同样标 isComplete                                   | 只有正常结束且 finishReason=stop 的非空摘要可作为候选；异常终态不退休原历史                                    |
| P5  | 旧快照测试锁定迁移前 Chat JSON 数字；模块文档仍有 Chat 类型和含混 token 名称                                                    | 更新预期与材料说明，保留算法／语义回归；同步当前模块文档，不批量改名公共类型                                   |
| P6  | `serialization.ts::serializePart` 对 completed 工具只输出 output，对 aborted 只输出 error；工具名／输入与部分已执行输出可能丢失 | 只补摘要生成材料中的工具事实；保留用于选段／prune/mask 的既有评分材料                                          |

P6 的确定性反例：两次不同名称／参数的工具调用，若都返回空 output，会得到相同摘要 transcript；aborted 带部分 output 时该 output 不进入 transcript。源码已证明材料遗漏，尚未进行真实摘要质量评测。修复只保证摘要模型能看到动作，不承诺其摘要绝对无损。

P2/P3 锚点：`core/context/token-estimation.ts::estimateContextOccupancyComposition/addHistoryMessagePayloads`。P4 链路：`services/interface-providers/openai-responses-stream.ts` 将 max_output_tokens 归一化为 length，`core/llm-client/streaming.ts` 标记 provider_finished，`adapters/ui-runtime/prompt-context.ts::generateSummary` 未检查 finishReason。本次为源码确认，新增失败用例属于实施任务。

### 4.1 已核实但不在本轮调整

- `getContextUsage` 采用现有模型预算；requested output 传递和半窗口 reserve 策略存在进一步统一空间，本轮保留，不能宣称已保证预算预留等于每次实际 maxTokens。
- `ui-inprocess.ts::connectModelInternal` 已 resetRuntime 并清 occupancy；不把普通切模型描述成必然遗留旧校准。
- tracker 缓存命中代表最近 prepare/compact 快照，这是 context 4.1 的明确约定。历史或 tools 变化不意味着必须立即重测。
- 非 native 选段沿用可读历史评分；prune 仍看普通工具 output 大小。`serialization.ts::serializeHistory` 是摘要／评分用的可读格式，不是应删除的旧 Chat 请求格式。

## 5. SWE 与兼容性判断

复用现有自有类型和 PreparedModelRequest；Context 选择估算材料，provider 转协议请求，store 管持久化原子性。仅为删除旧转换而新增三套 meter、另一份请求 DTO、版本缓存或全链路用量更名，收益不足以抵偿复杂度。

自有结构必须有明确的通用字段和受校验的协议分支，不能用任意 metadata 字典承接所有供应商差异。ModelState 的同源回放、跨源已完成单元降级、未完成工具禁止不兼容切换继续生效；不增加新的协议能力。

新的材料长度可能改变估算数字和触发时点，这属于格式迁移的结果；不能偷偷调整阈值来凑回旧数字。压缩前后须使用同一估算口径和倍率。缓存 input 仍占窗口，reasoning 不重复加到 output；辅助摘要 usage 不能校准主请求。

## 6. 本次测试证据

2026-09-15 在上述基线复跑 **11 个存量测试文件，82 项通过**：provider 的 model-contract/native-state；context 的 native-context/native-policy/token-estimation/serializer/context-window-usage/compaction-atomic/native-state/prepared-request；ui-runtime 的 prompt-context。

准确命令见 04。它们证明已有能力的这组回归通过，尚不能证明 P1～P6 已修复或本轮三协议新合同已验收。本次未跑全量 preflight、实网请求；未修改生产代码。沿用仓库 Vitest 和 preflight，不另建测试框架。
