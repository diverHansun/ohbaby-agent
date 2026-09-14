# 1. 现状与问题分析

> 勘测日期：2026-09-14。生产代码 `734f2ef6`，验收文档 `3a66b173`。本页不是实施结果；测试“已有”表示代码中存在，不代表本规划会话新跑通过。路径以下均相对仓库根。

## 1.1 承重问题

| ID  | 已证实的现状或证据缺口                                                                                      | 性质                              | 02 回应        |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------- |
| P1  | `realPromptTokens` 参数仍有 Chat 命名；单步 input、Run 累计、窗口占用容易被笼统叫 token usage               | 说明/命名歧义，不是已证实数值 bug | §2.2、B        |
| P2  | 当前强制重试会重赋 prepared；现有 retry 用例验证换请求，但没有返回 usage 并断言对应估算                     | 集成证据缺口，不是已证实配对错误  | §2.1、A        |
| P3  | `usageComplete` 仅在 aggregate 调用时变化，无终态/抛错会在聚合之前离开；不能承诺所有尝试完整                | 既有限制需明确保留                | §2.2、A/B      |
| P4  | metadata、worker/bridge、辅助请求已有分离测试；尚需把三协议单步 usage 与真实 context 校准串成一份可定位证据 | 证据组合缺口                      | A/C            |
| P5  | 历史候选出现过 wire 精确估算、占用改变；参考项目 input 也有互斥桶语义                                       | 范围漂移风险                      | §2.5、§2.8、03 |

## 1.2 provider 与 llm-client

- **目标/职责**：`services/interface-providers/token-usage.ts` 的 `normalizeOpenAICompatibleUsage`、`normalizeOpenAIResponsesUsage`、`createAnthropicUsageAccumulator` 分别解释原生用量；llm-client 累积并传递模型响应。
- **架构**：协议解析留在 adapter，core 消费 `TokenUsage`。`core/llm-client/types.ts` 将其别名到 `InterfaceProviderTokenUsage`，本轮不搬迁类型所有权。
- **数据模型**：`inputTokens/outputTokens/totalTokens`；可选 `inputBreakdown` 含 uncached/cacheRead/cacheWrite 和 observed。input 已包含 cache，不能再加一次 cache 来求输入总量。
- **数据流**：provider 原生事件 → normalizer/accumulator → provider stream → llm-client → Lifecycle finalEvent。Responses 缺关键 input/output 返回 undefined；Anthropic start/delta 是累计字段，现有 accumulator 取单调累计值而非逐事件相加。
- **用例/失败**：总量有效而 cache 明细冲突时可保留总量、丢弃 breakdown；缺失组件与 observed 有现成规则，不能统一改成“所有缺字段都 undefined”或“都补零”。
- **工程约束**：不为了链路审计增加请求或新日志系统；Responses 仍受限拒绝原生续接。
- **测试**：`services/interface-providers/{token-usage,responses-token-usage}.unit.test.ts` 已覆盖归一；`openai-responses.integration.test.ts` 与 `core/llm-client/llm-client.test.ts` 覆盖流边界。P4 是跨模块合同证据，不要求重写 parser。

## 1.3 estimation 与 context

- **目标/职责**：`services/llm-model/tokenCounting.ts` 估算给定文本并提供预算；`core/context/token-estimation.ts` 选择计量材料；context-manager 管请求准备、系数和占用。
- **架构**：`PreparedTurn` 在 `core/context/types.ts:203` 维护 request、sentHeuristic、usage 等；单份 request 深冻结。`legacy-estimation.ts` 是私有旧口径投影，不在发送链。
- **数据模型**：原始 sentHeuristic 与校准后的 `usage.currentTokens` 不同。系数位于 context-manager 内部 Map，按 scopedSessionKey 管理，不进 SQLite。
- **数据流**：`estimatePreparedRequestHeuristic` → `measureUsage` → `Math.round(sentHeuristic * factor)`；`updateCalibrationFactor`（context-manager.ts:299）消费 provider input/原始估算，clamp [0.5,3]、EMA α=0.5。这里仅描述基线，不授权改系数。
- **用例/失败**：sentHeuristic 非正或非有限、actual 非有限时不更新；不新增负值/零值过滤。disposeScope/disposeSession 按原规则清理。强制准备发生在同一 Step 内，必须用最后实际请求的 prepared。
- **工程约束**：不重算全历史来回配，不加 sample ID、source enum、model 维度或持久化系数；七桶允许不等于校准总量。
- **测试**：`core/context/manager.unit.test.ts` 已覆盖 EMA/clamp、scope、dispose、测量复用；`token-estimation.unit.test.ts` 固定旧数值；`tests/integration/core/context-improve-4-1.integration.test.ts`、`context-subagent-scope.integration.test.ts` 是既有请求/隔离集成入口。

## 1.4 lifecycle 与运行时

