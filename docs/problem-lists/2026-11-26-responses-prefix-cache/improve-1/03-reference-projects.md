# 官方规则和相邻实现

OpenAI 在 GPT-6.2 上把顶层 instructions 放到 input 之后。可重复使用的应用指令应放在 input 开头的 developer 消息，服务会在符合条件的边界查找已有前缀。隐式模式足以验证本次修复。[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

模型、工具定义和顶层 effort 都可能改变可复用前缀。支持在历史里切档的模型可以保留原始 effort 并追加 configuration_update。[OpenAI 缓存诊断](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)

相邻 Codex 项目的 base_instructions.rs 将基础指令表示为 developer，client.rs 将它放在输入开头。Pi 的 openai-responses-shared.ts 按模型的角色兼容能力投影系统指令。ohbaby 已有独立的 Responses 适配器，这次只需在该边界调整基础指令的位置。
