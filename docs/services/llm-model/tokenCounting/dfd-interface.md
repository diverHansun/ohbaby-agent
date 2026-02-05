# tokenCounting 模块的数据流与接口设计

## 上下文与范围（Context & Scope）

tokenCounting 模块与以下模块交互：

- **Context 模块**：计算上下文 token 使用量，判断是否需要压缩
- **LLM Client 模块**：接收流式响应中的真实 Token 统计（可选）
- **对话管理模块**：提供消息历史，接收 Token 使用情况反馈
- **主调度模块**：提供当前会话信息，在请求前检查 Token 状态

本文档描述的是模块的外部接口和核心数据流，不涉及模块内部的实现细节。


## 数据流描述（Data Flow Description）

### 流程 1：文本 Token 估算

```
外部输入：文本字符串
    ↓
字符遍历与权重计算（Estimator）
    ↓
估算值输出：Token 数量整数
```

**处理步骤：**
1. 接收文本字符串
2. 逐字符遍历，判断 ASCII（0.25 Token/字符）或非 ASCII（1.3 Token/字符）
3. 累计权重求和
4. 返回 Math.floor(总和)

**说明：** 该流程全部发生在模块内部，无外部依赖。

### 流程 2：会话 Token 使用情况计算

```
外部输入：消息历史、模型标识、(可选)预期响应 Token
    ↓
消息估算：对每条消息执行流程 1 + 消息开销
    ↓
模型限额查询：根据模型名称获取限额
    ↓
数值计算：
  - 消息总 Token = 所有消息 Token + 会话开销
  - 总消耗 = 消息 Token + 响应 Token
  - 剩余 = 限额 - 总消耗
  - 使用百分比 = 消耗 / 限额
    ↓
输出：ContextTokens（包含剩余量、警告状态等）
```

**说明：**
- 该流程同样为纯本地计算，不涉及外部调用
- 消息 Token = 文本 Token + 消息角色开销（见 data-model.md）
- 响应 Token 默认为 2,048，也可由调用者指定

### 流程 3：Token 限制警告检测

```
外部输入：消息历史、模型标识
    ↓
执行流程 2（计算会话 Token）
    ↓
判断严重程度：
  if (使用百分比 < 80%)  → severity = 'none'
  else if (< 95%)        → severity = 'warning'
  else                    → severity = 'critical'
    ↓
输出：TokenWarning（包含严重程度、剩余量等）
```

## 接口定义（Interface Definition）

### 接口 1：estimateTokensForText()
**语义：** 对文本进行 Token 估算

```typescript
function estimateTokensForText(text: string): number
```

- **输入：** 任意字符串文本
- **输出：** 估算的 Token 数（整数，非负）
- **特性：** 同步，无副作用

### 接口 2：estimateTokensForMessage()
**语义：** 对单条聊天消息进行 Token 估算

```typescript
function estimateTokensForMessage(message: ChatCompletionMessage): number
```

- **输入：** OpenAI ChatCompletionMessage 对象（任何角色）
- **输出：** 估算的 Token 数（包含消息结构开销）
- **特性：** 同步，无副作用
- **处理规则：** 根据消息角色添加相应开销

### 接口 3：estimateTokensForMessages()
**语义：** 对消息历史进行 Token 估算

```typescript
function estimateTokensForMessages(messages: ChatCompletionMessage[]): number
```

- **输入：** 聊天消息数组
- **输出：** 消息历史的总 Token 数（包含会话开销）
- **特性：** 同步，无副作用

### 接口 4：getTokenLimit()
**语义：** 查询模型的 Token 限额

```typescript
function getTokenLimit(model: string): number
```

- **输入：** 模型标识字符串（如 'gpt-4-turbo'）
- **输出：** Token 限额数值
- **默认值：** 未知模型返回 4,096（保守默认值）
- **特性：** 同步，查询静态配置表

### 接口 5：calculateContextTokens()
**语义：** 计算当前会话的 Token 使用情况

```typescript
function calculateContextTokens(
  messages: ChatCompletionMessage[],
  model: string,
  maxResponseTokens?: number
): ContextTokens
```

- **输入：**
  - messages：消息历史
  - model：LLM 模型标识
  - maxResponseTokens：预期最大响应 Token（默认 2,048）
- **输出：** ContextTokens 对象，包含详细的 Token 分解信息
- **特性：** 同步，无副作用

### 接口 6：isApproachingTokenLimit()
**语义：** 检测是否接近 Token 限制

```typescript
function isApproachingTokenLimit(
  messages: ChatCompletionMessage[],
  model: string
): TokenWarning
```

- **输入：** 消息历史、模型标识
- **输出：** TokenWarning 对象，包含严重程度和剩余量
- **特性：** 同步，无副作用

## 数据归属与责任（Data Ownership & Responsibility）

| 数据 | 创建者 | 所有者 | 责任边界 |
|------|--------|--------|---------|
| 输入文本 | 调用者 | 调用者 | tokenCounting 仅读取，不修改或缓存 |
| 消息历史 | 调用者 | 调用者 | tokenCounting 仅读取，不添加删除或修改 |
| 模型标识 | 调用者 | 调用者 | tokenCounting 仅查询对应限额 |
| Token 限额配置 | 开发者 | 模块 | tokenCounting 维护并向外提供只读访问 |
| 估算的 Token 数 | tokenCounting | 调用者 | 调用者决定是否使用或忽略 |
| API 响应的真实 Token | LLM API | LLM Client | tokenCounting 不依赖或改动 |

**关键原则：** tokenCounting 是纯计算模块，不拥有任何业务数据，不参与数据的生命周期管理。

## 禁止的操作

以下操作**不**在本模块的接口范围内：

- 直接修改调用者传入的消息数据
- 缓存或持久化 Token 估算结果
- 根据 Token 情况主动调整行为（如删除消息、拒绝请求）
- 调用 LLM API 或其他外部服务
- 生成或强制执行业务决策
