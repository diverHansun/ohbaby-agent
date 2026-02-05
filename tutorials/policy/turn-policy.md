# Turn 分层与 Policy 机制设计

## 一、消息格式与角色

### 1.1 Content 类型（Google Genai SDK）

gemini-cli 使用 Google Genai SDK 的 `Content` 类型，而非 LangGraph 的 `UserMessage`/`AIMessage`：

```typescript
type Content = {
  role: 'user' | 'model' | 'tool';
  parts: Part[];
};
```

**三种角色：**

- `'user'`: 来自用户的消息
- `'model'`: LLM 的响应（可能包含 `functionCall`）
- `'tool'`: 工具执行的结果（`functionResponse`）

**对话循环示例：**

```
Turn #1:
  ├─ User: { role: 'user', parts: [{ text: '修复bug' }] }
  ├─ Model: { role: 'model', parts: [{ functionCall: {...} }] }
  └─ Tool: { role: 'tool', parts: [{ functionResponse: {...} }] }

Turn #2:
  ├─ User: { role: 'user', parts: [{ text: '继续' }] }
  └─ Model: { role: 'model', parts: [{ text: '已完成' }] }
```

### 1.2 与 OpenAI 格式的对比

**OpenAI 格式（iris-code 使用）：**

```typescript
type ChatCompletionMessage = 
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
```

**关键区别：**

- Google: `role: 'model'` + `parts` 数组
- OpenAI: `role: 'assistant'` + `content` 字符串 + 可选的 `tool_calls`

## 二、Turn 的分层结构

### 2.1 核心概念

在 gemini-cli 中，Turn 有隐式的分层：

1. **主 Turn（Main Turn）**: 用户与主 LLM 的完整交互周期
   - 从用户输入开始
   - 可能包含多次 LLM 调用
   - 可能包含多个工具调用（包括 Agent）

2. **Agent Turn**: Agent 内部的单次 LLM 调用周期
   - Agent 在 `AgentExecutor.run()` 中执行多个 Agent Turn
   - 每个 Agent Turn 可能包含工具调用
   - 最多执行 15 轮（`max_turns: 15`）

### 2.2 Turn 的实际实现（turn.ts）

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

**关键点：**

- Turn 是类，不是接口
- 不直接存储用户输入，通过 `chat` 对象访问历史
- 通过事件流（`ServerGeminiStreamEvent`）传递状态变化
- `pendingToolCalls` 只包含待处理的工具调用请求

### 2.3 分层关系示例

```
Main Turn (用户输入到最终响应)
  └─ Turn.run() - Main LLM Call #1
     ├─ Tool: read_file → Result
     └─ Tool: codebase_investigator → AgentExecution
        └─ AgentExecutor.run()
           ├─ Agent Turn #1
           │  ├─ Agent LLM Call
           │  ├─ Tool: glob → Result
           │  └─ Tool: read_file → Result
           ├─ Agent Turn #2
           │  ├─ Agent LLM Call
           │  └─ Tool: grep → Result
           └─ Agent Turn #N (最多 15 轮)
              └─ 返回结构化报告
  └─ Turn.run() - Main LLM Call #2（基于 Agent 结果）
     ├─ Tool: write_file → Result
     └─ Tool: shell → Result
```

## 三、Policy 机制：工具执行的安全控制

### 3.1 ApprovalMode（执行模式）

gemini-cli 支持三种执行模式（policy/types.ts）：

```typescript
export enum ApprovalMode {
  DEFAULT = 'default',    // 默认模式，需要用户确认
  AUTO_EDIT = 'autoEdit', // 自动编辑模式，经过安全检查后自动执行
  YOLO = 'yolo',          // 完全自动，跳过所有确认和检查
}
```

**模式说明：**

1. **DEFAULT**: 工具执行前询问用户是否允许
   - 通过 MessageBus 发送确认请求
   - 等待用户响应
   - 根据响应执行或拒绝

2. **AUTO_EDIT**: 自动执行，但需要经过安全检查
   - Policy Engine 检查规则
   - Safety Checker 执行安全检查（如路径检查）
   - 通过检查 → 自动执行
   - 失败检查 → 拒绝

3. **YOLO**: 完全自动执行
   - 跳过所有确认和检查
   - 直接执行，无提示
   - 仅用于开发/测试环境

### 3.2 PolicyDecision（策略决策）

Policy Engine 返回三种决策（policy/types.ts）：

```typescript
export enum PolicyDecision {
  ALLOW = 'allow',      // 允许执行
  DENY = 'deny',        // 拒绝执行
  ASK_USER = 'ask_user', // 询问用户
}
```

**决策流程：**

```
工具调用请求
  ↓
PolicyEngine.check()
  ├─> 匹配规则（按优先级）
  ├─> 执行 Safety Checker（如果配置）
  └─> 返回决策
       ├─> ALLOW: 直接执行
       ├─> DENY: 拒绝并发送拒绝消息
       └─> ASK_USER: 发送确认请求给 UI
```

