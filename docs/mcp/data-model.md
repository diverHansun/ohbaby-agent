# mcp 模块 data-model.md

本文档定义 `mcp` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 McpClient（MCP客户端）

表示与单个MCP服务器的连接，负责工具发现和调用。

本质：Entity（实体），有身份（服务器名称），有生命周期（连接、断开）。

### 1.2 McpManager（MCP管理器）

管理多个MCP客户端的生命周期，提供统一的工具访问接口。

本质：Service（服务），单例模式，按工作区隔离。

### 1.3 McpTool（MCP工具）

从MCP服务器发现的工具，经过适配后转换为iris-code Tool接口。

本质：Value Object（值对象），工具定义不可变。

### 1.4 传输层（Transport）

MCP协议的底层通信机制，支持Stdio、HTTP、SSE三种方式。

本质：抽象接口，由MCP SDK提供实现。

---

## 二、Data Types（数据类型）

### 2.1 客户端状态

```typescript
type McpClientStatus =
  | { status: 'connected'; toolCount: number }
  | { status: 'failed'; error: string }
  | { status: 'disconnected' }
  | { status: 'disabled' }
```

状态说明：

| 状态 | 说明 | 转换条件 |
|------|------|---------|
| connected | 已连接并成功发现工具 | connect()成功 && listTools()成功 |
| failed | 连接失败或工具发现失败 | connect()失败 或 listTools()失败 |
| disconnected | 已断开连接 | disconnect()调用 |
| disabled | 配置中enabled=false | 初始化时跳过 |

### 2.2 工具元数据

```typescript
interface McpToolMetadata {
  serverName: string           // 所属MCP服务器名称
  toolName: string             // MCP工具原始名称
  isTrusted: boolean           // 是否信任（来自配置）
  readOnlyHint?: boolean       // 来自 annotations.readOnlyHint，用于并发分类
}
```

### 2.3 MCP工具定义（来自MCP SDK）

```typescript
// 来自@modelcontextprotocol/sdk/types.js
interface McpToolDef {
  name: string
  description?: string
  inputSchema: JSONSchema      // 工具参数Schema
  annotations?: ToolAnnotations  // MCP 协议 2024-11 版本引入
}

// MCP 官方协议定义的工具行为注解（Tool Annotations）
// 参考：https://modelcontextprotocol.io/specification/2025-06-18/server/tools
interface ToolAnnotations {
  readOnlyHint?: boolean    // true = 工具不修改环境，可安全并行执行
  destructiveHint?: boolean // true = 工具可能执行破坏性更新（如删除数据）
  idempotentHint?: boolean  // true = 相同参数重复调用无额外副作用
  openWorldHint?: boolean   // true = 工具可能与外部实体交互（如互联网）
}
```

**并发分类规则**：

| `readOnlyHint` 值 | 映射到 ToolCategory | 并发行为 |
|-------------------|--------------------|---------
| `true` | `readonly` | 可并行（最多5个） |
| `false` 或未提供 | `write` | 串行执行（安全默认） |

> **安全默认原则**：MCP 服务器不提供 `annotations` 时，无法判断工具是否安全并行，故默认串行。  
> 只有服务器明确声明 `readOnlyHint: true` 时才允许并行，符合"保守优于激进"的并发原则。

### 2.4 转换后的Tool（iris-code格式）

```typescript
interface Tool {
  name: string                 // {serverName}_{toolName}
  description: string
  source: 'builtin' | 'extension' | 'mcp'
  category: ToolCategory       // MCP工具通过 readOnlyHint 推断：true→readonly，其余→write
  parameters: ZodSchema | JSONSchema

  // MCP工具特有字段
  mcpServer?: string           // MCP服务器名称
  isTrusted?: boolean          // 是否信任
  annotations?: ToolAnnotations // MCP 原始注解（保留完整信息供 Policy 等模块使用）

  execute: (
    params: any,
    context: ToolContext
  ) => Promise<ToolOutput>
}
```

### 2.5 工具执行上下文

```typescript
interface ToolContext {
  sessionId: string
  messageId: string
  callId: string
  signal: AbortSignal          // 用于取消执行
  timeout?: number             // 超时时间（毫秒）
}
```

### 2.6 工具执行结果

