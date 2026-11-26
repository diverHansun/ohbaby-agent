# 为何换个问题就读不到基础指令

正常会话的 `serializeForLlm` 在历史开头放一条 system 消息。Responses 的 `buildRequestParams` 收集所有 system 字符串，拼进顶层 `instructions`。工具、用户消息和助手历史则单独进入 `input`。GPT-6.2 在可缓存输入之后才处理这些顶层指令，重复请求也要重新计算它们。

修复前，在约 3,950 个输入 token 的样本上只改最后的问题，官方 GPT-6.2 Sol 和 Magpie 的 auto 路由连续五轮读到 0 个缓存 token。实验中只把开头的基础指令放入 developer 消息，两端换题后分别读到 3,936 和 3,932 个。清单里的官方 GPT-6.1 Sol、Terra 和 GPT-6 Astra 使用原布局也能命中。

Chat Completions 与 Anthropic 各有独立序列化器。Magpie 上同档重复的 GPT-6.2 Sol Chat 约为 99.9%，Sonnet 5.5 Messages 约为 92%。三个接口都使用供应商回报的 usage。缓存收益取决于前缀是否一致、长度和上游是否仍有缓存。
