# mcp 模块 dfd-interface.md

本文档描述 `mcp` 模块的数据流和对外接口。

---

## 一、Data Flow Diagram（数据流图）

### 1.1 完整工作流程

```
ohbaby-code启动
   │
   ▼
[不初始化MCP]  ← 懒加载策略
   │
   │  LLM首次调用MCP工具时
   │  或首次获取工具列表时
   ▼
McpManager.getInstance(workspaceId)
   │
   ▼
getAllTools()
   │
   ▼
ensureInitialized()
   │
   ├─→ loadMcpConfig()                   从config/mcp模块
   │      ↓
   │   合并全局和项目配置
   │      ↓
   │   McpServersConfig对象
   │
   ├─→ 并行创建McpClient
   │      ├─ new McpClient('fs', config1)
   │      │    ├─→ createTransport(config1)
   │      │    │      ↓
   │      │    │   StdioClientTransport
   │      │    ├─→ client.connect(transport)
   │      │    └─→ client.listTools()
   │      │           ↓
   │      │        McpToolDef[]
   │      │
   │      ├─ new McpClient('github', config2)
   │      │    ├─→ createTransport(config2)
   │      │    │      ↓
   │      │    │   StreamableHTTPClientTransport
   │      │    ├─→ client.connect(transport)
   │      │    └─→ client.listTools()
   │      │
   │      └─ 错误隔离：单个失败不影响其他
   │
   └─→ 转换工具
          ├─ adaptMcpTool(tool1, client1, 'fs')
          │     ↓
          │  { name: 'fs_read', source: 'mcp', ... }
          │
          └─ adaptMcpTool(tool2, client2, 'github')
                ↓
             { name: 'github_create_issue', source: 'mcp', ... }
                ↓
          Tool[]（返回给调用方）
```

### 1.2 工具执行流程

```
LLM请求执行github_create_issue
   │
   ▼
ToolScheduler.execute(request)
   │
   ├─→ 检查tool.source === 'mcp'？
   │      ↓ Yes
   │   executeMcpTool(tool, request)
   │      │
   │      ├─→ 检查trust
   │      │     ├─ trust=false → Permission.ask()
   │      │     └─ trust=true  → 跳过确认
   │      │
   │      └─→ tool.execute(params, context)
   │            ↓
   │         McpManager.executeTool('github', 'create_issue', params)
   │            │
   │            ├─→ ensureInitialized()
   │            ├─→ clients.get('github')
   │            └─→ client.callTool({...})
   │                  │
   │                  ▼
   │               MCP SDK → HTTP请求 → MCP Server
   │                  │
   │                  ▼
   │               CallToolResult
   │                  │
   │                  ▼
   │               transformMcpResult()
   │                  │
   │                  ▼
   │               ToolOutput
   │                  │
   │                  ▼
   │            返回给ToolScheduler
   │                  │
   │                  ▼
   │            返回给LLM
   │
   └─→ No （内置工具）
       executeBuiltinTool(tool, request)
```

---

## 二、Public Interface（公开接口）

### 2.1 McpManager类（主要接口）

```typescript
/**
 * MCP管理器，负责MCP客户端的生命周期管理
 */
export class McpManager {
  /**
   * 获取指定工作区的McpManager单例
   *
   * @param workspaceId 工作区标识符
   * @returns McpManager实例
   *
   * @example
   * const manager = McpManager.getInstance(process.cwd())
   */
  static getInstance(workspaceId: string): McpManager

  /**
   * 获取所有MCP工具列表
   *
   * 首次调用会触发懒加载初始化，后续调用返回缓存的工具列表。
   *
   * @returns 转换后的Tool数组
   * @throws McpConnectionError 所有MCP服务器连接失败
   *
   * @example
   * const tools = await manager.getAllTools()
   * for (const tool of tools) {
   *   console.log(tool.name, tool.mcpServer)
   * }
   */
  async getAllTools(): Promise<Tool[]>

  /**
   * 执行MCP工具
   *
   * @param serverName MCP服务器名称
   * @param toolName 工具名称（原始名称，非{serverName}_{toolName}格式）
   * @param params 工具参数
   * @returns 工具执行结果
   * @throws Error 服务器不存在
   * @throws McpToolExecutionError 工具执行失败
   *
   * @example
   * const result = await manager.executeTool(
   *   'filesystem',
   *   'read_file',
   *   { path: '/path/to/file.txt' }
   * )
   */
  async executeTool(
    serverName: string,
    toolName: string,
    params: any
  ): Promise<any>

  /**
   * 获取所有MCP服务器的状态
   *
   * @returns 服务器名称到状态的映射
   *
   * @example
   * const status = await manager.getStatus()
   * // { filesystem: { status: 'connected', toolCount: 5 } }
   */
  async getStatus(): Promise<Record<string, McpClientStatus>>

  /**
   * 清理资源，断开所有MCP连接
   *
   * @example
   * await manager.dispose()
   */
  async dispose(): Promise<void>
}
```

### 2.2 类型导出

