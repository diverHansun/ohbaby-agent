# context 模块 test.md

本文档描述 `context` 模块的测试策略与验证方法。重点是验证模块在协作环境中是否按照既定职责运行。

---

## 一、Test Scope（测试范围）

### 覆盖的职责

| 职责 | 测试重点 |
|------|----------|
| D1: 上下文组装 | 正确合并 Memory、SystemPrompt、History |
| D2: Token 使用量计算 | 正确调用 tokenCounting 并返回使用率 |
| D3: 自动压缩触发 | 85% 阈值判断正确 |
| D4: 上下文压缩 | 正确分割历史、调用 LLM、创建 summary |
| D5: Prune 策略 | 正确标记旧 tool output |
| D7: 事件发布 | 正确发布 Compressed 和 Pruned 事件 |

### 不在测试范围

| 内容 | 理由 |
|------|------|
| Memory 模块的文件读写 | Memory 模块自行测试 |
| Message 模块的存储逻辑 | Message 模块自行测试 |
| tokenCounting 的估算算法 | tokenCounting 模块自行测试 |
| LLM 的响应质量 | 外部依赖，非 Context 职责 |
| SystemPrompt 的构建逻辑 | SystemPrompt 模块自行测试 |

---

## 二、Critical Scenarios（关键场景）

### 2.1 上下文组装场景

#### 场景 1: 正常组装

**前置条件**：
- Memory 返回有效的记忆内容
- Message 返回会话历史
- SystemPrompt 返回系统提示词

**操作**：
```typescript
const context = await Context.assemble(sessionId, directory)
```

**预期结果**：
- `context.memory.merged` 包含全局和项目记忆
- `context.history` 包含历史消息
- `context.systemPrompt` 不为空
- `context.estimatedTokens > 0`

#### 场景 2: Memory 加载失败时降级

**前置条件**：
- Memory.load 抛出错误（如文件不可读）

**操作**：
```typescript
const context = await Context.assemble(sessionId, directory)
```

**预期结果**：
- 组装成功（不抛出错误）
- `context.memory.merged` 为空字符串
- 记录警告日志

#### 场景 3: 空会话

**前置条件**：
- 新创建的会话，没有历史消息

**操作**：
```typescript
const context = await Context.assemble(sessionId, directory)
```

**预期结果**：
- `context.history.length === 0`
- `context.hasSummary === false`
- 组装成功

### 2.2 压缩触发场景

#### 场景 4: 低于阈值不压缩

**前置条件**：
- 上下文使用率为 50%（低于 85%）

**操作**：
```typescript
const usage = Context.getUsage(context, modelId)
```

**预期结果**：
- `usage.usageRatio === 0.5`
- `usage.shouldCompress === false`

#### 场景 5: 达到阈值触发压缩

**前置条件**：
- 上下文使用率为 90%（高于 85%）

**操作**：
```typescript
const usage = Context.getUsage(context, modelId)
```

**预期结果**：
- `usage.usageRatio === 0.9`
- `usage.shouldCompress === true`

### 2.3 压缩执行场景

#### 场景 6: 成功压缩

**前置条件**：
- 会话有足够的历史消息
- LLM 正常返回压缩摘要

**操作**：
```typescript
const result = await Context.compress(sessionId, true)
```

**预期结果**：
- `result.status === 'compressed'`
- `result.newTokens < result.originalTokens`
- `result.summaryMessageId` 不为空
- Message 中创建了 summary Message

#### 场景 7: 历史太短跳过压缩

**前置条件**：
- 会话只有 1-2 条消息

**操作**：
```typescript
const result = await Context.compress(sessionId, true)
```

**预期结果**：
- `result.status === 'skipped'`
- 不创建 summary Message

#### 场景 8: 压缩后 token 增加

**前置条件**：
- LLM 返回的摘要比原历史还长

**操作**：
```typescript
const result = await Context.compress(sessionId, true)
```

**预期结果**：
- `result.status === 'inflated'`
- 不创建 summary Message
- 不替换历史

#### 场景 9: LLM 调用失败

**前置条件**：
- LLMClient.generateContent 抛出错误

**操作**：
```typescript
const result = await Context.compress(sessionId, true)
```

**预期结果**：
- `result.status === 'failed'`
- `result.error` 包含错误信息
- 不创建 summary Message

### 2.4 Prune 场景

#### 场景 10: 成功 Prune

**前置条件**：
- 会话有多个已完成的 tool output
- 总 tool output 超过 PRUNE_PROTECT（40k）

**操作**：
```typescript
const result = await Context.prune(sessionId)
```

**预期结果**：
- `result.prunedCount > 0`
- `result.freedTokens >= PRUNE_MINIMUM`
- 旧的 ToolPart 被标记 `time.compacted`

#### 场景 11: tool output 不足跳过 Prune

**前置条件**：
- tool output 总量 < PRUNE_PROTECT

**操作**：
```typescript
const result = await Context.prune(sessionId)
```

**预期结果**：
- `result.prunedCount === 0`
- 没有 Part 被标记

#### 场景 12: 保护最近的 tool output

**前置条件**：
- 会话有大量 tool output

**操作**：
```typescript
const result = await Context.prune(sessionId)
```

**预期结果**：
- 最近的 tool output（约 40k tokens）未被标记
- 只有更早的 tool output 被标记
- `result.protectedCount > 0`

### 2.5 事件发布场景

#### 场景 13: 压缩完成发布事件

**前置条件**：
- 压缩成功完成

**操作**：
```typescript
await Context.compress(sessionId, true)
```

**预期结果**：
- Bus 发布了 `context.compressed` 事件
- 事件包含 sessionId 和 result

