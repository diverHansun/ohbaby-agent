# Turn 结构与 Hook 系统设计

## 一、Turn 的位置与结构

### 1.1 Turn 在 gemini-cli 中的位置

在 gemini-cli 中，Turn 位于 `packages/core/src/core/turn.ts`，与 `client.ts`、`geminiChat.ts`、`coreToolScheduler.ts` 同级：

```
packages/core/src/core/
├── client.ts             主客户端
├── geminiChat.ts         LLM 交互
├── turn.ts               Turn 类定义
└── coreToolScheduler.ts 工具调度
```

**关键点：**

- Turn 是类，不是接口
- Turn 与使用它的模块（client、scheduler）同级
- `client.ts` 的 `sendMessageStream()` 返回 `AsyncGenerator<ServerGeminiStreamEvent, Turn>`

### 1.2 Turn 的实际实现

```typescript
export class Turn {
  readonly pendingToolCalls: ToolCallRequestInfo[] = [];
  private debugResponses: GenerateContentResponse[] = [];
  private pendingCitations = new Set<string>();
  finishReason: FinishReason | undefined = undefined;

  constructor(
    private readonly chat: GeminiChat,
    private readonly prompt_id: string,
  ) {}

  async *run(
    modelConfigKey: ModelConfigKey,
    req: PartListUnion,
    signal: AbortSignal,
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    // 执行单次 LLM 调用，产生事件流
  }
}
```

**特点：**

- 不直接存储用户输入，通过 `chat` 对象访问历史
- 通过事件流传递状态变化
- `pendingToolCalls` 只包含待处理的工具调用请求

### 1.3 ohbaby-code 的建议结构

**文件位置：**

```
src/core/
├── main-scheduler/
│   ├── client.ts        主协调器
│   └── logger.ts        日志
├── turn.ts              Turn 类定义（独立）
├── tool-scheduler/
├── llm-client/
└── hooks/
```

**Turn 接口设计：**

```typescript
export interface Turn {
  turnId: string;
  startTime: Date;
  endTime: Date;
  
  userMessage: ChatCompletionMessage;
  llmCalls: LLMCall[];
  toolExecutions: ToolExecution[];
  agentExecutions?: AgentExecution[];
  
  events: TurnEvent[];
  status: 'completed' | 'error' | 'cancelled';
  error?: Error;
}
```

**设计理由：**

- Turn 是多个模块的返回值类型，不是某个模块的内部实现
- 放在 `core/` 根部便于多模块引用
- 符合"数据结构与使用者距离"原则

## 二、main-scheduler 与 tool-scheduler 的配合

### 2.1 职责划分

**main-scheduler (client.ts)：**

- 协调整个流程
- 管理消息历史
- 调用 LLM
- 检测工具调用需求
- 调用 tool-scheduler

**tool-scheduler：**

- 接收工具调用请求
- 验证工具参数
- Policy 检查（确认机制）
- 执行工具（包含 Hook 触发）
- 返回结果给 main-scheduler

### 2.2 调用流程（基于 gemini-cli）

在 gemini-cli 中，`GeminiClient.sendMessageStream()` 返回 `AsyncGenerator<ServerGeminiStreamEvent, Turn>`：

1. 创建 Turn 对象
2. 调用 `Turn.run()` 产生事件流
3. 检测到工具调用时，调用 `CoreToolScheduler.schedule()`
4. 工具执行完成后，继续 LLM 调用
5. 返回完整的 Turn 对象

**关键点：**

- 使用 AsyncGenerator 实现流式处理
- Turn 在开始时创建，在结束时返回
- 工具执行是同步的（await），但事件流是异步的（yield）

## 三、Hook 系统架构

### 3.1 Hook 触发机制（基于 gemini-cli）

在 gemini-cli 中，Hook 触发器分散在各个模块：

- `clientHookTriggers.ts`: `fireBeforeAgentHook()`, `fireAfterAgentHook()`
- `coreToolHookTriggers.ts`: `fireBeforeToolHook()`, `fireAfterToolHook()`, `fireToolNotificationHook()`
- `geminiChatHookTriggers.ts`: `fireBeforeModelHook()`, `fireBeforeToolSelectionHook()`

**Hook 系统组件（全局）：**

- `HookSystem`: 主协调器
- `HookRegistry`: Hook 注册表
- `HookRunner`: Hook 执行器
- `HookEventHandler`: 事件处理
- `HookPlanner`: Hook 计划器

### 3.2 Hook 执行流程

**通过 MessageBus 通信：**

```typescript
// 触发器（在 tool-scheduler 中）
export async function fireBeforeToolHook(
  messageBus: MessageBus,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<DefaultHookOutput | undefined> {
  const response = await messageBus.request<HookExecutionRequest, HookExecutionResponse>(
    {
      type: MessageBusType.HOOK_EXECUTION_REQUEST,
      eventName: 'BeforeTool',
      input: { tool_name: toolName, tool_input: toolInput },
    },
    MessageBusType.HOOK_EXECUTION_RESPONSE,
  );
  return response.output ? createHookOutput('BeforeTool', response.output) : undefined;
}
```