```typescript
export type { McpClientStatus } from './types.js'
export type { McpToolMetadata } from './types.js'
```

---

## 三、Integration with tool-scheduler（与tool-scheduler集成）

### 3.1 工具注册接口

tool-scheduler如何使用mcp模块：

```typescript
// tool-scheduler初始化或首次使用MCP工具时

import { McpManager } from '@/mcp'

class ToolRegistry {
  async loadMcpTools(workspaceId: string): Promise<void> {
    const mcpManager = McpManager.getInstance(workspaceId)

    try {
      const mcpTools = await mcpManager.getAllTools()

      for (const tool of mcpTools) {
        this.mcpTools.set(tool.name, tool)
      }
    } catch (error) {
      // MCP加载失败不影响内置工具
      console.warn('Failed to load MCP tools:', error)
    }
  }

  getAllTools(): Tool[] {
    return [
      ...this.builtinTools.values(),
      ...this.mcpTools.values()
    ]
  }
}
```

### 3.2 工具执行接口

tool-scheduler如何执行MCP工具：

```typescript
class ToolScheduler {
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.registry.get(request.toolName)

    if (tool.source === 'mcp') {
      // MCP工具特殊处理
      if (!tool.isTrusted) {
        await Permission.ask({
          type: 'mcp-tool',
          serverName: tool.mcpServer,
          toolName: tool.name,
          message: `MCP工具"${tool.mcpServer}.${tool.name}"请求执行`
        })
      }

      // 直接调用Tool.execute（内部会调用McpManager.executeTool）
      const result = await tool.execute(request.params, {
        sessionId: request.sessionId,
        messageId: request.messageId,
        callId: request.callId,
        signal: this.createAbortSignal(request.callId)
      })

      return {
        callId: request.callId,
        status: 'success',
        output: result.content,
        metadata: result.metadata
      }
    } else {
      // 内置工具正常处理（走并发控制）
      return await this.executeBuiltinTool(tool, request)
    }
  }
}
```

---

## 四、Internal Data Flow（内部数据流）

### 4.1 初始化数据流

```
ensureInitialized()
   │
   ├─ this.initPromise存在？
   │    └─→ Yes → 等待initPromise完成
   │
   ├─ this.clients.size > 0？
   │    └─→ Yes → 已初始化，直接返回
   │
   └─ this.initPromise = this.initialize()
         │
         ├─→ loadMcpConfig()
         │      ↓
         │   { mcpServers: { fs: {...}, github: {...} } }
         │
         └─→ Promise.allSettled([
               createClient('fs', config1),
               createClient('github', config2)
             ])
                │
                ├─→ 成功 → clients.set('fs', client1)
                └─→ 失败 → 记录错误（不抛出）
```

### 4.2 工具适配数据流

```
adaptMcpTool(mcpToolDef, client, serverName)
   │
   ├─→ 生成工具名称
   │     sanitize(serverName) + '_' + sanitize(toolName)
   │     ↓
   │   'filesystem_read_file'
   │
   ├─→ 提取元数据
   │     ├─ description: mcpToolDef.description
   │     ├─ parameters: mcpToolDef.inputSchema
   │     └─ isTrusted: client.config.trust
   │
   └─→ 创建execute函数
         async (params, context) => {
           const result = await client.callTool({
             name: mcpToolDef.name,  // 原始名称
             arguments: params
           }, undefined, {
             timeout: context.timeout || client.config.timeout,
             signal: context.signal
           })

           return transformMcpResult(result)
         }
```

### 4.3 结果转换数据流

```
transformMcpResult(callToolResult)
   │
   ├─→ 遍历content数组
   │     ├─ type='text' → textParts.push(block.text)
   │     ├─ type='image' → 转换为Markdown图片
   │     └─ type='resource' → 转换为资源引用
   │
   ├─→ 合并文本内容
   │     textParts.join('\n')
   │
   └─→ 构造ToolOutput
         {
           content: combinedText,
           metadata: {
             source: 'mcp',
             contentTypes: [...]
           },
           error: callToolResult.isError ? {...} : undefined
         }
```

---

## 五、Error Flow（错误流）

### 5.1 初始化错误流

```
initialize()
   │
   ├─→ loadMcpConfig() 失败
   │     ├─→ catch → console.warn()
   │     └─→ 使用空配置 { mcpServers: {} }
   │
   └─→ 单个McpClient.connect() 失败
         ├─→ catch → console.error()
         └─→ 不添加到clients Map（跳过该服务器）
```

### 5.2 工具执行错误流

```
executeTool(serverName, toolName, params)
   │
   ├─→ clients.get(serverName) === undefined
   │     └─→ throw new Error('MCP server not found')
   │
   └─→ client.callTool() 失败
         ├─→ 超时 → AbortSignal触发
         │     └─→ throw new Error('Tool execution timeout')
         │
         ├─→ MCP协议错误
         │     └─→ transformMcpResult({ isError: true, ... })
         │           ↓
         │        ToolOutput with error字段
         │
         └─→ 网络错误/进程崩溃
               └─→ throw new McpToolExecutionError(...)
```

