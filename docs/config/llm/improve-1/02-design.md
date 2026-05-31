# 02 · 单活动模型配置设计

> config/llm improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 设计原则

1. **单活动模型优先**
   - 当前只维护一组活动配置。
   - 不引入多 provider schema。
   - 为后续多 provider/multi model 保留字段和边界。

2. **配置读写归 config/llm**
   - `config/llm` 负责 `model.json` 和 `.env` 的读取、校验、写入。
   - 不负责 TUI 交互，不负责 slash command。

3. **模型领域语义归 services/llm-model**
   - `services/llm-model` 负责把 resolved config 投影为 active model summary。
   - `services/llm-model` 不直接写文件，不读取 API key。

4. **接口协议与 LLM provider 分离**
   - `provider` 表示 LLM provider/配置归属。
   - `apiConfig.interfaceProvider` 表示底层接口协议。
   - 当前默认 `openai-compatible`。

## 2. 数据模型

### 2.1 ModelJsonConfig

当前 schema 继续保持单活动模型：

```typescript
interface ModelJsonConfig {
  provider: string;
  defaultModel: string;
  apiConfig: {
    baseUrl: string;
    apiKeyEnv: string;
    interfaceProvider?: "openai-compatible" | "anthropic";
  };
  llmParams: {
    temperature: number;
    maxTokens: number;
    contextWindowTokens?: number;
  };
  models?: readonly ModelJsonModelProfile[];
}
```

兼容策略：

- 旧配置没有 `apiConfig.interfaceProvider` 时，读取时默认补为 `openai-compatible`。
- 写回单活动模型时，默认写入 `apiConfig.interfaceProvider: "openai-compatible"`。
- 如果未来要支持原生 Anthropic 接口，可显式写入 `anthropic`，但不是本批次目标。

### 2.2 LLMConfig

resolved config 增加非敏感字段：

```typescript
interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  apiKeyEnv: string;
  baseUrl: string;
  interfaceProvider: "openai-compatible" | "anthropic";
  temperature: number;
  maxTokens: number;
  contextWindowTokens?: number;
  modelProfiles?: readonly ModelJsonModelProfile[];
}
```

`apiKey` 仍然只在 config/core 内部使用，不进入 UI summary 和日志。

### 2.3 SetActiveLLMConfigInput

第一分支新增 public API：

```typescript
interface SetActiveLLMConfigInput {
  provider: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  apiKey?: string;
  interfaceProvider?: "openai-compatible" | "anthropic";
}
```

规则：

- `provider`、`model`、`baseUrl`、`apiKeyEnv` 必填。
- `interfaceProvider` 缺省为 `openai-compatible`。
- 如果传入 `apiKey`，写入目标 `.env` 并更新本次调用使用的 `env` 对象。
- 如果未传 `apiKey`，必须能从传入 `env` 或 `envPath` 读取到 `apiKeyEnv`。

### 2.4 SetActiveLLMConfigResult

```typescript
interface SetActiveLLMConfigResult {
  config: LLMConfig;
  modelJsonPath: string;
  envPath: string;
  wroteApiKey: boolean;
}
```

返回值不包含真实 API key。

## 3. 模块结构

建议文件：

```text
packages/ohbaby-agent/src/config/llm/
├── writer.ts              # 新增：写 model.json 和 .env
├── env-file.ts            # 可选：若 .env 读写逻辑较多，可拆出
├── loaders.ts             # 扩展：支持 modelJsonPath/envPath/env 注入
├── manager.ts             # 扩展：setActive + cache key 修正
├── types.ts               # 扩展：新类型
├── validation.ts          # 扩展：interfaceProvider/env name 校验
└── index.ts               # 导出 setActiveLLMConfig
```

如果 `.env` 读写代码不复杂，可以先放在 `writer.ts`，避免过度拆分。

## 4. 公开接口

```typescript
async function getLLMConfig(options?: LLMConfigLoadOptions): Promise<LLMConfig>;
async function reloadLLMConfig(options?: LLMConfigLoadOptions): Promise<LLMConfig>;
async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
  options?: SetActiveLLMConfigOptions,
): Promise<SetActiveLLMConfigResult>;
```

