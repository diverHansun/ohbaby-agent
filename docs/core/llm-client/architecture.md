# llm-client 模块架构设计

## 架构概览（Architecture Overview）

llm-client 模块由两个独立的职责区域组成：

```
llm-client Module
├── Client Creation（客户端创建）
│   └── createLLMClient()
│       ├── 从 config 模块获取配置
│       └── 创建 OpenAI SDK 实例
│
└── Streaming Processing（流式处理）
    └── streamChatCompletion()
        ├── 发起 OpenAI stream API 调用
        ├── 实时积累消息内容
        └── 解析工具调用参数
```

**各部分的协作方式：**

1. **createLLMClient** 负责一次性初始化，获取配置并创建 OpenAI 实例
2. **streamChatCompletion** 利用已创建的实例进行流式调用，处理流中的数据
3. 两者协作提供完整的 LLM 交互能力

## 设计模式与理由（Design Pattern & Rationale）

### 1. 无状态的函数式接口
**模式：** Functional Interface
**理由：**
- 降低耦合性，消费者无需管理客户端的生命周期
- 易于测试和模拟
- 与 JavaScript 的函数式编程风格一致

### 2. AsyncGenerator 实现流式调用
**模式：** Async Generator
**理由：**
- 与 JavaScript 的 for-await-of 语法天然兼容
- 易于消费者控制流程（可中断、可缓冲）
- 比 Callback 或 Promise 更清晰的控制流

### 3. 配置注入而非配置查询
**模式：** Dependency Injection（配置层面）
**理由：**
- createLLMClient 的返回值包含配置，流式调用直接使用
- 避免流式调用重复查询或缓存配置
- 确保一次流式调用中的配置一致性

### 4. 延迟解析策略
**模式：** Lazy Parsing
**理由：**
- Tool call arguments 在流完成时才 JSON.parse
- 避免在流进行中解析不完整的 JSON（会抛异常）
- 减少中间过程的错误处理复杂度

## 模块结构与文件组织（Module Structure & File Layout）

```
src/core/llm-client/
├── types.ts                  类型定义（LLMClientInstance、StreamingResponse 等）
├── client.ts                 createLLMClient() 实现
├── streaming.ts              streamChatCompletion() 实现
├── index.ts                  公开接口导出
└── __tests__/
    ├── client.test.ts        createLLMClient 单元测试
    ├── streaming.test.ts     streamChatCompletion 单元测试
    └── integration.test.ts   集成测试
```

**各文件职责：**

- **types.ts**：定义 LLMClientInstance、StreamingResponse、ChatFinishReason、ParsedToolCall 等类型
- **client.ts**：实现 createLLMClient()，负责调用 config 模块和初始化 OpenAI 实例
- **streaming.ts**：实现 streamChatCompletion()，处理流式 API 调用和数据积累
- **index.ts**：导出 createLLMClient、streamChatCompletion 以及公开的类型

## 架构约束与权衡（Architectural Constraints & Trade-offs）

### 1. 流式优先，非流式由 SDK 负责
**权衡：** 简化 API 表面积 vs 提供更多便利
**选择：** 仅包装流式调用
**代价：** 消费者需要直接使用 OpenAI SDK 进行非流式调用
**收益：** 降低 llm-client 的复杂度，专注于流式处理

### 2. 中断时返回部分结果，而非抛异常
**权衡：** 隐式异常处理 vs 显式错误传播
**选择：** 返回部分结果
**代价：** 上层需要区分"异常"和"用户中断"两种情况
**收益：** 避免中断时丢失已生成的内容，支持用户更灵活的处理策略

### 3. 配置由外部提供，不缓存或持久化
**权衡：** 每次查询配置 vs 缓存配置
**选择：** 由 createLLMClient 承载配置
**代价：** 无法动态切换模型（需要重新创建实例）
**收益：** 简化设计，避免配置不同步的问题

### 4. 延迟解析 Tool call 参数
**权衡：** 及时解析 vs 完整后解析
**选择：** 完整后解析
**代价：** 消费者无法实时获得已解析的 arguments
**收益：** 避免频繁的 JSON 解析或错误处理

## 与 goals-duty 的对应关系

| Architecture 要素 | 对应目标/职责 |
|------------------|------------|
| createLLMClient 函数 | Duty 1&2：获取配置并初始化 SDK |
| streamChatCompletion 函数 | Duty 3-6：流式调用和数据处理 |
| AsyncGenerator 模式 | Goal 2&4：支持流式积累和中断 |
| Tool call 延迟解析 | Goal 3：自动解析工具参数 |
| 配置不可变设计 | Non-Duty 1：配置由 config 模块管理 |
| 不提供非流式包装 | Non-Duty 4：仅提供流式接口 |
