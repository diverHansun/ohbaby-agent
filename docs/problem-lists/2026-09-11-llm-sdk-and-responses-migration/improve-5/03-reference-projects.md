# 3. 七个参考项目的纳入规则与取舍

> 2026-09-14 至 2026-09-15 只读本地源码。下列为本地快照，不代表上游最新行为，也不替代供应商 API 合同。未在参考项目运行真实请求。

## 3.1 来源快照

本地共同父目录：`/Users/hansun025/Projects/code-cli/`。下文链接均指向实查文件；行号对应以下 HEAD。

| 项目              | HEAD                                       |
| ----------------- | ------------------------------------------ |
| deepseek-harness  | `47f943859bef60e4160492346772ded9b24f765a` |
| DeepSeek-Reasonix | `ea28602b23badc71afc701ea92aa2982f443c638` |
| kimi-code         | `19c5aa64ebef86925ad58074ebcac6a5a7a8ff8d` |
| Kun               | `1377249652cef30f9f7b777f8f6111fd6ac70fc9` |
| oh-my-pi          | `4df68d60438423b384b2b47fb3d6835641624757` |
| opencode          | `d4ad650f738aaa986cee5879c581bd4834277577` |
| pi                | `57cde86906679fd0581b277a179ab46fa2a09ab6` |

共同发现：所查统计路径均不采用 ohbaby 原来的“任一步缺缓存明细，整 Run 排除”门槛。但多数计算层会把缺失转成零，所以“按响应/Step 纳入”和“严格保留未知”必须分开评价。本轮采用前者，继续保留自己的 observed 合同。

## 3.2 deepseek-harness

- [translate.ts](../../../../../deepseek-harness/packages/llm/llm-deepseek/src/translate.ts)的 `mapUsage`（约 53 行）在 parser 层区分未返回读取字段和明确零；内部普通输入为 prompt 减 read。到 [usage-projection.ts](../../../../../deepseek-harness/packages/llm/token-meter/src/usage-projection.ts)的 `bucketsFrom`（约 31 行）时，缺 cache 通过 `?? 0` 合并为零。
- 同文件约 112 行消费 assistant chunk/message 的 usage；对最后一个匹配 `(turn, step)` 的样本减旧加新，避免正常重复更新累加。不能将这个实现夸大为对任意历史乱序事件的全局去重。
- [StatsLine.tsx](../../../../../deepseek-harness/packages/client/ui-conversation/src/client/chat/StatsLine.tsx)约 107 行以会话日志累计 read / (uncached+read+write)，后一步缺数据不撤销前面的步骤。
- 已进入 projection 的 usage 不因后续失败撤销；但该 DeepSeek adapter 的 pending usage 要到 `[DONE]` 才发出，不能据此声称所有断流用量都保留。

取舍：借鉴已知步骤独立保留与一次记账，拒绝统计层缺失转零；不复制持久日志 projection。本项目没有 ohbaby 可用的同样最终 Step 接缝，减旧加新不能直接变成我们的默认复杂度。

## 3.3 DeepSeek-Reasonix

- [Responses parser](../../../../../DeepSeek-Reasonix/internal/provider/responses/responses.go)约 790 行，cached 默认 0，miss 为 input-cached；约 872 行普通整数属性不能区分 JSON 缺失和明确零。
- [run_usage.go](../../../../../DeepSeek-Reasonix/internal/agent/run_usage.go)的 `mergeSamplingUsage`（约 137 行）按请求尝试累计，含重试；无 hit/miss 时把 prompt 算作未缓存输入。部分失败/取消会估算 usage 并标记 Estimated。原始 session counter 与最终计費事件不是同一层账本。
- [subagent_progress.go](../../../../../DeepSeek-Reasonix/internal/agent/subagent_progress.go)约 706 行标记子代理来源，[stats recorder](../../../../../DeepSeek-Reasonix/internal/stats/recorder.go)约 246 行复用 usage 记录来源与缓存量。
- [textsink.go](../../../../../DeepSeek-Reasonix/internal/agent/textsink.go)会显示 usage（约 136、236 行），不能宣称它也采用“子代理仅静默”。

取舍：借鉴复用用量通路与来源归属；不引入失败估算、重试计费、cached/new 新 UI 或未知全算 miss。

## 3.4 kimi-code

