# context 模块 dfd-interface.md

本文档描述 `context` 模块的数据流与接口定义。以数据流为核心，明确模块之间如何发生交互。

---

## 一、Context & Scope（上下文与范围）

### 模块定位

Context 模块是**上下文管理的中枢**，位于数据源（Memory、Message）和消费者（lifecycle）之间：

```
┌─────────────────────────────────────────────────────────────────┐
│                        数据源层                                  │
├─────────────────────────────────────────────────────────────────┤
│  Memory 模块        Message 模块        SystemPrompt 模块        │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Context 模块                                │
│                                                                  │
│  assemble() ← 组装上下文                                         │
│  compress() ← 压缩历史                                           │
│  prune()    ← 裁剪 tool output                                   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                        消费者层                                  │
├─────────────────────────────────────────────────────────────────┤
│  lifecycle 模块                Commands 模块                     │
└─────────────────────────────────────────────────────────────────┘
```

### 交互模块

| 模块 | 交互方向 | 说明 |
|------|----------|------|
| Memory | Context ← Memory | Context 从 Memory 获取记忆内容 |
| Message | Context ↔ Message | Context 读取历史、更新 Part、创建 summary |
| SystemPrompt | Context ← SystemPrompt | Context 获取系统提示词 |
| tokenCounting | Context ← tokenCounting | Context 调用 token 估算 |
| LLMClient | Context → LLMClient | Context 调用 LLM 执行压缩 |
| lifecycle | lifecycle → Context | lifecycle 调用 Context 接口 |
| Commands | Commands → Context | `/compact` 命令调用 Context |
| Bus | Context → Bus | Context 发布事件 |

---

## 二、Data Flow Description（数据流描述）

### 2.1 上下文组装数据流

```
┌────────────────────────────────────────────────────────────────┐
│ 触发：lifecycle 开始新的 turn                                    │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. lifecycle 调用 Context.assemble(sessionId, directory)       │
└────────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐
│ 2a. Memory.load  │ │ 2b. SystemPrompt │ │ 2c. Message.get  │
│    (directory)   │ │    .build(...)   │ │    Messages(...) │
└──────────────────┘ └──────────────────┘ └──────────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. 合并成 AssembledContext                                      │
│    - 计算 estimatedTokens                                       │
│    - 检查是否包含 summary                                        │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. 检查是否需要自动压缩                                          │
│    - 调用 Context.getUsage()                                    │
│    - usageRatio >= 0.85 → 触发压缩                              │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. 返回 AssembledContext 给 lifecycle                           │
└────────────────────────────────────────────────────────────────┘
```

### 2.2 上下文压缩数据流

```
┌────────────────────────────────────────────────────────────────┐
│ 触发：自动压缩（85% 阈值）或 /compact 命令                        │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. 调用 Context.compress(sessionId, force)                      │
│    - force = true: 手动触发（/compact）                          │
│    - force = false: 自动触发                                    │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. 先执行 Prune                                                 │
│    - Context.prune(sessionId)                                   │
│    - 释放 tool output 空间                                      │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. 获取历史消息                                                  │
│    - Message.getMessages(sessionId)                             │
│    - 计算各消息的 token 数                                       │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. 分割历史                                                     │
│    - historyToKeep: 最新的 30%（基于 token）                     │
│    - historyToCompress: 更早的 70%                              │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. 调用 LLM 生成 snapshot（阻塞等待）                            │
│    - LLMClient.generateContent(historyToCompress, prompt)       │
│    - 返回 XML 格式的 <state_snapshot>                           │
│    - 注意：LLM 生成的内容不输出到交互界面                          │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 6. 创建 summary Message                                         │
│    - Message.updateMessage({ summary: true, ... })              │
│    - Message.updatePart({ type: 'text', text: snapshot })       │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 7. 发布事件并返回结果                                            │
│    - Bus.publish(Context.Event.Compressed, { sessionId })       │
│    - 返回 CompressionResult                                     │
└────────────────────────────────────────────────────────────────┘
```

**自动压缩时的行为说明**：

1. **Agent 阻塞**：自动压缩触发时，Agent 会暂停当前任务执行，阻塞等待 LLM 生成压缩摘要
2. **简短通知**：UI 层订阅 `Context.Event.Compressed` 事件后，显示简短通知：
   ```
   ⊙ 上下文已自动压缩（85% → 28%）
   ```
3. **不输出 LLM 内容**：压缩过程中 LLM 生成的摘要内容不输出到交互界面（太长），只存储到 summary Message
4. **对话继续**：压缩完成后，Agent 自动继续执行被中断的任务


### 2.3 Prune 数据流

