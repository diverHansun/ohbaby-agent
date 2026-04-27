# ohbaby-agent Architecture Analysis & Design Direction

## Executive Summary

Based on detailed analysis of `gemini-cli` and `mini-kode` core architectures, combined with ohbaby-agent's existing tutorial documents, this document provides:

1. **Gap Analysis**: What components are currently missing from `src/core`
2. **Main-Scheduler Design**: From simple-to-complex approach
3. **Complete Request-to-Completion Cycle**: How user input flows to completion
4. **Architecture Direction**: Recommended design strategy for ohbaby-agent

**Key Insight**: ohbaby-agent is positioned between gemini-cli (feature-rich) and mini-kode (minimal) - it should adopt gemini-cli's architectural sophistication with mini-kode's clarity and separation of concerns.

---

## Part 1: Gap Analysis - What's Missing from src/core

### Current State of ohbaby-agent/src/core

```
src/core/
├── conversation/          [EMPTY - needs implementation]
├── llm-client/           [✓ COMPLETE - 537 lines + 384 tests]
│   ├── types.ts
│   ├── client.ts
│   ├── streaming.ts
│   ├── index.ts
│   └── llm-client.test.ts
│
├── main-scheduler/       [PLACEHOLDER - needs design]
│   ├── client.ts
│   ├── logger.ts
│   └── turn.ts
│
├── system-prompts/       [EMPTY - needs implementation]
├── tool-scheduler/       [EMPTY - needs implementation]
└── turn.ts              [EMPTY - needs implementation]
```

### Missing Core Modules (In Priority Order)

#### 1. **Conversation Module** (High Priority)
**Status**: Empty directory
**Purpose**: Manage conversation state and history
**Responsibilities**:
- Store message history (in-memory)
- Provide message retrieval (full, curated, comprehensive)
- Handle message addition and validation
- Expose system message and initial context
- Track conversation metadata

**Design Pattern**: Based on ohbaby-agent tutorial `conversation-design.md`
- Separate concerns: Message memory vs. Persistence
- SessionService handles database persistence
- Conversation class handles in-memory state

**Estimated Size**: 150-200 lines

**Key Types to Implement**:
```typescript
interface Conversation {
  getMessages(): ChatCompletionMessage[]
  addMessage(message: ChatCompletionMessage): void
  setMessages(messages: ChatCompletionMessage[]): void
  getSystemMessage(): string
  getInitialHistory(): ChatCompletionMessage[]
  // Metadata
  messageCount: number
  tokenEstimate: number
}
```

#### 2. **Turn Module** (High Priority)
**Status**: Empty file
**Purpose**: Represent a single user-request-to-completion cycle
**Responsibilities**:
- Container for a complete agentic loop iteration
- Accumulate LLM response chunks
- Parse and collect tool calls
- Track turn state and metadata
- Emit turn events (start, update, complete, error)
- Support cancellation via AbortSignal

**Design Pattern**: Based on ohbaby-agent tutorial `turn-hook.md`
- AsyncGenerator for streaming
- Hook system for extensibility
- Message bus integration for events

**Estimated Size**: 250-350 lines

**Key Types to Implement**:
```typescript
interface Turn {
  turnId: string
  messages: ChatCompletionMessage[]
  startTime: Date
  state: 'pending' | 'executing' | 'tool_execution' | 'complete' | 'error'

  // Main execution
  execute(options: TurnExecutionOptions): AsyncGenerator<TurnEvent>

  // Events during execution
  onStart(callback: () => void): void
  onUpdate(callback: (update: TurnUpdate) => void): void
  onToolCall(callback: (toolCall: ParsedToolCall) => void): void
  onComplete(callback: (result: TurnResult) => void): void
  onError(callback: (error: Error) => void): void
}

type TurnEvent =
  | { type: 'content_chunk', content: string }
  | { type: 'tool_call', toolCall: ParsedToolCall }
  | { type: 'complete', response: ChatCompletionMessage, toolCalls?: ParsedToolCall[] }
  | { type: 'error', error: Error }
```

