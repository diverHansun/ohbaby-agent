# mcp 模块 architecture.md

本文档描述 `mcp` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

mcp模块是iris-code的MCP协议客户端实现层，位于config/mcp和tool-scheduler之间，负责MCP服务器的连接管理和工具适配。

### 核心架构

```
mcp/
├── index.ts                      # 公开接口导出
├── types.ts                      # 类型定义
│
├── core/                         # 核心层
│   ├── client.ts                # MCP客户端封装
│   ├── manager.ts               # MCP管理器（生命周期）
│   └── transport.ts             # 传输层工厂
│
├── integration/                  # 集成层
│   └── tool-adapter.ts          # MCP工具→Tool转换
│
└── __tests__/                    # 测试
    ├── client.test.ts
    ├── manager.test.ts
    └── tool-adapter.test.ts
```

### 组件协作图

```
┌─────────────────────────────────────────────────────────────┐
│                        McpManager                            │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  clients: Map<string, McpClient>                       │ │
│  │  initPromise: Promise<void> | null                     │ │
│  │  workspaceId: string                                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────┐                │
│  │  ensureInitialized()                    │ ← 懒加载       │
│  │  ├─ loadMcpConfig()                     │   入口         │
│  │  ├─ 并行创建 McpClient                  │                │
│  │  └─ 错误隔离                             │                │
│  └─────────────────────────────────────────┘                │
│                                                               │
│  ┌─────────────────────────────────────────┐                │
│  │  getAllTools()                          │ ← 工具发现     │
│  │  ├─ ensureInitialized()                 │                │
│  │  ├─ 遍历 clients                        │                │
│  │  └─ adaptMcpTool()                      │                │
│  └─────────────────────────────────────────┘                │
│                                                               │
│  ┌─────────────────────────────────────────┐                │
│  │  executeTool()                          │ ← 工具执行     │
│  │  ├─ ensureInitialized()                 │                │
│  │  ├─ clients.get(serverName)             │                │
│  │  └─ client.callTool()                   │                │
│  └─────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
                    │
         ┌──────────┼──────────┐
         │          │          │
         ▼          ▼          ▼
   ┌──────────┐ ┌──────────┐ ┌──────────┐
   │McpClient1│ │McpClient2│ │McpClient3│
   └──────────┘ └──────────┘ └──────────┘
         │          │          │
         ▼          ▼          ▼
   MCP Server1  MCP Server2  MCP Server3
   (Stdio)      (HTTP)       (SSE)
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 单例模式（Singleton）

McpManager采用按工作区的单例模式。

```typescript
export class McpManager {
  private static instances = new Map<string, McpManager>()

