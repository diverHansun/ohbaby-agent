# 01 · llm-model 单活动模型领域语义问题分析

> services/llm-model improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 当前模块定位

`services/llm-model` 当前源码：

```text
packages/ohbaby-agent/src/services/llm-model/
├── index.ts
├── modelProfiles.ts
├── modelProfiles.unit.test.ts
├── tokenCounting.ts
└── tokenCounting.unit.test.ts
```

它已经不是占位模块，而是模型元数据与 token 估算服务层：

- `modelProfiles.ts`：模型 profile 注册表、context window、max output tokens、token budget。
- `tokenCounting.ts`：启发式文本 token 估算器，提供可注入 `core/context` 的 `TokenCounter`。

## 2. 当前职责边界

当前 `services/llm-model` 做得比较清楚：

- 不读取 `config/llm`。
- 不创建 provider。
- 不调用网络。
- 不写配置文件。
- 不管理会话。

它是本地模型辅助能力，适合继续承载模型领域语义。

## 3. 新需求

第一分支要做单活动模型配置基础能力。`config/llm` 可以返回 resolved `LLMConfig`，但后续 `/models`、TUI 和 commands 需要更适合 UI/业务层消费的模型摘要，例如：

- 当前 provider。
- 当前 model name。
- 当前 baseUrl。
- 当前 apiKeyEnv。
- 当前 interfaceProvider。
- 当前模型 profile 和 token budget 信息。
- 可读取到的 user model profiles。

这些不应该散落在 commands 或 TUI 中拼装。更适合放到 `services/llm-model`。

## 4. Provider 概念混淆

当前项目里有两个“provider”概念：

1. LLM provider：用户理解的模型来源或配置归属，如 `openai`、`deepseek`、`zhipu`。
2. Interface provider：底层接口协议，如 `openai-compatible`、`anthropic`。

当前 `services/interface-providers` 实际上是 interface provider adapter。它不是模型配置中心。

因此 `services/llm-model` improve-1 需要用清晰命名表达：

- `provider`：LLM provider id。
- `interfaceProvider`：底层接口协议。
- `model`：provider 的模型名称。
- `modelIdentity`：用于当前单活动模型展示的稳定标识。

## 5. 为什么不把 active summary 放在 config/llm

`config/llm` 的职责是配置读写和校验。它应该返回通用的 `LLMConfig`，但不应该承担 UI 展示、模型 identity、profile 匹配、token budget 这些领域语义。

`services/llm-model` 更适合做：

- 把 `LLMConfig` 转成 `ActiveModelSummary`。
- 根据 `LLMConfig.modelProfiles` 生成可展示 profile 列表。
- 复用 `createModelProfileRegistry()` 解析当前模型能力。

## 6. 非目标

第一分支中 `services/llm-model` 不做：

- 配置写入。
- API key 读取或写入。
- provider SDK 调用。
- 模型列表远程拉取。
- 多 provider CRUD。
- TUI 交互。
- commands catalog。

## 7. 风险

### 7.1 过早引入多模型中心

当前只需要单活动模型 summary。不要提前实现 provider-centric schema 或 CRUD。

### 7.2 把真实 API key 泄露到 UI

`ActiveModelSummary` 只能包含 `apiKeyEnv`，不能包含 `apiKey`。

### 7.3 identity 误用

当前 summary id 可以用 `provider:model`，但这不是未来多 provider 场景的最终唯一 ID。未来同 provider 不同 baseUrl 时，需要更强 identity。

第一分支应把它标注为 current-only display id，不作为长期持久 profile id。