### 3.3 Policy 配置（TOML 文件）

**示例：write.toml**

```toml
# 默认规则：询问用户
[[rule]]
toolName = "write_file"
decision = "ask_user"
priority = 10

# autoEdit 模式：自动允许（带安全检查）
[[rule]]
toolName = "write_file"
decision = "allow"
priority = 15
modes = ["autoEdit"]

[rule.safety_checker]
type = "in-process"
name = "allowed-path"  # 只允许修改特定路径
```

**示例：yolo.toml**

```toml
# 匹配所有工具，最高优先级
[[rule]]
decision = "allow"
priority = 999
modes = ["yolo"]
```

### 3.4 工具确认流程（coreToolScheduler.ts）

工具确认流程（coreToolScheduler.ts）：

1. 工具调用请求 → `invocation.shouldConfirmExecute(signal)`
2. 如果启用 MessageBus → `getMessageBusDecision()` 获取 Policy 决策
3. 根据决策：
   - `ALLOW`: 直接执行（`scheduled` 状态）
   - `DENY`: 抛出错误
   - `ASK_USER`: 返回确认详情，等待用户响应（`awaiting_approval` 状态）

## 四、Message Bus：系统间通信

### 4.1 MessageBus 的角色

MessageBus 是系统内部的事件总线（confirmation-bus/message-bus.ts），基于 Node.js 的 `EventEmitter`：

```
┌─────────────────────────────────────┐
│      Policy Engine                  │
│  Tool Call → Check → Decision      │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│      MessageBus (EventEmitter)      │
│  - publish(message)                 │
│  - subscribe(type, handler)         │
│  - request(request, responseType)    │
└──────────────┬──────────────────────┘
               ↓
┌─────────────────────────────────────┐
│  订阅者：UI / Logger / Hook System  │
└─────────────────────────────────────┘
```

### 4.2 消息类型（confirmation-bus/types.ts）

```typescript
export enum MessageBusType {
  // 工具确认相关
  TOOL_CONFIRMATION_REQUEST = 'tool-confirmation-request',
  TOOL_CONFIRMATION_RESPONSE = 'tool-confirmation-response',
  TOOL_POLICY_REJECTION = 'tool-policy-rejection',
  TOOL_EXECUTION_SUCCESS = 'tool-execution-success',
  TOOL_EXECUTION_FAILURE = 'tool-execution-failure',
  
  // 钩子相关
  HOOK_EXECUTION_REQUEST = 'hook-execution-request',
  HOOK_EXECUTION_RESPONSE = 'hook-execution-response',
  HOOK_POLICY_DECISION = 'hook-policy-decision',
  
  // 策略更新
  UPDATE_POLICY = 'update-policy',
}
```

### 4.3 请求-响应模式

MessageBus 实现了基于 `correlationId` 的请求-响应模式：

```typescript
// 发送确认请求并等待响应
const response = await messageBus.request(
  {
    type: MessageBusType.TOOL_CONFIRMATION_REQUEST,
    toolCall: { name: 'write_file', args: {...} },
    // correlationId 由 request() 自动生成
  },
  MessageBusType.TOOL_CONFIRMATION_RESPONSE,
  60000 // 超时时间（默认 60 秒）
);
```

**工作流程：**

1. `request()` 生成 `correlationId`
2. 订阅响应类型
3. 发布请求（包含 `correlationId`）
4. 等待匹配 `correlationId` 的响应
5. 超时或收到响应后清理订阅

### 4.4 Policy Engine 集成

当 MessageBus 收到 `TOOL_CONFIRMATION_REQUEST` 时：

```typescript
async publish(message: Message): Promise<void> {
  if (message.type === MessageBusType.TOOL_CONFIRMATION_REQUEST) {
    // 1. 调用 Policy Engine 检查
    const { decision } = await this.policyEngine.check(
      message.toolCall,
      message.serverName,
    );

    switch (decision) {
      case PolicyDecision.ALLOW:
        // 直接发送确认响应
        this.emitMessage({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId: message.correlationId,
          confirmed: true,
        });
        break;
        
      case PolicyDecision.DENY:
        // 发送拒绝消息和响应
        this.emitMessage({
          type: MessageBusType.TOOL_POLICY_REJECTION,
          toolCall: message.toolCall,
        });
        this.emitMessage({
          type: MessageBusType.TOOL_CONFIRMATION_RESPONSE,
          correlationId: message.correlationId,
          confirmed: false,
        });
        break;
        
      case PolicyDecision.ASK_USER:
        // 传递给 UI 等待用户确认
        this.emitMessage(message);
        break;
    }
  }
}
```

## 五、iris-code 设计建议

