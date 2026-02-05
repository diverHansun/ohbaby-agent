# mcp 模块 goals-duty.md

本文档定义 `mcp` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 提供MCP协议的客户端实现

实现Model Context Protocol客户端，支持Stdio和HTTP/SSE两种传输方式，让iris-code能够连接和使用符合MCP协议的工具服务器。

### 2. 动态扩展工具能力

允许用户通过配置文件添加MCP服务器，动态扩展LLM可用的工具集，而无需修改iris-code代码。

### 3. 与tool-scheduler无缝集成

将MCP工具转换为iris-code的Tool接口，注册到ToolScheduler，使MCP工具与内置工具在调用层面保持一致。

### 4. 保持独立的执行路径

MCP工具不参与tool-scheduler的并发控制体系，由MCP服务器自己负责并发管理，iris-code仅负责工具调用的转发。

### 5. 支持多工作区隔离

每个工作区拥有独立的MCP配置和客户端实例，不同工作区的MCP服务器互不影响。

---

## 二、Duties（职责）

### 1. 管理MCP服务器连接生命周期

负责：
- 根据配置创建MCP客户端实例
- 建立与MCP服务器的连接（Stdio进程或HTTP/SSE连接）
- 管理连接状态（connected、failed、disconnected）
- 连接失败时的错误处理和状态记录
- 工作区切换时的客户端隔离

### 2. 工具发现和转换

负责：
- 调用MCP协议的listTools接口发现工具
- 将MCP工具定义转换为iris-code的Tool接口
- 根据配置过滤工具（includeTools、excludeTools）
- 为每个MCP工具生成唯一的名称（serverName_toolName格式）

### 3. 工具执行转发

负责：
- 接收来自tool-scheduler的工具调用请求
- 将请求参数转发给对应的MCP服务器
- 调用MCP协议的callTool接口
- 将MCP返回的结果转换为标准ToolOutput格式

### 4. 懒加载初始化

负责：
- 首次调用MCP工具时才初始化MCP客户端
- 避免MCP加载失败影响iris-code启动
- 单个MCP服务器失败不影响其他服务器和内置工具

### 5. 配置驱动的信任机制

负责：
- 根据配置的trust字段决定是否需要额外确认
- 在所有模式（Ask/Plan/Agent）下开放MCP工具
- 不参与Policy的类别检查（MCP工具无ToolCategory）

---

## 三、Non-Duties（非职责）

### 1. 不负责配置加载和验证

MCP服务器配置的加载、验证由config/mcp模块负责，mcp模块只使用已验证的配置对象。

### 2. 不负责工具分类和并发控制

MCP工具不分配ToolCategory，不参与tool-scheduler的ConcurrencyController，由MCP服务器自己管理并发。

### 3. 不负责OAuth认证流程

阶段1-2不实现OAuth，仅支持通过headers手动传递认证令牌。未来如实现OAuth，也应作为独立的auth子模块。

### 4. 不负责工具权限检查

工具的权限检查（Policy.check、Permission.ask）由tool-scheduler负责，mcp模块只负责执行。

### 5. 不负责MCP工具的注册

MCP工具的注册到ToolScheduler.registry由初始化流程或tool-scheduler负责，mcp模块只提供转换后的Tool对象。

### 6. 不负责资源和Prompt

阶段1-2仅支持MCP的工具（Tools）功能，不支持资源（Resources）和提示（Prompts）。

### 7. 不负责动态工具更新

阶段1-2不监听ToolListChangedNotification，工具列表在初始化时确定。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| config/mcp | 依赖 | 调用loadMcpConfig()获取配置 |
| tool-scheduler | 被依赖 | tool-scheduler调用MCP工具的execute函数 |
| Policy | 无直接依赖 | MCP工具不走Policy.check的类别检查 |
| Permission | 无直接依赖 | trust机制可能触发Permission.ask（由tool-scheduler处理） |
| MCP SDK | 依赖 | 使用@modelcontextprotocol/sdk的Client、Transport |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：mcp模块管理连接
```typescript
// mcp模块负责
const client = new McpClient(name, config)
await client.connect()  // 建立连接
```

正确：mcp模块转换工具
```typescript
// mcp模块负责
const mcpToolDef = await client.listTools()
const tool = adaptMcpTool(mcpToolDef, client, serverName)
```

### 5.2 职责外的示例

错误：mcp模块不应检查权限
```typescript
// ❌ 错误：不应该在mcp模块中
if (Policy.getMode() === 'ask') {
  await Permission.ask(...)
}

// ✅ 正确：由tool-scheduler负责
```

错误：mcp模块不应加载配置
```typescript
// ❌ 错误：不应该在mcp模块中
const config = JSON.parse(fs.readFileSync(...))

// ✅ 正确：由config/mcp模块负责
const config = await loadMcpConfig()
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：mcp模块实现MCP协议客户端，让iris-code能够动态连接和使用第三方MCP工具服务器
- 能清楚回答"这个模块不该做什么"：不做配置加载、不做工具分类、不做并发控制、不做权限检查、不做OAuth认证
- 职责与其他模块无明显重叠：与config/mcp（配置管理）、tool-scheduler（调度和权限）、MCP SDK（协议实现）边界清晰
