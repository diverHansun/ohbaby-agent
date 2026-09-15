# 1. 当前代码与问题溯源

> 基线：`8b546e3b8ea8870d4cca79a0c030ad60eecacb2d`，2026-09-15。本文描述实现与诊断事实，不代表 5.5 已实施。下文代码路径均相对仓库根；行号为此基线快照，定位以符号为准。

## 1.1 问题清单

| ID  | 现状与影响                                                                                                            | 证据入口                                                                                                                  | 方案批次 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------- |
| P1  | 配置没有 reasoning 开关/强度；temperature 必填并在 writer 补默认，新模型可能拒绝                                      | `config/llm/types.ts`、`validation.ts:243`、`writer.ts:91`、`core/llm-client/streaming.ts`                                | A、B     |
| P2  | Responses 明确拒绝 phase/reasoning；部分路由 created 携 queued 被初始状态检查拒绝                                     | `services/interface-providers/openai-responses-stream.ts:supportedItem/validateResponse`                                  | A、C、D  |
| P3  | Anthropic 丢弃 tool_use.start.input，空参数或完整初始参数没有 delta 时可能 JSON.parse 失败；thinking/signature 没接入 | `services/interface-providers/anthropic.ts:buildStreamEvent`，约 401 行                                                   | A、C、D  |
| P4  | 模型结果只有可见 reasoning 文本，缺原生状态及来源；每 Run 的内存 Map 无法跨 Run/重启续接                              | `core/llm-client/types.ts`、`core/lifecycle/lifecycle.ts:324/904`                                                         | D、E     |
| P5  | 历史转换和估算投影只认识旧字段；新增原生状态不会自动纳入活跃历史、压缩或估算                                          | `core/context/serializer.ts`、`legacy-estimation.ts`、`context-manager.ts`                                                | D、E     |
| P6  | 正确的 usage/cache 消费边界可能被新增分块事件破坏；持久化有重复写 usage 的风险                                        | `core/lifecycle/lifecycle.ts:593`、`adapters/ui-inprocess/prompt-cache-usage.ts`                                          | D、E、F  |
| P7  | 子代理和标题/摘要调用入口不同，不能仅在主循环中加参数；共享配置有跨任务串扰风险                                       | `core/agents/`、`agents/subagent-host.ts`、`adapters/ui-runtime/prompt-context.ts`、`services/session/title-generator.ts` | B、E     |
| P8  | 原有 adapter 测试通过不能证明新模型完整工具续接；HTTP 200 不等于 accepted Step                                        | improve-5/06 与本地诊断材料                                                                                               | A、F     |

上述缩写路径均以 `packages/ohbaby-agent/src/` 为前缀。

## 1.2 已执行的诊断及证据强度

| 实验                                 | 实际结果                                                                                                  | 能证明什么 / 不能证明什么                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| improve-5 第二轮真实矩阵             | 14 组，11 组完整通过、3 组未通过                                                                          | cache 主链可工作；不证明全部新模型兼容，详见 [原报告](../improve-5/06-real-cache-revalidation.md) |
| Claude Sonnet 5 / ZenMux             | temperature=0.2 拒绝；省略后文本 200，工具 200 但 tool_parse_failure                                      | 参数和工具解析是两个失败点，不能只修参数就宣称通过                                                |
| GPT-5.6 Luna / ZenMux Responses      | 原参数拒绝；省略温度后仍因 phase 失败                                                                     | phase 是后续能力边界，不能删除字段伪造兼容                                                        |
| 百炼 Responses 差分回放              | created.status=queued；仅改内存中的状态后仍碰到 reasoning；显式 none 样本只返回文本，改状态后的回放可接受 | 支持根因排序；修改仅在诊断内存，不是生产修复                                                      |
| Luna none + temperature=0.2 单独探测 | HTTP 200，仍被 phase 拒绝                                                                                 | 此路由接受该参数组合；不证明温度真实生效，也不证明完整 E2E                                        |
| Anthropic 工具本地边界               | 17 项：11 通过、6 失败，覆盖 raw 与 SDK 消费链                                                            | 初始 input/空 delta 的失败可以无网络复现；尚未修复                                                |
| 用量与估算探针                       | 12 项合成测试通过，零付费请求                                                                             | 三协议总量不重复加 reasoning；cache 不含输出；新原生字段被旧投影忽略的缺口得到证实                |

本地补充材料在 `.ohbaby/test-evidence/improve-5.5/`：`live/diagnostic-summary.json` 汇总前 7 次诊断 HTTP；`live/gpt-reasoning-none-temperature-request-1.json` 为后续单独样本，不在该 7 次计数内。`local-tool/tool-boundary.test.ts` 为故障复现；`usage-audit/results.json` 为 12 项结果。忽略目录不会随 git 交付，A 批必须将必要样本脱敏、最小化后纳入正式 fixture，不能让实施依赖某台电脑的临时目录。

这些是溯源证据，不是 improve-5.5 的验收结果。已跑过的历史测试数字不替代实施后的重新执行。

## 1.3 职责与架构现状

现有链路为：模型配置 → LLM client → 独立协议 adapter → 统一流累积 → Lifecycle → Message/Part → Context → 下一次请求。improve-3 已去掉主链上的 Chat SDK 类型耦合；SDK 版本升级不会自动补齐自有类型未承载的字段。

