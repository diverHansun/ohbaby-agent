# mcp 模块 dfd-interface.md

本文档描述 `mcp` 模块的数据流和对外接口。

---

## 一、Data Flow

### 1.1 Runtime 启动到工具可用

```
createUiRuntimeComposition()
  │
  ├─ register builtin tools
  ├─ register skill / skill_resource
  │
  └─ McpManager.getInstance(workdir)
        │
        ▼
     getAllTools()
        │
        ▼
     ensureInitialized()
        │
        ├─ loadMcpConfig()
        │    ├─ ~/.ohbaby-agent/mcp/settings.json
        │    └─ <project>/.ohbaby-agent/mcp/settings.json
        │
        ├─ merge plugin server registrations
        │    └─ manual config wins on same server name
        │
        ├─ create one McpClient per server
        │    ├─ stdio -> StdioClientTransport
        │    ├─ http/http_streamable -> StreamableHTTPClientTransport
        │    └─ sse -> legacy SSE transport
        │
        ├─ client.connect()
        │    ├─ MCP initialize lifecycle
        │    ├─ capture capabilities/serverInfo/instructions
        │    ├─ listTools()
        │    └─ install tools/list_changed handler
        │
        └─ adaptMcpTool()
             └─ ToolScheduler.register()
```

If a server fails to connect, the manager records failed status and continues with the other servers.

### 1.2 MCP Tool Execution

```
LLM tool call: mcp_s..._t...
  │
  ▼
ToolScheduler
  │
  ├─ category from MCP annotations
  ├─ untrusted MCP check if trust=false
  └─ tool.execute()
        │
        ▼
     McpClient.callTool()
        │
        ▼
     MCP Server
        │
        ▼
     CallToolResult
        │
        ▼
     transformMcpResult()
```

Tool result content supports text, image, audio, embedded resource, resource link, and `structuredContent` metadata.

### 1.3 Resource / Prompt Flow

Resources and prompts are exposed through stable read-only MCP access tools instead of registering each server item as a separate tool.

```
LLM calls mcp_resource(server, uri)
  │
  ▼
McpManager.readResource(server, uri)
  │
  ▼
McpClient.readResource(uri)
  │
  ▼
resources/read
```

```
LLM calls mcp_prompt(server, name, args)
  │
  ▼
McpManager.getPrompt(server, name, args)
  │
  ▼
McpClient.getPrompt(name, args)
  │
  ▼
prompts/get
```

`McpManager.listResources()` and `McpManager.listPrompts()` return server-qualified entries so callers can present choices without losing origin server context.

### 1.4 Dynamic Tool Refresh

```
MCP Server sends tools/list_changed
  │
  ▼
McpClient handler
  ├─ clears local tool cache
  └─ emits onToolsChanged(serverName)
        │
        ▼
McpManager
  ├─ clears adapted tool cache
  └─ emits onChange()
        │
        ▼
Runtime composition
  ├─ calls getAllTools()
  ├─ unregisters stale MCP tool names
  └─ registers fresh MCP tools
```

---

## 二、Public Interface

### 2.1 McpClient

```ts
class McpClient {
  connect(): Promise<void>
  listTools(): Promise<readonly McpToolDefinition[]>
  callTool(request, options?): Promise<McpCallToolResult>

  listResources(): Promise<readonly McpResourceDefinition[]>
  readResource(uri: string): Promise<McpReadResourceResult>

  listPrompts(): Promise<readonly McpPromptDefinition[]>
  getPrompt(name: string, args?: Record<string, string>): Promise<McpGetPromptResult>

  getServerMetadata(): McpServerMetadata
  onToolsChanged(listener): () => void

  disconnect(): Promise<void>
  getStatus(): McpClientStatus
}
```

### 2.2 McpManager

```ts
class McpManager {
  static getInstance(workspaceId: string): McpManager

  getAllTools(): Promise<readonly McpTool[]>
  executeTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<McpCallToolResult>

  listResources(): Promise<readonly McpServerResourceDefinition[]>
  readResource(serverName: string, uri: string): Promise<McpReadResourceResult>

  listPrompts(): Promise<readonly McpServerPromptDefinition[]>
  getPrompt(serverName: string, name: string, args?: Record<string, string>): Promise<McpGetPromptResult>

  getStatus(): Promise<Record<string, McpClientStatus>>
  onChange(listener): () => void

  registerPluginServers(pluginId: string, servers: McpPluginServerContribution): Promise<void>
  deregisterPlugin(pluginId: string): Promise<void>

  dispose(): Promise<void>
}
```

### 2.3 MCP Access Tools

| Tool | Category | Purpose |
|------|----------|---------|
| `mcp_resource` | `readonly` | Read a specific resource from a connected MCP server |
| `mcp_prompt` | `readonly` | Get a specific prompt from a connected MCP server |

Both tools use `source: "mcp"` and `isTrusted: false`, so the same untrusted MCP confirmation path protects resource and prompt reads. Server-provided executable tools still carry their per-server `trust` setting.

---

## 三、Error Handling

- Config read/validation errors are surfaced through config errors.
- Individual server connection failures are isolated and reflected in status.
- Individual resource/prompt discovery failures are isolated per server and reported through status/onError.
- Unsupported resource/prompt direct reads throw clear capability errors.
- Tool execution results with `isError` become `McpToolExecutionError`.
- Runtime composition reports MCP refresh failures through `onNotice` and does not block startup.