#### 3. **Tool Scheduler Module** (High Priority)
**Status**: Empty directory
**Purpose**: Manage tool discovery, validation, execution, and permission handling
**Responsibilities**:
- Discover available tools (built-in + MCP)
- Validate tool calls before execution
- Execute tools with permission checking
- Handle tool errors and retries
- Convert tool results to LLM format
- Support concurrent/sequential execution based on tool properties

**Design Pattern**: Based on mini-kode's `tools/runner.ts` and gemini-cli's `CoreToolScheduler`
- Clear separation: validation → approval → execution → result formatting
- Permission-based execution (callback-driven)
- Auto-concurrency detection (readonly vs mutating)

**Estimated Size**: 400-500 lines (distributed across multiple files)

**Key Files**:
- `scheduler.ts` - Main coordinator
- `registry.ts` - Tool discovery and lookup
- `executor.ts` - Tool execution with permissions
- `validator.ts` - Tool call validation
- `types.ts` - Tool interfaces and results

**Key Types**:
```typescript
interface ToolScheduler {
  // Discovery
  getAvailableTools(): Tool[]
  getToolByName(name: string): Tool | undefined

  // Validation
  validateToolCall(toolCall: ParsedToolCall): ValidationResult

  // Execution
  executeToolCalls(
    toolCalls: ParsedToolCall[],
    signal?: AbortSignal,
    callbacks?: ToolExecutionCallbacks
  ): Promise<ToolResult[]>

  // Permission handling
  onPermissionRequired(callback: (toolName, hint) => Promise<boolean>): void
}

interface ToolExecutionCallbacks {
  onToolStart?: (toolName: string) => void
  onToolUpdate?: (toolName: string, output: string) => void
  onToolComplete?: (toolName: string, result: ToolResult) => void
  onPermissionRequired?: (toolName, hint) => Promise<boolean>
}
```

#### 4. **Main-Scheduler / Agent Executor** (High Priority)
**Status**: Placeholder directory with skeleton files
**Purpose**: Orchestrate the complete request-to-completion cycle
**Responsibilities**:
- Implement the main event loop (stream → execute → repeat)
- Coordinate between Conversation, LLM Client, Turn, and Tool Scheduler
- Manage context building (system prompt + history + user request)
- Handle compression when approaching token limits
- Manage error handling and recovery
- Track turn limits and session state

**Design Pattern**: Mini-kode's `executor.ts` pattern (494 lines, highly readable)
- Single responsibility: orchestration only
- Callback-based for UI agnosticism
- Clear separation between execution logic and UI

**Estimated Size**: 400-500 lines

**Key Types**:
```typescript
interface MainScheduler {
  execute(
    userRequest: string,
    options?: ExecutionOptions
  ): AsyncGenerator<ExecutionEvent, ExecutionResult, unknown>

  // State
  getConversationHistory(): ChatCompletionMessage[]
  resetConversation(): void
  getSessionMetadata(): SessionMetadata
}

interface ExecutionEvent {
  type: 'start' | 'streaming' | 'tool_call' | 'tool_result' | 'complete' | 'error'
  data: unknown
  timestamp: Date
}

interface ExecutionResult {
  success: boolean
  finalResponse: string
  toolCalls: ParsedToolCall[]
  tokenUsage: TokenUsage
  duration: number
}
```

#### 5. **System Prompts Module** (Medium Priority)
**Status**: Empty directory
**Purpose**: Manage and build system prompts/instructions
**Responsibilities**:
- Store system prompt templates
- Load AGENTS.md context
- Build dynamic system messages based on context
- Support multi-layer prompts (base + extensions)
- Token estimation for system prompts

**Design Pattern**: Based on mini-kode's `agent/prompts.ts`
- Simple function-based approach
- Dynamic context injection
- Composable prompts

**Estimated Size**: 150-200 lines

**Key Functions**:
```typescript
function buildSystemPrompt(context: {
  agentGoal?: string
  availableTools?: Tool[]
  environmentInfo?: Record<string, string>
  constraints?: string[]
}): string

function getSystemPromptTemplate(): string

function getAgentContextFromFile(filePath: string): string
```

#### 6. **Confirmation Bus / Message Bus** (Already Exists)
**Status**: Should exist in `src/confirmation-bus`
**Purpose**: Decouple components via event-driven architecture
**Used By**: Tool Scheduler (permission requests), Turn (hook events), Main Scheduler (events)

