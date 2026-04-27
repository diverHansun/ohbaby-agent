# mcp 模块 test.md

本文档描述 `mcp` 模块的测试策略与测试用例。

---

## 一、Test Strategy（测试策略）

### 1.1 测试目标

验证mcp模块的核心职责：
- 正确连接MCP服务器（Stdio、HTTP、SSE）
- 正确发现和转换MCP工具
- 正确执行MCP工具调用
- 正确处理各种错误情况
- 多工作区隔离正常工作
- 懒加载机制正常工作

### 1.2 测试层次

| 测试类型 | 覆盖范围 | 工具 |
|---------|---------|------|
| 单元测试 | 单个类/函数（McpClient、adaptMcpTool） | Jest + Mock |
| 集成测试 | McpManager完整流程 | Jest + 真实MCP服务器 |
| E2E测试 | 与tool-scheduler集成 | Jest + 端到端场景 |

---

## 二、Unit Tests（单元测试）

### 2.1 McpClient类测试

#### 测试用例1：Stdio连接成功

```typescript
describe('McpClient - Stdio', () => {
  it('should connect to stdio MCP server successfully', async () => {
    const config: McpStdioConfig = {
      type: 'stdio',
      command: ['node', './test-mcp-server.js']
    }

    const client = new McpClient('test', config)

    await expect(client.connect()).resolves.not.toThrow()
    expect(client.getStatus()).toEqual({
      status: 'connected',
      toolCount: expect.any(Number)
    })
  })
})
```

#### 测试用例2：HTTP连接成功

```typescript
it('should connect to HTTP MCP server successfully', async () => {
  const config: McpHttpConfig = {
    type: 'http',
    url: 'http://localhost:3000/mcp'
  }

  const client = new McpClient('http-test', config)

  await expect(client.connect()).resolves.not.toThrow()
  expect(client.getStatus().status).toBe('connected')
})
```

#### 测试用例3：连接失败处理

```typescript
it('should handle connection failure', async () => {
  const config: McpStdioConfig = {
    type: 'stdio',
    command: ['non-existent-command']
  }

  const client = new McpClient('fail', config)

  await expect(client.connect()).rejects.toThrow()
  expect(client.getStatus()).toMatchObject({
    status: 'failed',
    error: expect.any(String)
  })
})
```

#### 测试用例4：工具发现成功

```typescript
it('should discover tools successfully', async () => {
  const client = new McpClient('test', validConfig)
  await client.connect()

  const tools = await client.listTools()

  expect(Array.isArray(tools)).toBe(true)
  expect(tools.length).toBeGreaterThan(0)
  expect(tools[0]).toMatchObject({
    name: expect.any(String),
    description: expect.any(String),
    inputSchema: expect.any(Object)
  })
})
```

#### 测试用例5：工具调用成功

```typescript
it('should execute tool successfully', async () => {
  const client = new McpClient('test', validConfig)
  await client.connect()

  const result = await client.callTool({
    name: 'test_tool',
    arguments: { param1: 'value1' }
  })

  expect(result).toMatchObject({
    content: expect.any(Array),
    isError: false
  })
})
```

#### 测试用例6：工具调用超时

```typescript
it('should handle tool execution timeout', async () => {
  const client = new McpClient('test', validConfig)
  await client.connect()

  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)

  await expect(
    client.callTool(
      { name: 'slow_tool', arguments: {} },
      undefined,
      { signal: controller.signal }
    )
  ).rejects.toThrow('aborted')
})
```

#### 测试用例7：断开连接

```typescript
it('should disconnect successfully', async () => {
  const client = new McpClient('test', validConfig)
  await client.connect()

  await expect(client.disconnect()).resolves.not.toThrow()
  expect(client.getStatus().status).toBe('disconnected')
})
```

---

### 2.2 工具适配器测试

#### 测试用例1：基础工具适配

