# 03 · 七个参考项目的 Context 借鉴

调研日期：2026-09-15。均为用户指定目录下的本地源码，七个工作区调研时干净；未联网、未运行参考项目或调用模型。下列结论仅描述对应快照，不作为供应商 API 的通用保证。

## 1. 版本与调研边界

| 项目              | 本地 HEAD                                  | 主要范围                                            |
| ----------------- | ------------------------------------------ | --------------------------------------------------- |
| deepseek-harness  | `47f943859bef60e4160492346772ded9b24f765a` | token-meter、compaction-basic                       |
| DeepSeek-Reasonix | `ea28602b23badc71afc701ea92aa2982f443c638` | context usage、commit、recovery、Responses prefix   |
| kimi-code         | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` | agent-core context、full compaction                 |
| Kun               | `1377249652cef30f9f7b777f8f6111fd6ac70fc9` | loop context-compactor                              |
| oh-my-pi          | `4df68d60438423b384b2b47fb3d6835641624757` | compaction、opaque 估算、native compact             |
| opencode          | `d4ad650f738aaa986cee5879c581bd4834277577` | `packages/core` v2 compaction；未验证持久化事务全链 |
| pi                | `57cde86906679fd0581b277a179ab46fa2a09ab6` | compaction、session recovery、Responses replay      |

## 2. 具体借鉴与取舍

### deepseek-harness：测量有来源和覆盖范围

[token-meter](../../../../../deepseek-harness/packages/llm/token-meter/src/index.ts) 的测量包含 log revision、baseline、surface delta；请求 envelope 与 baseline 匹配才复用实际 usage anchor，否则重估。[region](../../../../../deepseek-harness/packages/compaction/compaction-basic/src/region.ts) 修正工具配对切点，并在摘要后验证源稳定性；compaction-basic 的 overflow 恢复检查 surface 是否推进。

**采用原则**：重新 prepare 后只能与新估算配对，沿用本项目已有 sentHeuristic 与 scope 生命周期；不新增 revision 或计量版本。**不采用**其 usage-anchor 算法和插件事件框架；其部分 UI 允许新模型容量配旧 pressure 的取舍也不采用。

### DeepSeek-Reasonix：下一请求投影是计量对象

[context_usage.go](../../../../../DeepSeek-Reasonix/internal/agent/context_usage.go) 的 `ContextUsedTokens` 测下一次可见请求，缓存覆盖 transcript／projection／calibration／tool schema revision。[compact_commit.go](../../../../../DeepSeek-Reasonix/internal/agent/compact_commit.go) 校验版本与 hash，持久化失败回退，释放锁后发事件。[responses.go](../../../../../DeepSeek-Reasonix/internal/provider/responses/responses.go) 的 prefix digest 与实际 wire 使用相同投影。

**采用原则**：计量与发送同源、压缩前后同口径。**沿用本项目实现**：selected-Part CAS 与 store 原子事务已存在。**不采用**其 checkpoint／receipt 系统、窗口学习算法或 previous-response 状态链。

### kimi-code：不要把旧 usage 当作新上下文的用量

[context/index.ts](../../../../../kimi-code/packages/agent-core/src/agent/context/index.ts) 将已覆盖 baseline 与新增消息分开，zero usage 不直接归零；压缩后重设历史及覆盖范围。[full.ts](../../../../../kimi-code/packages/agent-core/src/agent/compaction/full.ts) 在无新内容时跳过反复压缩，限制 overflow 次数，并在摘要完成后验证前缀。[types.ts](../../../../../kimi-code/packages/agent-core/src/agent/compaction/types.ts) 区分展示摘要与模型摘要，显式记录 summarizer 未覆盖的 droppedCount。

**采用原则**：完整终态、摘要输入与退休范围分名；本项目保留最后 prepare/compact 快照约定。**不采用**其 baseline+tail 估算或不同历史保留算法；本项目继续原 EMA 和增量摘要。其 droppedCount 也提醒我们不能宣称 overflow 降级无损。

### Kun：输入预算、输出预算和工具单元分别建模

[context-compactor.ts](../../../../../Kun/kun/src/loop/context-compactor.ts) 区分 prompt、overhead、已构造 request input、output budget 和 hard cap；tail 切点补齐工具往返，只摘要 folded head，避免重复当前用户任务。

**采用原则**：区分输入占用、输出预留和工具依赖；保留本项目已有完整 native 单元。实际输出预留策略留待后续。**不采用**其多种压力取最大值、6 倍 usage 信任阈值、规则摘要与 normal/aggressive/force 新策略。

### oh-my-pi：opaque 不能按字符串大小解释

[compaction.ts](../../../../../oh-my-pi/packages/agent/src/compaction/compaction.ts) 区分可重放上下文与账单 token，处理 reserve 来源，并为 encrypted reasoning 的本地估算单列规则。[openai.ts](../../../../../oh-my-pi/packages/agent/src/compaction/openai.ts) 有远端 Responses compact 和 native replay 路径。

**适配**：opaque 代理来源与计量限制必须明确；签名／密文不当作普通文本。**保留本项目既定代理规则**，不直接将 opaque 归零。**不采用**远端 `/responses/compact`、streaming compaction、snapcompact，也不将源码中的特定计费假设推广到所有模型。

### opencode：摘要请求自身也可能放不下

[v2 compaction.ts](../../../../../opencode/packages/core/src/session/compaction.ts) 对实际 system/messages/tools 估算，检查摘要输入与输出预算；成功事件要求流完成、无 provider error、非空摘要。

**采用原则**：摘要完成不能只看非空字符串；本轮保留已有主请求和摘要预算机制。**不采用**其 `context - max(output, buffer)` 公式及字符串切分 retained history；本项目保留结构化 native items 和既有 safety margin 语义。

### pi：来源切换和压缩边界使旧样本失效

[compaction.ts](../../../../../pi/packages/coding-agent/src/core/compaction/compaction.ts) 显式持有 usage 覆盖位置、trailing tokens、选段与保留部分；不从 tool result 中间切断。[agent-session.ts](../../../../../pi/packages/coding-agent/src/core/agent-session.ts) 不让旧模型 overflow 或压缩前旧 usage 驱动新一轮压缩。[transform-messages.ts](../../../../../pi/packages/ai/src/api/transform-messages.ts) 与 [Responses shared](../../../../../pi/packages/ai/src/api/openai-responses-shared.ts) 区分同源 signature／完整 reasoning item 回放和跨源清理。

**采用原则**：计量来源、压缩后重新计量、保留已有合法切点。**不采用**其 `usage.totalTokens` baseline 公式、滚动 previousSummary 处理；本项目窗口估算与 inclusive input usage 校准有自己的合同。

## 3. 本轮采用到哪里

| 调研启发                         | 本轮落点                                      | 后续再讨论                            |
| -------------------------------- | --------------------------------------------- | ------------------------------------- |
| 计量与发送使用同一份消息事实     | 自有 PreparedModelRequest、生产转换测试       | 三协议专用 meter、精确 tokenizer      |
| 原生状态有来源和特殊语义         | 沿用 ModelState，镜像去重、同源回放、跨源保护 | 新协议能力及远端状态链                |
| 摘要需要真实的任务信息与正常完成 | 工具动作最小补齐、完成终态校验                | 新摘要算法、滚动 previousSummary      |
| 压缩输入和退休范围可能不同       | 记录并测试现有 overflow 有损边界              | 改变丢弃／保留策略                    |
| 工具依赖和持久化必须完整         | 沿用 native 单元、selected-Part 比较与事务    | 新 checkpoint、receipt、全局 revision |

七个项目的 usage-anchor、baseline+tail、窗口学习、阈值及压缩策略保留为调研资料，**不进入本批实现**。尤其本项目 context improve-3 G12 已明确放弃 usage 锚点，不能因参考项目用了就重新引入。

以上为本地源码研究。没有运行这些项目，也不把它们各自的算法解释为本项目必须遵守的规则。
