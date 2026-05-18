# tokenCounting 模块的数据流与接口设计

## 上下文与范围

tokenCounting 位于本地模型辅助层。它接收调用方传入的文本、`TokenCountMessage[]` 和模型标识，返回估算 token、上下文使用率与 warning 信息。

它不参与以下流程：

- 不读取配置。
- 不调用 provider。
- 不消费或生成真实 `TokenUsage`。
- 不修改消息历史。

## 数据流

### 文本 token 估算

```text
text
  -> 字符权重累加
  -> Math.ceil()
  -> estimated token count
```

### 消息历史 token 估算

```text
TokenCountMessage[]
  -> 逐条消息估算文本与角色开销
  -> 加 conversation overhead
  -> messagesTokens
```

### 上下文使用率计算

```text
messagesTokens + estimatedResponseTokens + model token limit
  -> totalUsedTokens
  -> remainingTokens
  -> percentUsed / hasWarning
```

### 与 context 注入关系

```text
createHeuristicTokenCounter()
  -> TokenCounter { estimateTokens, getLimit }
  -> core/context
```

`core/context` 决定如何使用估算值，例如是否触发压缩；tokenCounting 不直接执行业务策略。

## 公共接口

```typescript
function estimateTokensForText(text: string): number;
```

估算一段文本的 token 数。

```typescript
function estimateTokensForMessage(message: TokenCountMessage): number;
```

估算单条消息的 token 数，包含角色和工具调用相关开销。

```typescript
function estimateTokensForMessages(
  messages: readonly TokenCountMessage[],
): number;
```

估算消息历史的 token 数，包含 conversation overhead。

```typescript
function getTokenLimit(model: string): number;
```

返回模型上下文窗口限制，未知模型返回保守默认值。

```typescript
function calculateContextTokens(
  messages: readonly TokenCountMessage[],
  model: string,
  maxResponseTokens?: number,
): ContextTokens;
```

计算当前上下文使用情况。

```typescript
function isApproachingTokenLimit(
  messages: readonly TokenCountMessage[],
  model: string,
): TokenWarning;
```

返回接近 token 上限的 warning 信息。

```typescript
function createHeuristicTokenCounter(): HeuristicTokenCounter;
```

创建可注入 `core/context` 的默认估算器。

## 数据归属

| 数据 | 创建者 | 归属 | tokenCounting 职责 |
| --- | --- | --- | --- |
| 文本 | 调用方 | 调用方 | 只读估算 |
| `TokenCountMessage[]` | 调用方 | 调用方 | 只读估算 |
| 模型标识 | 调用方 | 调用方 | 查询本地限制表 |
| 估算 token | tokenCounting | 调用方消费 | 返回数值，不缓存 |
| 真实 `TokenUsage` | provider | llm-client/上层 | 不参与 |