  static getInstance(workspaceId: string): McpManager {
    if (!this.instances.has(workspaceId)) {
      this.instances.set(workspaceId, new McpManager(workspaceId))
    }
    return this.instances.get(workspaceId)!
  }
}
```

理由：
- 每个工作区只需要一个MCP管理器实例
- 避免重复初始化和连接
- 支持多工作区隔离
- 简化资源管理

### 2.2 懒加载模式（Lazy Initialization）

MCP客户端在首次使用时才初始化。

```typescript
async ensureInitialized(): Promise<void> {
  if (this.initPromise) {
    return this.initPromise  // 正在初始化，等待
  }

  if (this.clients.size > 0) {
    return  // 已初始化
  }

  // 开始初始化
  this.initPromise = this.initialize()
  try {
    await this.initPromise
  } finally {
    this.initPromise = null
  }
}
```

理由：
- 避免MCP加载失败影响iris-code启动
- 减少不必要的资源消耗（用户可能不使用MCP）
- 遵循YAGNI原则
- 符合opencode的设计模式

### 2.3 工厂模式（Factory）

传输层通过工厂函数创建。

```typescript
function createTransport(config: McpServerConfig): Transport {
  if (config.type === 'stdio') {
    return new StdioClientTransport({
      command: config.command,           // 可执行文件
      args: config.args ?? [],           // 参数数组（可选）
      env: { ...process.env, ...config.env },
      stderr: 'pipe'
    })
  } else if (config.type === 'http') {
    return new StreamableHTTPClientTransport(
      new URL(config.url),
      { headers: config.headers }
    )
  } else if (config.type === 'sse') {
    return new SSEClientTransport(
      new URL(config.url),
      { headers: config.headers }
    )
  }
}
```

**配置格式说明**：

iris-code 采用主流的分离式命令格式，与以下工具保持一致：
- Claude Desktop
- Cursor
- VS Code Copilot
- Cline
- Amazon Q Developer

示例配置：
```json
{
  "firecrawl-mcp": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "firecrawl-mcp"],
    "env": {
      "FIRECRAWL_API_KEY": "YOUR-API-KEY"
    }
  }
}
```

理由：
- 隔离传输层创建逻辑
- 根据配置动态选择传输方式
- 易于扩展新的传输类型

### 2.4 适配器模式（Adapter）

MCP工具定义转换为iris-code Tool接口。

```typescript
function adaptMcpTool(
  mcpTool: McpToolDef,
  client: McpClient,
  serverName: string
): Tool {
  return {
    name: `${serverName}_${mcpTool.name}`,
    description: mcpTool.description ?? '',
    source: 'mcp',
    category: undefined,  // MCP工具不参与分类
    mcpServer: serverName,
    isTrusted: client.config.trust ?? false,
    parameters: mcpTool.inputSchema,
    execute: async (params, context) => {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: params
      }, undefined, {
        timeout: client.config.timeout,
        signal: context.signal
      })
      return transformMcpResult(result)
    }
  }
}
```

理由：
- 屏蔽MCP协议细节
- 统一工具接口
- 保留MCP特有信息（mcpServer、isTrusted）

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 文件职责划分

#### core/client.ts

职责：单个MCP服务器的客户端封装

内容：
- `McpClient` 类
  - `connect()`: 建立连接
  - `listTools()`: 发现工具
  - `callTool()`: 调用工具
  - `disconnect()`: 断开连接
  - `getStatus()`: 获取连接状态

#### core/manager.ts

职责：管理多个MCP客户端的生命周期

内容：
- `McpManager` 类
  - `getInstance(workspaceId)`: 获取工作区单例
  - `ensureInitialized()`: 懒加载初始化
  - `getAllTools()`: 获取所有MCP工具
  - `executeTool()`: 执行MCP工具
  - `dispose()`: 清理资源

#### core/transport.ts

职责：创建MCP传输层实例

内容：
- `createTransport(config)`: 传输层工厂函数
- 错误处理辅助函数

#### integration/tool-adapter.ts

职责：MCP工具与iris-code Tool接口的适配

内容：
- `adaptMcpTool()`: 转换单个工具
- `transformMcpResult()`: 转换执行结果
- MCP内容类型处理（text、image、resource）

#### types.ts

职责：定义mcp模块的类型

内容：
- `McpClientStatus`: 客户端状态类型
- `McpToolMetadata`: MCP工具元数据
- 复用config/mcp的配置类型

#### index.ts

职责：导出公开接口

内容：
```typescript
export { McpManager } from './core/manager.js'
export type { McpClientStatus } from './types.js'
```

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 MCP工具不参与并发控制

当前方案：MCP工具有独立的执行路径，不走ConcurrencyController

代价：
- tool-scheduler需要增加source判断分支
- MCP工具和内置工具的执行逻辑不完全一致

收益：
- 避免误判MCP工具的类别（readonly/write/dangerous）
- MCP工具的并发由MCP服务器自己管理
- 简化类别推断逻辑
- 符合MCP协议的设计哲学

理由：
- MCP工具的语义不一定符合iris-code的类别划分
- MCP服务器可能本身就支持并发
- 强制串行可能导致不必要的性能损失

### 4.2 懒加载而非启动时加载

当前方案：首次调用MCP工具时才初始化

未采用方案：iris-code启动时预加载所有MCP

理由：
- 避免MCP加载失败阻塞启动
- 减少启动时间（用户可能不使用MCP）
- 单个MCP失败不影响全局
- 符合错误隔离原则

### 4.3 阶段1-2不支持OAuth

当前方案：仅支持headers手动传递令牌

代价：
- 用户需要手动管理令牌
- 无法自动刷新过期令牌
- 配置文件中包含明文令牌（安全风险）

收益：
- 实现简单，代码量少
- 满足大部分本地开发场景
- 避免OAuth流程的复杂性（浏览器跳转、回调服务器）

理由：
- 遵循YAGNI原则
- 阶段1-2重点是Stdio和基础HTTP
- OAuth可在未来作为独立子模块扩展

### 4.4 工具列表静态化

当前方案：工具列表在初始化时确定，不监听动态更新

未采用方案：监听ToolListChangedNotification

理由：
- 减少事件监听的复杂性
- 大部分MCP服务器的工具列表是静态的
- 动态更新可在未来扩展

---

## 五、Connection Management（连接管理）

### 5.1 连接状态机

```
初始状态
   │
   ▼
[创建McpClient]
   │
   ▼
connecting
   │
   ├─→ 成功 → connected
   │           │
   │           ├─ listTools成功 → 保持connected
   │           └─ listTools失败 → failed
   │
   └─→ 失败 → failed
```

### 5.2 状态定义

```typescript
type McpClientStatus =
  | { status: 'connected'; toolCount: number }
  | { status: 'failed'; error: string }
  | { status: 'disconnected' }
  | { status: 'disabled' }