```
┌────────────────────────────────────────────────────────────────┐
│ 触发：压缩前自动执行 或 独立调用                                  │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 1. 获取所有消息                                                  │
│    - Message.getMessages(sessionId)                             │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 2. 从最新消息向前遍历                                            │
│    - 扫描所有 ToolPart                                          │
│    - 累计 tool output 的 token 数                               │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 3. 判断是否需要标记                                              │
│    - 保护最近的 PRUNE_PROTECT_TOKENS（40k）                     │
│    - 更早的 tool output 加入待标记列表                           │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 4. 执行标记                                                      │
│    - 检查待释放 token >= PRUNE_MINIMUM（20k）                    │
│    - Message.updatePart({ time.compacted: Date.now() })         │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│ 5. 返回 PruneResult                                             │
│    - prunedCount, freedTokens, protectedCount                   │
└────────────────────────────────────────────────────────────────┘
```

---

## 三、Interface Definition（接口定义）

### 3.1 上下文组装接口

```typescript
/**
 * 组装上下文
 * 
 * @param sessionId - 会话 ID
 * @param directory - 当前工作目录（用于加载项目级 Memory）
 * @param isSubagent - 是否为子代理模式（默认 false）
 * @returns 组装后的上下文
 * 
 * 主代理模式（isSubagent = false）：
 * - 加载完整 SystemPrompt（Identity + Environment + CustomInstructions）
 * - 加载 Memory（全局 + 项目级 IRIS.md）
 * - 加载完整历史消息（包含压缩后的 Summary）
 * 
 * 子代理模式（isSubagent = true）：
 * - 加载子代理专属 SystemPrompt（AgentPrompt + Environment 精简版）
 * - 不加载 Memory（子代理不继承父 Memory）
 * - 不继承父 Session 的历史（使用子 Session 自己的消息）
 * - 消息流与主代理完全隔离
 */
async function assemble(
  sessionId: string,
  directory: string,
  isSubagent: boolean = false
): Promise<AssembledContext>
```

**调用时机**：lifecycle 在每个 turn 开始时调用

**输入**：
- `sessionId`：当前会话 ID
- `directory`：当前工作目录
- `isSubagent`：是否为子代理（默认 false）

**输出**：
- `AssembledContext`：包含 systemPrompt、memory、history、estimatedTokens

**子代理上下文隔离说明**：

子代理与主代理的上下文完全隔离，通过 `SubtaskPart` 传递结果：

```
主代理上下文：
├── SystemPrompt（完整版）
├── Memory（全局 + 项目）
├── 历史消息（含 Summary）
└── 用户消息

子代理上下文：
├── SystemPrompt（子代理专属）
├── Memory（空）            ← 不继承
├── 历史消息（子 Session 自己的）  ← 隔离
└── 任务 Prompt

通信方式：
└── SubtaskPart.result（子代理最终输出传递给主代理）
```

### 3.2 上下文使用情况接口

```typescript
/**
 * 获取上下文使用情况
 * 
 * @param assembledContext - 组装后的上下文
 * @param modelId - 模型 ID（用于获取 context limit）
 * @returns 使用情况统计
 */
function getUsage(
  assembledContext: AssembledContext,
  modelId: string
): ContextUsage
```

**调用时机**：assemble 后、判断是否需要压缩时

**输入**：
- `assembledContext`：组装后的上下文
- `modelId`：当前使用的模型 ID

**输出**：
- `ContextUsage`：包含 currentTokens、contextLimit、usageRatio、shouldCompress

### 3.3 压缩接口

```typescript
/**
 * 压缩上下文
 * 
 * @param sessionId - 会话 ID
 * @param force - 是否强制压缩（手动触发）
 * @returns 压缩结果
 */
async function compress(
  sessionId: string,
  force: boolean
): Promise<CompressionResult>
```

**调用时机**：
- 自动触发：usageRatio >= 0.85 时
- 手动触发：用户执行 `/compact` 命令时

**输入**：
- `sessionId`：当前会话 ID
- `force`：是否强制压缩

**输出**：
- `CompressionResult`：包含 status、originalTokens、newTokens、savedTokens

### 3.4 Prune 接口

```typescript
/**
 * 裁剪旧的 tool output
 * 
 * @param sessionId - 会话 ID
 * @returns Prune 结果
 */
async function prune(
  sessionId: string
): Promise<PruneResult>
```

**调用时机**：压缩前自动执行

**输入**：
- `sessionId`：当前会话 ID

**输出**：
- `PruneResult`：包含 prunedCount、freedTokens、protectedCount

### 3.5 事件定义

