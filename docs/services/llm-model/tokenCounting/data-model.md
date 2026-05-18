# tokenCounting 模块的数据模型

## 核心概念

### Token

LLM 的基本上下文计量单位。当前实现使用保守启发式估算：

- ASCII 字符按 `0.25` token/字符估算。
- 非 ASCII 字符按 `1.3` token/字符估算。
- 最终结果向上取整。

### Token Limit

模型允许的最大上下文窗口。当前已内置常见 OpenAI 系列模型的保守限制，未知模型返回默认 `4_096`。

### TokenCountMessage

`services/llm-model` 暴露的消息估算输入类型。它只表示 token 估算需要读取的结构，不等同于 provider/lifecycle 的消息边界。

```typescript
type TokenCountMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: readonly unknown[];
    }
  | {
      role: "tool";
      content: string;
      tool_call_id: string;
    };
```

不同角色的估算开销：

- system: 文本 token + `100`
- user: 文本 token + `3`
- assistant: 文本 token + tool calls 序列化 token + `3`
- tool: 文本 token + `tool_call_id` token + `5`

### ContextTokens

```typescript
interface ContextTokens {
  messagesTokens: number;
  estimatedResponseTokens: number;
  totalUsedTokens: number;
  remainingTokens: number;
  usage: {
    hasWarning: boolean;
    percentUsed: number;
  };
}
```

### TokenWarning

```typescript
type TokenWarningSeverity = "none" | "warning" | "critical";

interface TokenWarning {
  isApproaching: boolean;
  severity: TokenWarningSeverity;
  percentUsed: number;
  tokensRemaining: number;
}
```

阈值：

- `< 80%`: `none`
- `>= 80%` 且 `< 95%`: `warning`
- `>= 95%`: `critical`

### HeuristicTokenCounter

```typescript
interface HeuristicTokenCounter {
  estimateTokens(content: string): number;
  getLimit(modelId: string): number;
}
```

`createHeuristicTokenCounter()` 返回的对象与 `core/context` 的 `TokenCounter` 结构兼容，可作为 context manager 的默认估算器注入。

### TokenUsage

`TokenUsage` 表示 provider 返回的真实 usage，来源在 `services/providers` 和 `core/llm-client` 的流式响应中。它不是本模块的估算结果，不应和 `ContextTokens` 或 `TokenWarning` 混用。

## 设计约束

1. tokenCounting 是纯计算模块，不持有 session/message/run 状态。
2. tokenCounting 不发网络请求，不依赖 provider SDK。
3. 估算结果只能用于规划、预警、压缩决策输入，不能用于费用结算。
4. provider 返回的真实 usage 由 llm-client 透传给上层消费者。
