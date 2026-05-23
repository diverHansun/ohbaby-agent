# mcp 模块 architecture.md

本文档描述 `mcp` 模块的内部架构。当前实现以 Anthropic / MCP 开放标准为主：ohbaby-agent 作为 MCP Host，在每个 workspace 内维护多个 MCP Client，每个 Client 连接一个 MCP Server。Server 可以暴露 tools、resources、prompts 等上下文能力。

---

## 一、Architecture Overview（架构概览）

### 模块定位

`mcp` 模块位于 `config/mcp`、runtime composition、tool-scheduler 和未来 `plugins` 模块之间，负责：

- 按 MCP Server 配置创建 Client 连接
- 执行 MCP 初始化生命周期并记录 server capabilities / info / instructions
- 发现 MCP tools 并适配为 ohbaby-agent `Tool`
- 提供 MCP resources / prompts 的只读访问工具
- 监听 `tools/list_changed`，清理缓存并通知 runtime 刷新
- 接收未来 plugins 模块分发的 MCP server contribution

### 核心结构

```
mcp/
├── index.ts
├── types.ts
│
├── core/
│   ├── client.ts       # 单个 MCP Client：连接、metadata、tools/resources/prompts
│   ├── manager.ts      # workspace 级管理器：多 server、缓存、plugin 注册、change event
│   └── transport.ts    # stdio / streamable HTTP / legacy SSE transport factory
│
├── integration/
│   ├── tool-adapter.ts             # MCP tool -> Tool
│   └── resource-prompt-tools.ts    # mcp_resource / mcp_prompt MCP access tools
│
└── __tests__/
```

### Host / Client / Server 映射

| MCP 概念 | ohbaby-agent 实现 |
|----------|-------------------|
| Host | runtime composition + ToolScheduler |
| Client | `McpClient`，每个 server 一个实例 |
| Server | 用户配置或插件贡献的 MCP server |
| Tools | `adaptMcpTool()` 适配进 ToolScheduler |
| Resources | `mcp_resource` 只读 MCP access tool 读取 |
| Prompts | `mcp_prompt` 只读 MCP access tool 获取 |

---

## 二、核心组件

### 2.1 McpClient

`McpClient` 包装官方 SDK Client。连接成功后会：

1. 通过 SDK 初始化流程完成 protocol negotiation
2. 读取 `getServerCapabilities()`、`getServerVersion()`、`getInstructions()`
3. 调用 `listTools()` 建立工具缓存
4. 注册 `ToolListChangedNotificationSchema` handler

主要接口：

- `connect()`
- `listTools()`
- `callTool()`
- `listResources()` / `readResource(uri)`
- `listPrompts()` / `getPrompt(name, args)`
- `getServerMetadata()`
- `onToolsChanged(listener)`
- `disconnect()`

`listTools()` / `listResources()` / `listPrompts()` 会沿 `nextCursor` 翻页，直到 server discovery 完整结束。

如果 server 未声明 resources/prompts capability，列表接口返回空数组；直接读取 unsupported capability 会抛出明确错误。

### 2.2 McpManager

`McpManager` 是 workspace 级 facade。它保持每个 workspace 一个实例，首次访问时才读取配置和连接 server。

职责：

- 从 `config/mcp` 读取全局 + 项目配置
- 合并 `registerPluginServers(pluginId, servers)` 注册的插件 server
- 手动配置同名时优先于插件配置
- 并行连接多个 server，单个失败不影响其他 server
- 缓存适配后的 MCP tools
- 汇总 resources/prompts，并在返回时附加 `serverName`
- 对外发布 `onChange()`，让 runtime 刷新 tool registry

### 2.3 Runtime Integration

`createUiRuntimeComposition()` 创建 ToolScheduler 后会：

1. 注册内置工具
2. 注册 SkillTool / SkillResourceTool
3. 通过 `McpManager.getAllTools()` 注册 MCP tools
4. 注册 `mcp_resource` / `mcp_prompt` MCP access tools
5. 订阅 `McpManager.onChange()`，在 MCP tools 变化时替换旧 MCP tools

ToolScheduler 对 `source: "mcp"` 的工具保持统一权限检查。`trust: false` 的 MCP tool 即使策略允许，也会进入用户确认流程；`mcp_resource` / `mcp_prompt` 作为跨 server 访问入口固定以未信任 MCP tool 处理，避免绕过确认。

---

## 三、Transport Strategy

当前对齐目标是一主一远两类传输：

| 配置类型 | SDK transport | 说明 |
|----------|---------------|------|
| `stdio` | `StdioClientTransport` | 本地 MCP server 子进程 |
| `http` / `http_streamable` | `StreamableHTTPClientTransport` | MCP streamable HTTP |
| `sse` | `SSEClientTransport` | 兼容旧 server，不作为新能力主路径 |

`http` 保留为历史兼容写法；`http_streamable` 是显式的 streamable HTTP 别名。

---

## 四、Tool Adapter

MCP tool 名称不会使用简单的 `{server}_{tool}`。当前实现使用长度前缀和字符转义：

```
mcp_s{serverEncodedLength}_{serverEncoded}_t{toolEncodedLength}_{toolEncoded}
```

这样可以避免 server/tool 名含 `_`、`.`、空格或其它字符时发生碰撞。

`annotations.readOnlyHint === true` 映射为 `readonly` category，其余默认 `write`。`destructiveHint`、`idempotentHint`、`openWorldHint` 会保留在 `mcpAnnotations` 中，供后续更细粒度 policy 使用。

---

## 五、Plugin Handoff

未来 `plugins` 模块不直接连接 MCP server，只负责解析插件包并调用：

```ts
await McpManager.registerPluginServers(pluginId, servers)
await McpManager.deregisterPlugin(pluginId)
```

`mcp` 模块负责最终 schema、连接生命周期、工具适配和权限语义。插件 server 与手动配置同名时，手动配置优先；插件注销会清理旧 client、清空缓存并通知 runtime。

---

## 六、Testing Strategy

测试分层：

- config validation：传输类型、默认值、tool filters
- client unit：metadata、tools cache、tools/list_changed、resources/prompts
- manager unit：懒加载、错误隔离、plugin registration、resources/prompts 聚合
- integration：使用官方 SDK InMemoryTransport 验证真实 MCP tool call
- runtime composition：验证 MCP tools 注入 ToolScheduler，并在变更时替换旧工具
