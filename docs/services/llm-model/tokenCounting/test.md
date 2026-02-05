# tokenCounting 模块的测试策略

## 测试目标

通过单元测试验证：
1. Token 估算的启发式算法是否正确应用
2. 不同消息类型的处理是否符合预期
3. 警告阈值的判断逻辑是否准确
4. 模块接口的边界情况处理是否合理

## 单元测试范围

### 1. estimateTokensForText() - 文本 Token 估算

**测试用例：**

| 用例 | 输入 | 预期行为 | 验证点 |
|------|------|--------|-------|
| ASCII 文本 | "Hello world" | 正确应用 0.25 Token/字符 | 估算值 ≈ 2-3 Token |
| 非 ASCII 文本 | "你好世界" | 正确应用 1.3 Token/字符 | 估算值 ≈ 5-6 Token |
| 混合文本 | "Hello 世界" | 分别应用权重 | 结果正确 |
| 空字符串 | "" | 返回 0 | 边界情况 |
| 特殊字符 | "!@#$%^&*()" | 使用 1.3 权重 | 处理一致 |
| 表情符号 | "😀" | 使用 1.3 权重 | 多字节字符处理 |

**验证方式：** 对比预期 Token 范围（允许 ±1 的浮动误差）

---

### 2. estimateTokensForMessage() - 消息 Token 估算

**测试用例：**

| 消息类型 | 测试内容 | 预期验证 |
|---------|--------|--------|
| User 消息 | `{ role: 'user', content: 'test' }` | = estimateTokensForText('test') + 3 |
| Assistant 消息 | `{ role: 'assistant', content: 'response' }` | 包含内容 + 开销 |
| System 消息 | `{ role: 'system', content: '...' }` | 较大的固定开销（~100） |
| Tool 消息 | `{ role: 'tool', content: '...', tool_call_id: 'xxx' }` | 内容 + tool_call_id + 5 开销 |
| Null 内容 | `{ role: 'assistant', content: null }` | 返回基础开销（无内容） |

**验证方式：** 检查开销是否被正确加入

---

### 3. estimateTokensForMessages() - 消息历史 Token 估算

**测试用例：**

| 输入 | 预期 | 验证点 |
|------|------|-------|
| 单条消息 | ≈ 消息 Token + 会话开销 4 | 会话开销被加入 |
| 多条消息 | ≈ 消息总和 + 会话开销 4 | 正确累加 |
| 空数组 | 返回 4（仅开销） | 边界情况 |
| 长历史（100+ 消息） | 正确求和，无溢出 | 性能和准确性 |

**验证方式：** 对比单条消息估算的累加结果

---

### 4. getTokenLimit() - 模型限额查询

**测试用例：**

| 模型标识 | 预期返回 | 验证点 |
|---------|--------|-------|
| 'gpt-4' | 8,192 | 已知模型 |
| 'gpt-4-turbo' | 128,000 | 已知模型 |
| 'gpt-4o' | 128,000 | 已知模型 |
| 'gpt-4o-mini' | 128,000 | 已知模型 |
| 'gpt-3.5-turbo' | 4,096 | 已知模型 |
| 'unknown-model' | 4,096 | 默认限额 |
| '' | 4,096 | 空字符串返回默认值 |

**验证方式：** 直接比较返回值

---

### 5. calculateContextTokens() - 会话 Token 使用情况

**测试用例：**

| 输入场景 | 预期验证 |
|---------|---------|
| 空消息列表 | messagesTokens ≈ 0, remainingTokens ≈ 限额, percentUsed ≈ 0 |
| 小消息量（<20% 限额） | usage.hasWarning = false, severity = 'none' |
| 中等消息量（80% 限额） | usage.hasWarning = true, severity = 'warning' |
| 高消息量（>95% 限额） | severity = 'critical' |
| 自定义响应 Token | estimatedResponseTokens = 传入值 |
| 默认响应 Token | estimatedResponseTokens = 2,048 |

**验证方式：**
- 检查计算结果的正确性（remainingTokens = limit - used）
- 验证警告状态和百分比的对应关系
- 确保所有字段都被正确填充

---

### 6. isApproachingTokenLimit() - 限制警告检测

**测试用例：**