```typescript
interface ToolOutput {
  content: string              // 主要输出内容
  metadata?: {
    source?: 'mcp'
    server?: string
    executionTime?: number
    [key: string]: any
  }
  error?: {
    type: string
    message: string
  }
}
```

---

## 三、MCP Protocol Data Types（MCP协议数据类型）

### 3.1 工具调用请求（来自MCP SDK）

```typescript
interface CallToolRequest {
  name: string                 // 工具名称
  arguments?: Record<string, unknown>  // 工具参数
}
```

### 3.2 工具调用结果（来自MCP SDK）

```typescript
interface CallToolResult {
  content: ContentBlock[]      // 内容块数组
  isError?: boolean            // 是否为错误
}

type ContentBlock =
  | TextContent
  | ImageContent
  | ResourceContent

interface TextContent {
  type: 'text'
  text: string
}

interface ImageContent {
  type: 'image'
  data: string                 // base64编码的图片数据
  mimeType: string             // 如 'image/png'
}

interface ResourceContent {
  type: 'resource'
  resource: {
    uri: string
    mimeType?: string
    text?: string
  }
}
```

---

## 四、Class Definitions（类定义）

### 4.1 McpClient类

```typescript
class McpClient {
  readonly name: string
  readonly config: McpServerConfig
  private client: Client | null      // MCP SDK的Client实例
  private transport: Transport | null
  private status: McpClientStatus

  constructor(name: string, config: McpServerConfig)

  async connect(): Promise<void>
  async listTools(): Promise<McpToolDef[]>
  async callTool(
    request: CallToolRequest,
    options?: { timeout?: number; signal?: AbortSignal }
  ): Promise<CallToolResult>
  async disconnect(): Promise<void>
  getStatus(): McpClientStatus
}
```

生命周期：
```
new McpClient() → connect() → listTools() → callTool() → disconnect()
```

### 4.2 McpManager类

```typescript
class McpManager {
  private static instances: Map<string, McpManager>
  private clients: Map<string, McpClient>
  private initPromise: Promise<void> | null
  private readonly workspaceId: string

  private constructor(workspaceId: string)

  static getInstance(workspaceId: string): McpManager
  private async ensureInitialized(): Promise<void>
  private async initialize(): Promise<void>

  async getAllTools(): Promise<Tool[]>
  async executeTool(
    serverName: string,
    toolName: string,
    params: any
  ): Promise<any>
  async getStatus(): Promise<Record<string, McpClientStatus>>
  async dispose(): Promise<void>
}
```

---

## 五、Content Transformation（内容转换）

### 5.1 MCP结果转换为ToolOutput

```typescript
function transformMcpResult(result: CallToolResult): ToolOutput {
  const textParts: string[] = []
  const metadata: Record<string, any> = {}

  for (const block of result.content) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text)
        break

      case 'image':
        // 图片转换为Markdown
        textParts.push(`![Image](data:${block.mimeType};base64,${block.data})`)
        metadata.hasImage = true
        break

      case 'resource':
        // 资源转换为引用
        textParts.push(`[Resource: ${block.resource.uri}]`)
        if (block.resource.text) {
          textParts.push(block.resource.text)
        }
        break
    }
  }

  return {
    content: textParts.join('\n'),
    metadata: {
      source: 'mcp',
      contentTypes: result.content.map(b => b.type),
      ...metadata
    },
    error: result.isError ? {
      type: 'McpToolError',
      message: textParts[0] || 'MCP tool execution failed'
    } : undefined
  }
}
```

### 5.2 转换示例

输入（MCP Result）：
```json
{
  "content": [
    { "type": "text", "text": "File read successfully" },
    { "type": "text", "text": "Content: Hello World" }
  ],
  "isError": false
}
```

输出（ToolOutput）：
```json
{
  "content": "File read successfully\nContent: Hello World",
  "metadata": {
    "source": "mcp",
    "contentTypes": ["text", "text"]
  }
}
```

---

## 六、Lifecycle State（生命周期状态）

### 6.1 McpClient生命周期

```
[创建] → [连接中] → [已连接] → [断开]
  │         │          │         │
  │         ↓          ↓         │
  │      [失败]     [失败]       │
  │         │          │         │
  └─────────┴──────────┴─────────┘
           [清理资源]
```

