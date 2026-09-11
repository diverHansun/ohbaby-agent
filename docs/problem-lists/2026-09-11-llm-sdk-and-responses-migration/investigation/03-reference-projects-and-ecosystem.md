# 参考项目与生态结论

## 1. 本地 coding-agent 项目

调查范围位于 `/Users/hansun025/Projects/code-cli/`。

| 项目 | 观察到的策略 | 对 ohbaby-agent 的启示 |
| --- | --- | --- |
| pi | OpenAI Chat/Completions 与 Responses 分文件实现，共用内部消息模型 | Responses 应作为独立 provider 协议，不应污染 Chat 分支 |
| opencode | `openai-chat` 与 `openai-responses` 分离 | 路由层选择协议，agent loop 消费统一事件 |
| kimi-code | 显式区分 legacy OpenAI 与 Responses | 协议选择应进入配置，而不是通过 base URL 猜测 |
| deepseek-harness | DeepSeek 主链以 Chat compatible 为主，依赖层可覆盖多协议 | 第三方模型仍需要稳定 Chat 基线 |
| DeepSeek Reasonix | Chat 与 Responses 分开，Responses 可选择有状态/无状态 | 服务端状态应是可选能力，而非本地 context 的强制替代 |

共同模式是“内部语义稳定、边界 adapter 分离”，而不是让 lifecycle 直接处理每家 SDK 的事件联合。

## 2. 框架生态

用户调查记录中的生态信号可归纳为：

- OpenAI Agents SDK、Vercel AI SDK、PydanticAI 对 OpenAI 原生模型越来越偏向 Responses；
- LangChain、LiteLLM 等同时保留 Responses 和 Chat 路径；
- AutoGen、Semantic Kernel 等仍保留大量 Chat-oriented 抽象；
- OpenRouter、vLLM、LM Studio、Ollama 等已出现 Responses 支持，但能力覆盖和兼容程度并不一致；
- Gemini、DeepSeek 及大量中转站的最大公约数仍是 Chat Completions。

这里的“支持 Responses”不能简单等价为完整支持 OpenAI 的所有 input/output item、hosted tool、reasoning continuity 或 server state。后续若实施，应建立 capability matrix，并通过真实 provider contract test 验证，而不是只看 endpoint 是否返回 200。

## 3. 架构建议

未来新增 Responses 时采用：

```text
provider-neutral request/event contract
  ├─ openai-compatible.ts  -> /v1/chat/completions
  ├─ openai-responses.ts   -> /v1/responses
  └─ anthropic.ts          -> /v1/messages
```

`openai-responses.ts` 独立实现更直接，原因是 Responses 的输入 item、输出 item、流事件、tool result、usage、状态引用都不是 Chat chunk 的少量字段差异。把它做成 Chat provider 内的条件分支会让解析状态机和错误处理持续交叉。

但独立文件不等于复制整个 provider。重试、诊断、usage 归一化、abort 识别和通用配置应继续复用；协议专属转换与流解析保持隔离。

## 4. 本阶段不落地的待决问题

后续 Responses 设计至少需要单独回答：

- provider kind 与配置如何表达 Chat/Responses，而不破坏现有配置；
- 内部 message/tool/content item IR 的最小集合；
- reasoning item 是否持久化、回放或仅作为 opaque provider state；
- stateful 与 stateless 两种模式如何切换和降级；
- provider 切换、会话恢复和 SQLite 迁移策略；
- cache 命中、context 压缩与远端状态失效时的真相源；
- 第三方“Responses-compatible”的分级验收标准。

这些问题不阻塞 `improve-1`，也不应由 SDK 升级顺带决定。
