# tokenCounting 模块的测试策略

## 测试目标

通过单元测试验证：
1. 文本 Token 估算的启发式算法是否正确应用
2. 可注入的 `HeuristicTokenCounter` 是否与 `core/context` 端口结构兼容
3. 模型限额与预算解析（委托 `modelProfiles`）是否符合预期
4. 接口的边界情况处理是否合理

## 单元测试范围

### 1. estimateTokensForText() - 文本 Token 估算

**测试用例：**

| 用例 | 输入 | 预期行为 | 验证点 |
|------|------|--------|-------|
| ASCII 文本 | "abcd" | 应用 0.25 Token/字符后向上取整 | = 1 |
| ASCII 文本 | "abcde" | 同上 | = 2 |
| 非 ASCII 文本 | "你好" | 应用 1.3 Token/字符 | = 3 |
| 混合文本 | "Hello 世界" | 分别应用权重 | = 5 |
| 表情符号 | "🙂" | 多字节字符按非 ASCII 计 | = 2 |
| 空字符串 | "" | 返回 0 | 边界情况 |

**验证方式：** 由于权重固定，直接比较精确值。

---

### 2. createHeuristicTokenCounter() - 可注入估算器

**测试用例：**

| 场景 | 预期验证 |
|------|---------|
| 默认构造 | 返回对象可赋给 `core/context` 的 `TokenCounter`；`estimateTokens("abcd") = 1`；`getLimit("gpt-4") = 8_192` |
| 配置 defaultLimit | 未知模型 `getLimit` 返回配置值；已知模型（如 `gpt-4o`）仍返回内置 `128_000` |
| 注册自定义 profile | `getLimit` 返回自定义 context 窗口；`getBudget` 返回符合该 profile 的预算（input/output/safety margin 等字段） |

**验证方式：** 检查端口结构兼容性，并对 `getLimit` / `getBudget` 的解析结果做断言。模型 profile 自身的解析细节在 `modelProfiles` 的测试中覆盖，此处只验证经由 counter 的透传是否正确。

---

## 集成测试考虑

### 与 core/context 的协作
- `core/context` 通过 `TokenCounter` 端口注入本模块产出的 counter；验证 `estimateTokens` 被对话级估算（`token-estimation.ts`）正确调用于历史尾部。
- 对话级使用率、压缩阈值等行为属于 `core/context` 的测试范畴，不在本模块。

### 与 LLM Client 的协作
- 当 LLM Client 返回真实 Token 使用时，可与估算值对比，审视估算精度，确保不会系统性低估。

## 边界情况与错误处理

```typescript
// 应抛出 TypeError
estimateTokensForText(null)
estimateTokensForText(undefined)
estimateTokensForText(123)
```

```typescript
// 应正确处理
estimateTokensForText('a'.repeat(100000))  // 超长文本
createHeuristicTokenCounter().getLimit('') // 空模型标识 → 保守默认
```

## 测试代码示例

```typescript
import { describe, it, expect } from 'vitest';
import {
  createHeuristicTokenCounter,
  estimateTokensForText,
} from '@/services/llm-model/tokenCounting';
import type { TokenCounter } from '@/core/context';

describe('tokenCounting', () => {
  describe('estimateTokensForText', () => {
    it('estimates ASCII / non-ASCII / empty text', () => {
      expect(estimateTokensForText('abcd')).toBe(1);
      expect(estimateTokensForText('你好')).toBe(3);
      expect(estimateTokensForText('')).toBe(0);
    });

    it('throws TypeError for non-string input', () => {
      expect(() => estimateTokensForText(null as any)).toThrow(TypeError);
    });
  });

  describe('createHeuristicTokenCounter', () => {
    it('returns a TokenCounter-compatible shape', () => {
      const counter: TokenCounter = createHeuristicTokenCounter();
      expect(counter.estimateTokens('abcd')).toBe(1);
      expect(counter.getLimit('gpt-4')).toBe(8_192);
    });
  });
});
```

## 测试维护原则

1. **测试应聚焦于接口行为，而非实现细节**
   - 不测试内部辅助函数（如字符权重计算、限额解析内部分支）
   - 只验证公开函数与 counter 的输入输出

2. **权重固定处用精确值，模型表演进处用宽松断言**
   - 文本估算权重固定，可断言精确值
   - 模型限额可能随内置表演进，断言时优先用 `toBeGreaterThanOrEqual` 等范围

3. **保持测试数据的现实性**
   - 使用真实的模型标识与文本示例

4. **定期对标 API 实际 Token 使用**
   - 记录估算 vs 实际的偏差，必要时调整估算权重