状态转换：
```typescript
class McpClient {
  private status: McpClientStatus = { status: 'disconnected' }

  async connect(): Promise<void> {
    try {
      this.transport = createTransport(this.config)
      this.client = new Client({ name: 'iris-code', version: '1.0.0' })
      await this.client.connect(this.transport)

      const tools = await this.listTools()
      this.status = { status: 'connected', toolCount: tools.length }
    } catch (error) {
      this.status = { status: 'failed', error: error.message }
      throw error
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.close()
    this.status = { status: 'disconnected' }
  }
}
```

### 6.2 McpManager生命周期

```
[getInstance] → [ensureInitialized] → [运行中] → [dispose]
                      │                   │
                      ↓                   │
                  [并行初始化]             │
                      │                   │
                 ┌────┴────┐             │
                 ↓         ↓              │
            [Client1] [Client2]           │
                 │         │              │
                 └────┬────┘              │
                      ↓                   │
                  [getAllTools]           │
                      │                   │
                      ↓                   │
                  [executeTool]           │
                      │                   │
                      └───────────────────┘
```

---

## 七、Error Types（错误类型）

### 7.1 连接错误

```typescript
class McpConnectionError extends Error {
  constructor(
    public serverName: string,
    public originalError: Error
  ) {
    super(`Failed to connect to MCP server "${serverName}": ${originalError.message}`)
  }
}
```

### 7.2 工具发现错误

```typescript
class McpToolDiscoveryError extends Error {
  constructor(
    public serverName: string,
    public originalError: Error
  ) {
    super(`Failed to discover tools from "${serverName}": ${originalError.message}`)
  }
}
```

### 7.3 工具执行错误

```typescript
class McpToolExecutionError extends Error {
  constructor(
    public serverName: string,
    public toolName: string,
    public originalError: Error
  ) {
    super(`MCP tool "${serverName}.${toolName}" execution failed: ${originalError.message}`)
  }
}
```

---

## 八、Constants（常量定义）

### 8.1 默认值

```typescript
export const DEFAULT_CONNECT_TIMEOUT = 10000      // 10秒
export const DEFAULT_TOOL_TIMEOUT = 120000        // 2分钟（继承tool-scheduler默认值）
export const MAX_TOOL_NAME_LENGTH = 100           // 工具名称最大长度
```

### 8.2 工具名称清理规则

```typescript
export const TOOL_NAME_SANITIZE_REGEX = /[^a-zA-Z0-9_-]/g
export const TOOL_NAME_SEPARATOR = '_'
```

---

## 九、Configuration Mapping（配置映射）

### 9.1 传输配置映射

```typescript
// Stdio配置 → StdioClientTransport
McpStdioConfig → {
  command: string,
  args: string[],
  env: Record<string, string>,
  stderr: 'pipe'
}

// HTTP配置 → StreamableHTTPClientTransport
McpHttpConfig → {
  url: URL,
  requestInit: {
    headers: Record<string, string>
  }
}

// SSE配置 → SSEClientTransport
McpSseConfig → {
  url: URL,
  requestInit: {
    headers: Record<string, string>
  }
}
```

---

## 十、Tool Metadata Examples（工具元数据示例）

### 10.1 Stdio工具示例

配置：
```json
{
  "filesystem": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem"]
  }
}
```

转换后的Tool：
```typescript
{
  name: 'filesystem_read_file',
  description: 'Read the contents of a file',
  source: 'mcp',
  category: undefined,
  mcpServer: 'filesystem',
  isTrusted: false,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' }
    },
    required: ['path']
  },
  execute: async (params, context) => { /* ... */ }
}
```

### 10.2 HTTP工具示例

配置：
```json
{
  "github": {
    "type": "http",
    "url": "https://api.github.com/mcp",
    "trust": true
  }
}
```

转换后的Tool：
```typescript
{
  name: 'github_create_issue',
  description: 'Create a GitHub issue',
  source: 'mcp',
  category: undefined,
  mcpServer: 'github',
  isTrusted: true,
  parameters: { /* JSONSchema */ },
  execute: async (params, context) => { /* ... */ }
}
```

---

## 十一、文档自检

- 核心概念定义清晰，区分Entity和Value Object
- 数据类型完整覆盖MCP协议和iris-code集成
- 类定义完整，包含生命周期
- 内容转换逻辑清晰
- 错误类型定义明确
- 常量定义合理
- 配置映射清晰
- 示例覆盖常见场景
