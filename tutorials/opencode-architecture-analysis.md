# OpenCode vs Gemini-CLI vs Iris-Code 架构对比分析

## 一、核心生命周期状态机对比

### 1. OpenCode 的生命周期架构

```
用户输入 → SessionPrompt.prompt()
   ↓
创建 User Message (createUserMessage)
   ↓
进入核心循环 loop() ← 状态机核心
   ↓
┌─────────────────────────────────────────┐
│  while (true) {                         │
│    1. 获取消息历史                       │
│    2. 检查是否有待处理任务               │
│    3. 处理子任务 (Subtask/Compaction)    │
│    4. 创建 SessionProcessor              │
│    5. 解析工具 (resolveTools)            │
│    6. processor.process() 调用 LLM      │
│    7. 循环直到完成或停止                 │
│  }                                      │
└─────────────────────────────────────────┘
   ↓
SessionProcessor.process()
   ↓
┌─────────────────────────────────────────┐
│  while (true) {  // 处理重试循环          │
│    LLM.stream()                         │
│    for await (event) {                  │
│      - reasoning-start/delta/end        │
│      - tool-call → 执行工具              │
│      - tool-result → 保存结果            │
│      - text-delta → 流式输出             │
│      - finish-step → 完成一轮            │
│    }                                    │
│  }                                      │
└─────────────────────────────────────────┘
```

**关键特征：**
- **双层循环**：外层 `SessionPrompt.loop()` 管理多步推理，内层 `SessionProcessor.process()` 管理单次 LLM 调用和重试
- **状态管理**：通过 `MessageV2.Part` 持久化每个工具调用、文本输出的状态
- **Agent 不是工具**：Agent 是配置（权限、提示词、工具列表），不作为工具暴露给 LLM

### 2. Gemini-CLI 的生命周期架构

```
用户输入 → MainAgent.sendMessage()
   ↓
创建 Turn (轮次)
   ↓
┌─────────────────────────────────────────┐
│  Turn.execute()                         │
│    ↓                                    │
│  构建工具列表（包含 Subagent）           │
│    ↓                                    │
│  LLM.generateContent(tools)             │
│    ↓                                    │
│  for (functionCall in response) {       │
│    if (isDelegateToAgentTool) {        │
│      → 创建 SubagentToolWrapper         │
│      → LocalSubagentInvocation          │
│         → 递归调用 MainAgent            │
│         → 返回子任务结果                 │
│    } else {                             │
│      → 执行普通工具                      │
│    }                                    │
│  }                                      │
│    ↓                                    │
│  检查是否需要继续循环                     │
└─────────────────────────────────────────┘
```

**关键特征：**
- **Subagent 作为工具**：通过 `delegate_to_agent` 工具暴露给 LLM
- **递归调用**：Subagent 实际上是递归调用主 Agent，创建新的会话
- **单层循环**：每个 Turn 内部自我循环直到完成或达到最大步数

### 3. Iris-Code 当前架构（你的设计）

```
Main-Scheduler
   ↓
Turn 管理
   ↓
LLM Client
   ↓
工具调用？
```

**问题分析：**
- 状态管理不清晰
- 工具执行逻辑分散
- Agent 定位模糊

## 二、Agent 的定位对比

### OpenCode 的 Agent 定位

**Agent = 配置模板**，不是代码执行主体

```typescript
// agent/agent.ts
export const Info = z.object({
  name: z.string(),                      // Agent 名称
  mode: z.enum(["subagent", "primary"]), // 模式：subagent 不能直接使用
  permission: z.object({...}),           // 权限配置
  tools: z.record(z.string(), z.boolean()), // 允许的工具
  prompt: z.string().optional(),         // 自定义提示词
  model: z.object({...}).optional(),     // 默认模型
  temperature: z.number().optional(),    // 采样温度
})

// 内置 Agent
const agents = {
  build: {  // 默认主 Agent
    mode: "primary",
    permission: {...},
    tools: {...},
  },
  plan: {  // 规划 Agent
    mode: "primary",
    permission: { edit: "deny", bash: {...} }, // 只能读
    tools: {...},
  },
  explore: {  // 探索 Agent（subagent）
    mode: "subagent",  // 不能直接选择
    tools: { edit: false, write: false }, // 只读工具
    prompt: PROMPT_EXPLORE,
  },
  general: {  // 通用 subagent
    mode: "subagent",
    description: "多步骤并行任务执行",
    tools: { todoread: false, todowrite: false },
  }
}
```

**关键机制：**

1. **Task Tool 调用 Subagent**

