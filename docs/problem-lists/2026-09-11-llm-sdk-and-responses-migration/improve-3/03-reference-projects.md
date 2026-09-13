# 3. 六项目参考与取舍

> 2026-09-13 本地代码只读调研；结论限定所查路径，不代表项目全部实现。

| 项目 / 代码锚点（相对 /Users/hansun025/Projects/code-cli） | 事实 | ohbaby 取舍 |
| --- | --- | --- |
| pi/packages/ai/src/types.ts:433,487；api/openai-responses-shared.ts:136 | 自有Message/Context；system顶层；各协议直接转换 | 借边界，不照搬signature及全流事件 |
| opencode/packages/core/src/session/runner/to-llm-message.ts；packages/llm/src/schema/messages.ts:183,224 | native/V2应用历史转LLM；工具inputSchema扁平；system顶层与时间线共存 | 借双层消息和字段含义，不搬Effect/通用metadata框架 |
| oh-my-pi/packages/ai/src/types.ts:817,1202；packages/agent/src/types.ts:164 | 应用消息投影；developer与systemPrompt并存；provider特定转换 | 借角色判别，不搬providerPayload/replay状态 |
| kimi-code/packages/kosong/src/message.ts:92；packages/agent-core/src/agent/context/projector.ts:100 | 自有消息，content数组与toolCalls分开；context扩展后投影 | 借工具独立，不强制全数组/复制encrypted extras |
| deepseek-harness/packages/llm/llm/src/message.ts:128；types.ts:320 | 同一不可变消息可用于历史/请求；工具在blocks内；system也可顶层 | 不合并ohbaby存储/模型消息；不复制工具块重构 |
| Kun/kun/src/ports/model-client.ts:64；adapters/model/compat-request-codecs.ts:11 | port用应用TurnItem，adapter内部仍有Chat-shaped中间结构 | 借私有投影边界，不称其完全去Chat化，不搬存储字段 |

这些项目没有统一的role/content/system方案。采用自有类型不意味着禁用messages/role/content通用词，也不意味着所有供应商同等支持。

## 官方扩展字段核对

- [DeepSeek思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)：reasoning_content存在工具回传要求。
- [智谱思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)：回传与clear_thinking等控制有关。
- [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)：结构化reasoning_details不能压为文本。

上述只作为防丢信息的依据，不加入新能力。Kimi/ZenMux对应官方扩展页上轮搜索未取得有效结果；不把参考项目实现冒充官方完整支持证明。具体模型端点在U6补证。不得复制deepseek-harness的disjoint token定义覆盖ohbaby inclusive usage。