**Not required to implement yet, but referenced by other modules**

---

## Part 2: Main-Scheduler Design - Simple to Complex

### Philosophy: Progressive Implementation

Implement main-scheduler in 3 phases:

```
Phase 1: MVP (Minimal Viable)
├── Single-turn conversation
├── No tool execution
├── No permission handling
└── Direct LLM response only

Phase 2: Basic Agent Loop
├── Multi-turn with tool execution
├── Sequential tool execution
├── Basic permission callbacks
└── Error logging

Phase 3: Production-Ready
├── Concurrent execution for readonly tools
├── Token compression at threshold
├── Loop detection
├── Comprehensive error recovery
└── Complete hook system integration
```

### Phase 1: MVP Main-Scheduler (100 lines)

**Simplest possible orchestration loop:**

```typescript
// src/core/main-scheduler/executor.ts

import type { ChatCompletionMessage } from '@/core/llm-client'
import { createLLMClient, streamChatCompletion } from '@/core/llm-client'
import type { Conversation } from '@/core/conversation'
import type { StreamingResponse } from '@/core/llm-client'

export async function* mvpExecute(
  conversation: Conversation,
  userRequest: string
) {
  // Step 1: Add user message to history
  const messages: ChatCompletionMessage[] = [
    ...conversation.getInitialHistory(),
    { role: 'user', content: userRequest }
  ]

  // Step 2: Stream from LLM
  const llmClient = createLLMClient()

  for await (const response of streamChatCompletion(llmClient, messages)) {
    // Yield streaming updates to UI
    yield {
      type: 'streaming' as const,
      response,
      timestamp: new Date()
    }

    // When complete, save to conversation
    if (response.isComplete) {
      conversation.addMessage(response.completeMessage)

      yield {
        type: 'complete' as const,
        response: response.completeMessage,
        tokenUsage: response.tokenUsage,
        timestamp: new Date()
      }
    }
  }
}
```

**Key Characteristics:**
- No tool execution
- No permission handling
- Linear flow: user → LLM → response
- Reusable by any UI layer (CLI, IDE, etc.)

---

### Phase 2: Tool Execution Addition (300 lines)

**Add tool scheduler integration:**

```typescript
// src/core/main-scheduler/executor.ts (enhanced)

export interface ExecutionCallbacks {
  onLLMUpdate?: (response: StreamingResponse) => void
  onToolStart?: (toolName: string) => void
  onToolUpdate?: (toolName: string, output: string) => void
  onToolComplete?: (toolName: string, result: ToolResult) => void
  onPermissionRequired?: (toolName: string, hint: ToolConfirmationDetails) => Promise<boolean>
  onError?: (error: Error) => void
  onComplete?: (result: ExecutionResult) => void
}

export async function* agentExecute(
  conversation: Conversation,
  toolScheduler: ToolScheduler,
  userRequest: string,
  callbacks?: ExecutionCallbacks
): AsyncGenerator<ExecutionEvent, ExecutionResult, unknown> {

  const startTime = Date.now()
  const llmClient = createLLMClient()

  let messages: ChatCompletionMessage[] = [
    ...conversation.getInitialHistory(),
    { role: 'user', content: userRequest }
  ]

  let toolCallCount = 0
  const maxToolLoops = 10 // Prevent infinite loops

  while (toolCallCount < maxToolLoops) {
    // Stream LLM response
    let finalResponse: StreamingResponse | null = null

    for await (const response of streamChatCompletion(llmClient, messages)) {
      callbacks?.onLLMUpdate?.(response)

      if (response.isComplete) {
        finalResponse = response
      }
    }

    if (!finalResponse) {
      throw new Error('No response from LLM')
    }

    // Save assistant message
    messages.push(finalResponse.completeMessage)
    conversation.addMessage(finalResponse.completeMessage)

    // Check if tools were called
    if (finalResponse.finishReason === 'tool_calls' && finalResponse.parsedToolCalls) {
      toolCallCount++

      yield {
        type: 'tool_call',
        toolCalls: finalResponse.parsedToolCalls,
        timestamp: new Date()
      }

      // Execute tools
      const toolResults = await toolScheduler.executeToolCalls(
        finalResponse.parsedToolCalls,
        undefined,
        {
          onToolStart: (toolName) => callbacks?.onToolStart?.(toolName),
          onToolUpdate: (toolName, output) => callbacks?.onToolUpdate?.(toolName, output),
          onToolComplete: (toolName, result) => callbacks?.onToolComplete?.(toolName, result),
          onPermissionRequired: (toolName, hint) => callbacks?.onPermissionRequired?.(toolName, hint)
        }
      )

      // Format and add tool results to history
      const toolResultMessage = formatToolResultsMessage(toolResults)
      messages.push(toolResultMessage)
      conversation.addMessage(toolResultMessage)

      yield {
        type: 'tool_result',
        toolResults,
        timestamp: new Date()
      }

      // Continue loop - LLM will respond to tool results
    } else {
      // No more tool calls - conversation is complete
      break
    }
  }

  if (toolCallCount >= maxToolLoops) {
    throw new Error(`Exceeded maximum tool execution loops (${maxToolLoops})`)
  }

  return {
    success: true,
    finalResponse: finalResponse?.completeMessage.content as string,
    duration: Date.now() - startTime,
    messageCount: messages.length
  }
}
```