#### 场景 14: Prune 完成发布事件

**前置条件**：
- Prune 执行完成

**操作**：
```typescript
await Context.prune(sessionId)
```

**预期结果**：
- Bus 发布了 `context.pruned` 事件
- 事件包含 sessionId 和 result

---

## 三、Integration Points（集成点测试）

### 3.1 与 Memory 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| 正常加载 | Memory.load 返回内容被正确合并到 AssembledContext |
| 加载失败 | Memory.load 失败时降级处理，不中断组装 |

### 3.2 与 Message 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| 获取历史 | Message.getMessages 返回的消息被正确包含在 history 中 |
| 创建 summary | 压缩后正确调用 Message.updateMessage 创建 summary |
| 更新 Part | Prune 时正确调用 Message.updatePart 标记 compacted |
| compacted 过滤 | 已标记 compacted 的 tool output 不出现在 toModelMessages 结果中 |

### 3.3 与 tokenCounting 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| token 估算 | 调用 estimateTokens 返回的值被用于计算 usageRatio |
| 限额查询 | 调用 getLimit 返回的值被用于判断是否需要压缩 |

### 3.4 与 LLMClient 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| 压缩调用 | 压缩时正确调用 generateContent |
| 错误处理 | LLM 调用失败时返回 failed 状态 |

### 3.5 与 Bus 模块集成

| 测试点 | 验证内容 |
|--------|----------|
| 压缩事件 | 压缩完成后发布 context.compressed 事件 |
| Prune 事件 | Prune 完成后发布 context.pruned 事件 |

---

## 四、Verification Strategy（验证策略）

### 4.1 单元测试

| 组件 | Mock 对象 | 测试重点 |
|------|-----------|----------|
| ContextAssembler | Memory, Message, SystemPrompt | 组装逻辑、降级处理 |
| ContextCompressor | Message, LLMClient, tokenCounting | 分割逻辑、压缩流程 |
| ContextPruner | Message | 扫描逻辑、标记逻辑 |
| ContextManager | 所有子组件 | API 协调、阈值判断 |

### 4.2 集成测试

使用真实的 Message 和 Memory 模块（mock Storage 和 LLMClient）：

- 完整的组装流程
- 完整的压缩流程
- Prune 后 toModelMessages 正确过滤

### 4.3 Mock 策略

```typescript
// Mock Memory 模块
const mockMemory = {
  load: vi.fn().mockResolvedValue({
    global: 'global memory',
    project: 'project memory',
    merged: 'global memory\n---\nproject memory'
  })
}

// Mock Message 模块
const mockMessage = {
  getMessages: vi.fn().mockResolvedValue([
    { info: { id: 'msg1', role: 'user', ... }, parts: [...] },
    { info: { id: 'msg2', role: 'assistant', ... }, parts: [...] }
  ]),
  updateMessage: vi.fn().mockResolvedValue({ id: 'summary_msg', ... }),
  updatePart: vi.fn().mockResolvedValue({ id: 'part1', ... })
}

// Mock tokenCounting 模块
const mockTokenCounting = {
  estimateTokens: vi.fn().mockReturnValue(50000),
  getLimit: vi.fn().mockReturnValue(100000)
}

// Mock LLMClient 模块
const mockLLMClient = {
  generateContent: vi.fn().mockResolvedValue({
    text: '<state_snapshot>...</state_snapshot>'
  })
}

// Mock Bus 模块
const mockBus = {
  publish: vi.fn()
}
```

### 4.4 边界条件测试

| 边界条件 | 测试内容 |
|----------|----------|
| 空会话 | history 为空时组装和压缩行为 |
| 单条消息 | 只有一条消息时压缩跳过 |
| 恰好 85% | usageRatio = 0.85 时是否触发压缩 |
| 恰好 30% | 分割时边界消息归属 |
| 全部是 tool output | Prune 时的保护逻辑 |
| 没有 tool output | Prune 跳过 |

---

## 五、测试数据准备

### 5.1 典型消息历史

```typescript
const typicalHistory: MessageWithParts[] = [
  {
    info: { id: 'msg1', role: 'user', sessionId, time: { created: 1000 }, ... },
    parts: [{ id: 'part1', type: 'text', text: 'Hello' }]
  },
  {
    info: { id: 'msg2', role: 'assistant', sessionId, parentId: 'msg1', ... },
    parts: [
      { id: 'part2', type: 'text', text: 'Hi there!' },
      { id: 'part3', type: 'tool', tool: 'read_file', state: { status: 'completed', output: '...' } }
    ]
  },
  // ... 更多消息
]
```

### 5.2 压缩快照示例

```xml
<state_snapshot>
  <overall_goal>用户正在开发一个 TypeScript 项目</overall_goal>
  <key_knowledge>
    - 项目使用 Vitest 测试框架
    - 构建命令: npm run build
  </key_knowledge>
  <file_system_state>
    - CWD: /home/user/project
    - MODIFIED: src/index.ts
  </file_system_state>
  <recent_actions>
    - 执行了 npm test
    - 修复了 2 个测试
  </recent_actions>
  <current_plan>
    1. [DONE] 分析代码
    2. [IN PROGRESS] 实现功能
    3. [TODO] 编写文档
  </current_plan>
</state_snapshot>
```

---

## 六、文档自检

- [x] 所有关键职责都有对应的验证场景
- [x] 明确了模块与外部交互时的失败处理预期
- [x] 避免了与具体实现细节的绑定
- [x] Mock 策略清晰
- [x] 边界条件覆盖充分
- [x] 测试数据准备完整