```typescript
// tool/task.ts - 这是一个 LLM 可见的工具
const TaskTool: Tool.Info = {
  id: "task",
  description: "Execute complex multi-step tasks using a subagent",
  parameters: z.object({
    prompt: z.string(),
    subagent_type: z.enum(["general", "explore"]), // 只能用 subagent
  }),
  async execute(params, ctx) {
    // 创建子会话
    const session = await Session.create({ parentID: ctx.sessionID });
    
    // 使用指定的 subagent 配置
    const agent = await Agent.get(params.subagent_type);
    
    // 在子会话中执行
    await SessionPrompt.prompt({
      sessionID: session.id,
      agent: agent.name,
      parts: [{ type: "text", text: params.prompt }],
    });
    
    return result;
  }
}
```

2. **用户可选择 Primary Agent**

```
用户消息附带 agent: "plan" 参数
   ↓
SessionPrompt.prompt({ agent: "plan", ... })
   ↓
使用 "plan" Agent 配置（权限、工具、提示词）
   ↓
LLM 看不到 Agent 列表，只能通过 task 工具调用 subagent
```

### Gemini-CLI 的 Agent 定位

**Agent = 工具**，LLM 可以直接选择委派

```typescript
// agents/delegate-to-agent-tool.ts
export class DelegateToAgentTool extends BaseDeclarativeTool {
  constructor(registry: AgentRegistry, ...) {
    const definitions = registry.getAllDefinitions();
    
    // 构建 discriminated union schema
    const agentSchemas = definitions.map(def => 
      z.object({
        agent_name: z.literal(def.name).describe(def.description),
        ...def.inputConfig.inputs, // 各 agent 的参数
      })
    );
    
    super(
      'delegate_to_agent',
      'Delegate to Agent',
      `Delegate tasks to specialized agents: ${definitions.map(d => d.name).join(', ')}`,
      ...
    );
  }
}

// LLM 看到的工具定义
{
  "name": "delegate_to_agent",
  "description": "Delegate to specialized agents",
  "parameters": {
    "type": "object",
    "oneOf": [
      {
        "properties": {
          "agent_name": { "enum": ["codebase-investigator"], "description": "..." },
          "query": { "type": "string" }
        }
      },
      {
        "properties": {
          "agent_name": { "enum": ["custom-agent"], "description": "..." },
          "task": { "type": "string" }
        }
      }
    ]
  }
}
```

**特征：**
- LLM 可以"看到"所有可用的 subagent
- LLM 自主决定何时委派给哪个 agent
- 更透明，但可能导致 LLM 过度使用

### Iris-Code 应该怎么做？

## 三、Iris-Code 架构建议

### 推荐架构：**融合模式**

**借鉴 OpenCode 的双层循环 + Gemini-CLI 的 Turn 概念**

```
src/core/
├── session/              # 会话管理
│   ├── session-manager.ts
│   └── message.ts
├── scheduler/            # 重命名：main-scheduler → scheduler
│   ├── loop.ts          # 核心循环（类似 OpenCode SessionPrompt.loop）
│   └── processor.ts     # LLM 调用处理器（类似 OpenCode SessionProcessor）
├── turn/                # Turn 管理（借鉴 Gemini-CLI）
│   └── turn-executor.ts
├── agent/               # Agent 配置系统
│   ├── agent-manager.ts
│   └── builtin-agents.ts
└── tools/               # 工具系统
    ├── tool-registry.ts
    └── implementations/
```

### 生命周期状态机设计

```typescript
// core/scheduler/loop.ts
export class SessionLoop {
  async run(sessionId: string): Promise<void> {
    let step = 0;
    
    while (true) {
      // 1. 获取最新消息历史
      const messages = await this.getMessages(sessionId);
      const lastUser = messages.findLast(m => m.role === 'user');
      const lastAssistant = messages.findLast(m => m.role === 'assistant');
      
      // 2. 检查退出条件
      if (lastAssistant?.finish && lastAssistant.finish !== 'tool-calls') {
        break;
      }
      
      // 3. 获取 Agent 配置
      const agent = await this.agentManager.get(lastUser.agentName);
      
      // 4. 创建处理器
      const processor = new TurnProcessor({
        sessionId,
        agent,
        model: await this.getModel(lastUser.model),
        messages,
      });
      
      // 5. 执行一轮（包含 LLM 调用和工具执行）
      const result = await processor.execute();
      
      // 6. 检查是否继续
      if (result.status === 'stop') break;
      step++;
    }
  }
}

// core/scheduler/processor.ts
export class TurnProcessor {
  async execute(): Promise<TurnResult> {
    // 1. 解析可用工具（包含 task tool 如果需要 subagent）
    const tools = await this.resolveTools();
    
    // 2. 调用 LLM
    const stream = await this.llmClient.stream({
      messages: this.messages,
      tools,
      ...this.agent.options,
    });
    
    // 3. 处理流式输出
    for await (const event of stream) {
      switch (event.type) {
        case 'tool-call':
          await this.handleToolCall(event);
          break;
        case 'text-delta':
          await this.handleTextDelta(event);
          break;
        case 'finish':
          return { status: event.finishReason === 'stop' ? 'stop' : 'continue' };
      }
    }
  }
  
  private async handleToolCall(event: ToolCallEvent) {
    //  执行工具（普通工具或 task tool）
    const tool = this.tools[event.toolName];
    const result = await tool.execute(event.parameters);
    
    // 保存工具调用结果到消息
    await this.saveToolResult(event.toolCallId, result);
  }
}
```