**Key Features:**
- Multi-turn agentic loop
- Tool execution with callbacks
- Permission handling via callback
- Loop prevention
- Clear yield events for UI

---

### Phase 3: Production-Ready (500+ lines)

**Add advanced features:**

```typescript
// src/core/main-scheduler/executor.ts (production)

export interface ExecutionOptions {
  maxToolLoops?: number
  compressionThreshold?: number
  signal?: AbortSignal
  hooks?: {
    onBeforeExecute?: () => Promise<void>
    onAfterExecute?: () => Promise<void>
    onBeforeTool?: (toolName: string) => Promise<void>
  }
}

export async function* productionExecute(
  conversation: Conversation,
  toolScheduler: ToolScheduler,
  userRequest: string,
  options?: ExecutionOptions,
  callbacks?: ExecutionCallbacks
): AsyncGenerator<ExecutionEvent, ExecutionResult, unknown> {

  // ... (Phase 2 logic) ...

  // ADDED IN PHASE 3:

  // 1. Token compression check
  if (shouldCompressConversation(messages, tokenUsage)) {
    yield {
      type: 'compressing',
      timestamp: new Date()
    }

    const compressed = await compressConversation(conversation)
    conversation.setMessages(compressed)
    messages = [...compressed, { role: 'user', content: userRequest }]

    yield {
      type: 'compressed',
      newMessageCount: messages.length,
      timestamp: new Date()
    }
  }

  // 2. Loop detection
  if (detectInfiniteLoop(messages)) {
    yield {
      type: 'loop_detected',
      timestamp: new Date()
    }
    throw new Error('Infinite loop detected - same tool calls repeated')
  }

  // 3. Hook integration
  await options?.hooks?.onBeforeExecute?.()

  // 4. Error recovery with fallback
  try {
    // ... main execution logic ...
  } catch (error) {
    if (isRetryableError(error)) {
      yield {
        type: 'retrying',
        reason: error.message,
        timestamp: new Date()
      }
      // Retry with different model or parameters
    } else {
      throw error
    }
  }

  await options?.hooks?.onAfterExecute?.()
}
```

**Advanced Features:**
- Token compression at threshold
- Loop detection
- Retry logic with fallbacks
- Hook system integration
- Configurable limits
- AbortSignal support

---

### Comparison: Simple vs Production

| Aspect | Phase 1 | Phase 2 | Phase 3 |
|--------|---------|---------|---------|
| **Lines of Code** | ~100 | ~300 | ~500+ |
| **Features** | MVP only | Agent loop | Production-ready |
| **Tool Support** | No | Sequential | Concurrent + smart |
| **Permissions** | No | Callback | Full integration |
| **Compression** | No | No | Auto at 90% |
| **Loop Detection** | No | Basic | Full |
| **Error Recovery** | Throw | Log | Retry with fallback |
| **Hooks** | No | No | Full system |
| **Time to Implement** | 1-2 hours | 4-6 hours | 8-12 hours |

**Recommendation**: Start with Phase 2 (basic agent loop), then add Phase 3 features incrementally based on user feedback.

---

