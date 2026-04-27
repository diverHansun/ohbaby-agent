# MCP 配置格式决策文档

本文档记录 ohbaby-code MCP 模块采用的配置格式及其理由。

---

## 一、配置格式选择

### 采用的格式（主流格式）

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR-API-KEY"
      }
    },
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_xxxx"
      }
    }
  }
}
```

### 未采用的格式（opencode格式）

```json
{
  "mcp": {
    "firecrawl-mcp": {
      "type": "local",
      "command": ["npx", "-y", "firecrawl-mcp"],
      "environment": {
        "FIRECRAWL_API_KEY": "YOUR-API-KEY"
      }
    },
    "github": {
      "type": "remote",
      "url": "https://api.github.com/mcp"
    }
  }
}
```

---

## 二、关键差异对比

| 特性 | ohbaby-code（主流格式） | opencode格式 |
|------|---------------------|-------------|
| **顶层字段** | `mcpServers` | `mcp` |
| **类型标识** | `stdio` / `http` / `sse` | `local` / `remote` |
| **命令格式** | `command: string` + `args: string[]` | `command: string[]` |
| **环境变量** | `env` | `environment` |
| **兼容性** | Claude Desktop, Cursor, VS Code, Cline, Amazon Q | 仅 opencode |

---

## 三、决策理由

### 3.1 采用主流格式的原因

1. **广泛兼容性**
   - Claude Desktop：官方 MCP 客户端
   - Cursor：主流 AI 代码编辑器
   - VS Code Copilot：微软官方 MCP 支持
   - Cline：流行的 AI 编程助手
   - Amazon Q Developer：AWS 官方 AI 开发工具

2. **官方推荐**
   - MCP 官方文档推荐的标准格式
   - [Model Context Protocol - Connect to local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)

3. **更好的语义**
   - `command: string` 清晰表示可执行文件
   - `args: string[]` 明确表示参数列表
   - 与 Node.js `child_process.spawn(command, args)` API 一致

4. **可读性**
   ```json
   // 主流格式 - 清晰直观
   {
     "command": "npx",
     "args": ["-y", "firecrawl-mcp"]
   }

   // opencode格式 - 需要理解数组第一个元素是命令
   {
     "command": ["npx", "-y", "firecrawl-mcp"]
   }
   ```

5. **用户体验**
   - 用户可以直接复制 Claude Desktop、Cursor 等工具的配置
   - 减少学习成本和配置错误
   - 社区资源丰富（教程、示例配置等）

### 3.2 类型标识选择

**`stdio` vs `local`**：
- `stdio` 是传输层协议的准确描述
- `local` 是部署位置的描述，语义不够精确
- MCP SDK 使用 `StdioClientTransport` 而非 `LocalTransport`

**`http`/`sse` vs `remote`**：
- 明确区分 HTTP Streamable 和 SSE 两种不同的传输协议
- `remote` 过于笼统，无法表达传输方式差异

### 3.3 顶层字段选择

**`mcpServers` vs `mcp`**：
- `mcpServers` 更明确表示这是 MCP 服务器配置集合
- 与 Claude Desktop 等主流工具保持一致
- 避免与其他 `mcp` 相关配置字段冲突

---

## 四、实现映射

### 4.1 Stdio配置 → SDK Transport

**配置**：
```json
{
  "command": "npx",
  "args": ["-y", "firecrawl-mcp"],
  "env": { "FIRECRAWL_API_KEY": "xxx" }
}
```

**映射到 MCP SDK**：
```typescript
new StdioClientTransport({
  command: "npx",                    // config.command
  args: ["-y", "firecrawl-mcp"],     // config.args
  env: {
    ...process.env,
    "FIRECRAWL_API_KEY": "xxx"       // config.env
  },
  stderr: 'pipe'
})
```

### 4.2 HTTP配置 → SDK Transport

**配置**：
```json
{
  "type": "http",
  "url": "https://api.github.com/mcp",
  "headers": { "Authorization": "Bearer xxx" }
}
```

**映射到 MCP SDK**：
```typescript
new StreamableHTTPClientTransport(
  new URL("https://api.github.com/mcp"),  // config.url
  {
    headers: { "Authorization": "Bearer xxx" }  // config.headers
  }
)
```

---

## 五、配置示例集合

### 5.1 Firecrawl（Cursor 官方示例）

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "YOUR-API-KEY"
      }
    }
  }
}
```

### 5.2 Filesystem（Claude Desktop 官方示例）

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/username/Desktop",
        "/Users/username/Downloads"
      ]
    }
  }
}
```

### 5.3 PostgreSQL（Claude Desktop 官方示例）

```json
{
  "mcpServers": {
    "postgres": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-postgres",
        "postgresql://localhost/mydb"
      ]
    }
  }
}
```

### 5.4 Memory（最小配置）

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"]
    }
  }
}
```

**注意**：`type: "stdio"` 可省略，默认为 stdio 类型。

### 5.5 HTTP 远程服务器

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_xxxxxxxxxxxx"
      },
      "trust": false
    }
  }
}
```

### 5.6 完整配置示例

```json
{
  "mcpServers": {
    "firecrawl": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "firecrawl-mcp"],
      "env": {
        "FIRECRAWL_API_KEY": "fc-xxx"
      },
      "enabled": true,
      "trust": true,
      "timeout": 15000
    },
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_xxx"
      },
      "enabled": true,
      "trust": false,
      "excludeTools": ["delete_repository"]
    }
  }
}
```

---

## 六、参考资料

### 官方文档

- [Model Context Protocol - Connect to local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Claude Desktop MCP Configuration](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)
- [VS Code Copilot MCP Servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

### 配置生成器

- [Claude Desktop Config Generator](https://claudedesktopconfiggenerator.com/)

### 社区资源

- [Configuring MCP Tools in Claude Code](https://scottspence.com/posts/configuring-mcp-tools-in-claude-code)
- [How to add MCP servers to Claude](https://www.weavely.ai/blog/claude-mcp)

---

## 七、未来兼容性

### 7.1 是否支持 opencode 格式？

**阶段1-2（MVP）**：仅支持主流格式

**未来扩展**：可考虑在配置加载器中添加格式转换层，支持 opencode 格式作为兼容模式：

```typescript
function normalizeConfig(raw: any): McpServerConfig {
  // 检测 opencode 格式
  if (raw.type === 'local' && Array.isArray(raw.command)) {
    return {
      type: 'stdio',
      command: raw.command[0],
      args: raw.command.slice(1),
      env: raw.environment
    }
  }

  // 主流格式
  return raw
}
```

### 7.2 TOML 格式支持

**阶段1-2**：仅支持 JSON

**未来扩展**：可添加 `settings.toml` 支持（次优先级）

---

## 八、文档自检

- [x] 清楚说明了采用主流格式的理由
- [x] 对比了 ohbaby-code 与 opencode 格式的差异
- [x] 提供了充分的官方文档和社区资源引用
- [x] 给出了完整的配置示例集合
- [x] 说明了实现映射细节
- [x] 预留了未来兼容性扩展方向
