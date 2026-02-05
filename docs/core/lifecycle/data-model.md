# lifecycle 模块 data-model.md

本文档定义 `lifecycle` 模块的核心概念与数据模型。重点是统一"认知模型"，而非冻结实现细节。

---

## 一、Core Concepts（核心概念）

### 概念 1: Step（步骤）

**定义**：Step 是用户请求处理过程中的一个完整迭代单元，包含一次 LLM 调用及可能的工具执行。

**边界**：
- 开始：发起 LLM 调用
- 结束：LLM 返回响应（无论是否包含 tool_calls）

**与其他概念的关系**：
```
一次用户请求（Run）
├── Step 1: LLM 返回 tool_calls -> 执行工具
├── Step 2: LLM 继续推理 -> 返回 tool_calls -> 执行工具
├── Step 3: LLM 返回最终答案（finish_reason: stop）
└── Run 完成
```

### 概念 2: Turn（轮次）

**定义**：Turn 是单次 LLM 交互，包含请求发送、流式响应接收、工具调用执行的完整过程。

**注意**：在当前设计中，Turn 和 Step 是 1:1 的关系，但概念上有区别：
- Step 强调"循环的一步"
- Turn 强调"与 LLM 的一次交互"

### 概念 3: LoopEvent（循环事件）

**定义**：执行过程中产生的事件，通过 AsyncGenerator yield 传递给调用方。

**事件类型**：

| 类型 | 触发时机 | 携带数据 |
|------|----------|----------|
| `llm:start` | LLM 调用开始 | stepIndex |
| `llm:delta` | 收到流式片段 | content（文本片段） |
| `llm:complete` | LLM 调用完成 | finishReason, toolCalls? |
| `tool:start` | 工具开始执行 | toolName, toolCallId |
| `tool:result` | 工具执行完成 | toolCallId, result |
| `tool:error` | 工具执行失败 | toolCallId, error |
| `step:complete` | 单步完成 | stepIndex, status |
| `error` | 发生错误 | error |

### 概念 4: LoopResult（循环结果）

**定义**：执行循环完成后的最终结果，作为 AsyncGenerator 的 return 值。

**关键字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| success | boolean | 是否成功完成 |
| finishReason | string | 完成原因：stop/maxSteps/abort/error |
| steps | number | 执行的步数 |
| finalResponse | string? | 最终的文本响应 |
| error | Error? | 如果失败，包含错误信息 |
| usage | object? | Token 使用统计 |

---

## 二、Entity vs Value Object（实体 vs 值对象）

| 概念 | 分类 | 理由 |
|------|------|------|
| Step | 值对象 | 无独立生命周期，作为执行过程的片段存在 |
| LoopEvent | 值对象 | 不可变，产生后立即消费 |
| LoopResult | 值对象 | 不可变，表示执行结束的快照 |
| ExecutionState | 实体（内部） | 在执行过程中持续更新，但不暴露给外部 |

---

## 三、Key Data Fields（关键数据字段）

### LoopEvent 通用字段

```typescript
interface LoopEvent {
  type: string        // 事件类型
  timestamp: number   // 事件发生时间
  stepIndex?: number  // 当前步骤索引（如适用）
}
```

### LoopResult 完整字段

```typescript
interface LoopResult {
  success: boolean
  finishReason: 'stop' | 'maxSteps' | 'abort' | 'error'
  steps: number
  finalResponse?: string
  error?: {
    name: string
    message: string
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
  toolCallRecords?: ToolCallRecord[]
}
```

### 内部执行状态（不对外暴露）

```typescript
interface ExecutionState {
  sessionId: string
  currentStep: number
  messages: Message[]       // 内存中累积的消息
  toolCallRecords: ToolCallRecord[]
  startTime: number
  aborted: boolean
}
```

---

## 四、Lifecycle and Ownership（生命周期与归属）

### LoopEvent 生命周期

```
创建 -> yield -> 调用方消费 -> 销毁
  │                  │
  └── lifecycle 模块创建   └── 调用方负责处理后释放
```

### LoopResult 生命周期

```
循环完成 -> 构建 LoopResult -> return -> 调用方获取 -> 持久化/丢弃
                                           │
                                 └── 调用方决定是否持久化
```

### 消息历史生命周期

```
循环开始
    │
    ├── 从 Message 读取历史消息
    │
    ├── 循环执行中：实时写入新消息和 Part
    │   ├── 用户消息提交时 → Message.updateMessage()
    │   ├── LLM 响应时 → Message.updateMessage() + updatePart()
    │   └── 工具执行完成 → Message.updatePart()
    │
    └── 循环结束后
        ├── 成功：更新最终消息状态
        ├── 失败：标记错误消息
        └── 取消：标记中断消息
```

---

## 五、与 Message 模块的数据边界

| 数据 | lifecycle 职责 | Message 职责 |
|------|----------------|---------------|
| 历史消息 | 读取（只读） | 存储、提供查询接口 |
| 新用户消息 | 构建并立即写入 | 接收并持久化 |
| 新助手消息 | 构建并实时写入 | 接收并持久化 |
| 消息 Part | 构建并实时写入 | 接收并持久化 |
| 工具结果 | 格式化为 ToolPart 并写入 | 接收并持久化 |

---

## 六、文档自检

- [x] 每个概念有清晰的边界定义
- [x] 区分了对外暴露和内部实现的数据
- [x] 明确了数据归属和生命周期
- [x] 不包含实现细节的类型定义