## Part 3: Complete Request-to-Completion Cycle (Architecture Overview)

### User Interaction Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    USER INTERACTION LAYER                            │
│  (CLI / IDE Extension / Web UI - Implementation Details Vary)        │
└────────────────────────┬────────────────────────────────────────────┘
                         │ User Types: "help me debug this error"
                         ↓
        ┌────────────────────────────────────┐
        │  UI Event Handler                   │
        │  ├─ Validate input                  │
        │  ├─ Show loading indicator          │
        │  └─ Call MainScheduler.execute()    │
        └────────┬───────────────────────────┘
                 │
                 ↓
╔════════════════════════════════════════════════════════════════════╗
║                     MAIN-SCHEDULER (ORCHESTRATOR)                  ║
║  src/core/main-scheduler/executor.ts                               ║
║                                                                    ║
║  Responsibility: Coordinate complete request→completion cycle     ║
╚════════════════╤═══════════════════════════════════════════════════╝
                 │
     ┌───────────┴───────────┐
     ↓                       ↓
┌─────────────────┐   ┌──────────────────┐
│ CONVERSATION    │   │ CONTEXT BUILDER  │
│ Module          │   │ (system-prompts) │
│                 │   │                  │
│ Responsibilities:   │ Responsibilities: │
│ • Get history  │   │ • Load AGENTS.md │
│ • Add messages │   │ • Build system   │
│ • Validate seq │   │   prompt         │
│ • Track state  │   │ • Inject context │
└────────┬────────┘   └────────┬─────────┘
         │                     │
         └──────────┬──────────┘
                    ↓
        ┌────────────────────────────────┐
        │ BUILD EXECUTION CONTEXT        │
        │                                │
        │ messages = [                   │
        │   { role: 'system', ... },     │
        │   ...history...,               │
        │   { role: 'user', content }    │
        │ ]                              │
        └────────────┬───────────────────┘
                     │
╔════════════════════╩═════════════════════════════════════════════╗
║            TURN / STREAMING LOOP                                 ║
║  (Handle one complete LLM request-response cycle)               ║
╚════════════════════╤═════════════════════════════════════════════╝
                     │
                     ↓
        ┌──────────────────────────────┐
        │ LLM CLIENT - Stream           │
        │ (src/core/llm-client/)        │
        │                               │
        │ 1. streamChatCompletion()     │
        │ 2. Accumulate content         │
        │ 3. Parse tool calls           │
        │ 4. Yield complete message     │
        └────────────┬──────────────────┘
                     │
         ┌───────────┴────────────┐
         ↓                        ↓
    Content Stream          Tool Calls?
         │                        │
         │ (yield chunks)         │ (parsed + ready)
         │                        │
    [to UI in real-time]         ↓
                          ┌─────────────────┐
                          │ Check finish    │
                          │ reason          │
                          └────┬────────────┘
                               │
                   ┌───────────┴────────────┐
                   ↓                        ↓
            finish_reason =          finish_reason =
            'tool_calls'              'stop'
                   │                        │
                   │                        └──→ [Save message]
                   │                            [Return result]
                   │                            [Conversation ends]
                   ↓
        ┌──────────────────────────────┐
        │ TOOL SCHEDULER               │
        │ (src/core/tool-scheduler/)   │
        │                              │
        │ Responsibilities:            │
        │ • Validate tool calls        │
        │ • Check permissions          │
        │ • Execute tools              │
        │ • Format results             │
        └────────────┬─────────────────┘
                     │
                     ↓
        ┌────────────────────────────────┐
        │ Validate Tool Calls            │
        │ ├─ Tool exists?               │
        │ ├─ Parameters match schema?   │
        │ └─ Allowed by permissions?    │
        └────────────┬───────────────────┘
                     │
        ┌────────────┴──────────────────┐
        │ Check Permissions             │
        │ (confirmation-bus)            │
        │                               │
        │ Need approval? →              │
        │  └─ emit PermissionRequested  │
        │     await onPermissionRequired│
        │     (callback from UI)        │
        └────────────┬──────────────────┘
                     │
        ┌────────────┴──────────────────┐
        ↓                               ↓
    Permission          ┌──────────────────────────┐
    Denied?             │ Execute Tool             │
       │                │                          │
       │ YES            │ • Run tool.execute()     │
       └──→ Return      │ • Capture output         │
           error        │ • Handle errors          │
           message      │ • Format result          │
                        └────────┬─────────────────┘
                                 │
                                 ↓
                    ┌──────────────────────┐
                    │ Tool Execution       │
                    │ Strategies:          │
                    │                      │
                    │ Readonly tools?      │
                    │ └─ Concurrent        │
                    │                      │
                    │ Mutating tools?      │
                    │ └─ Sequential        │
                    │                      │
                    │ (prevents race cond) │
                    └────────┬─────────────┘
                             │
                             ↓
                    ┌──────────────────────┐
                    │ Format Tool Results  │
                    │                      │
                    │ Convert to OpenAI   │
                    │ function_result msg │
                    │ format              │
                    └────────┬─────────────┘
                             │
                             ↓
        ┌──────────────────────────────────┐
        │ Check Auto-Compression           │
        │ (Token usage tracking)           │
        │                                  │
        │ If tokenUsage > 90% of limit:   │
        │ ├─ Trigger compression          │
        │ ├─ Summarize conversation      │
        │ └─ Replace history              │
        └────────────┬─────────────────────┘
                     │
                     ↓
        ┌──────────────────────────────────┐
        │ Check Loop Condition             │
        │                                  │
        │ Tool calls again? →              │
        │ └─ Back to TURN/STREAMING LOOP  │
        │                                  │
        │ Text response (stop)? →          │
        │ └─ Conversation Complete        │
        │                                  │
        │ Max loops exceeded? →            │
        │ └─ Error: Infinite loop          │
        └────────────┬─────────────────────┘
                     │
                     ↓
        ┌──────────────────────────────────┐
        │ Add Tool Results to History      │
        │                                  │
        │ messages.push(                   │
        │   tool_result_message            │
        │ )                                │
        │                                  │
        │ Continue loop (Back to           │
        │ LLM CLIENT - Stream)             │
        └──────────────────────────────────┘
                     │
                     └─→ [Repeat until stop]