- [Responses `_extractUsage`](../../../../../kimi-code/packages/kosong/src/providers/openai-responses.ts)约 703 行将缺 cached_tokens 变为 0，普通 input 为 input-cached；该路径 cacheCreation 固定为 0，没有读取 Responses cache_write_tokens。
- [usage recorder](../../../../../kimi-code/packages/agent-core/src/agent/usage/index.ts)从约 17 行记录每个 Step 的 usage，按模型累加，总数跨 Turn 保留；currentTurn 独立清空。[full compaction](../../../../../kimi-code/packages/agent-core/src/agent/compaction/full.ts)约 548 行也向 session recorder 记用量，所以其总量范围包含压缩请求。
- [subagent-host](../../../../../kimi-code/packages/agent-core/src/session/subagent-host.ts)约 348 行读取 child 自己的 usage，在完成事件和返回值中携带；没有由此自动调用 parent recorder。
- [turn-step](../../../../../kimi-code/packages/agent-core/src/loop/turn-step.ts)约 292–332 行的工具执行、取消检查位于 afterStep 之前。从调用顺序推断：LLM 已返回但工具期间取消时，内部 Run 小计可能已更新，而 session recorder 尚未执行。不能把“按 Step”误解为所有失败路径都完整。

取舍：借鉴主子各自保有数据、跨轮累计；不引入压缩请求统计、不复制未知转零，也不把新增观察放到工具完成之后。

## 3.5 Kun

- [compat-usage-normalizer.ts](../../../../../Kun/kun/src/adapters/model/compat-usage-normalizer.ts)约 14–31 行使用数值零 fallback，并按 prompt-hit 推 miss。`{input_tokens:100,output_tokens:10}` 没有缓存明细，实际会得到 hit=0、miss=100、rate=0%，与文档中的“未知 null”意图并不等价。
- [usage-counter.ts](../../../../../Kun/kun/src/telemetry/usage-counter.ts)约 37 行逐响应加 hit/miss，再计算累计比例。如果上游真的保留缺失，counter 可不增加 cache 分母；但兼容 parser 通常已推成 miss，不能只看 counter 宣称它严格保留未知。
- [model-round-engine](../../../../../Kun/kun/src/loop/model-round-engine.ts)约 358 行收到 usage intent 就记录并写事件，后续异常没有 rollback。不过 [compat-model-client](../../../../../Kun/kun/src/adapters/model/compat-model-client.ts)约 1112–1186 行会等待流末尾才 emit，截断可能没有本次 usage。
- [child-agent-executor](../../../../../Kun/kun/src/delegation/child-agent-executor.ts)约 120–137 行让 child 使用独立 thread 和 UsageService，共享持久事件存储；[delegation-runtime](../../../../../Kun/kun/src/delegation/delegation-runtime.ts)约 896、1301 行在正常返回后还把 child usage 合入父桶。失败 catch 没有同样折入，不能称为统一完整的父子账本。
- [use-thread-usage](../../../../../Kun/src/renderer/src/hooks/use-thread-usage.ts)读取累计指标；它还提供诊断、建议等扩展信息，这些不是 ohbaby 本轮所需。

取舍：借鉴子任务可留证与累计结果保持；拒绝主子自动合并、未知转 miss、复杂诊断和持久恢复范围扩张。

## 3.6 opencode

- 原生 [Responses parser](../../../../../opencode/packages/llm/src/protocols/openai-responses.ts)约 507 行保留缺失字段；V1 [Session.getUsage](../../../../../opencode/packages/opencode/src/session/session.ts)约 338 行在产品模型归一化时把缺失 read/write 变 0，并把 input 转成不含 cache 的输入。
- V1 [processor](../../../../../opencode/packages/opencode/src/session/processor.ts)约 435 行每个 step-finish 保存 token part；[projector](../../../../../opencode/packages/core/src/session/projector.ts)约 310 行更新 part 时减旧加新，删除也减回，累计指定 session。它是可重建的数据库投影，与本轮内存只增累计不同。
- V2 [publish-llm-event](../../../../../opencode/packages/core/src/session/runner/publish-llm-event.ts)约 16 行也将缺失变 0，以 stepSettlement 保存终态；[runner/llm](../../../../../opencode/packages/core/src/session/runner/llm.ts)约 316 行发送 Step.Ended。[message-updater](../../../../../opencode/packages/core/src/session/message-updater.ts)约 209 行写消息 tokens，但当前 projector 的 Step.Ended 分支不走 V1 applyUsage。不能把 V1 的完整 session 汇总能力算到 V2 上。
- V1 [task tool](../../../../../opencode/packages/opencode/src/tool/task.ts)约 156 行创建带 parentID 的独立 child session，未自动合并到父桶。Web 的 session context metrics 取最近一条有 tokens 的 assistant，不等同于累计缓存百分比。

取舍：借鉴单步结算和独立归属；不照搬字段零值化、持久化投影或假定其 V1/V2 完全等价。

## 3.7 pi

