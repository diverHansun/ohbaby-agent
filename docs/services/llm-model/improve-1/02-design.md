# 02 · 单活动模型领域服务设计

> services/llm-model improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 设计目标

在不引入多 provider 配置中心的前提下，为当前单活动模型提供一个稳定领域投影：

- 从 `LLMConfig` 生成 `ActiveModelSummary`。
- 展示当前模型的非敏感连接信息。
- 展示当前模型匹配到的 model profile。
- 为后续 `/models` command 和 TUI 提供统一数据形态。

## 2. 建议新增文件

```text
packages/ohbaby-agent/src/services/llm-model/
├── activeModel.ts
├── activeModel.unit.test.ts
├── modelProfiles.ts
└── tokenCounting.ts
```

`activeModel.ts` 是纯领域投影，不读写文件。

## 3. 数据模型

### ActiveModelSummary

```typescript
interface ActiveModelSummary {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly interfaceProvider: "openai-compatible" | "anthropic";
  readonly profile?: ModelProfile;
}
```

说明：

- `id` 第一阶段使用 `${provider}:${model}` 小写形式。
- `id` 只用于当前展示和交互，不作为未来多 provider 持久 ID。
- 不包含真实 API key。

### ActiveModelProfileList

```typescript
interface ActiveModelProfileList {
  readonly current: ActiveModelSummary;
  readonly profiles: readonly ActiveModelSummary[];
}
```

`profiles` 从 `LLMConfig.modelProfiles` 派生。如果没有配置 profiles，则至少返回当前模型。

## 4. 公共函数

### summarizeActiveModel()

```typescript
function summarizeActiveModel(config: LLMConfig): ActiveModelSummary
```

职责：

- 生成当前活动模型 summary。
- 使用 `createModelProfileRegistry()` 匹配 profile。
- `label` 优先取 profile label，否则取 model。
- 不读取 env，不访问 API。

### listConfiguredModelSummaries()

```typescript
function listConfiguredModelSummaries(config: LLMConfig): ActiveModelProfileList
```

职责：

- 生成当前模型 summary。
- 将 `config.modelProfiles` 转成 summary 列表。
- 合并当前模型，去重。
- 标记 current。

可以扩展 `ActiveModelSummary`：

```typescript
readonly active?: boolean;
readonly source?: "current" | "user-profile" | "builtin" | "fallback";
```

## 5. 与 config/llm 的关系

```text
config/llm
  -> LLMConfig
  -> services/llm-model.summarizeActiveModel()
  -> ActiveModelSummary
```

`services/llm-model` 不知道 `model.json` 在哪里，也不知道 `.env` 在哪里。

## 6. 与 services/interface-providers 的关系

`services/interface-providers` 当前是 interface provider adapter。第一分支重命名目录为 `services/interface-providers`，新增文档统一称为 interface provider。

关系如下：

```text
LLM provider id
  example: deepseek

interfaceProvider
  example: openai-compatible

services/interface-providers
  creates OpenAI-compatible client
```

`services/llm-model` 可以把 `interfaceProvider` 放进 summary，但不调用 `createInterfaceProvider()`。

## 7. 与 commands/TUI 的关系

第二分支 commands 可直接消费：

```typescript
const current = summarizeActiveModel(config);
const list = listConfiguredModelSummaries(config);
```

输出给 `/models`：

```json
{
  "current": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "interfaceProvider": "openai-compatible"
  },
  "models": [...]
}
```

不输出 API key。

## 8. 未来多 provider 扩展

未来多 provider schema 中，`ActiveModelSummary` 可以继续作为当前活动模型投影；新增的 provider/model CRUD 可返回更丰富的 `ConfiguredProviderSummary`：

```typescript
interface ConfiguredProviderSummary {
  id: string;
  label: string;
  interfaceProvider: "openai-compatible" | "anthropic";
  baseUrl: string;
  apiKeyEnv: string;
  models: readonly ConfiguredModelSummary[];
}
```

第一分支不实现该类型。

## 9. 命名建议

本分支命名结果：

- `services/providers` → `services/interface-providers`
- `ProviderKind` → `InterfaceProviderKind`
- `CreateInterfaceProviderOptions.interfaceProvider` 显式选择底层协议

第一分支完成目录重命名，避免后续 `services/` 下的多厂商 LLM provider 管理模块与接口协议适配层重名。