┌─────────────────────────────────────────────────────────────┐
│                    COMPLETION PHASE                          │
│                                                              │
│ Final response saved to conversation                        │
│ Return ExecutionResult to UI:                              │
│ ├─ Final message                                           │
│ ├─ Tool calls executed                                     │
│ ├─ Token usage                                             │
│ └─ Execution time                                          │
│                                                              │
│ UI updates display and enables new input                   │
└─────────────────────────────────────────────────────────────┘
```

### Key Components in the Cycle

| Component | Responsibility | Input | Output |
|-----------|-----------------|-------|--------|
| **MainScheduler** | Orchestrate complete cycle | User request | ExecutionResult |
| **Conversation** | Manage message history | Messages | Message array |
| **System Prompts** | Build instruction context | Context info | System message |
| **LLM Client** | Stream LLM responses | Messages + tools | StreamingResponse |
| **Turn** | Represent single cycle | Starting state | Turn completion |
| **Tool Scheduler** | Manage tool execution | Tool calls | Tool results |
| **Tool Registry** | Discover available tools | Tool name | Tool definition |
| **Permission System** | Check/request approvals | Tool name | Approval decision |
| **Confirmation Bus** | Decouple permission flow | Permission request | User decision |
| **Token Counter** | Track context usage | Messages | Token count |

---

## Part 4: Architecture Direction for ohbaby-agent

### Strategic Positioning

ohbaby-agent should position itself as:
- **More sophisticated than mini-kode**: Full feature support with hooks, MCP, permissions
- **More maintainable than gemini-cli**: Clear separation, readable code, educational value
- **Tailored for code assistance**: Focus on file operations, shell execution, code editing

### Design Principles

Based on gemini-cli and mini-kode analysis, ohbaby-agent should follow:

#### 1. **Layered Architecture with Clear Boundaries**

```
┌──────────────────────────────────────────┐
│  User Interface Layer (CLI/IDE)          │
│  (Not our responsibility - partners use) │
└────────────────┬─────────────────────────┘
                 │
