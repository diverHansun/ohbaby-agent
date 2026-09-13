# improve-4 候选范围与后续顺序

> 用户最新收窄要求取代此前“替换实际请求计量材料、允许估值变化”的候选建议。improve-4 先核对估算校准链路与字段/接口，核心算法不改；本页是勘测输入，不是正式实施授权。improve-3 完成提交与审查后，再据实际验收编写正式方案。

## 1. 本轮做与不做

“校准”先指核对每一步的估算样本、供应商实际 inputTokens、作用域和更新时机，保证比较的是同一次请求。并不自动授权修改 EMA、夹取范围、启发式算法或预算公式。发现算法问题只登记，另行讨论。

| 范围 | improve-4 允许调查/规划 | 暂不改动 |
| --- | --- | --- |
| 估算校准 | 追踪 sentHeuristic 与本 step inclusive inputTokens，检查字段含义、来源、scope、完成状态和重复更新 | EMA 系数、上下界、估算公式、tokenizer |
| usage 存储 | canonical 字段与旧 metadata 读兼容；仅必要接口适配 | SQLite schema、已存 JSON、缺失/非法值处理规则 |
| lifecycle usage | 区分单 step 观测与整轮累计；必要命名/接口对齐 | 聚合算法、usageComplete、observed/partial 规则 |
| context 展示 | 接口字段与来源核对，避免误把累计消耗当当前占用 | currentTokens/窗口比率计算、七桶算法、预算、压缩阈值 |
| cache | 验证既有数据不会因接口改名被破坏 | 命中率公式、cache key、前缀/控制策略、命中效果优化 |

不以删除 legacy-estimation.ts 为目标。它仍维持 improve-3 旧计量合同；替换材料本身会改变估值及压缩时机，未经新方案批准不得删除或重写。暂不创建通用计量层、新统计桶或另一份消息正文。

## 2. 扫描入口与职责

以下是调查清单，不表示每个文件都必须修改；命名已经准确的保持不动。

| 文件 / 符号 | 现有职责与核对点 |
| --- | --- |
| packages/ohbaby-agent/src/core/message/token-usage-metadata.ts：createTokenUsageMetadata/readTokenUsageMetadata | 序列化 canonical input/output/total，兼容旧 promptTokens/completionTokens；这些旧键是历史数据合同，不应当作旧公开 API 直接删除 |
| packages/ohbaby-agent/src/core/lifecycle/token-usage.ts：aggregateTokenUsage | 累计整轮 usage，维护完整性与 breakdown；累计 inputTokens 不可作为单次校准样本或当前窗口占用 |
| packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts | 每 step usage 的实际生产者，向 context 更新校准，并将 usage 唯一落入原 Message/Part |
| packages/ohbaby-agent/src/core/context/context-manager.ts：updateCalibrationFactor | 按 session/contextScopeId 存因子，realPromptTokens/sentHeuristic 比值、上下界和 EMA；优先核对名称及入参，不调整公式 |
| packages/ohbaby-agent/src/core/context/token-estimation.ts、legacy-estimation.ts | 冻结请求材料的启发式估算、总量和七桶；保留现有数值合同 |
| packages/ohbaby-agent/src/core/context/context-window-usage.ts：contextUsageToContextWindowUsage/createContextWindowUsageTracker | 将当前 context 估值投影成 UI 窗口占用，维护 session 展示快照；不等于 provider usage 聚合或持久计费 |
| packages/ohbaby-agent/src/core/context/types.ts、core/lifecycle/types.ts、core/llm-client/types.ts | 请求前估值、请求后观测与整轮累计的类型边界；不为了改名一律新增类型 |
| packages/ohbaby-agent/src/services/interface-providers/token-usage.ts | 三协议原生 usage 归一入口，inclusive/observed 的事实来源；只查字段对齐，不改统计算法 |
| packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts | 文本启发式及窗口预算；核心算法冻结 |
| packages/ohbaby-sdk/src、packages/ohbaby-agent/src/adapters、packages/ohbaby-cli/src、apps/ohbaby-web/src | 沿 UiContextWindowUsage 和 usage 调用链查展示、事件、公开 exports；若改名必须列消费者，不顺带改 UI 交互 |

历史依据：[context improve-5 职责收口](../../../core/context/improve-5/06-token-responsibility-review-and-follow-up.md)、[context improve-6](../../../core/context/improve-6/README.md)、[session cache](../../2026-08-27-session-cache-hit/README.md)。不得因为历史功能距今约两周就忽略其已有契约。

## 3. 候选批次与验证

1. **合同核对**：画清单次估算 → 单次 provider usage → 校准更新，与跨步累计、数据库和窗口显示的区别；列出确有必要的旧/新字段对应表。先冻结数值 fixture。
2. **最小接口适配**：只实施已确认的名称、类型和调用边界；兼容旧存储键，保持主/子 scope、summary/title 隔离。若遇到会改变数值或更新时机的修复，单列行为差异交用户确认，不藏在重命名中。
3. **回归验收**：同一 fixture 前后数值相同，缺 usage/partial 不伪造 0，单 step 样本不误用整轮累计；metadata roundtrip、lifecycle 聚合、context tracker、真实 worker/UI 桥和公开包消费者覆盖。每批单元/集成/相关 contract、子代理审查、commit；最后 preflight 和小量真实请求，只验证链路，不宣称精确计数或缓存优化。

本页不预先承诺精确误差阈值、字段名称或公开 API 变更。正式 improve-4 需明确“校准”究竟只对齐现有接口，还是包含某个有证据的样本接线修复；核心公式保持不动。

已扫描的回归入口包括 context/manager.unit（EMA、clamp、scope、dispose）、context/token-estimation.unit（旧数值与七桶）、message/token-usage-metadata.unit、lifecycle/token-usage.unit、context/context-window-usage.unit、services/interface-providers/responses-token-usage.unit，以及 adapters/ui-runtime/token-usage-roundtrip.integration 与 auxiliary-token-usage-isolation.integration。保留七桶可不等于校准总量的既有合同，不把“来源可解释”误写为“数值必须相加相等”。

## 4. 后续顺序

1. 收尾 improve-3：提交 C 测试/文档及用户授权空 model.json 删除，完整范围子代理审查和测试通过后交用户审核。未经明确确认不 merge。
2. 用户审核后合入本地 openai-responses-migration；improve-4 在新的本地临时分支按批准方案实施。
3. improve-4 先做上述校准链路和必要接口对齐。
4. 后续独立处理 cache 命中相关议题，具体公式/策略变更另立契约。
5. cache 命中处理完成后，再检查已有上下文窗口压缩机制、上下文窗口占用功能；不是本轮提前重写。
6. 原生 reasoning/phase/签名状态、previous_response_id、Conversations、hosted tools 另排。当前 Responses 拒绝边界不放宽；Grok 通过不代表原 Luna/DeepSeek Responses 限制已解决。
7. 后端、token、cache、context、lifecycle 整体达到要求后才讨论集成分支合 main。每轮合入集成分支不等于切换默认协议或上线。

## 5. 当前验收输入

improve-3 的 Responses/Chat 有完整真实成功记录，Qwen 定向诊断及清理插桩后的原 runner 均通过；原偶发工具未执行失败未定因，保留在 [05](./05-implementation-acceptance.md)。不将分次成功写成同一轮矩阵全绿，也不将已知问题移交后假装已经修复。

llm-client 改造说明按用户要求位于 [独立模块目录](../../../core/llm-client/openai-response-miagration-improve-3/README.md)，原平铺文档不重写。