---

## 六、Workspace Isolation（工作区隔离）

### 6.1 多工作区数据流

```
工作区A: /path/to/project-a
   │
   ├─→ McpManager.getInstance('/path/to/project-a')
   │     │
   │     ├─→ 加载全局配置: ~/.ohbaby-code/mcp/settings.json
   │     ├─→ 加载项目配置: /path/to/project-a/.ohbaby-code/mcp/settings.json
   │     ├─→ 合并配置
   │     └─→ 创建独立的clients Map
   │
   └─→ 工作区A的Tool[]

工作区B: /path/to/project-b
   │
   ├─→ McpManager.getInstance('/path/to/project-b')
   │     │
   │     ├─→ 加载全局配置: ~/.ohbaby-code/mcp/settings.json
   │     ├─→ 加载项目配置: /path/to/project-b/.ohbaby-code/mcp/settings.json
   │     ├─→ 合并配置
   │     └─→ 创建独立的clients Map
   │
   └─→ 工作区B的Tool[]

两者完全隔离，互不影响
```

---

## 七、Lifecycle Events（生命周期事件）

### 7.1 初始化事件序列

```
T0: McpManager.getInstance(workspaceId)
     └─→ 创建McpManager实例（不初始化）

T1: getAllTools() 首次调用
     ├─→ ensureInitialized() 触发
     ├─→ loadMcpConfig()
     ├─→ 并行创建McpClient
     │     ├─ Client1.connect() [100ms]
     │     ├─ Client2.connect() [200ms]
     │     └─ Client3.connect() [失败]
     └─→ listTools() 并行调用
           ├─ Client1.listTools() [50ms]
           └─ Client2.listTools() [80ms]

T2: getAllTools() 再次调用
     └─→ 直接返回缓存的Tool[]（不重新初始化）

T3: dispose()
     ├─→ Client1.disconnect()
     ├─→ Client2.disconnect()
     └─→ 清空clients Map
```

---

## 八、Performance Characteristics（性能特征）

### 8.1 初始化性能

| 阶段 | 耗时（估计） | 并行 |
|------|-------------|------|
| loadMcpConfig() | ~10ms | - |
| Stdio启动（单个） | 100-500ms | 是 |
| HTTP连接（单个） | 100-1000ms | 是 |
| listTools()（单个） | 50-200ms | 是 |
| 总计（3个服务器） | Max(各服务器耗时) | - |

### 8.2 工具执行性能

| 操作 | 耗时（估计） |
|------|-------------|
| executeTool()调用开销 | <1ms |
| MCP协议序列化 | ~1ms |
| 网络往返（HTTP） | 50-500ms |
| Stdio IPC | 10-100ms |
| 结果转换 | ~1ms |

---

## 九、Configuration Flow（配置流）

### 9.1 配置加载和使用

```
初始化阶段
   │
   ▼
loadMcpConfig()
   │
   ├─→ 全局: ~/.ohbaby-code/mcp/settings.json
   │     {
   │       "mcpServers": {
   │         "github": { "url": "...", "trust": false }
   │       }
   │     }
   │
   ├─→ 项目: {workspace}/.ohbaby-code/mcp/settings.json
   │     {
   │       "mcpServers": {
   │         "github": { "url": "...", "trust": true },
   │         "local": { "command": [...] }
   │       }
   │     }
   │
   └─→ 合并后
         {
           "mcpServers": {
             "github": { "url": "...", "trust": true },  ← 项目覆盖
             "local": { "command": [...] }               ← 项目新增
           }
         }
         │
         ▼
   遍历mcpServers
         │
         ├─→ new McpClient('github', config1)
         │     ├─→ this.config = config1
         │     └─→ isTrusted来自config1.trust
         │
         └─→ new McpClient('local', config2)
               └─→ this.config = config2
```

---

## 十、Testing Interface（测试接口）

### 10.1 Mock接口

```typescript
/**
 * 仅用于测试：注入Mock的MCP客户端
 */
export class McpManagerForTest extends McpManager {
  setClient(name: string, client: McpClient): void {
    this.clients.set(name, client)
  }

  clearClients(): void {
    this.clients.clear()
  }
}
```

### 10.2 测试辅助函数

```typescript
/**
 * 创建Mock的MCP客户端
 */
export function createMockMcpClient(
  name: string,
  tools: McpToolDef[]
): McpClient {
  return {
    name,
    config: { type: 'stdio', command: ['mock'] },
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue(tools),
    callTool: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'mock result' }]
    }),
    disconnect: jest.fn(),
    getStatus: jest.fn().mockReturnValue({ status: 'connected', toolCount: tools.length })
  }
}
```

---

## 十一、文档自检

- 数据流图清晰展示完整工作流程
- 公开接口文档完整（参数、返回值、异常、示例）
- 内部数据流逻辑明确
- 错误流处理清晰
- 工作区隔离机制清晰
- 性能特征已说明
- 测试接口提供