┌────────────────▼─────────────────────────┐
│  Application Layer: MainScheduler        │
│  (Orchestration, request→completion)     │
├──────────────────────────────────────────┤
│  Domain Layer: Core Components           │
│  • Conversation (message memory)         │
│  • Turn (single cycle)                   │
│  • Tool Scheduler (tool coordination)    │
│  • System Prompts (instruction building) │
├──────────────────────────────────────────┤
│  Infrastructure Layer: Services          │
│  • LLM Client (OpenAI SDK wrapper)       │
│  • Confirmation Bus (event routing)      │
│  • Token Counter (consumption tracking)  │
├──────────────────────────────────────────┤
│  External: APIs, Filesystems, Shells     │
└──────────────────────────────────────────┘
```

**Benefit**: Each layer can be tested independently; changes in one layer don't cascade.

#### 2. **Callback-Driven Communication (Not State Sharing)**

**Example**: Tool permission flow

```
// DON'T do this (tight coupling):
toolScheduler.permissionRequired = true
ui.showPermissionDialog()
// (waiting for UI to modify state directly)

// DO this (decoupled):
toolScheduler.executeToolCalls(
  toolCalls,
  {
    onPermissionRequired: async (toolName, hint) => {
      const approved = await ui.showPermissionDialog(hint)
      return approved
    }
  }
)
```

**Benefit**: Same MainScheduler works for CLI, IDE, web UI, tests - no UI dependency.

#### 3. **Async Generators for Streaming**

**Why**:
- Natural fit for streaming responses
- Cancellation support via AbortSignal
- Backpressure handling (consumer controls pace)
- Easy to chain/compose

**Pattern**:
```typescript
async function* execute(
  request: string,
  signal?: AbortSignal
): AsyncGenerator<ExecutionEvent, ExecutionResult>
```

#### 4. **Progressive Implementation**

**Implement in phases:**

1. **Phase 1 (Week 1)**: MVP - No tools, just conversation
2. **Phase 2 (Week 2)**: Basic agent loop - Sequential tool execution
3. **Phase 3 (Week 3+)**: Production - Compression, loops, hooks

**Benefit**: Get working system quickly, add complexity gradually.

#### 5. **Comprehensive Hook System**

**Learn from gemini-cli** - support extension points:

```
BeforeAgent          ← Can add context, block execution
  ↓
BeforeModel          ← Can modify prompt/config
  ↓
[LLM Response]
  ↓
AfterModel           ← Can process response
  ↓
Tool Execution       ← BeforeTool, ToolNotification, AfterTool
  ↓
AfterAgent           ← Can request continuation
```

**Benefit**: Users can extend without modifying core code.

#### 6. **Multi-Mode Execution**

Support different execution patterns:

```typescript
// Standard: stream to UI
async function* streamExecute() { }

// Batch: get final result only
async function batchExecute() { }

// Testing: with recording/replay
async function* recordingExecute() { }

// Session: resume from checkpoint
async function* resumeExecute() { }
```

#### 7. **Message Validation**

Always validate message sequence before sending to LLM:

```typescript
// OpenAI expects specific patterns:
// - Cannot have assistant-to-assistant messages
// - Tool results must follow assistant with tool_calls
// - System message must be first

