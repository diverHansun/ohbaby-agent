# 讨论结论：SDK、Chat Completions 与 Responses

## 1. 调查输入

本轮以用户提供的 [ChatGPT 调查记录](https://chatgpt.com/share/6aa2c965-df80-83e9-92dc-cfbe36c2d10d)、当前仓库代码、官方 SDK 文档和本地参考项目为依据。

截至 2026-09-11，结论不是“Chat Completions 已经被 Responses 强制替换”，而是：

- Responses 是 OpenAI 面向新能力的首选协议；
- Chat Completions 仍是有效接口，官方 deprecations 页面没有给出它的停止日期；
- 跨供应商、中转站和 OpenAI-compatible 生态仍以 Chat Completions 为最广泛的共同基线；
- 因此 ohbaby-agent 应当把 Responses 视为一条独立协议能力，而不是立即覆盖现有 Chat provider。

参考：[OpenAI API deprecations](https://developers.openai.com/api/docs/deprecations)、[OpenAI 最新模型迁移建议](https://developers.openai.com/api/docs/guides/latest-model)。

## 2. 当前代码究竟使用 SDK 还是手拼 HTTP/SSE

当前两条主链都基于官方 SDK：

- OpenAI-compatible 创建 `OpenAI` client，并调用 `client.chat.completions.create({ stream: true })`；
- Anthropic 创建 `Anthropic` client，并调用 `client.messages.stream()`；
- 项目自己负责的是跨 provider 请求转换、事件归一化、tool-call 增量拼接、usage/cache 统计，而不是自行实现通用 HTTP 或 SSE 解析器。

项目没有 `/v1/completions` 文本补全实现，也没有 `/v1/responses` 实现。当前 OpenAI 路径是 `/v1/chat/completions` 语义，Anthropic 路径是 `/v1/messages` 语义。

## 3. Responses 是否直接提升 agent 能力

字段改名本身不会让模型“更聪明”。能力改善来自 Responses 能承载或更自然支持的机制，例如：

- reasoning item 与后续轮次之间更完整的连续性；
- hosted tools 和多种 output item；
- `previous_response_id`/conversation 等服务端状态能力；
- OpenAI 新能力优先在 Responses 暴露。

官方材料指出，保留 reasoning 上下文可能减少重复推理、提高缓存命中并降低延迟。这是一种协议能力带来的间接收益，不代表把相同文本从 Chat JSON 改写为 Responses JSON 就会自动提升效果。

## 4. “服务端状态链替代本地 context”的准确含义

Responses 可让客户端通过 response/conversation 标识引用远端已有状态，而不必每轮把所有历史原样重发。但它不能无条件替代 ohbaby-agent 的本地 context：

- 本地仍需保存可恢复、可审计、可跨供应商回放的事实；
- context 压缩仍负责预算控制、长期历史取舍和 provider 切换；
- 服务端状态具有供应商绑定、保留期、可观测性和故障恢复约束；
- cache 命中与 context 压缩是两件相关但不同的事。

若未来使用服务端状态，建议把它建模为可选的 provider continuation reference，而不是 SQLite 会话真相源。

## 5. Anthropic Messages 与 OpenAI-compatible 如何兼容

它们不是线协议兼容，而是由 ohbaby-agent 在 provider 边界转换：

1. lifecycle/context 交付当前内部的 Chat-shaped 消息与 function tool 定义；
2. OpenAI-compatible adapter 直接交给 Chat Completions SDK；
3. Anthropic adapter 把 system、user/assistant、tool call/result、tools 转为 Anthropic Messages content blocks；
4. 两边的流事件再归一化为项目自己的 `InterfaceProviderStreamEvent`。

这解释了为什么 lifecycle 的 while 循环与具体 API 并非强绑定，但“准备请求”和“消费归一化事件”之间的类型边界仍会受到协议设计影响。

## 6. 决策

当前决策分两步：

- `improve-1`：先升级 SDK，保持线上协议和持久化语义不变；
- 后续独立阶段：若获批，新增独立 `openai-responses.ts`，与 `openai-compatible.ts` 并列，而不是塞进 Chat provider 的小分支。

这样能先消除过旧依赖带来的维护风险，同时利用升级暴露的类型问题厘清最小边界；又不会把 SDK 升级、协议迁移和 agent 状态模型重构混成一次不可审计的大改。