| 消息量占比 | 预期 severity | 预期 isApproaching |
|-----------|--------------|-----------------|
| < 80% | 'none' | false |
| 80% - 95% | 'warning' | true |
| > 95% | 'critical' | true |

**验证方式：** 通过构造不同消息量，验证阈值判断逻辑

---

## 集成测试考虑

### 与 LLM Client 的协作
- 当 LLM Client 返回真实 Token 使用时，应与估算值对比，计算误差率
- 定期审视估算精度，确保不会系统性地低估

### 与对话管理的协作
- 在真实会话中，验证 Token 警告是否及时准确地被发现

## 边界情况与错误处理

### 无效输入
```typescript
// 应抛出 TypeError
estimateTokensForText(null)
estimateTokensForText(undefined)
estimateTokensForText(123)

estimateTokensForMessages('not array')
estimateTokensForMessages(null)

getTokenLimit(123)  // 非字符串
```

### 极端值
```typescript
// 应正确处理
estimateTokensForText('a'.repeat(100000))  // 超长文本
estimateTokensForMessages([])  // 空数组
calculateContextTokens([], 'gpt-4')  // 空历史
```

## 测试代码示例

```typescript
import { describe, it, expect } from 'vitest';
import {
  estimateTokensForText,
  estimateTokensForMessage,
  estimateTokensForMessages,
  getTokenLimit,
  calculateContextTokens,
  isApproachingTokenLimit
} from '@/services/llm-model/tokenCounting';

describe('tokenCounting', () => {
  describe('estimateTokensForText', () => {
    it('should estimate ASCII text', () => {
      const tokens = estimateTokensForText('hello');
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThanOrEqual(2);
    });

    it('should estimate non-ASCII text', () => {
      const tokens = estimateTokensForText('你好');
      expect(tokens).toBeGreaterThanOrEqual(2);
      expect(tokens).toBeLessThanOrEqual(3);
    });

    it('should return 0 for empty string', () => {
      expect(estimateTokensForText('')).toBe(0);
    });
  });

  describe('getTokenLimit', () => {
    it('should return limit for known model', () => {
      expect(getTokenLimit('gpt-4-turbo')).toBe(128_000);
    });

    it('should return default limit for unknown model', () => {
      expect(getTokenLimit('unknown')).toBe(4_096);
    });
  });

  describe('calculateContextTokens', () => {
    it('should calculate context tokens correctly', () => {
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' }
      ];
      const context = calculateContextTokens(messages, 'gpt-4');

      expect(context.messagesTokens).toBeGreaterThan(0);
      expect(context.remainingTokens).toBeGreaterThan(0);
      expect(context.remainingTokens).toBeLessThan(8192);
      expect(context.usage.percentUsed).toBeGreaterThan(0);
      expect(context.usage.percentUsed).toBeLessThan(100);
    });

    it('should warn when exceeding 80%', () => {
      // 构造占用 85% 的消息
      const largeContent = 'x'.repeat(6000);
      const messages = [
        { role: 'user', content: largeContent }
      ];
      const context = calculateContextTokens(messages, 'gpt-4');

      expect(context.usage.hasWarning).toBe(true);
      expect(context.usage.percentUsed).toBeGreaterThanOrEqual(80);
    });
  });

  describe('isApproachingTokenLimit', () => {
    it('should return none severity when under 80%', () => {
      const messages = [{ role: 'user', content: 'short' }];
      const warning = isApproachingTokenLimit(messages, 'gpt-4');

      expect(warning.severity).toBe('none');
      expect(warning.isApproaching).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should throw TypeError for invalid input', () => {
      expect(() => estimateTokensForText(null as any)).toThrow(TypeError);
      expect(() => estimateTokensForMessages('not array' as any)).toThrow(TypeError);
    });
  });
});
```

## 测试维护原则

1. **测试应聚焦于接口行为，而非实现细节**
   - 不测试内部辅助函数（如字符权重计算）
   - 只验证公开函数的输入输出

2. **使用值范围而非精确值**
   - 由于启发式的本质，测试应使用范围检查
   - 例：`expect(tokens).toBeBetween(2, 4)` 而非 `toBe(3)`

3. **保持测试数据的现实性**
   - 使用真实的消息内容示例
   - 避免过度简化或极端情况

4. **定期对标 API 实际 Token 使用**
   - 记录估算 vs 实际的偏差
   - 如发现系统性错误，调整估算权重