### 5.1 Turn 分层设计

**建议的 Turn 结构：**

```typescript
// 主 Turn
interface MainTurn {
  // 用户输入
  userMessage: ChatCompletionMessage;
  
  // LLM 调用记录
  llmCalls: {
    request: ChatCompletionCreateParams;
    response: ChatCompletionResponse;
    toolCalls?: ToolCall[];
  }[];
  
  // 工具执行记录
  toolExecutions: {
    toolName: string;
    toolInput: unknown;
    toolResult: ToolResult;
    agentExecution?: AgentExecution; // 如果是 Agent 工具
  }[];
  
  // 元数据
  turnNumber: number;
  startTime: Date;
  endTime: Date;
  finishReason?: FinishReason;
}

// Agent 内部 Turn
interface AgentTurn {
  llmCall: {
    request: ChatCompletionCreateParams;
    response: ChatCompletionResponse;
  };
  
  toolCalls: {
    toolName: string;
    toolInput: unknown;
    toolResult: unknown;
  }[];
  
  turnNumber: number; // Agent 内部的 turn 编号
  agentId: string;
}
```

### 5.2 ApprovalMode 简化设计

相比 gemini-cli 的 TOML 配置，iris-code 可以简化为：

```typescript
enum ApprovalMode {
  ASK_USER = 'ask_user',  // 每次询问用户
  AUTO = 'auto',          // 自动执行（带安全检查）
  YOLO = 'yolo',          // 完全自动
}

// 配置
config.approvalMode = ApprovalMode.ASK_USER;
```

**简化理由：**

- 不需要复杂的 TOML 配置
- 通过代码配置更灵活
- 减少配置文件的维护成本

### 5.3 Message Bus 简化设计

**推荐：使用回调函数**

```typescript
interface ToolExecutionContext {
  onNeedConfirmation?: (toolCall: ToolCall) => Promise<boolean>;
  onBeforeExecute?: (toolCall: ToolCall) => void;
  onAfterExecute?: (result: ToolResult) => void;
}
```

**可选：使用 EventEmitter（如果需要更复杂的通信）**

```typescript
class SimpleMessageBus extends EventEmitter {
  async request<TRequest, TResponse>(
    request: TRequest,
    responseType: string,
    timeout: number = 60000
  ): Promise<TResponse> { /* ... */ }
}
```

### 5.4 Policy 决策流程

**简化的 Policy 检查：**

```typescript
async function checkToolPermission(
  toolCall: ToolCall,
  approvalMode: ApprovalMode
): Promise<'ALLOW' | 'DENY' | 'ASK_USER'> {
  // 1. YOLO 模式：直接允许
  if (approvalMode === ApprovalMode.YOLO) {
    return 'ALLOW';
  }
  
  // 2. AUTO 模式：执行安全检查
  if (approvalMode === ApprovalMode.AUTO) {
    const safetyCheck = await runSafetyCheck(toolCall);
    return safetyCheck.passed ? 'ALLOW' : 'DENY';
  }
  
  // 3. ASK_USER 模式：询问用户
  return 'ASK_USER';
}
```

## 六、关键设计决策总结

| 方面 | gemini-cli | iris-code 建议 |
|------|-----------|---------------|
| **消息格式** | Google Content (user/model/tool) | OpenAI ChatMessage (user/assistant/tool) |
| **Turn 分层** | 隐式（在 executor 中） | 显式（MainTurn vs AgentTurn） |
| **ApprovalMode** | DEFAULT / AUTO_EDIT / YOLO | ASK_USER / AUTO / YOLO |
| **Policy 配置** | TOML 文件 + 代码动态配置 | 代码配置（枚举 + 函数） |
| **Message Bus** | 完整的 EventEmitter | 可选：简化为回调函数 |
| **确认机制** | MessageBus 请求-响应 | 回调函数或简化 MessageBus |

## 七、实现要点

### 7.1 工具确认流程

1. **工具调用请求** → `invocation.shouldConfirmExecute()`
2. **Policy 检查** → 返回 `ALLOW` / `DENY` / `ASK_USER`
3. **用户确认**（如果需要）→ 通过回调或 MessageBus
4. **执行工具** → 更新状态为 `executing`
5. **返回结果** → 更新状态为 `success` / `error`

### 7.2 状态管理

工具调用有明确的状态流转：

```
validating → scheduled → executing → success/error
                ↓
         awaiting_approval (如果需要确认)
```

### 7.3 错误处理

- **Policy DENY**: 抛出错误，工具不执行
- **用户拒绝**: 状态更新为 `cancelled`
- **超时**: 默认返回 `ASK_USER`（tools.ts 第 208 行）

### 7.4 非交互模式

在非交互模式下（`nonInteractive: true`），`ASK_USER` 决策会被转换为 `DENY`（policy-engine.ts 第 333-334 行）。
