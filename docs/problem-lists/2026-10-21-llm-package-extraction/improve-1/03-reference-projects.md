# 3. 参考项目借鉴

> 2026-10-21 由子代理阅读 `/Users/hansun025/Projects/code-cli/` 下的本地仓库，主代理汇总。只记录与 LLM 包相关的部分。

## 3.1 借鉴来源

| 项目 | 本地路径 | LLM 包 |
|---|---|---|
| pi | `code-cli/pi` | `pi-ai`（“Unified LLM API”） |
| opencode | `code-cli/opencode` | `packages/ai` |
| claude-code | `code-cli/claude-code` | `packages/@ant/model-provider` |
| dsh（deepseek-harness） | `code-cli/deepseek-harness` | `packages/llm/llm`（`dsh-llm`）及 `llm-*` 适配器包 |
| kimi-code | `code-cli/kimi-code` | `packages/kosong` |
| ZCode | `code-cli/ZCode` | 没有独立的 LLM 客户端包；调用放在 `apps/zcode-cli/packages/adapters/src/model` |

## 3.2 各项目的做法

| 项目 | 依赖什么 | 内容 | 核心是否使用 |
|---|---|---|---|
| pi `pi-ai` | 只依赖 telemetry | 统一的模型调用接口 | 是，`pi-agent-core` 依赖它 |
| opencode `ai` | 只依赖 `schema` | providers、协议、tool runtime，以及多媒体客户端 | 是 |
| claude-code `@ant/model-provider` | 只依赖 `@anthropic-ai/sdk`、`openai` | `providers/`（openai、gemini、grok）、`shared/`（消息、工具、流转换）、`types/`；通过 `registerHooks`、`registerClientFactories` 让应用注入鉴权和统计 | 是，`src` 下 21 个文件引用 |
| dsh `dsh-llm` | util、timeout、schema 等基础包，不依赖 agent | 消息、内容、流、重试策略、错误、API key；适配器 `llm-deepseek`、`llm-pi-ai` 是单独的包 | 是，session、system-prompt、agent 都依赖它 |
| kimi-code `kosong` | 无内部依赖 | provider、生成、消息、工具、用量、能力目录 | **否**。核心 `agent-core-v2` 自己有一份 `src/llm-adapter/`，只有 `node-sdk` 用 `kosong` |
| ZCode | — | 模型调用在 `adapters` 中，核心通过 `contracts` 接口反转依赖 | — |

## 3.3 可借鉴点

| 借鉴点 | 来源 | 取舍 | 说明 |
|---|---|---|---|
| LLM 包不依赖 agent 核心，核心依赖它 | pi、opencode、claude-code、dsh | 采用 | 02 的整体方向 |
| 应用通过注入提供鉴权、统计等能力 | claude-code 的 `registerHooks` | 简化采用 | 我们只有一个 token 用量回调，直接作为构造函数选项，不建注册机制 |
| provider 放在子目录 | opencode、claude-code | 采用 | `src/providers/` |
| 核心必须真正使用抽出的包，不留副本 | kimi-code 的反面教训 | 采用 | 00 §2、02 Stage 2 第 6 步 |
| 每个 provider 单独成包 | dsh | 不采用 | 只有三种协议，见 02 §2.8 |
| LLM 包依赖一个共享 schema 包 | opencode | 不采用 | 我们的 sdk 是前后端 UI 契约，LLM 层不应依赖它；见 00 §2 |
| 不建 LLM 包，用接口反转 | ZCode | 不采用 | 用户的目标是可复用的独立包 |

## 3.4 对 02 的影响

- `ohbaby-llm` 不依赖任何 workspace 包（02 Stage 2 完成定义）来自 3.2 中 pi、claude-code 的做法。
- 日志通过回调注入（02 §2.2）是 claude-code 做法的简化版。
- “agent 内部全部改为从 `ohbaby-llm` 引入、不留副本”来自 kimi-code 的反面教训。
