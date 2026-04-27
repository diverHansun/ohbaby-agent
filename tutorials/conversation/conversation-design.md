# Conversation 模块设计

## 一、Conversation 模块的职责

### 1.1 gemini-cli 的设计（参考标准）

在 gemini-cli 中，没有单独的 "conversation" 模块，职责分散到：

**消息管理：**

- `core/geminiChat.ts`: 内存中的消息历史管理（`getHistory`, `addHistory`, `setHistory`）
- `services/chatRecordingService.ts`: 消息持久化到磁盘、会话记录、Token 统计

**上下文构建：**

- `utils/environmentContext.ts`: 环境信息（cwd、日期、平台、目录结构）
- `core/prompts.ts`: 系统提示词构建（`getCoreSystemPrompt`）

### 1.2 Conversation 的核心职责

基于 gemini-cli 的实践，conversation 模块应该负责：

1. **消息历史管理（内存）**
   - 存储消息序列
   - 提供获取/追加/设置接口
   - 消息验证（角色、有效性）

2. **上下文构建**
   - 环境信息（cwd、日期、平台）
   - 系统提示词
   - 初始历史（环境上下文）

3. **消息格式化**
   - 转换为 LLM 可用的格式
   - 处理消息角色（user/assistant/tool）

**Conversation 不负责：**

- 消息持久化（由 session service 管理）
- 消息执行（由 tool-scheduler 管理）
- 消息流式传输（由 main-scheduler 管理）
- 消息压缩（由 compression service 管理）

## 二、消息存储架构

### 2.1 分层存储（基于 gemini-cli）

**内存层（运行时）：**

- `GeminiChat.history: Content[]` - 当前会话的消息历史
- 通过 `getHistory()`, `addHistory()`, `setHistory()` 管理

**磁盘层（持久化）：**

- `ChatRecordingService` - 自动记录到磁盘
- 存储位置：`~/.gemini/tmp/<project_hash>/chats/session-<timestamp>-<id>.json`
- 格式：`ConversationRecord`（包含 sessionId、messages、tokens、thoughts）

### 2.2 ConversationRecord 结构（chatRecordingService.ts）

```typescript
interface ConversationRecord {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: MessageRecord[];
  summary?: string;
}
```

**MessageRecord 类型：**

- `type: 'user' | 'gemini' | 'tool'`
- `content`: 消息内容
- `toolCalls`: 工具调用（如果是 gemini 消息）
- `thoughts`: 思考过程（如果是 gemini 消息）
- `tokens`: Token 统计

### 2.3 ohbaby-code 建议的存储结构

```
src/core/conversation/
├── conversation.ts        内存管理（消息历史）
└── contextBuilder.ts      上下文构建

src/services/session/
├── sessionRecorder.ts     持久化到磁盘
├── sessionLoader.ts        从磁盘恢复
└── sessionStore.ts        存储目录管理
```

**存储位置：**

```
~/.ohbaby-code/
├── sessions/
│   └── session-<projectHash>-<sessionId>.json
```

## 三、消息历史管理

### 3.1 GeminiChat 的实现（geminiChat.ts）

```typescript
export class GeminiChat {
  private history: Content[] = [];
  private readonly chatRecordingService: ChatRecordingService;

  getHistory(curated: boolean = false): Content[] {
    const history = curated
      ? extractCuratedHistory(this.history)
      : this.history;
    return structuredClone(history); // 深拷贝，避免外部修改
  }

  addHistory(content: Content): void {
    this.history.push(content);
  }

  setHistory(history: Content[]): void {
    validateHistory(history); // 验证角色
    this.history = history;
  }
}
```

**关键点：**

- `getHistory()` 返回深拷贝，避免外部修改内部状态
- `curated` 参数控制是否过滤无效消息
- `validateHistory()` 验证消息角色（必须是 'user' 或 'model'）

### 3.2 两种历史概念

**Comprehensive History（完整历史）：**

- 包含所有消息，包括无效的/重试的响应
- 用于调试和记录
- 存储在 `GeminiChat.history` 中

**Curated History（精选历史）：**

- 移除无效的 model 响应（通过 `extractCuratedHistory()`）
- 只保留有效的交互序列
- 用于发送给 LLM（避免 API 错误）

**为什么需要两种历史：**

- LLM API 不接受无效的消息序列（无效的 function call、空响应等）
- 但需要保留完整记录用于调试和审计
- `extractCuratedHistory()` 会移除无效的 model 响应，保留有效的

### 3.3 消息验证（geminiChat.ts）

```typescript
function validateHistory(history: Content[]) {
  for (const content of history) {
    if (content.role !== 'user' && content.role !== 'model') {
      throw new Error(`Role must be user or model, but got ${content.role}.`);
    }
  }
}

function isValidContent(content: Content): boolean {
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (!part.thought && part.text !== undefined && part.text === '') {
      return false;
    }
  }
  return true;
}
```

## 四、上下文构建

### 4.1 初始历史（environmentContext.ts）

`getInitialChatHistory()` 构建初始历史，包含：

- 环境信息：日期、平台、临时目录
- 目录结构：工作目录的文件夹结构
- 设置完成提示：告知 LLM 设置已完成

**实现：**

```typescript
export async function getInitialChatHistory(
  config: Config,
  extraHistory?: Content[],
): Promise<Content[]> {
  const envParts = await getEnvironmentContext(config);
  const envContextString = envParts.map((part) => part.text || '').join('\n\n');

  const allSetupText = `
${envContextString}

Reminder: Do not return an empty response when a tool call is required.

My setup is complete. I will provide my first command in the next turn.
  `.trim();

  return [
    {
      role: 'user',
      parts: [{ text: allSetupText }],
    },
    ...(extraHistory ?? []),
  ];
}
```