- [openai-responses-shared](../../../../../pi/packages/ai/src/api/openai-responses-shared.ts)约 533–572 行读取 Responses 的 read 和 write，缺失均回退 0；内部 input 为 `max(0,input_tokens-read-write)`。
- [footer](../../../../../pi/packages/coding-agent/src/modes/interactive/components/footer.ts)约 87–104 行虽然累计所有 session entries 用量，但 `latestCacheHitRate` 每遇到 assistant 都覆盖；**显示的 CH 是最新一次响应比例**。100/read100 后接 900/read0，CH 为 0%，不能用它作为 session 10% 的实现依据。
- Responses failed 分支（shared 约 715 行）抛错前没有提取该失败事件的 usage；error/aborted 消息仍可能被持久化，已保留的 usage 可以累计。它不是所有失败尝试的账本。
- [subagent 示例扩展](../../../../../pi/packages/coding-agent/examples/extensions/subagent/index.ts)约 342–377 行自行累计 child usage，结果放在 details.results 中；不能因为核心支持 toolResult.usage 就断言这个示例会自动合入父统计。

取舍：借鉴明确 input 分桶及消息保存证据；拒绝 latest CH、未知转零与未经证实的子代理合并推断。

## 3.8 oh-my-pi

- [openai-shared](../../../../../oh-my-pi/packages/ai/src/providers/openai-shared.ts)约 3265–3340 行读取 Responses cached_tokens 和 cache_write_tokens；约 425 行进行分桶。DeepSeek miss 在相应分支保留为普通 input，不能把所有未命中输入都说成 cache write。
- [session-manager](../../../../../oh-my-pi/packages/coding-agent/src/session/session-manager.ts)约 144 行累计 assistant 与 task toolResult usage，并可由全部 entries 重建。[cache_hit segment](../../../../../oh-my-pi/packages/coding-agent/src/modes/components/status-line/segments.ts)约 566 行使用累计 read/(input+read+write)，读取为零时隐藏整个 segment。
- [task/index](../../../../../oh-my-pi/packages/coding-agent/src/task/index.ts)约 61 行把子任务汇总放入 toolResult，父累计明确纳入 child，与本轮主子隔离不同。
- Responses 失败终态可先 populate usage 再抛错，比 pi 的上述分支保留更多；但透明重试会重置当前 output usage，仍非所有 HTTP 尝试账本。另一个 SessionStatsTracker 统计当前 agent messages，不能与状态栏全部 entries 范围混写。

取舍：采用“累计 token 后求比例”的思路；不采用未知转零、零时隐藏、子代理合并或跨重启历史累计。

## 3.9 对本轮方案的实际影响

| 观察                                       | 本轮选择                                        |
| ------------------------------------------ | ----------------------------------------------- |
| 逐响应/Step 不因后步缺失丢掉前步           | 采用；用户已确认替代旧 Run 门槛                 |
| 多数项目缺缓存字段默认零                   | 不采用；ohbaby 的 observed 保留                 |
| 一些项目按日志修正或重建累计               | 不复制；利用本项目最终 Step 接缝，只记一次      |
| 子任务有独立身份与 usage 数据              | 复用本项目 session+scope、事件与 metadata 验证  |
| 最新百分比、累计百分比、含子代理是不同范围 | 只实现用户确认的主代理 session 累计             |
| 外部项目的 input 可能不含缓存              | 先翻译口径；ohbaby inclusive input 不再加 cache |
| 实际返回零或缺失均可能发生                 | 用固定样本保护所有分支；live 观察不设命中率目标 |

本轮没有为“像优秀项目”而引入新状态、诊断系统、记账数据库或缓存控制。新接缝的选择来自 ohbaby 自身最终用量处理的位置，见 02。

## 3.10 真实平台接口核对（实施前补查，2026-09-15）

以下为官方接口文档支持声明；实际账号、网关和当前 adapter 是否跑通，分别由本轮 05 记录，不能用文档支持替代实测。

| 平台                 | 官方接口与本轮选择                                                                                                                                                                                                                                                                 | 观测限制                                                                                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ZenMux DeepSeek/Qwen | [协议转换](https://zenmux.ai/docs/api/protocol-conversion.html)支持三协议；基准 Responses 保留已有非 reasoning 的 Grok profile                                                                                                                                                     | 隐式命中受路由和前缀复用影响，本轮不固定供应商路由或修改缓存控制；[缓存文档](https://zenmux.ai/docs/guide/advanced/prompt-cache.html)                                    |
| 百炼 Qwen3.8-Flash   | [模型说明](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)；[Responses](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-responses)、[Anthropic](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/anthropic-api-messages)均有官方支持 | 使用北京 endpoint；隐式读取按实际字段观察，不引入 previous_response_id/session-cache header；[缓存说明](https://www.alibabacloud.com/help/en/model-studio/context-cache) |
| 智谱 GLM-5.3         | [模型说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)列多协议；本轮尝试 Chat/Anthropic                                                                                                                                                                                 | 强制 thinking 与当前受限 Responses 不兼容，部分 Coding Plan 账号限制协议；[缓存说明](https://docs.bigmodel.cn/cn/guide/capabilities/cache)                               |

`.env` 已配置相关凭据名称；不把其值写入文档。实验固定合成长前缀、变量放末尾、顺序等待调用完成，不修改产品 system prompt 或缓存策略来提高命中。实际零/未知同样保留为观测结果。