### Agent 定位建议

**采用 OpenCode 模式：Agent 是配置，不直接暴露给 LLM**

理由：
1. 更清晰的权限控制
2. 减少 LLM 滥用 delegation 的风险
3. 用户可以在 CLI 层选择主 Agent，LLM 通过 task 工具隐式调用 subagent

```typescript
// core/agent/builtin-agents.ts
export const BUILTIN_AGENTS = {
  default: {
    name: 'default',
    mode: 'primary',
    description: 'General coding assistant',
    tools: {
      file_read: true,
      file_write: true,
      bash: true,
      task: true, // 允许委派任务
    },
    permissions: {
      file_write: 'ask',
      bash: 'ask',
    },
  },
  
  analyzer: {
    name: 'analyzer',
    mode: 'subagent', // 不能直接选择
    description: 'Code analysis specialist',
    tools: {
      file_read: true,
      file_write: false, // 只读
      bash: false,
    },
  },
};

// core/tools/implementations/task-tool.ts
export class TaskTool implements Tool {
  async execute(params: { prompt: string; subagent?: string }) {
    // 创建子会话
    const subSession = await this.sessionManager.createChild(this.sessionId);
    
    // 使用 subagent 配置
    const agent = params.subagent 
      ? await this.agentManager.get(params.subagent)
      : await this.agentManager.get('default');
    
    if (agent.mode === 'primary') {
      throw new Error('Cannot delegate to primary agent');
    }
    
    // 在子会话中执行
    const loop = new SessionLoop(...);
    await loop.run(subSession.id);
    
    return { output: subSession.summary };
  }
}
```

### 关键决策总结

| 方面 | OpenCode | Gemini-CLI | Iris-Code 建议 |
|------|----------|------------|----------------|
| **状态机位置** | `SessionPrompt.loop()` | `Turn.execute()` | `SessionLoop.run()` |
| **Agent 定位** | 配置模板 | 工具 | **配置模板** ✅ |
| **Subagent 暴露** | 通过 task tool | 通过 delegate tool | **通过 task tool** ✅ |
| **循环结构** | 双层循环 | 单层循环 | **双层循环** ✅ |
| **工具执行** | SessionProcessor 内 | Turn 内 | **TurnProcessor 内** ✅ |

## 四、Main-Scheduler 是否合理？

**结论：部分合理，但需要重构**

**合理部分：**
- 中心化调度逻辑
- 管理 Turn/轮次

**需要改进：**
1. **重命名**：`main-scheduler` → `session-scheduler` 或 `loop-manager`
2. **职责明确化**：
   - `loop.ts`: 管理多步骤循环
   - `processor.ts`: 单次 LLM 调用和工具执行
3. **与 Turn 解耦**：Turn 应该是数据结构，而不是执行主体

### 建议的文件结构

```
core/
├── session-loop/         # 重命名
│   ├── loop.ts          # 核心循环
│   ├── processor.ts     # LLM 调用处理
│   └── state-machine.ts # 状态转换逻辑
├── turn/
│   ├── turn.ts          # Turn 数据结构
│   └── turn-manager.ts  # Turn CRUD
└── agent/
    ├── agent-manager.ts
    └── types.ts
```

## 五、总结

1. **OpenCode 的状态机**更适合教育项目，清晰的双层循环易于理解
2. **Agent 应该是配置**，不是工具 - 这样权限控制更清晰
3. **main-scheduler 合理**，但建议分成 `loop` 和 `processor` 两个模块
4. **借鉴 OpenCode 的 SessionProcessor 设计**，在其中处理流式输出、工具调用、重试
