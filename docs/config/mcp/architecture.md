# config/mcp 模块 architecture.md

本文档描述 `config/mcp` 模块的职责、配置格式和合并策略。

---

## 一、Architecture Overview

`config/mcp` 是 MCP server 配置的纯加载与验证层。它不创建连接、不理解 runtime 生命周期，也不执行插件逻辑；这些由 `mcp` 和未来 `plugins` 模块负责。

```
config/mcp/
├── types.ts      # Zod schema、默认值、错误类型
├── loaders.ts    # 全局/项目配置读取和合并
├── index.ts
└── __tests__/
```

加载入口：

```ts
loadMcpConfig({
  homeDirectory?,
  projectDirectory?,
  globalPath?,
  projectPath?,
})
```

默认路径：

- 全局：`~/.ohbaby/mcp/settings.json`
- 项目：`<project>/.ohbaby/mcp/settings.json`

项目配置按 server name 完全覆盖全局同名配置。

---

## 二、Config Shape

顶层格式：

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {
        "ROOT": "${HOME}"
      },
      "trust": false,
      "timeout": 10000
    }
  }
}
```

### stdio

本地子进程 server：

```json
{
  "type": "stdio",
  "command": "node",
  "args": ["server.js"],
  "cwd": "D:/repo",
  "env": {
    "API_KEY": "..."
  }
}
```

`type` 可省略，含 `command` 时默认为 `stdio`。

### streamable HTTP

远程 streamable HTTP server：

```json
{
  "type": "http_streamable",
  "url": "https://example.com/mcp",
  "headers": {
    "Authorization": "Bearer token"
  }
}
```

兼容历史写法：

```json
{
  "type": "http",
  "url": "https://example.com/mcp"
}
```

`http` 和 `http_streamable` 都会创建 `StreamableHTTPClientTransport`。

### legacy SSE

`sse` 仍被 schema 接受，用于旧 MCP server 兼容；新增 server 应优先使用 `http_streamable`。

---

## 三、Common Fields

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | 是否连接该 server |
| `timeout` | `10000` | SDK connect/list/call timeout，单位 ms |
| `trust` | `false` | 是否跳过 MCP 工具的额外用户确认 |
| `includeTools` | unset | 只暴露指定 tool name |
| `excludeTools` | unset | 排除指定 tool name |

`includeTools` 与 `excludeTools` 不允许有重叠项。

`trust: false` 是安全默认值。ToolScheduler 对未信任 MCP tool 会要求用户确认，即使普通策略已允许。

---

## 四、Validation Rules

- `mcpServers` 必须是对象。
- server name 不能为空，不能带首尾空白。
- stdio `command` 必须是非空字符串，`args` 是字符串数组。
- streamable HTTP / SSE `url` 必须是有效 URL。
- schema 使用 `strict()`，未知字段会报错。
- 缺失配置文件返回空配置，不视为错误。

---

## 五、Plugin Interaction

插件提供的 MCP server 不由 `config/mcp` 读取。未来 `plugins` 模块会解析插件 manifest / `.mcp.json`，再调用 `await McpManager.registerPluginServers(pluginId, servers)`。

最终合并优先级：

```
global config
  ↓
project config overrides global
  ↓
plugin servers fill missing names only
```

因此手动配置永远优先于插件同名配置。这个优先级在 `mcp` 模块中执行，因为它涉及运行时注册和连接生命周期，不属于纯配置加载职责。

---

## 六、Non-goals

当前不在 `config/mcp` 中实现：

- OAuth login/logout
- token/keychain 存储
- plugin package 解析
- MCP server 连接
- runtime tool 注册

这些职责分别属于后续 auth、plugins、mcp core 和 runtime composition。
