# tokenCounting 模块的数据模型

## 核心概念

### Token（令牌）
LLM 的基本计费单位。一个 Token 通常代表约 4 个英文字符或 1-2 个 CJK 字符。

**估算权重：**
- ASCII 字符（0-127）：0.25 Token/字符（即 4 字符 = 1 Token）
- 非 ASCII 字符：1.3 Token/字符（保守估计，用于 CJK 等）

### Token 限额（Token Limit）
LLM 模型允许的最大 Token 数，由模型能力和 API 定价决定。

**例子：**
- gpt-4：8,192 tokens
- gpt-4-turbo：128,000 tokens
- gpt-4o：128,000 tokens
- gpt-3.5-turbo：4,096 tokens

### Token 消耗分解

当发送请求到 LLM 时，Token 消耗包括：

```
总消耗 Token = 输入 Token + 输出 Token
           = 消息历史 Token + 响应 Token
```

其中：
- **消息历史 Token** = 所有历史消息的 Token 之和 + 消息结构开销
- **响应 Token** = 预期最大响应 Token（默认 2,048）或实际响应 Token

## 核心类型

### TokenEstimation（Token 估算值）
```
value: number       // 估算的 Token 数量
accuracy: number    // 估算精度（±百分比）
```

### ContextTokens（会话 Token 信息）
```
messagesTokens: number            // 消息历史的 Token 数
estimatedResponseTokens: number   // 预期响应的 Token 数
totalUsedTokens: number          // 总消耗 Token 数
remainingTokens: number          // 剩余可用 Token 数
usage: {
  hasWarning: boolean            // 是否达到警告阈值（80%）
  percentUsed: number            // 已使用的百分比（0-100）
}
```

### TokenWarning（Token 警告信息）
```
isApproaching: boolean                              // 是否接近限制
severity: 'none' | 'warning' | 'critical'         // 严重程度
percentUsed: number                                 // 已使用百分比
tokensRemaining: number                            // 剩余 Token 数
```

**严重程度定义：**
- `none`：< 80% 的限额
- `warning`：80% - 95% 的限额
- `critical`：> 95% 的限额

### ChatCompletionMessage（聊天消息）
来自 OpenAI SDK，用于表示对话中的消息。

```
type ChatCompletionMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: any[] }
  | { role: 'system'; content: string }
  | { role: 'tool'; content: string; tool_call_id: string }
```

**不同角色的 Token 开销：**
- System 消息：~100 Token 开销
- User/Assistant 消息：~3 Token 开销（角色、格式标记等）
- Tool 消息：~5 Token 开销（包含 tool_call_id）

### TokenUsage（API 响应中的真实 Token 统计）
来自 LLM API 的精确 Token 消耗数据。

```
prompt_tokens: number        // 输入 Token 数
completion_tokens: number    // 输出 Token 数
total_tokens: number         // 总计 Token 数
```

## 设计约束

1. **估算保守性**
   - 所有估算都向上取整（使用 Math.floor 后不再向下舍入）
   - 宁可高估也不低估，以避免意外超限

2. **启发式算法的局限性**
   - 估算值通常与实际值偏差 ±5-15%
   - 不同模型、不同内容类型的偏差可能更大
   - 永远不应将估算值作为成本计费的依据

3. **模型限额的固定性**
   - Token 限额由配置表定义，不支持运行时修改
   - 未知模型使用默认限额 4,096（保守值）
