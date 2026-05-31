# 01 · 单活动模型配置基础能力问题分析

> config/llm improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 背景

当前 `config/llm` 已经能读取 `~/.ohbaby-agent/model.json`，解析出一个可供 `core/llm-client` 使用的 `LLMConfig`。但它仍然是只读配置模块：

- 用户需要手工编辑 `model.json`。
- 模块没有写回默认模型、baseUrl、apiKeyEnv 或 API key 的能力。
- 当前配置是单活动模型：同一时刻只有一组 provider/baseUrl/apiKey/model 生效。
- 后续 `/models` TUI 入口需要能切换这组单活动模型配置。

用户确认：当前先保持单模型，不做多 provider 配置中心，不做 provider/model CRUD；但第一分支需要为后续 `/models` TUI 接入准备单活动模型配置基础能力。

## 2. 当前代码状态

源码位于：

```text
packages/ohbaby-agent/src/config/llm/
├── index.ts
├── loaders.ts
├── manager.ts
├── types.ts
└── validation.ts
```

当前能力：

- `loadModelJson()` 固定读取 `~/.ohbaby-agent/model.json`。
- `loadApiKey()` 只从 `process.env` 读取。
- `LLMConfigManager` 按 `projectDirectory` 做缓存。
- `reloadLLMConfig()` 可清缓存并重读。
- `modelProfiles` 会从 `llmParams.contextWindowTokens` 和 `models` 字段合并到 `LLMConfig.modelProfiles`。

当前不足：

- 缺少 `modelJsonPath` / `envPath` / `env` 注入点，测试和运行时很难隔离。
- 缺少写回 `model.json` 的 public API。
- 缺少写入 `.env` 的 API key 持久化能力。
- `LLMConfig` 没有暴露 `apiKeyEnv`，上层无法展示“当前 key 来自哪个 env var”。
- 当前 provider 字段同时承担“LLM 提供商”和“底层接口选择”两层语义，后续跨厂商但 OpenAI-compatible 接口切换会混淆。

## 3. Provider 命名问题

当前 `services/interface-providers` 命名容易误导。它并不是“LLM 厂商 provider 管理中心”，更准确地说是 **interface provider** 或 **API interface adapter**：

- `openai-compatible`：使用 OpenAI SDK 的 Chat Completions 兼容接口。
- `anthropic`：使用 Anthropic Messages 接口。

用户确认：当前 ohbaby 的模型切换先统一走 OpenAI-compatible 接口。无论底层模型来自哪个 LLM provider，只要配置了对应 `baseUrl` 和 API key，就通过 OpenAI-compatible 接口访问。

因此 improve-1 中需要区分：

| 概念 | 含义 | 示例 |
| --- | --- | --- |
| `provider` | 用户/模型配置层面的 LLM provider 标识 | `openai`, `deepseek`, `zhipu`, `openrouter`, `custom` |
| `apiConfig.interfaceProvider` | 底层调用接口协议 | `openai-compatible`, `anthropic` |
| `baseUrl` | 该接口协议的服务地址 | `https://api.deepseek.com/v1` |
| `apiKeyEnv` | API key 所在环境变量名 | `DEEPSEEK_API_KEY` |

第一分支完成源码目录重命名：`services/providers` 迁移为 `services/interface-providers`，并统一使用 `interfaceProvider` 概念。

## 4. 为什么不放在 commands 分支

单活动模型配置涉及：

- 配置文件读写。
- `.env` 写入。
- API key 解析。
- LLM client reload。
- 真实 API e2e 验证。

这些属于后端基础能力，不是 slash command 解析本身。若放进 commands 分支，会把 SDK resolver、catalog、TUI command runtime、配置写入混在一起，风险过大。

因此第一分支先做配置基础能力；第二分支 commands 只消费它。

## 5. 目标

第一分支需要完成：

- 保持单活动模型 schema，不引入 provider-centric 多模型配置中心。
- 增加单活动模型配置写回 API。
- 支持写回 `provider`、`defaultModel`、`apiConfig.baseUrl`、`apiConfig.apiKeyEnv`。
- 支持显式提供 API key 时写入 `envPath` 指定的 `.env`；未提供 `envPath` 时默认写入当前项目 `.env`。
- 支持加载时优先读 `process.env`，缺失时按 `envPath` 读取 `.env`。
- 在 resolved `LLMConfig` 中暴露非敏感字段 `apiKeyEnv` 和 `interfaceProvider`。
- 不在任何输出或日志中暴露真实 API key。

## 6. 非目标

第一分支不做：

- `/models` slash command。
- TUI 表单。
- CLI 迁移。
- 多 provider schema。
- provider/model CRUD。
- 数据库或 keychain secret store。
- 原生 Anthropic 接口策略扩展。

## 7. 风险

### 7.1 `.env` 写入与读取不一致

如果只写 `.env`，但加载时仍只读 `process.env`，重启后会找不到 API key。改进方案必须让 loader 支持 `envPath` fallback。

### 7.2 provider 字段误用

如果继续用 `provider === "anthropic"` 推断 Anthropic 原生接口，那么用户通过 OpenAI-compatible 网关配置 `provider: "anthropic"` 时会走错 adapter。

第一分支建议新增显式 `apiConfig.interfaceProvider`，默认写入 `openai-compatible`。底层接口选择以后看 `interfaceProvider`，不再只靠 LLM provider 名称推断。

### 7.3 测试污染真实用户配置

写入测试必须使用临时 `modelJsonPath`、`envPath` 和隔离的 `env` 对象。真实 e2e 只能读取 `.env` 中的 key，不允许改写真实配置文件。