`core/llm-client/types.ts:ModelResponseSnapshot/StreamingResponse` 承载文字、工具与完成信号；`services/interface-providers/types.ts:ModelMessage` 只有有限 reasoningText。Responses adapter 主动 fail-closed 是 improve-2 的既定范围，属于能力待扩展，不是 improve-1 SDK 升级失败。

Anthropic 初始 input 丢弃则是既有 mapper 的解析缺口；此前溯源显示该行为早于本次迁移。应从具体 adapter 修复，不能把所有问题笼统归到 improve-1 重做。

## 1.4 数据模型、存储与外部投影现状

- `core/lifecycle/lifecycle.ts` 每 Run 新建 `activeReasoningByMessageId`。serializer 主要把其中的 reasoningText 带到同 Run 的工具 assistant；普通文本历史没有同等恢复机制。
- `core/message/types.ts` 有 ReasoningPart，但生产 Lifecycle 不创建它。相关测试明确约束“不落可见 reasoning Part”。这个限制不等于禁止保存续接状态。
- `AssistantMessage` 已有 providerId/modelId，但 `runModelStep` 创建消息时未填；原生状态不能在未知来源时盲目跨模型回放。
- `core/message/database-store.ts:serializeMessage/serializePart` 与 `services/database/schema.ts` 使用 JSON data；可兼容扩展 payload，目前无需证明为此新增 SQL 表。但 reader、活动性、更新与重开数据库需要测试。
- `adapters/ui-state/persistent-store.ts` 将 ReasoningPart.text 投影为可见 reasoning；不能将签名/加密内容写进 text。message bus 也会携带完整内部对象，新增字段必须核查公开序列化边界。

## 1.5 上下文与估算现状

`core/context/context-manager.ts:getActiveHistory` 只保留含 active Part 的消息；仅在 assistant.info 加状态却不处理 active 判断，reasoning-only 历史仍会消失。prune 按工具 Part，summary 按消息选段，现状没有原生状态关联单元。

`core/context/legacy-estimation.ts:legacyMessageForEstimation` 枚举旧字段；`token-estimation.ts:estimatePreparedRequestHeuristic` 估算该投影。当前是启发式，不是供应商 tokenizer。探针中纯消息约 9 tokens，加入已有 reasoningText 后约 265，加入 2 万字符未声明状态仍约 9；最后一例刻意使用尚未支持的字段以暴露投影边界。

`services/llm-model/modelProfiles.ts` 已预留一次输出额度；reasoning 与回答共用输出上限，不能另扣一份推理额度。真实输入仍须与同一次 prepared.sentHeuristic 配对校准。

## 1.6 用量与 cache 现状

`services/interface-providers/token-usage.ts`：Chat completion_tokens、Responses output_tokens、Anthropic output_tokens 均是包含 reasoning 的输出总量。当前忽略 reasoning 子项不导致漏总量；缺输出总量时不能从子项猜出总量。

`Lifecycle.run` 在接受最终 Step 之后 aggregate、onStepUsage、校准，再检查 abort/length。原始 complete 标志可能出现多次，不能新增逐块记账。overflow 被放弃的尝试不能覆盖成功尝试的状态或重复进入 tracker。

`prompt-cache-usage.ts` 仅用可信输入与 observed cacheRead；reasoning 输出不参与当次 hit 分母。后续回传的状态对下一次输入/cache 的影响由供应商 usage 报告。继续保持 main/child/contextScope 隔离。

## 1.7 调用目的与非功能约束

`services/session/title-generator.ts` 直接调用 streamResponse，purpose=session-title；`adapters/ui-runtime/prompt-context.ts:createContextSummaryClient` 直接调用 streamResponse，purpose=context-summary，手动/自动压缩共用。它们不是独立子代理，也不经过主 agent-step 的统计入口。

主子共享运行基础设施，因此配置必须按任务解析成不可变快照，不能在共享 client 上临时改 temperature/reasoning 再改回来。原生状态只用于续接，不能自动进入正文、摘要提示词或普通日志。

## 1.8 历史文档对照与 SWE 判断

| 历史合同                                                 | 代码实际                                        | 本轮关系                                   |
| -------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| improve-1 只升级 SDK                                     | 已升级，不自动透传所有新能力                    | 保留，不重做                               |
| improve-2 拒绝 reasoning/phase，完整流后才可执行工具     | 当前执行此限制                                  | D/E 完整接通后扩大允许集合；不能只删断言   |
| improve-3 reasoningText 是文字，估算/存储保持旧合同      | 原生状态尚无承载                                | 增加自有协议判别类型，保持 SDK 隔离        |
| improve-4 同请求输入校准、每 Step 至多一个 Part 有 usage | 目前成立，reasoning-only 无 Part 可无持久 usage | 必要原生状态有承载后扩展；不制造重复 usage |
| improve-5 可信 Step 累计、进程内 cache                   | 当前成立                                        | 继续沿用，不新增重启 cache 恢复            |

SWE 重点：协议差异是必要复杂度，隐式丢字段与共享对象临时改配置是偶然复杂度。保持 adapter 负责 wire、core 负责自身状态所有权；只增加当前三协议续接需要的类型，不设计全能 IR、不建设全平台路由服务。新增持久化结构可兼容扩展，但回退旧版本可能无法续接新状态，需在 02 明确降级边界。
