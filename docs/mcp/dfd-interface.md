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
        │    ├─ ~/.ohbaby/mcp/settings.json
        │    └─ <project>/.ohbaby/mcp/settings.json
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
             └─ admitMcpTools()
                  ├─ ToolScheduler.register()  # 执行注册
                  ├─ McpToolMenu.setAvailable() # scope 点菜
                  └─ McpToolSearch              # 原始 desc 仅入索引
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
  ├─ generic explicit approval if requireExplicitApproval=true
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

模型调用 MCP 工具前先经过发现/加载：

```text
select_tools({query, limit?, load:false}) -> candidates [{name, score}]
select_tools({query, limit?, load:true})  -> 同一排名依次 menu.select
select_tools({tools:[exact names]})       -> 精确 menu.select（兼容路径）
```

只有 loaded 集中的 MCP 工具能通过 runtime access guard。搜索结果和模型可见 metadata 均不包含 server 原始 description。

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
  ├─ 串行/合并 refresh，revision latest-wins
  ├─ calls getAllTools() + admit
  └─ 同快照更新 registry / menu / search corpus
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

Both tools use `source: "mcp"` and `requireExplicitApproval: true`, so the generic explicit-approval path protects resource and prompt reads. Server-provided executable tools still carry MCP-local `isTrusted` metadata, but scheduler consumes only `requireExplicitApproval`.

### 2.4 `select_tools`

`tools` 只能单独出现；`query` 可搭配 `limit`（1–8，默认 5）和 `load`（默认 false）。空对象、空 tools、空白 query、`tools+query/load/limit`、以及无 query 的 load/limit 均报错。query 无命中是成功空结果。

---

## 三、Error Handling

- Config read/validation errors are surfaced through config errors.
- Individual server connection failures are isolated and reflected in status.
- Individual resource/prompt discovery failures are isolated per server and reported through status/onError.
- Unsupported resource/prompt direct reads throw clear capability errors.
- Tool execution results with `isError` become `McpToolExecutionError`. Its optional, non-enumerable `metadata` carries the existing MCP fields through the generic scheduler error path into `ToolPart.state.metadata`; the result stays an error. Metadata is projected by the existing tool whitelist instead of being duplicated inside serialized error details.
- Runtime composition reports MCP refresh failures through `onNotice` and does not block startup.

## stdio 启动环境与失败边界

`createTransport()` 仅为 stdio 装配代理白名单和 `config.env`。SDK 保留默认安全环境列表（例如 PATH、HOME），父进程其他变量和无关 secret 不会全量继承。HTTP / SSE transport 仍使用主进程路由。

SDK client 和 transport 构造均在 `connect()` 的错误处理范围内；构造、启动、连接或工具发现失败时记录 `failed` 状态并关闭已创建 SDK 资源。该 server 的错误不会影响其他 server；重新连接再次读取当前代理快照。诊断区分配置不可用与命令实际联网失败，避免输出凭证、完整代理 URL 或环境转储。

### 子进程代理环境契约

Shell 和 MCP stdio 在每次新启动时读取 `network-proxy` 当前已完成的配置快照。安装时捕获的进程显式代理变量作为基础，该次 `context.env` / `config.env` 的非空同名逻辑键优先；同层小写优先大写。`ALL_PROXY` 补齐缺少的协议，只要存在显式 HTTP / HTTPS / ALL 代理，就整组使用环境配置，不从系统补另一协议。空白覆盖值恢复继承，普通环境变量空串保持原值。

只有 `NO_PROXY` 时仍跟随系统；`NO_PROXY=*` 明确全部绕过，允许在系统读取失败时启动。POSIX 输出同值大小写代理别名；Windows 按大小写不敏感键处理并输出单一逻辑键。构造时先清除旧代理别名；系统值不会写回 `process.env`。显式外部客户端原生代理协议保留，HTTP(S) URL 继续校验；这不新增主 Node SOCKS 支持。

自动系统 bypass 支持字面 IP 和规范化 IPv4 CIDR（curl 7.86+）；固定绕过包含 localhost、127.0.0.1、::1 和 127/8。映射 IPv6 系统字面规则生成 curl 的点分与十六进制两种别名。IPv6 CIDR、精确裸域、仅子域、通配域、host:port 与 `<local>` 无法保证等价，本次启动明确失败。常见 `*.local` / `<local>` 配置在自动系统路径下必然失败；错误提示显式设置所需协议的 `HTTP_PROXY` / `HTTPS_PROXY`（可附加 `NO_PROXY`），或选择 `NO_PROXY=*`。只设置普通 `NO_PROXY` 不能绕开转换失败。不执行 PAC，不丢弃规则，不启动本地转发服务。

刷新完成后原子替换快照；系统关闭或读取失败不继续沿用旧成功值。已有子进程保留启动环境，重连或新启动使用新快照。卸载清空安装快照；嵌入方未安装时只继承显式 env，不自动读取系统设置。变量传递不构成网络沙箱；不读取变量的程序不在透明接管承诺内。