```typescript
describe('adaptMcpTool', () => {
  it('should adapt MCP tool to Tool interface', () => {
    const mcpTool: McpToolDef = {
      name: 'test_tool',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: {
          param1: { type: 'string' }
        }
      }
    }

    const mockClient = createMockMcpClient('server', [mcpTool])
    const tool = adaptMcpTool(mcpTool, mockClient, 'server')

    expect(tool).toMatchObject({
      name: 'server_test_tool',
      description: 'A test tool',
      source: 'mcp',
      category: undefined,
      mcpServer: 'server'
    })
  })
})
```

#### 测试用例2：工具名称清理

```typescript
it('should sanitize tool names', () => {
  const mcpTool: McpToolDef = {
    name: 'tool-with.special@chars',
    description: 'Test',
    inputSchema: {}
  }

  const tool = adaptMcpTool(mcpTool, mockClient, 'server-name')

  // 特殊字符被替换为下划线
  expect(tool.name).toBe('server_name_tool_with_special_chars')
})
```

#### 测试用例3：工具执行函数

```typescript
it('should create working execute function', async () => {
  const mcpTool: McpToolDef = {
    name: 'test',
    inputSchema: {}
  }

  const mockClient = createMockMcpClient('server', [mcpTool])
  mockClient.callTool.mockResolvedValue({
    content: [{ type: 'text', text: 'result' }]
  })

  const tool = adaptMcpTool(mcpTool, mockClient, 'server')
  const result = await tool.execute({ param: 'value' }, {
    sessionId: 'session1',
    messageId: 'msg1',
    callId: 'call1',
    signal: new AbortController().signal
  })

  expect(mockClient.callTool).toHaveBeenCalledWith(
    {
      name: 'test',
      arguments: { param: 'value' }
    },
    undefined,
    expect.objectContaining({
      signal: expect.any(AbortSignal)
    })
  )

  expect(result.content).toBe('result')
})
```

---

### 2.3 结果转换测试

#### 测试用例1：文本内容转换

```typescript
describe('transformMcpResult', () => {
  it('should transform text content', () => {
    const mcpResult: CallToolResult = {
      content: [
        { type: 'text', text: 'Line 1' },
        { type: 'text', text: 'Line 2' }
      ]
    }

    const output = transformMcpResult(mcpResult)

    expect(output).toMatchObject({
      content: 'Line 1\nLine 2',
      metadata: {
        source: 'mcp',
        contentTypes: ['text', 'text']
      }
    })
  })
})
```

#### 测试用例2：图片内容转换

```typescript
it('should transform image content', () => {
  const mcpResult: CallToolResult = {
    content: [
      {
        type: 'image',
        data: 'base64encodeddata',
        mimeType: 'image/png'
      }
    ]
  }

  const output = transformMcpResult(mcpResult)

  expect(output.content).toContain('![Image](data:image/png;base64,base64encodeddata)')
  expect(output.metadata?.hasImage).toBe(true)
})
```

#### 测试用例3：资源内容转换

```typescript
it('should transform resource content', () => {
  const mcpResult: CallToolResult = {
    content: [
      {
        type: 'resource',
        resource: {
          uri: 'file:///path/to/file.txt',
          text: 'File content'
        }
      }
    ]
  }

  const output = transformMcpResult(mcpResult)

  expect(output.content).toContain('[Resource: file:///path/to/file.txt]')
  expect(output.content).toContain('File content')
})
```

#### 测试用例4：错误结果转换

```typescript
it('should handle error results', () => {
  const mcpResult: CallToolResult = {
    content: [{ type: 'text', text: 'Error message' }],
    isError: true
  }

  const output = transformMcpResult(mcpResult)

  expect(output.error).toMatchObject({
    type: 'McpToolError',
    message: 'Error message'
  })
})
```

---

## 三、Integration Tests（集成测试）

### 3.1 McpManager初始化测试

#### 测试用例1：懒加载初始化

```typescript
describe('McpManager', () => {
  it('should lazy load on first getAllTools call', async () => {
    // 准备配置
    await createTestConfig({
      mcpServers: {
        test: {
          type: 'stdio',
          command: ['node', './test-server.js']
        }
      }
    })

    const manager = McpManager.getInstance(testWorkspaceId)

    // 创建时不初始化
    expect(manager['clients'].size).toBe(0)

    // 首次调用触发初始化
    const tools = await manager.getAllTools()

    expect(manager['clients'].size).toBeGreaterThan(0)
    expect(tools.length).toBeGreaterThan(0)
  })
})
```