```typescript
namespace ContextEvent {
  /** 压缩完成事件 */
  interface Compressed {
    type: 'context.compressed'
    sessionId: string
    result: CompressionResult
  }
  
  /** Prune 完成事件 */
  interface Pruned {
    type: 'context.pruned'
    sessionId: string
    result: PruneResult
  }
}
```

---

## 四、Data Ownership & Responsibility（数据归属与责任）

### 4.1 数据创建责任

| 数据 | 创建者 | 说明 |
|------|--------|------|
| AssembledContext | Context 模块 | 组装后的临时对象 |
| CompressionResult | Context 模块 | 压缩操作的返回值 |
| Summary Message | Context 模块（通过 Message） | 压缩结果的持久化存储 |
| Compacted 标记 | Context 模块（通过 Message） | Prune 结果的持久化存储 |

### 4.2 数据更新责任

| 数据 | 更新者 | 说明 |
|------|--------|------|
| ToolPart.time.compacted | Context 模块 | Prune 时标记时间戳 |
| Summary Message | - | 创建后不再更新 |

### 4.3 数据读取责任

| 数据 | 读取者 | 说明 |
|------|--------|------|
| Memory 内容 | Context 模块 | 调用 Memory.load() |
| Message 历史 | Context 模块 | 调用 Message.getMessages() |
| SystemPrompt | Context 模块 | 调用 SystemPrompt.build() |
| Token 估算 | Context 模块 | 调用 tokenCounting 接口 |

### 4.4 数据删除责任

Context 模块**不负责**数据删除：
- Message 的删除由 Session/Message 模块负责
- Prune 只标记不删除

---

## 五、与其他模块的接口依赖

### 5.1 Context → Memory

```typescript
// Context 调用 Memory
const memory = await Memory.load(directory)
// memory: { global: string, project: string, merged: string }
```

### 5.2 Context → Message

```typescript
// 获取历史消息
const messages = await Message.getMessages(sessionId)

// 更新 Part（标记 compacted）
await Message.updatePart({
  id: partId,
  sessionId,
  messageId,
  state: {
    ...existingState,
    time: { ...existingTime, compacted: Date.now() }
  }
})

// 创建 summary Message
const summaryMsg = await Message.updateMessage({
  id: generateMessageId(),
  sessionId,
  role: 'assistant',
  summary: true,
  // ...
})

// 创建 summary 的 TextPart
await Message.updatePart({
  id: generatePartId(),
  messageId: summaryMsg.id,
  sessionId,
  type: 'text',
  text: snapshot  // XML 格式的压缩摘要
})
```

### 5.3 Context → tokenCounting

```typescript
// 估算 token 数
const tokens = tokenCounting.estimateTokens(content)

// 获取模型限额
const limit = tokenCounting.getLimit(modelId)
```

### 5.4 Context → LLMClient

```typescript
// 执行压缩总结
const response = await LLMClient.generateContent({
  messages: historyToCompress,
  systemPrompt: compressionPrompt,
  // ...
})
```

### 5.5 Context → Bus

```typescript
// 发布压缩完成事件
Bus.publish(ContextEvent.Compressed, {
  sessionId,
  result: compressionResult
})

// 发布 Prune 完成事件
Bus.publish(ContextEvent.Pruned, {
  sessionId,
  result: pruneResult
})
```

---

## 六、错误处理

### 6.1 组装阶段错误

| 错误场景 | 处理方式 |
|----------|----------|
| Memory.load 失败 | 记录警告，使用空记忆继续 |
| Message.getMessages 失败 | 抛出错误，中断组装 |
| SystemPrompt.build 失败 | 抛出错误，中断组装 |

### 6.2 压缩阶段错误

| 错误场景 | 处理方式 |
|----------|----------|
| 历史太短无需压缩 | 返回 status: 'skipped' |
| LLM 调用失败 | 返回 status: 'failed'，附带错误信息 |
| 压缩后 token 反而增加 | 返回 status: 'inflated'，不创建 summary |
| Message.updateMessage 失败 | 抛出错误 |

### 6.3 Prune 阶段错误

| 错误场景 | 处理方式 |
|----------|----------|
| 释放的 token 不足 20k | 跳过 Prune，返回 prunedCount: 0 |
| Message.updatePart 失败 | 抛出错误 |

---

## 七、文档自检

- [x] 可以清楚说明每一条数据从哪里来、到哪里去
- [x] 所有接口都服务于明确的数据流
- [x] 不存在数据责任不清或重复处理的风险
- [x] 错误处理策略明确
- [x] 与 Memory、Message、tokenCounting、LLMClient 的接口依赖清晰