```

### 5.3 错误隔离策略

```typescript
async initialize(): Promise<void> {
  const config = await loadMcpConfig()

  // 并行初始化，单个失败不影响其他
  await Promise.allSettled(
    Object.entries(config.mcpServers).map(async ([name, serverConfig]) => {
      if (!serverConfig.enabled) return

      try {
        const client = new McpClient(name, serverConfig)
        await client.connect()
        this.clients.set(name, client)
      } catch (error) {
        // 仅记录错误，继续初始化其他服务器
        console.error(`Failed to connect to MCP server "${name}":`, error)
      }
    })
  )
}
```

---

## 六、Tool Discovery & Execution（工具发现和执行）

### 6.1 工具发现流程

```
getAllTools() 被调用
   │
   ▼
ensureInitialized()  ← 懒加载
   │
   ▼
遍历 this.clients
   │
   ├─ client1.listTools()
   │    ├─ 过滤工具（includeTools/excludeTools）
   │    └─ adaptMcpTool(tool1, client1, 'server1')
   │         → { name: 'server1_tool1', source: 'mcp', ... }
   │
   ├─ client2.listTools()
   │    └─ ...
   │
   └─ 返回所有转换后的Tool[]
```

### 6.2 工具执行流程

```
tool-scheduler执行MCP工具
   │
   ▼
McpManager.executeTool(serverName, toolName, params)
   │
   ▼
ensureInitialized()
   │
   ▼
clients.get(serverName)
   │
   ▼
client.callTool({ name: toolName, arguments: params })
   │
   ▼
transformMcpResult(result)
   │
   └─→ ToolOutput { content, metadata }
```

### 6.3 工具命名规范

格式：`{serverName}_{toolName}`

示例：
- `filesystem_read_file`
- `github_create_issue`
- `weather_api_get_forecast`

清理规则：
```typescript
function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

const toolKey = `${sanitizeName(serverName)}_${sanitizeName(toolName)}`
```

---

## 七、Integration with tool-scheduler（与tool-scheduler集成）

### 7.1 工具注册流程

```typescript
// iris-code初始化或首次使用MCP工具时

// 1. 获取MCP工具列表
const mcpManager = McpManager.getInstance(workspaceId)
const mcpTools = await mcpManager.getAllTools()

// 2. 注册到ToolScheduler
for (const tool of mcpTools) {
  ToolScheduler.registry.register(tool, 'mcp')
}
```

### 7.2 执行路径分离

```typescript
// tool-scheduler的execute方法

class ToolScheduler {
  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.registry.get(request.toolName)

    if (tool.source === 'mcp') {
      // MCP工具独立路径
      return await this.executeMcpTool(tool, request)
    } else {
      // 内置工具正常路径
      return await this.executeBuiltinTool(tool, request)
    }
  }

  private async executeMcpTool(
    tool: Tool,
    request: ToolCallRequest
  ): Promise<ToolCallResult> {
    // 1. 检查trust（可能触发Permission.ask）
    if (!tool.isTrusted) {
      await Permission.ask({
        type: 'mcp-tool',
        serverName: tool.mcpServer,
        toolName: tool.name
      })
    }

    // 2. 直接执行（不走并发控制）
    return await tool.execute(request.params, {
      sessionId: request.sessionId,
      messageId: request.messageId,
      callId: request.callId,
      signal: createAbortSignal()
    })
  }
}
```

---

## 八、Multi-Workspace Support（多工作区支持）

### 8.1 工作区隔离

```typescript
// 工作区A
const managerA = McpManager.getInstance('workspace-a')
// 加载 workspace-a/.iris-code/mcp/settings.json

// 工作区B
const managerB = McpManager.getInstance('workspace-b')
// 加载 workspace-b/.iris-code/mcp/settings.json

// 两者完全独立
```

### 8.2 全局配置共享

```
全局配置: ~/.iris-code/mcp/settings.json
   │
   ├─→ 工作区A项目配置: workspace-a/.iris-code/mcp/settings.json
   │     └─ 合并后用于工作区A的McpManager
   │
   └─→ 工作区B项目配置: workspace-b/.iris-code/mcp/settings.json
         └─ 合并后用于工作区B的McpManager
```

---

## 九、Error Handling（错误处理）

### 9.1 初始化错误

| 错误场景 | 处理策略 |
|---------|---------|
| 配置加载失败 | 使用空配置，不抛出异常 |
| Stdio进程启动失败 | 记录错误，该服务器状态为failed |
| HTTP连接超时 | 记录错误，该服务器状态为failed |
| 工具发现失败 | 记录错误，该服务器状态为failed |

### 9.2 执行错误

| 错误场景 | 处理策略 |
|---------|---------|
| 服务器不存在 | 抛出Error: "MCP server not found" |
| 工具调用失败 | 返回包含错误信息的ToolOutput |
| 工具调用超时 | 通过AbortSignal中止，返回超时错误 |

---

## 十、文档自检

- 架构服务于goals-duty.md中定义的职责
- 组件职责单一、边界清晰
- 设计模式选择有明确理由（单例、懒加载、工厂、适配器）
- 错误处理策略明确（错误隔离、不影响全局）
- 与tool-scheduler的集成方式清晰
- 多工作区支持设计合理