#### 测试用例2：并行初始化多个服务器

```typescript
it('should initialize multiple servers in parallel', async () => {
  await createTestConfig({
    mcpServers: {
      server1: { type: 'stdio', command: ['node', 'server1.js'] },
      server2: { type: 'stdio', command: ['node', 'server2.js'] },
      server3: { type: 'stdio', command: ['node', 'server3.js'] }
    }
  })

  const manager = McpManager.getInstance(testWorkspaceId)
  const startTime = Date.now()

  await manager.getAllTools()

  const duration = Date.now() - startTime

  // 并行执行应该比串行快
  // 假设每个服务器启动200ms，并行应在250ms内完成
  expect(duration).toBeLessThan(300)
  expect(manager['clients'].size).toBe(3)
})
```

#### 测试用例3：单个服务器失败不影响其他

```typescript
it('should isolate server failures', async () => {
  await createTestConfig({
    mcpServers: {
      good: { type: 'stdio', command: ['node', 'good-server.js'] },
      bad: { type: 'stdio', command: ['non-existent'] },
      good2: { type: 'stdio', command: ['node', 'good-server2.js'] }
    }
  })

  const manager = McpManager.getInstance(testWorkspaceId)

  // 不应抛出异常
  const tools = await manager.getAllTools()

  // 应该有来自good和good2的工具
  expect(tools.length).toBeGreaterThan(0)
  expect(manager['clients'].has('good')).toBe(true)
  expect(manager['clients'].has('bad')).toBe(false)
  expect(manager['clients'].has('good2')).toBe(true)
})
```

---

### 3.2 工具发现测试

#### 测试用例1：工具过滤（includeTools）

```typescript
describe('Tool filtering', () => {
  it('should filter tools by includeTools', async () => {
    await createTestConfig({
      mcpServers: {
        server: {
          type: 'stdio',
          command: ['node', 'server.js'],
          includeTools: ['tool1', 'tool2']
        }
      }
    })

    const manager = McpManager.getInstance(testWorkspaceId)
    const tools = await manager.getAllTools()

    // 只包含tool1和tool2
    const toolNames = tools.map(t => t.name.split('_')[1])
    expect(toolNames).toContain('tool1')
    expect(toolNames).toContain('tool2')
    expect(toolNames).not.toContain('tool3')
  })
})
```

#### 测试用例2：工具过滤（excludeTools）

```typescript
it('should filter tools by excludeTools', async () => {
  await createTestConfig({
    mcpServers: {
      server: {
        type: 'stdio',
        command: ['node', 'server.js'],
        excludeTools: ['dangerous_tool']
      }
    }
  })

  const manager = McpManager.getInstance(testWorkspaceId)
  const tools = await manager.getAllTools()

  const toolNames = tools.map(t => t.name.split('_')[1])
  expect(toolNames).not.toContain('dangerous_tool')
})
```

---

### 3.3 工具执行测试

#### 测试用例1：执行Stdio工具

```typescript
describe('Tool execution', () => {
  it('should execute stdio tool successfully', async () => {
    const manager = McpManager.getInstance(testWorkspaceId)
    await manager.getAllTools()  // 初始化

    const result = await manager.executeTool(
      'filesystem',
      'read_file',
      { path: '/test/file.txt' }
    )

    expect(result.content).toContain('text')
  })
})
```

#### 测试用例2：执行HTTP工具

```typescript
it('should execute HTTP tool successfully', async () => {
  const manager = McpManager.getInstance(testWorkspaceId)
  await manager.getAllTools()

  const result = await manager.executeTool(
    'github',
    'get_user',
    { username: 'test' }
  )

  expect(result.content).toBeDefined()
})
```

#### 测试用例3：服务器不存在错误

```typescript
it('should throw error when server not found', async () => {
  const manager = McpManager.getInstance(testWorkspaceId)

  await expect(
    manager.executeTool('non-existent', 'tool', {})
  ).rejects.toThrow('MCP server "non-existent" not found')
})
```

