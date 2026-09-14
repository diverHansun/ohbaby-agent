# 3. 本地参考项目与取舍

> 2026-09-14 只读勘测；路径根为 `/Users/hansun025/Projects/code-cli/`。下述 SHA 是本地 HEAD，结论基于当时工作树所读文件，不声称上游最新版、官方架构或六项目全量审计。后续子代理复核这些锚点。历史 context improve-5 的路径不能直接当作今天的文件位置。

## 3.1 来源与事实

| 项目 / HEAD                   | 代码锚点（相对该项目）                                                                                                                                                    | 已观察到的做法                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| pi / 57cde8690                | packages/ai/src/types.ts:368 Usage、:399 AssistantMessage；packages/coding-agent/src/core/compaction/compaction.ts:146 calculateContextTokens、:202 estimateContextTokens | 单响应 usage 和 stopReason 分开；context 用最近有效 usage 加后续消息估算；其 input/cache 桶口径不能按名字直接照搬             |
| oh-my-pi / 4df68d6043         | packages/agent/src/compaction/compaction.ts:229 calculateContextTokens、:239 calculatePromptTokens                                                                        | context sizing 排除 provider orchestration token，另有 prompt-side 口径；说明账单和占用不是同一个数字                         |
| opencode / d4ad650f73         | packages/opencode/src/session/session.ts:338 getUsage；session/processor.ts:435 step-finish                                                                               | session 从 SDK inclusive 输入拆出 noncached/cached 计费桶；step-finish 保存本步 tokens；缺值归零是该实现选择                  |
| kimi-code / 19c5aa64e         | packages/kosong/src/usage.ts TokenUsage/inputTotal/addUsage；providers/openai-responses.ts:703 \_extractUsage                                                             | inputOther、inputCacheRead、inputCacheCreation 是互斥桶；Responses mapper 从 inclusive input 减 cached；使用前必须理解语义    |
| deepseek-harness / 47f943859b | packages/llm/token-meter/src/usage-projection.ts:107 tokenUsageProjectionDefinition；types.ts TokenMeasurement                                                            | usage chunk 与 finalized message 同 turn/step 替换前样本避免重复；依赖同一步样本相邻的日志不变量；有独立 occupancy projection |
| Kun / 13772496                | src/renderer/src/lib/context-capacity.ts:48 buildContextCapacity；对应 context-capacity.test.ts                                                                           | UI 只从一份 request snapshot 计算分类，不按累计用量缩放；显式 estimated/nativeHistoryUnknown 表达限制                         |

这些项目均为用户指定的本地参考代码。第三方实现中的推理、计费、fallback 语义并不自动成为 ohbaby 的需求。

## 3.2 借鉴、调整和不采用

| 来源             | 可借鉴                                             | 本轮取舍                                                                                        |
| ---------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| pi / oh-my-pi    | 单次 usage、响应状态、占用口径分开                 | 借鉴职责解释；不采用最近 usage + trailing、orchestration 新桶、错误/零 usage 筛选来替换本轮算法 |
| opencode         | 归一/持久化/成本投影有明确落点；SDK 升级会影响语义 | 借鉴检查边界的方法；不复制 cost 模型、缺值归零或把计费桶 input 当 ohbaby inclusive input        |
| kimi-code        | provider 内部转换为共有 usage 后再累计             | 借鉴 adapter 所有权；不复制 inputOther 名称、emptyUsage fallback 或把未知 cache 变成已观测零    |
| deepseek-harness | 明确单步观测与累计，防重复消费有真实前提           | 借鉴重复计数测试思路；不移植 replay projector、sample ID、替换累计算法或失败尝试记账            |
| Kun              | 不用累计消耗直接代表窗口占用，估算限制说清楚       | 借鉴文档/断言；不新增 estimated/nativeHistoryUnknown 字段，不改七桶和求和规则                   |

## 3.3 对方案的影响

支持 02 的 K1/K2/K5/K6：关注实际请求、usage 来源和所有权，防止累计/占用互相替代。各项目明显不同的算法和缺失策略反而支持本轮保持原算法，不能据“优秀项目这么做”绕过 00 的冻结约束。

未发现本轮需要引入统一 TokenManager 的证据，也未以本次局部勘测证明任何项目的精度更高。精确算法比较应在后续另定样本、指标和成本预算。
