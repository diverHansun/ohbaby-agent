# models-for-tests 测试模型清单

API Key 详情见 `.env`。

## Zenmux

- Provider：`zenmux`
- API Key：`ZENMUX_API_KEY`

| 模型 | 文档 | message-interface |
| --- | --- | --- |
| `deepseek-v4.1-flash` | [deepseek-v4.1-flash](https://zenmux.ai/deepseek/deepseek-v4.1-flash) | `openai-compatible`, `openai-responses`, `anthropic` |
| `claude-sonnet-5` | [claude-sonnet-5](https://zenmux.ai/anthropic/claude-sonnet-5) | `anthropic` |
| `gpt-5.6-luna` | [gpt-5.6-luna](https://zenmux.ai/openai/gpt-5.6-luna) | `openai-responses`, `openai-compatible` |

## Zhipu

- Provider：`zhipu`
- API Key：`ZAI_API_KEY`

| 模型 | 文档 | message-interface |
| --- | --- | --- |
| `glm-5.3-flash` | [glm-5.3-flash](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash) | `openai-compatible` |

## Aliyun Dashscope

- Provider：`aliyun-dashscope`
- API Key：`DASHSCOPE_API_KEY`

| 模型 | 文档 | message-interface |
| --- | --- | --- |
| `qwen3.8-flash` | [OpenAI Chat Completions](https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)<br>[Anthropic Messages](https://docs.bailian.console.aliyun.com/zh/model-studio/anthropic-api-messages) | `openai-compatible`, `anthropic` |

## DeepSeek

- Provider：`deepseek`
- API Key：`DEEPSEEK_API_KEY`

官方模型与能力表见 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)。两个模型都支持三种请求格式：Chat Completions（`openai-compatible`）、Responses API（`openai-responses`）、Anthropic Messages（`anthropic`）。

| 模型 | 文档 | message-interface |
| --- | --- | --- |
| `deepseek-flash` | [Chat Completions](https://api-docs.deepseek.com/)<br>[Responses API](https://api-docs.deepseek.com/guides/responses_api)<br>[Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) | `openai-compatible`, `openai-responses`, `anthropic` |
| `deepseek-v4-pro` | [Chat Completions](https://api-docs.deepseek.com/)<br>[Responses API](https://api-docs.deepseek.com/guides/responses_api)<br>[Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api) | `openai-compatible`, `openai-responses`, `anthropic` |

## deepseek

- Provider:`deepseek`