validateMessageSequence(messages)  // Throws if invalid
```

#### 8. **Tool Concurrency Strategy**

Auto-detect and optimize:

```
Readonly tools (fileRead, grep, glob):     Concurrent
Mutating tools (fileEdit, bash):           Sequential
Mixed:                                      Sequential (safe default)
```

**Benefit**: Maximum safety without user configuration.

---

### Implementation Roadmap

#### **Phase 1: Foundation (Week 1-2)**

- [ ] Implement `conversation/` module (150-200 lines)
- [ ] Implement `turn/` module (250-350 lines)
- [ ] Implement `system-prompts/` module (150-200 lines)
- [ ] Create `main-scheduler/executor.ts` Phase 1 MVP (100 lines)
- [ ] Create comprehensive tests for each module

**Outcome**: MVP working - user can get LLM responses without tool execution

#### **Phase 2: Tool Integration (Week 3-4)**

- [ ] Implement `tool-scheduler/` module (400-500 lines)
- [ ] Implement tool registry and MCP integration
- [ ] Implement permission system (callback-driven)
- [ ] Upgrade `main-scheduler/executor.ts` to Phase 2 (300 lines)
- [ ] Create tool execution tests

**Outcome**: Full agent loop - tools execute with permission checks

#### **Phase 3: Production Features (Week 5-6)**

- [ ] Implement token compression
- [ ] Implement loop detection
- [ ] Implement error recovery with fallbacks
- [ ] Complete hook system integration
- [ ] Upgrade `main-scheduler/executor.ts` to Phase 3 (500+ lines)
- [ ] Performance optimization and stress testing

**Outcome**: Production-ready - handles edge cases and provides extensibility

#### **Phase 4: Hardening (Week 7+)**

- [ ] Document all APIs and patterns
- [ ] Create example integrations (CLI, IDE, web)
- [ ] Performance profiling and optimization
- [ ] Security audit and fixes
- [ ] User feedback integration

---

### Technology Choices

| Component | Technology | Rationale |
|-----------|-----------|-----------|
| **LLM** | OpenAI SDK v6.10.0 | Already chosen, well-maintained |
| **Tool Registry** | MCP Protocol | Standard, extensible, multi-provider |
| **Message Bus** | Simple EventEmitter | Sufficient, no external dependency |
| **Token Counting** | Character-based heuristic | No API calls needed, 5-10% accuracy sufficient |
| **Configuration** | JSON files | Simple, human-editable |
| **Testing** | Vitest | Fast, TypeScript-native, ESM support |
| **CLI** | Commander.js (if needed) | Lightweight, popular |

---

### Key Success Metrics

1. **Code Clarity**: Average function <50 lines, clear single responsibility
2. **Test Coverage**: >80% for core modules (execution, tools, permissions)
3. **Performance**: Complete cycle <2s for simple queries (with caching)
4. **Extensibility**: Users can add hooks/tools without modifying core code
5. **Maintainability**: New developer can understand architecture in <2 hours

---

## Part 5: Comparison Matrix

### ohbaby-agent vs gemini-cli vs mini-kode

| Aspect | gemini-cli | mini-kode | ohbaby-agent (Target) |
|--------|-----------|----------|-------------------|
| **Scale** | Very large | Minimal | Medium |
| **Complexity** | High | Low | Medium |
| **Extensibility** | Full (hooks, strategies, plugins) | Limited | High (hooks, MCP) |
| **Maintainability** | Complex task/state mgmt | Simple iteration | Clear layers |
| **Performance** | Optimized | Basic | Balanced |
| **Error Recovery** | Sophisticated retries | Basic logging | Retry + fallback |
| **Learning Curve** | Steep | Easy | Medium |
| **Time to Market** | 8+ weeks | 2-3 weeks | 4-6 weeks |
| **Production Ready** | Yes (Google) | Educational | Target |
| **Documentation** | Extensive | Minimal | Planned |

---

## Recommended Action Items

### Immediate (This Week)

1. **Review this document** with the team
2. **Decide on implementation phases** - Start with Phase 1 or Phase 2?
3. **Allocate responsibilities** - Who implements which module?
4. **Set up development environment** - Ensure all dependencies installed

### Short-term (Next 2 Weeks)

1. Implement Phase 1: Conversation, Turn, System Prompts, MVP Executor
2. Create comprehensive tests
3. Document APIs and usage patterns
4. Create example integration (simple CLI)

### Medium-term (Next 4 Weeks)

1. Implement Phase 2: Tool Scheduler, Permissions, Basic Agent Loop
2. Add MCP support
3. Stress test with complex scenarios
4. Performance optimization

### Long-term (Ongoing)

1. Implement Phase 3: Advanced features
2. User feedback integration
3. Production hardening
4. Documentation and examples

---

## Conclusion

ohbaby-agent is positioned to be a **modern, maintainable, and extensible AI coding assistant** that combines:
- **gemini-cli's sophistication** (hooks, routing, error recovery)
- **mini-kode's clarity** (simple loop, callback-driven, readable)
- **ohbaby-agent's tailoring** (code-focused tools, IDE integration)

The key to success is **progressive implementation** - start simple (Phase 1), add complexity gradually (Phases 2-3), and maintain code clarity throughout.

By following the layered architecture and callback-driven patterns outlined above, ohbaby-agent will achieve high maintainability while providing the extensibility needed for enterprise use.