### 4.2 系统提示词（prompts.ts）

`getCoreSystemPrompt()` 构建系统提示词，包含：

- 核心指令（Core Mandates）
- 主要工作流（Primary Workflows）
- 操作指南（Operational Guidelines）
- 安全规则（Security and Safety Rules）
- 用户记忆（User Memory）

**关键点：**

- 系统提示词通过 `systemInstruction` 参数传递给 `GeminiChat`
- 不是作为消息的一部分，而是 API 的独立参数
- 可以通过 `setSystemInstruction()` 动态更新

### 4.3 GeminiChat 的初始化（client.ts）

```typescript
async startChat(
  extraHistory?: Content[],
  resumedSessionData?: ResumedSessionData,
): Promise<GeminiChat> {
  const history = await getInitialChatHistory(this.config, extraHistory);
  const userMemory = this.config.getUserMemory();
  const systemInstruction = getCoreSystemPrompt(this.config, userMemory);
  
  return new GeminiChat(
    this.config,
    systemInstruction,
    tools,
    history,
    resumedSessionData,
  );
}
```

## 五、消息持久化

### 5.1 ChatRecordingService 的工作方式

**初始化：**

- `initialize()`: 创建新会话文件或恢复现有会话
- 文件路径：`<projectTempDir>/chats/session-<timestamp>-<id>.json`

**记录消息：**

- `recordMessage()`: 记录用户或模型消息
- `recordToolCalls()`: 记录工具调用
- `recordThought()`: 记录思考过程
- `recordMessageTokens()`: 记录 Token 统计

**特点：**

- 自动记录：每次 `addHistory()` 后自动调用
- 增量更新：使用 `updateConversation()` 更新文件
- 包含元数据：thoughts、tokens、toolCalls

### 5.2 会话恢复

**恢复流程：**

1. 加载会话文件（`ResumedSessionData`）
2. 解析 `ConversationRecord`
3. 转换为 `Content[]` 格式
4. 传递给 `GeminiChat` 构造函数

**关键点：**

- 恢复时更新 sessionId（如果配置变化）
- 保留完整的消息历史（包括 thoughts、tokens）
- 验证消息有效性

## 六、ohbaby-code Conversation 设计建议

### 6.1 模块结构

```
src/core/conversation/
├── conversation.ts          主类（消息历史管理）
├── contextBuilder.ts        上下文构建
├── messageValidator.ts      消息验证
└── index.ts

src/services/session/
├── sessionRecorder.ts       持久化
├── sessionLoader.ts          恢复
└── sessionStore.ts           存储管理
```

### 6.2 Conversation 类接口

```typescript
export class Conversation {
  private messages: ChatCompletionMessage[] = [];
  private sessionId: string;
  private context: ConversationContext;

  // 消息管理
  getMessages(): ChatCompletionMessage[] { }
  addMessage(message: ChatCompletionMessage): void { }
  setMessages(messages: ChatCompletionMessage[]): void { }
  clearMessages(): void { }

  // 上下文
  getSystemMessage(): ChatCompletionMessage { }
  getInitialHistory(): ChatCompletionMessage[] { }
  
  // 完整消息列表（用于 LLM）
  getFullMessages(): ChatCompletionMessage[] {
    return [
      this.getSystemMessage(),
      ...this.getInitialHistory(),
      ...this.messages
    ];
  }

  // 会话信息
  getSessionId(): string { }
}
```

### 6.3 与 Main-Scheduler 的集成

在 `main-scheduler/client.ts` 中：

1. 获取历史：`conversation.getFullMessages()`
2. 添加用户消息：构建完整消息列表
3. 调用 LLM：使用完整消息列表
4. 保存消息：`conversation.addMessage()` 保存用户和助手消息
5. 工具结果：`conversation.addMessage()` 保存工具消息

**关键点：**

- Conversation 只管理内存中的消息
- 持久化由 SessionRecorder 负责（可选）
- 系统消息通过 `getSystemMessage()` 获取，不是存储在 messages 中

### 6.4 消息顺序要求（OpenAI API）

OpenAI API 对消息顺序有严格要求：

1. **Tool 消息必须跟在有 tool_calls 的 assistant 消息之后**
2. **每个 tool_call_id 必须有且仅有一个 tool 消息**
3. **Tool 消息的顺序必须与 tool_calls 数组顺序一致**
4. **所有 tool_calls 必须有对应的 tool 消息**

**实现注意：**

- 在添加消息时验证顺序
- 工具执行完成后立即添加 tool 消息
- 避免重复的 tool 消息（abort 场景）

## 七、总结对比

| 方面 | gemini-cli | ohbaby-code 建议 |
|------|-----------|---------------|
| **消息存储** | `GeminiChat.history: Content[]` | `Conversation.messages: ChatCompletionMessage[]` |
| **系统消息** | `systemInstruction` 参数（独立） | `getSystemMessage()` 方法 |
| **初始历史** | `getInitialChatHistory()` | `getInitialHistory()` |
| **上下文** | 嵌入在初始历史中 | `ConversationContext` 对象 |
| **持久化** | `ChatRecordingService` | `SessionRecorder`（services/session） |
| **历史验证** | `curated` vs `comprehensive` | 暂时只用 `comprehensive`，后续可添加 `curated` |
| **会话恢复** | `resumeSession()` | `SessionLoader.load()` |

## 八、设计要点

1. **职责分离**: Conversation 管理内存，Session 管理持久化
2. **深拷贝**: `getMessages()` 返回深拷贝，避免外部修改
3. **消息验证**: 添加消息时验证角色和有效性
4. **系统消息**: 不作为消息存储，通过方法动态获取
5. **初始历史**: 包含环境上下文，作为第一条用户消息
6. **持久化时机**: 每次 `addMessage()` 后自动持久化（可选）
