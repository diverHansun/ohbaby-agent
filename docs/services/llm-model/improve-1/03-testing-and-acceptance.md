# 03 · llm-model 单活动模型测试与验收

> services/llm-model improve-1  
> 日期: 2026-05-31  
> 范围: 第一分支 `codex/llm-single-active-config`

## 1. 单元测试

新增测试文件：

```text
packages/ohbaby-agent/src/services/llm-model/activeModel.unit.test.ts
```

## 2. 测试场景

### 2.1 当前模型 summary

输入：

```typescript
const config = {
  provider: "deepseek",
  model: "deepseek-chat",
  baseUrl: "https://api.deepseek.com/v1",
  apiKeyEnv: "DEEPSEEK_API_KEY",
  interfaceProvider: "openai-compatible",
  temperature: 0.7,
  maxTokens: 4096,
  apiKey: "hidden",
};
```

期望：

- `provider` 是 `deepseek`。
- `model` 是 `deepseek-chat`。
- `baseUrl` 被保留。
- `apiKeyEnv` 被保留。
- `interfaceProvider` 是 `openai-compatible`。
- 不包含 `apiKey`。

### 2.2 匹配 user model profile

输入 config 包含：

```typescript
modelProfiles: [
  {
    provider: "deepseek",
    model: "deepseek-chat",
    label: "DeepSeek Chat",
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_192
  }
]
```

期望：

- summary label 为 `DeepSeek Chat`。
- profile source 为 `user`。
- profile contextWindowTokens 为 `64_000`。

### 2.3 没有 modelProfiles 时使用 fallback/builtin

输入未知模型：

```typescript
provider: "custom",
model: "custom-chat"
```

期望：

- summary 存在。
- profile source 为 `fallback`。
- 不抛错。

### 2.4 不泄露 API key

断言：

```typescript
expect(JSON.stringify(summary)).not.toContain("sk-");
expect("apiKey" in summary).toBe(false);
```

### 2.5 列出配置 profiles

`listConfiguredModelSummaries(config)` 应：

- 至少包含 current。
- 包含 user profiles。
- 对 current 和 profile 重复项去重。
- current 项标记 `active: true`。

## 3. 现有测试保持

继续跑：

```powershell
pnpm vitest run packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts
```

这些测试确保 improve-1 没有破坏已有 token budget 和启发式估算。

## 4. 与 config 集成测试

在 config 集成测试中增加：

```text
temp model.json + temp .env
  -> getLLMConfig()
  -> summarizeActiveModel(config)
  -> assert summary
```

验证 config 和 llm-model 之间的数据形态一致。

## 5. 验收清单

- [ ] `summarizeActiveModel()` 是纯函数，不读写文件。
- [ ] `listConfiguredModelSummaries()` 至少返回当前模型。
- [ ] summary 包含 `provider/model/baseUrl/apiKeyEnv/interfaceProvider`。
- [ ] summary 不包含真实 API key。
- [ ] user model profile label/context 被正确匹配。
- [ ] unknown model 使用 fallback profile。
- [ ] 现有 `modelProfiles` 和 `tokenCounting` 测试继续通过。