---

### 3.4 多工作区测试

#### 测试用例1：工作区隔离

```typescript
describe('Multi-workspace', () => {
  it('should isolate workspaces', async () => {
    // 工作区A配置
    await createTestConfig({
      mcpServers: {
        server: { type: 'stdio', command: ['node', 'serverA.js'] }
      }
    }, '/workspace-a')

    // 工作区B配置
    await createTestConfig({
      mcpServers: {
        server: { type: 'stdio', command: ['node', 'serverB.js'] }
      }
    }, '/workspace-b')

    const managerA = McpManager.getInstance('/workspace-a')
    const managerB = McpManager.getInstance('/workspace-b')

    const toolsA = await managerA.getAllTools()
    const toolsB = await managerB.getAllTools()

    // 工具来自不同的服务器
    expect(toolsA).not.toEqual(toolsB)
  })
})
```

#### 测试用例2：单例模式验证

```typescript
it('should reuse instance for same workspace', () => {
  const manager1 = McpManager.getInstance('/workspace-a')
  const manager2 = McpManager.getInstance('/workspace-a')

  expect(manager1).toBe(manager2)
})
```

---

## 四、E2E Tests（端到端测试）

### 4.1 与tool-scheduler集成测试

#### 测试用例1：MCP工具注册

```typescript
describe('E2E with tool-scheduler', () => {
  it('should register MCP tools to ToolScheduler', async () => {
    const manager = McpManager.getInstance(testWorkspaceId)
    const mcpTools = await manager.getAllTools()

    // 注册到ToolScheduler
    for (const tool of mcpTools) {
      ToolScheduler.registry.register(tool, 'mcp')
    }

    // 验证注册成功
    const allTools = ToolScheduler.registry.getAllTools()
    const mcpToolNames = mcpTools.map(t => t.name)

    for (const name of mcpToolNames) {
      expect(allTools.find(t => t.name === name)).toBeDefined()
    }
  })
})
```

#### 测试用例2：通过tool-scheduler执行MCP工具

```typescript
it('should execute MCP tool through ToolScheduler', async () => {
  // 初始化MCP
  const manager = McpManager.getInstance(testWorkspaceId)
  const mcpTools = await manager.getAllTools()

  // 注册工具
  for (const tool of mcpTools) {
    ToolScheduler.registry.register(tool, 'mcp')
  }

  // 通过ToolScheduler执行
  const result = await ToolScheduler.execute({
    callId: 'test-call-1',
    toolName: 'filesystem_read_file',
    params: { path: '/test.txt' },
    sessionId: 'session1',
    messageId: 'msg1'
  })

  expect(result.status).toBe('success')
  expect(result.output).toBeDefined()
})
```

#### 测试用例3：trust机制集成

```typescript
it('should trigger Permission.ask when trust=false', async () => {
  const askSpy = jest.spyOn(Permission, 'ask').mockResolvedValue()

  const mcpTool = {
    name: 'untrusted_tool',
    source: 'mcp',
    isTrusted: false,
    execute: jest.fn().mockResolvedValue({ content: 'result' })
  }

  ToolScheduler.registry.register(mcpTool, 'mcp')

  await ToolScheduler.execute({
    callId: 'call1',
    toolName: 'untrusted_tool',
    params: {},
    sessionId: 'session1',
    messageId: 'msg1'
  })

  // 应该触发Permission.ask
  expect(askSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'mcp-tool'
    })
  )

  askSpy.mockRestore()
})
```

---

## 五、Error Handling Tests（错误处理测试）

### 5.1 连接错误测试

```typescript
describe('Error handling', () => {
  it('should handle Stdio process spawn error', async () => {
    const config: McpStdioConfig = {
      type: 'stdio',
      command: ['/non/existent/path']
    }

    const client = new McpClient('test', config)

    await expect(client.connect()).rejects.toThrow()
    expect(client.getStatus()).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('ENOENT')
    })
  })
})
```

### 5.2 HTTP错误测试