**MessageBus 路由到 HookEventHandler：**

1. MessageBus 收到 `HOOK_EXECUTION_REQUEST`
2. 路由到 `HookEventHandler.handleHookExecutionRequest()`
3. 调用对应的 `fire*Event()` 方法
4. 执行匹配的 hooks
5. 返回聚合结果

### 3.3 Hook 集成到工具执行

在 `executeToolWithHooks()` 中（coreToolHookTriggers.ts）：

1. 执行前：`fireBeforeToolHook()` - 可以阻止工具执行
2. 执行工具：`invocation.execute()`
3. 执行后：`fireAfterToolHook()` - 可以添加额外上下文或停止执行

**Hook 输出处理：**

- `getBlockingError()`: 检查是否阻止工具执行
- `shouldStopExecution()`: 检查是否停止整个 Agent 执行
- `getAdditionalContext()`: 获取要添加到结果的额外上下文

### 3.4 ohbaby-code 建议的架构

```
src/core/
├── tool-scheduler/
│   └── coreToolHookTriggers.ts  ← Hook 触发器
│       fireBeforeToolHook()
│       fireAfterToolHook()
│
├── hooks/                        ← 全局 Hook System
│   ├── hookSystem.ts
│   ├── hookRegistry.ts
│   ├── hookRunner.ts
│   ├── hookEventHandler.ts
│   └── types.ts
```

**关键设计点：**

- 触发器分散在各模块（靠近使用点）
- Hook System 全局统一管理
- 通过 MessageBus 或回调函数通信

## 四、AsyncGenerator 与 Turn 的关系

### 4.1 核心理解

AsyncGenerator 用于传递 Turn 的中间状态，而不是创建 Turn。

**Turn 生命周期：**

```
初始化 Turn（记录开始时间）
  ↓
async* generator 逐步填充 Turn
  ├─ yield LLM 事件 → Turn 记录
  ├─ yield 工具事件 → Turn 记录
  └─ yield Agent 事件 → Turn 记录
  ↓
return 完整的 Turn（包含所有事件和结果）
```

### 4.2 实际流程（基于 gemini-cli）

`GeminiClient.sendMessageStream()` 的实现模式：

1. 创建 Turn 对象
2. 调用 `Turn.run()` 产生事件流
3. 每个事件 yield 给调用者
4. 同时 Turn 内部记录状态
5. 最后返回完整的 Turn

**关键点：**

- Turn 在开始时创建
- 事件流实时传递中间状态
- Turn 在结束时返回，包含完整记录

## 五、Message Bus 的作用

### 5.1 Message Bus 的角色

Message Bus 是系统内部的通信枢纽，用于：

1. **工具确认**: 工具执行前的用户确认
2. **Hook 执行**: Hook 的请求-响应通信
3. **事件通知**: 系统事件的发布-订阅

### 5.2 与 Turn 的关系

**Turn**: 数据容器，记录整个流程
**AsyncGenerator**: 数据流动，实时传递中间状态
**Message Bus**: 通信通道，处理中断和确认

**流程示意：**

```
主流程（Turn 记录）
  ↓
需要工具确认？
  ↓
MessageBus.request() ← 分支出去
  ↓
等待用户响应
  ↓
响应返回 → 继续主流程（Turn 继续记录）
```

### 5.3 在工具执行中的使用

在 `CoreToolScheduler` 中：

1. 工具调用请求到达
2. `invocation.shouldConfirmExecute()` 检查是否需要确认
3. 如果需要，通过 MessageBus 发送确认请求
4. 等待用户响应
5. 根据响应执行或取消工具

## 六、总结与建议

### 6.1 文件结构

```
src/core/
├── main-scheduler/
│   ├── client.ts          async* sendMessageStream()
│   └── logger.ts
├── turn.ts                Turn 类定义
├── tool-scheduler/
│   ├── toolScheduler.ts
│   └── coreToolHookTriggers.ts
├── hooks/                 全局 Hook System
│   ├── hookSystem.ts
│   ├── hookRegistry.ts
│   └── hookEventHandler.ts
└── llm-client/
```

### 6.2 执行流程

```
executeTurn() → async* generator
  ├─ yield LLM events → Turn 记录
  ├─ yield Tool events → Turn 记录
  │  ├─ MessageBus.request() 等待确认
  │  ├─ fireBeforeToolHook()
  │  ├─ 执行工具
  │  └─ fireAfterToolHook()
  ├─ yield Agent events → Turn 记录
  └─ return Turn
```

### 6.3 关键原则

1. **Turn 是容器**: 记录整个流程的数据
2. **AsyncGenerator 是流动**: 实时传递中间状态
3. **Message Bus 是通道**: 处理中断、确认、Hook 通信
4. **Hook 是监听**: 触发器分散在各模块，系统全局管理

### 6.4 设计要点

- Turn 放在 `core/` 根部，便于多模块引用
- Hook 触发器靠近使用点，系统全局管理
- 使用 AsyncGenerator 实现流式处理
- Message Bus 统一处理异步通信
