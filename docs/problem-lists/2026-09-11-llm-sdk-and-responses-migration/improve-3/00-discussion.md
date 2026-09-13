# 已确认讨论

> 来源：2026-09-13 当前会话逐组确认；以下是有效结论摘要，不虚构会议逐字稿。

## 1. 目标与范围

- 保留 Chat、Anthropic、Responses 各自 adapter；减少共享请求/结果对 Chat SDK 类型和结构的依赖。
- 已有 `MessageWithParts` 继续承担历史/存储职责；新的模型消息只面向 LLM 调用。
- system 继续存在于有序 messages 中，不新增顶层抽取；保留 developer 差异，adapter 独立决定支持范围。
- content 按角色允许字符串/内容块；不自动归一空字符串、null、缺失、空数组，不自动 trim、合并或重排。
- 工具调用独立于 content；工具定义采用 name/description/inputSchema，去掉固定 function 外壳。调用采用 callId/name/argumentsJson；解析后参数另行表达。结果继续 role=tool、callId、content，不新增状态。
- reasoningText、cacheControl 采用明确字段；不引入万能 extras/native/providerMetadata。原生状态续接不属于本轮。
- completeMessage 改为 messageSnapshot，快照与请求消息语义分开，不重复维护正文；保留 isComplete 和三种结束原因的现有行为。
- KISS：类型不必全部新增，通用参数名称保持；不新增管理器、完整事件框架或包。
- 公开旧入口可以直接删除，仓库内调用方全部迁移；删除入口不意味着可以静默删除旧输入能力。
- 精确契约最终确认：消息name与多模态/refusal/assistant audio窄请求能力按design/data-model.md §5保留；删除旧role=function、assistant.function_call和历史custom tool call表达，不删除Responses原生同名item或Chat结束原因兼容映射。

## 2. 不变量与不做事项

- SQLite 表与持久 JSON 字段不变；新结果仍映射回既有 Message/Part。
- 估算按design/data-model.md §6批准的有限等价保持旧口径，包括tools、tail directives和composition；不只保持字符权重公式。不保留任意外部对象仅因字段插入顺序不同导致分类失配的旧行为，不为此维护原对象副本。
- cache 请求策略、key、标记落点、usage 归一化、累计统计不变。
- 不改 context 压缩阈值/算法、lifecycle 调度/双循环、UI 交互、默认协议。
- 统计对齐、精确 token counting、原生 reasoning/phase/服务端状态续接和整体迁移验收留后续。

## 3. 批次与验证

A 请求与 adapter；B 结果与消费者；C 兼容及公开入口清理。每批单元、集成、子代理审查，修复复测后分批提交。全部完成后全量门禁与 LLM 请求 E2E；真实供应商与本地可控端点证据分开。

## 4. 文档与分支

用户指定同时使用plan-module-design与plan-code-improvement，在本目录补齐设计和迁移文档，写关键改动条目及新旧字段表。2026-09-13最终确认契约并授权按前置门推进：improve-2真实测试通过后合入已有openai-responses-migration，再新建本地临时分支实施improve-3。improve-3按A/B/C测试、审查、提交并完成真实E2E后，必须等待用户审查和improve-4计划确认，不自动合回集成分支；main不动。

## 5. 参考

用户指定 deepseek-harness、kimi-code、Kun、oh-my-pi、opencode、pi；取舍见 03。context improve-5（含 token 职责收口 06/07）、improve-6 是兼容约束，不能作为过时背景忽略。

## 6. 2026-09-13最终批准与真实测试

用户原话：“接受以上的建议，部分在improve-3中未完成，需要improve-4继续或者后续继续的点，请在文档中说清楚”。由此关闭字段设计U1–U5及公开命名决定；观察LifecycleEvent允许缺messageSnapshot，StreamingResponse仍必有；入口采用streamResponse/toModelTools，旧StreamingTokenUsage公开蛇形别名在B删除，数据库codec不动。

用户指定ZenMux及ZENMUX_API_KEY：openai/gpt-5.6-luna走Responses；deepseek/deepseek-v4.1-flash分别走Chat和Responses；qwen/qwen3.8-flash走Anthropic。后续补充凭据来源为仓库根.env。只向这些批准端点发送测试fixture，不输出密钥或提交.env。执行矩阵见04 §4.6。

这是用户将live证据来源改为ZenMux的修订，不是直连OpenAI官方endpoint的证明；improve-2/04追加门禁修订。不得因指定模型支持某API就假定它必然符合当前受限adapter，实际测试遇到不支持输出仍停并报告。

用户随后批准最小参数兼容修订（temperature发送条件、非推理模式核实），但没有授权放宽reasoning/phase保护或提前开始原生状态迁移。受控验证结果见improve-2/05 §5.10；未满足前置验收，improve-3实施授权的前提仍未成立。

用户再次明确：“确认在ZenMux 中另选 Responses 验收模型，先预检确认符合要求，再调整测试矩阵！”本次授权允许在同一ZenMux端点筛选替代模型，不允许放宽输出保护。筛选后x-ai/grok-4.2-fast-non-reasoning通过文本与生产llm-client两轮工具预检，按此授权更新04 §4.6为Grok Responses、DeepSeek Chat、Qwen Anthropic三行；原两款Responses失败记录保留。完整lifecycle T12仍待执行，未因此提前合并或开工。