Load options：

```typescript
interface LLMConfigLoadOptions {
  projectDirectory?: string;
  modelJsonPath?: string;
  envPath?: string;
  env?: NodeJS.ProcessEnv;
}
```

Write options：

```typescript
interface SetActiveLLMConfigOptions {
  projectDirectory?: string;
  modelJsonPath?: string;
  envPath?: string;
  env?: NodeJS.ProcessEnv;
}
```

## 5. 读取流程

```text
getLLMConfig(options)
  ↓
resolve modelJsonPath
  ↓
loadModelJson({ modelJsonPath })
  ↓
validateModelJson()
  ↓
resolve interfaceProvider (default openai-compatible)
  ↓
loadApiKey(apiKeyEnv, { env, envPath })
  ├─ process/custom env
  └─ envPath .env fallback
  ↓
validateApiKey()
  ↓
build LLMConfig
  ↓
cache by modelJsonPath + envPath + projectDirectory
```

如果传入自定义 `env` 对象，建议不缓存，避免测试或多项目场景污染。

## 6. 写入流程

```text
setActiveLLMConfig(input, options)
  ↓
validate input
  ↓
load current model.json
  ↓
validate current model.json
  ↓
resolve apiKey
      ├─ input.apiKey
      ├─ options.env[input.apiKeyEnv]
      └─ envPath .env
  ↓
if input.apiKey exists:
      write/update envPath key
      update options.env or process.env
  ↓
write model.json atomically
  ↓
reload LLMConfig from same paths
  ↓
return SetActiveLLMConfigResult
```

## 7. `.env` 写入规则

第一阶段只支持简单 dotenv 文件：

```dotenv
OPENAI_API_KEY="sk-..."
DEEPSEEK_API_KEY="sk-..."
```

写入要求：

- 保留无关行。
- 更新同名 key 时替换旧值。
- 新 key 追加到文件末尾。
- API key 用双引号包裹。
- 转义 `\`、`"`、`\r`、`\n`。
- 文件不存在时创建。
- 不打印 key，不把 key 放入错误对象 context。

## 8. 原子写入

`model.json` 和 `.env` 写入都使用临时文件 + rename：

```text
target.tmp
  ↓ write
  ↓ rename
target
```

Windows 下 rename 覆盖行为需要测试确认；如果遇到平台差异，可先删除目标文件再 rename，但必须保证目标路径已解析且位于预期配置目录或测试临时目录。

## 9. 与 core/llm-client 的关系

`core/llm-client` 仍只负责：

- 调用 `getLLMConfig()`。
- 创建底层 interface provider。
- 返回不包含真实 API key 的 `LLMClientInstance.config`。

需要新增透传：

```typescript
config: {
  provider,
  model,
  baseUrl,
  apiKeyEnv,
  interfaceProvider,
  temperature,
  maxTokens,
}
```

真实 `apiKey` 不进入 `LLMClientInstance.config`。

## 10. 与 services/interface-providers 的关系

当前源码目录为 `services/interface-providers`，语义上是 interface provider adapter。

第一分支建议最小调整：

```typescript
interface CreateInterfaceProviderOptions {
  provider: string;
  apiKey: string;
  baseUrl: string;
  interfaceProvider?: "openai-compatible" | "anthropic";
}
```

`createInterfaceProvider()` 优先使用 `interfaceProvider`，缺省为 `openai-compatible`。这符合当前统一使用 OpenAI-compatible 接口的方向。

不在第一分支重命名目录。

## 11. 向多 provider 扩展的路径

未来多 provider schema 可以从当前单活动字段演进：

```json
{
  "active": {
    "provider": "deepseek",
    "model": "deepseek-chat"
  },
  "providers": {
    "deepseek": {
      "apiConfig": {
        "interfaceProvider": "openai-compatible",
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKeyEnv": "DEEPSEEK_API_KEY"
      },
      "models": ["deepseek-chat"]
    }
  }
}
```

第一分支不实现这个 schema，但新增的 `interfaceProvider` 和 active summary 语义应避免阻碍该方向。