```typescript
it('should handle HTTP connection error', async () => {
  const config: McpHttpConfig = {
    type: 'http',
    url: 'http://localhost:9999/mcp'  // 不存在的端口
  }

  const client = new McpClient('test', config)

  await expect(client.connect()).rejects.toThrow()
})
```

### 5.3 工具执行错误测试

```typescript
it('should handle tool execution error gracefully', async () => {
  const manager = McpManager.getInstance(testWorkspaceId)
  await manager.getAllTools()

  const result = await manager.executeTool(
    'server',
    'failing_tool',
    { param: 'value' }
  )

  expect(result.error).toBeDefined()
  expect(result.error?.type).toBe('McpToolError')
})
```

---

## 六、Performance Tests（性能测试）

### 6.1 并行初始化性能

```typescript
describe('Performance', () => {
  it('should initialize multiple servers within acceptable time', async () => {
    await createTestConfig({
      mcpServers: {
        s1: { type: 'stdio', command: ['node', 's1.js'] },
        s2: { type: 'stdio', command: ['node', 's2.js'] },
        s3: { type: 'stdio', command: ['node', 's3.js'] }
      }
    })

    const manager = McpManager.getInstance(testWorkspaceId)
    const startTime = Date.now()

    await manager.getAllTools()

    const duration = Date.now() - startTime

    // 3个服务器并行初始化应在1秒内完成
    expect(duration).toBeLessThan(1000)
  })
})
```

### 6.2 缓存性能

```typescript
it('should return cached tools on subsequent calls', async () => {
  const manager = McpManager.getInstance(testWorkspaceId)

  const time1Start = Date.now()
  await manager.getAllTools()
  const time1 = Date.now() - time1Start

  const time2Start = Date.now()
  await manager.getAllTools()
  const time2 = Date.now() - time2Start

  // 第二次调用应该快得多（使用缓存）
  expect(time2).toBeLessThan(time1 / 10)
})
```

---

## 七、Test Utilities（测试工具函数）

### 7.1 Mock MCP服务器

```typescript
/**
 * 创建Mock MCP服务器进程
 */
function createMockMcpServer(tools: McpToolDef[]): ChildProcess {
  // 启动一个简单的MCP服务器进程
  // 用于集成测试
}
```

### 7.2 测试配置创建

```typescript
/**
 * 创建测试配置文件
 */
async function createTestConfig(
  config: McpServersConfig,
  workspacePath: string = testWorkspaceId
): Promise<void> {
  const configPath = path.join(workspacePath, '.ohbaby-code', 'mcp', 'settings.json')
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2))
}
```

### 7.3 清理函数

```typescript
/**
 * 清理测试资源
 */
async function cleanupTests(): Promise<void> {
  // 清理所有McpManager实例
  const instances = McpManager['instances']
  for (const manager of instances.values()) {
    await manager.dispose()
  }
  instances.clear()

  // 删除测试配置文件
  await fs.rm(testConfigDir, { recursive: true, force: true })
}

afterEach(async () => {
  await cleanupTests()
})
```

---

## 八、Coverage Requirements（覆盖率要求）

### 8.1 目标覆盖率

| 指标 | 目标 |
|------|------|
| 语句覆盖率 | >= 85% |
| 分支覆盖率 | >= 80% |
| 函数覆盖率 | >= 90% |
| 行覆盖率 | >= 85% |

### 8.2 必须覆盖的场景

- 所有正常路径（成功连接、成功执行）
- 所有错误路径（连接失败、执行失败）
- 所有配置组合（Stdio、HTTP、SSE）
- 懒加载机制
- 多工作区隔离
- 工具过滤（includeTools、excludeTools）
- 结果转换（text、image、resource）
- 错误隔离（单个服务器失败）

---

## 九、文档自检

- 测试策略清晰，覆盖单元测试、集成测试、E2E测试
- 测试用例完整，包含正常情况、错误情况、边界情况
- 测试工具函数可复用
- 覆盖率要求明确
- 测试用例与goals-duty.md定义的职责对应
- 性能测试覆盖关键场景
