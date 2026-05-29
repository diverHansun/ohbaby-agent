# tokenCounting 模块的数据模型

## 核心概念

### Token

LLM 的基本上下文计量单位。当前实现使用保守启发式估算：

- ASCII 字符按 `0.25` token/字符估算。
- 非 ASCII 字符按 `1.3` token/字符估算。
- 最终结果向上取整。

空字符串返回 `0`；非字符串输入抛出 `TypeError`。

### Token Limit / Token Budget

模型允许的最大 context 窗口及其输入/输出预算由 `modelProfiles` 注册表负责解析，tokenCounting 通过 `HeuristicTokenCounter` 的 `getLimit` / `getBudget` 暴露：

- 内置常见模型的保守限额（如 `gpt-4` → `8_192`、`gpt-3.5-turbo` → `4_096`、`gpt-4o` → `128_000`、`claude-` → `200_000`、`deepseek-` → `64_000`、`glm-4` → `128_000`、`gpt-5` → `400_000`）。
- 未知模型回退到 `defaultLimit`（缺省 `128_000`，可通过选项覆盖）。
- 空模型标识回退到 `4_096`。

`TokenBudget` / `TokenBudgetOptions` 的结构定义在 `modelProfiles.ts`，本模块不复制其字段。

### HeuristicTokenCounterOptions

```typescript
interface HeuristicTokenCounterOptions {
  defaultLimit?: number;
  defaultMaxOutputTokens?: number;
  profiles?: readonly ModelProfileRegistration[];
  provider?: string;
}
```

用于配置默认限额、默认输出预算、用户自定义模型 profile 与默认 provider。

### HeuristicTokenCounter

```typescript
interface HeuristicTokenCounter {
  estimateTokens(content: string): number;
  getBudget(modelId: string, options?: TokenBudgetOptions): TokenBudget;
  getLimit(modelId: string): number;
}
```

`createHeuristicTokenCounter()` 返回的对象与 `core/context` 的 `TokenCounter` 端口结构兼容，可作为 context manager 的默认估算器注入。`estimateTokens` 即文本估算原语；`getLimit` / `getBudget` 委托 `modelProfiles` 注册表。

### TokenUsage（非本模块产物）

`TokenUsage` 表示 provider 返回的真实 usage，来源在 `services/providers` 和 `core/llm-client` 的流式响应中。它不是本模块的估算结果，由 llm-client 透传给上层消费者。`core/context` 的对话级估算会优先采信历史中已回传的真实 `TokenUsage`（anchor），仅对未回传的尾部调用本模块的 `estimateTokens`。

## 设计约束

1. tokenCounting 是纯计算模块，不持有 session/message/run 状态。
2. tokenCounting 不发网络请求，不依赖 provider SDK。
3. 估算结果只能用于规划、压缩决策输入，不能用于费用结算。
4. provider 返回的真实 usage 由 llm-client 透传给上层消费者。