- **目标/职责**：`Lifecycle.run()` 编排 agent Step；`core/lifecycle/token-usage.ts` 累加已进入聚合的结果。`runtime/run-manager/worker.ts` 驱动一次 lifecycle run，不是 Session 总账。
- **架构**：usage 变量在 step 循环之外；step 内 finalEvent 驱动聚合和校准，两条路径并列，不经 metadata 反查。
- **数据模型**：`LifecycleResult.usage` / `LifecycleTokenUsage.usageComplete`（types.ts:239、250）；`RunResult` 等 usage 通过 Lifecycle 类型传导，不能凭同名误认单步样本。
- **数据流**：lifecycle.ts:593 聚合，596 起校准，随后检查 abort 和 length。无 finalEvent 在聚合前返回；provider 抛错路径同样可能绕过 aggregate。
- **用例/失败**：完成但缺 usage → 已知小计、不完整；先完整一步后下一步受控失败返回 → 已有小计/完整性可能原样保留。未分类异常在 lifecycle.ts:460–461、530–531 原样抛出，不保证返回 LifecycleResult。有效 usage 已处理后取消，不回滚；这一范围不等于全部收费请求。
- **工程约束**：不改更新顺序或异常恢复，不新增 exactly-once 持久化协调。正常流只消费最终用量，不将流中累计字段逐帧累加。
- **测试**：`lifecycle.unit.test.ts` 已有单步校准、scope、text/tool/hybrid metadata 及 overflow。现有 “force prepares and retries once…” 没有最终 usage，因此不证明 retry 校准配对。`token-usage.unit.test.ts` 已有缺失、零输入和 observed AND 用例。

## 1.5 message、传输与展示

- **目标/职责**：`core/message/token-usage-metadata.ts` creator 构造新 metadata、reader 读取 unknown 历史 JSON；不是 provider parser。worker/bridge 传递 canonical；`core/context/context-window-usage.ts` 投影窗口；cache 另走 promptCacheUsage。
- **架构/数据**：creator 拷贝 breakdown/observed、重算 total；reader 先 canonical，损坏 breakdown 保总量，canonical 不成立再尝试合法 legacy。数据库仍保存原 Message/Part JSON。
- **数据流**：模型单步结果 → metadata creator → Part；另一支 → worker → stream bridge。没有先落库再发送事件的统一串行承诺。`contextUsageToContextWindowUsage` 用 contextLimit 作分母，不用 Run usage。
- **用例/失败**：text/tool/hybrid 每步最多一个 durable Part 携带 usage；无承载 Part 时不伪造。重启可以读取历史 usage，不因此恢复校准系数。
- **工程约束**：不把 canonical/legacy parser 强行与 provider normalizer 合并；不改 UI 交互、字段或数据库 schema。
- **测试**：`core/message/{token-usage-metadata.unit,database-store.integration}.test.ts`、`adapters/ui-runtime/{token-usage-roundtrip,auxiliary-token-usage-isolation}.integration.test.ts` 已存在；前者 roundtrip 真实 worker/bridge、fake Lifecycle，并不是完整真实模型校准测试。

## 1.6 文档与代码对照

| 历史资料                                                           | 当前代码                                      | 本轮差异处理                       |
| ------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------- |
| context improve-5/06 区分 provider、estimator、metadata、aggregate | 分工已实施                                    | 保留，不当成待新建模块             |
| 同文档“每步最多一个 durable part”，无 Part 不造记录                | lifecycle writer/appendToolParts 已对应       | 测试不要求每步必须落库             |
| context improve-6 占用七桶，cache 独立通道                         | context-window-usage 与 promptCacheUsage 分开 | 保留算法，04 回归                  |
| improve-3 02 的旧估算合同                                          | legacy-estimation 保持 Chat-shaped JSON 数值  | 不删除、不换 Responses wire        |
| improve-3 next-stage-candidates 的“整轮”和校准范围                 | 实际为 Run 累计、调用点条件有限               | 本轮明确术语；历史候选不是实施授权 |

历史依据：[context improve-5/06](../../../core/context/improve-5/06-token-responsibility-review-and-follow-up.md)、[context improve-6](../../../core/context/improve-6/README.md)、[session-cache-hit](../../2026-08-27-session-cache-hit/README.md)。

## 1.7 SWE 审视与影响面

信息隐藏和单一职责已经比较清楚，风险是解释不清和缺少交叉断言，不是少一个框架。KISS/YAGNI 要求保留直接调用；DRY 不要求把网络 parser 与历史 JSON reader 合并。legacy 桥属于有意的过渡重复。

承重改动预计集中在 context 参数名/注释、lifecycle 类型语义注释和测试。provider normalizer、tokenCounting、metadata、cache、window 算法为核对及回归对象，不因被列入勘测就必改。未确认跨模块数值 bug；若后续发现，按 02 §2.6 处理。
