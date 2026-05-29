# tokenCounting 模块的数据流与接口设计

## 上下文与范围

tokenCounting 位于本地模型辅助层。它接收调用方传入的文本与模型标识，返回估算 token、模型 context 限额与输入/输出预算。

它不参与以下流程：

- 不读取配置。
- 不调用 provider。
- 不消费或生成真实 `TokenUsage`。
- 不修改消息历史。
- 不做对话级估算、使用率计算或 warning 分级（这些由 `core/context` 负责）。

## 数据流

### 文本 token 估算

```text
text
  -> 逐字符按 ASCII / 非 ASCII 加权累加
  -> Math.ceil()
  -> estimated token count
```

### 模型限额与预算解析

```text
modelId (+ options)
  -> modelProfiles 注册表 resolve / calculateBudget
  -> contextWindowTokens (getLimit)
  -> TokenBudget (getBudget)
```

### 与 context 注入关系

```text
createHeuristicTokenCounter(options?)
  -> HeuristicTokenCounter { estimateTokens, getBudget, getLimit }
  -> 注入 core/context 的 TokenCounter 端口
```

`core/context` 决定如何使用估算值，例如是否触发压缩；对话历史的 token 估算（含对真实 `TokenUsage` 锚点的复用）由 `core/context/token-estimation.ts` 负责，tokenCounting 只提供文本级原语与模型限额/预算。

## 公共接口

```typescript
function estimateTokensForText(text: string): number;
```

估算一段文本的 token 数。空字符串返回 `0`，非字符串抛出 `TypeError`。

```typescript
function createHeuristicTokenCounter(
  options?: HeuristicTokenCounterOptions,
): HeuristicTokenCounter;
```

创建可注入 `core/context` 的默认估算器。返回对象提供：

- `estimateTokens(content)`：文本 token 估算原语。
- `getLimit(modelId)`：解析模型 context 窗口（委托 `modelProfiles`）。
- `getBudget(modelId, options?)`：计算输入/输出预算（委托 `modelProfiles`）。

## 数据归属

| 数据 | 创建者 | 归属 | tokenCounting 职责 |
| --- | --- | --- | --- |
| 文本 | 调用方 | 调用方 | 只读估算 |
| 模型标识 | 调用方 | 调用方 | 委托 modelProfiles 解析限额/预算 |
| 估算 token | tokenCounting | 调用方消费 | 返回数值，不缓存 |
| 模型 profile / 预算 | modelProfiles | modelProfiles | 透传，不复制定义 |
| 真实 `TokenUsage` | provider | llm-client/上层 | 不参与 |
