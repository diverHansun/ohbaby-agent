# 05 — Context Window 同步

## 1. 当前数据流

```text
model.json
  llmParams.contextWindowTokens
  llmParams.maxTokens
  models[]
    -> config/llm/manager.ts
    -> LLMConfig.contextWindowTokens / modelProfiles
    -> ui-runtime/composition.ts
    -> HeuristicTokenCounter
    -> context-manager getContextUsage()
    -> TUI context window usage
```

`contextWindowTokens` 是后端 compact 预算和前端占用率分母。模型切换后如果该值错误，用户会看到错误百分比，后端也可能过早 compact。

## 2. 已发现问题

### 2.1 代理 provider 阻断内置 profile

当前 `findBuiltinProfile()` 同时要求 provider 和 model prefix 匹配。代理场景下：

```text
provider = zenmux
model    = anthropic/claude-sonnet-4.6
```

Claude 内置规则 provider 是 `anthropic`，因此会 fallback 到 128K，而不是 Claude 的 200K。

### 2.2 Namespace 模型名无法命中

`anthropic/claude-sonnet-4.6` 不会 `startsWith("claude-")`，`openai/gpt-4o` 不会 `startsWith("gpt-4o")`。这会影响 OpenRouter、Zenmux 等常见代理模型名。

### 2.3 writer 会保留旧 active context window

`setActiveLLMConfig()` 当前未传 `contextWindowTokens` 时会保留旧值。用户从 A 模型切到 B 模型，如果 B 未解析到窗口大小，就可能继续沿用 A 的分母。

## 3. 目标行为

ConnectPanel 中：

- `Context window` 默认空
- `Max output tokens` 默认空
- 用户可手动填写正整数
- 用户值优先

后端保存时：

1. 用 `model + provider + interfaceProvider` 解析 profile。
2. 解析应支持代理 provider 和 namespace 模型名。
3. 用户填写 context/max output 时，用用户值覆盖 resolver。
4. resolver 命中时写入 active context window 和当前模型 `models[]` profile。
5. resolver 未命中且用户留空时，不沿用旧 `contextWindowTokens`。
6. `llmParams.maxTokens` 跟随最终 `maxOutputTokens`；没有最终 max output 时不强行猜。

## 4. Profile Resolver 调整

推荐规则：

- 先匹配用户 `models[]` profile。
- 再匹配内置规则。
- 内置匹配时，把模型名拆成候选：
  - 原始模型名：`anthropic/claude-sonnet-4.6`
  - namespace 后缀：`claude-sonnet-4.6`
  - 可能的 provider hint：`anthropic`
- provider 为未知/代理 provider 时，不阻断模型名前缀命中。
- provider 为明确官方 provider 时，仍优先匹配同 provider 规则。

示例：

| Provider | Model | 期望 |
|----------|-------|------|
| `zenmux` | `anthropic/claude-sonnet-4.6` | Claude 200K |
| `zenmux` | `claude-sonnet-4.6` | Claude 200K |
| `openrouter` | `openai/gpt-4o` | GPT-4o 128K |
| `openai` | `gpt-4.1` | GPT-4.1 1M |
| `custom` | `unknown-model` | fallback，仅用于运行时计算，不自动写旧值 |

## 5. 写入策略

解析成功或用户显式填写时：

```json
{
  "llmParams": {
    "temperature": 0,
    "maxTokens": 8192,
    "contextWindowTokens": 200000
  },
  "models": [
    {
      "provider": "zenmux",
      "model": "anthropic/claude-sonnet-4.6",
      "contextWindowTokens": 200000,
      "maxOutputTokens": 8192
    }
  ]
}
```

说明：

- `llmParams.contextWindowTokens` 是 active model 的即时 override，方便现有 runtime 默认值使用。
- `models[]` 是 per-model profile，防止未来切换历史把一个全局分母套到另一个模型上。
- `llmParams.maxTokens` 跟随最终 `maxOutputTokens`。
- 重复保存同一 `provider + model` 时更新旧 profile，不重复插入。

解析失败且用户留空时：

- 不写新的 `llmParams.contextWindowTokens`
- 清理旧 active context override
- 不新增当前模型 profile
- runtime 可继续使用 resolver fallback 做临时预算，但配置文件不把 fallback 当成事实保存

## 6. 受影响文件

完整文件变更清单见 `02-implementation-plan.md` Section 2。本节只列出 context window 同步特有的改动细节。

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts` | 支持代理 provider 和 namespace 模型名 |
| `packages/ohbaby-agent/src/config/llm/writer.ts` | 写入/更新 `models[]`；支持清理旧 active context |
| `packages/ohbaby-agent/src/config/llm/types.ts` | 如需要，扩展 writer input |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | connect save 时传入最终 profile 信息 |
| `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx` | context/max output 字段默认空 |

## 7. 验收标准

```text
□ provider=zenmux + model=anthropic/claude-sonnet-4.6 命中 200K
□ provider=openrouter + model=openai/gpt-4o 命中 128K
□ 用户手动 context window 覆盖 resolver
□ 用户手动 max output tokens 覆盖 resolver
□ llmParams.maxTokens 跟随最终 maxOutputTokens
□ 未识别模型不沿用旧 contextWindowTokens
□ /status context window 分母正确
□ compact 预算使用新模型窗口
```
