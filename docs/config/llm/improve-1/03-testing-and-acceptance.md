# 03 · 单活动模型配置测试与验收

> config/llm improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 测试层级

第一分支需要覆盖：

- 单元测试：纯函数、验证、dotenv 读写、writer 行为。
- 集成测试：临时 `model.json + .env`、manager cache/reload、`createLLMClient` 消费 resolved config。
- e2e 测试：使用 `.env` 中真实 API key，对 OpenAI-compatible 接口发起最小请求。

## 2. 单元测试

### 2.1 validation

覆盖：

- `apiConfig.interfaceProvider` 缺省时为 `openai-compatible`。
- 允许 `openai-compatible`。
- 暂时允许但不默认使用 `anthropic`。
- 拒绝空字符串或未知 interface provider。
- 拒绝非法 `apiKeyEnv`，例如 `1_BAD`、`BAD-NAME`、空字符串。

### 2.2 env file

覆盖：

- `.env` 文件不存在时读取为空。
- 可读取 `KEY=value`。
- 可读取 `KEY="quoted value"`。
- 写入新 key。
- 更新已有 key。
- 保留无关行和注释。
- 正确转义双引号、反斜杠和换行。
- 不在错误 context 中包含 key value。

### 2.3 writer

覆盖：

- 写回 `provider/defaultModel/apiConfig.baseUrl/apiConfig.apiKeyEnv/apiConfig.interfaceProvider`。
- 显式 `apiKey` 写入 `.env` 并更新传入 `env` 对象。
- 未传 `apiKey` 时从传入 `env` 读取。
- 未传 `apiKey` 且 `env` 缺失时从 `envPath` 读取。
- 缺少 API key 时抛 `MISSING_API_KEY`。
- 空 API key 抛 `EMPTY_API_KEY`。
- 无效 model.json 不被覆盖。
- 写入后 reload 返回新 `LLMConfig`。

## 3. 集成测试

### 3.1 manager 集成

使用临时目录：

```text
temp-home/
└── .ohbaby/
    ├── model.json
    └── .env
```

覆盖：

- `getLLMConfig({ modelJsonPath, envPath })` 能从 `.env` fallback 读取 API key。
- `setActiveLLMConfig()` 写入后，`getLLMConfig()` 返回新 provider/model/baseUrl/apiKeyEnv/interfaceProvider。
- cache key 包含 `modelJsonPath` 和 `envPath`，不同测试路径不互相污染。
- 自定义 `env` 对象加载不污染 `process.env`。

### 3.2 core/llm-client 集成

覆盖：

- `createLLMClient({ projectDirectory })` 消费新增字段。
- `LLMClientInstance.config` 包含 `apiKeyEnv` 和 `interfaceProvider`。
- `LLMClientInstance.config` 不包含真实 `apiKey`。
- `createInterfaceProvider()` 收到 `interfaceProvider: "openai-compatible"`。

## 4. e2e 测试

e2e 使用 `.env` 中真实 API key，但必须安全：

- 测试默认跳过，需显式环境变量启用，例如 `OHBABY_LLM_E2E=1`。
- 不打印 API key。
- 不把 API key 写入测试快照。
- 测试只报告 env var 名称和接口结果。
- 请求内容使用最小 prompt，例如 `"Reply with ok."`。

建议 e2e 输入：

```dotenv
OHBABY_LLM_E2E=1
OHBABY_E2E_BASE_URL=https://...
OHBABY_E2E_API_KEY=...
OHBABY_E2E_MODEL=...
OHBABY_E2E_PROVIDER=custom
```

测试流程：

```text
load runtime .env
  ↓
create temp model.json
  ↓
getLLMConfig({ modelJsonPath, envPath, env: process.env })
  ↓
createLLMClient()
  ↓
streamChatCompletion("Reply with ok.")
  ↓
assert response has text or valid finish reason
```

验收标准：

- e2e 只走 OpenAI-compatible 接口。
- `baseUrl` 和 `model` 来自 `.env`。
- API key 不出现在 stdout/stderr。

## 5. 推荐验证命令

Focused:

```powershell
pnpm vitest run packages/ohbaby-agent/src/config/llm/__tests__/loaders.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts packages/ohbaby-agent/src/config/llm/__tests__/integration.test.ts packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts
```

Services:

```powershell
pnpm vitest run packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts packages/ohbaby-agent/src/services/interface-providers/openai-compatible.test.ts
```

Full checks:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run build
```

E2E:

```powershell
$env:OHBABY_LLM_E2E='1'
pnpm vitest run packages/ohbaby-agent/src/config/llm/__tests__/llm-config.e2e.test.ts
```

## 6. 验收清单

- [ ] `LLMConfig` 暴露 `apiKeyEnv`，但不泄露 `apiKey`。
- [ ] `LLMConfig` 暴露 `interfaceProvider`，默认 `openai-compatible`。
- [ ] `setActiveLLMConfig()` 能写回单活动模型配置。
- [ ] 显式 API key 能写入 `.env`。
- [ ] 未显式 API key 时能从 `env` 或 `envPath` 读取。
- [ ] 写入使用 atomic write。
- [ ] 测试不污染真实 `~/.ohbaby/model.json`。
- [ ] e2e 使用真实 `.env` key 时不打印 key。

