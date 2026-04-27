# config/mcp 模块 data-model.md

本文档定义 `config/mcp` 模块的核心数据类型与概念。

---

## 一、Core Concepts（核心概念）

### 1.1 McpServerConfig（MCP服务器配置）

表示单个MCP服务器的完整配置信息，包括连接方式、认证、超时等参数。

本质：Value Object（值对象），无身份标识，不可变。

### 1.2 McpServersConfig（MCP服务器集合配置）

表示所有MCP服务器的配置集合，以服务器名称为键的映射表。

本质：Value Object，配置文件的直接映射。

### 1.3 传输类型（Transport Type）

MCP协议支持的三种传输方式：
- Stdio: 本地进程通信
- HTTP: 基于HTTP的Streamable传输
- SSE: Server-Sent Events传输

---

## 二、Data Types（数据类型）

### 2.1 Stdio类型配置

```typescript
interface McpStdioConfig {
  type: 'stdio'                      // 显式类型标识

  // 命令格式：支持两种主流格式
  // 格式1（主流）：分离的 command 和 args
  command: string                    // 可执行文件（如 "npx", "node", "python"）
  args?: string[]                    // 参数列表（如 ["-y", "firecrawl-mcp"]）

  // 格式2（opencode 兼容）：单数组格式
  // command: string[]               // 命令+参数（如 ["npx", "-y", "firecrawl-mcp"]）

  env?: Record<string, string>       // 环境变量
  cwd?: string                       // 工作目录
  enabled?: boolean                  // 是否启用（默认true）
  trust?: boolean                    // 是否信任（默认false）
  timeout?: number                   // 连接和工具发现超时（毫秒，默认10000）
  includeTools?: string[]            // 工具白名单
  excludeTools?: string[]            // 工具黑名单
}
```

**说明**：

ohbaby-agent 采用**主流格式**（分离的 `command` 和 `args`），与以下工具保持一致：
- Claude Desktop
- Cursor
- VS Code Copilot
- Cline
- Amazon Q Developer

此格式也是 MCP 官方文档推荐的标准格式。

### 2.2 HTTP类型配置

```typescript
interface McpHttpConfig {
  type: 'http'                       // 显式类型标识
  url: string                        // 服务器URL
  headers?: Record<string, string>   // HTTP请求头（如Authorization）
  enabled?: boolean                  // 是否启用（默认true）
  trust?: boolean                    // 是否信任（默认false）
  timeout?: number                   // 连接和工具发现超时（毫秒，默认10000）
  includeTools?: string[]            // 工具白名单
  excludeTools?: string[]            // 工具黑名单
}
```

### 2.3 SSE类型配置

```typescript
interface McpSseConfig {
  type: 'sse'                        // 显式类型标识
  url: string                        // 服务器URL
  headers?: Record<string, string>   // HTTP请求头
  enabled?: boolean                  // 是否启用（默认true）
  trust?: boolean                    // 是否信任（默认false）
  timeout?: number                   // 连接和工具发现超时（毫秒，默认10000）
  includeTools?: string[]            // 工具白名单
  excludeTools?: string[]            // 工具黑名单
}
```

### 2.4 联合类型

```typescript
type McpServerConfig = McpStdioConfig | McpHttpConfig | McpSseConfig
```

### 2.5 完整配置对象

```typescript
interface McpServersConfig {
  mcpServers: Record<string, McpServerConfig>
}
```

---

## 三、Zod Schema Definitions（Schema定义）

### 3.1 基础Schema

```typescript
import { z } from 'zod'

// Stdio配置Schema（主流格式：分离的 command 和 args）
export const McpStdioConfigSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1).describe('Executable command (e.g., "npx", "node", "python")'),
  args: z.array(z.string()).optional().describe('Command arguments (e.g., ["-y", "firecrawl-mcp"])'),
  env: z.record(z.string(), z.string()).optional().describe('Environment variables'),
  cwd: z.string().optional().describe('Working directory'),
  enabled: z.boolean().optional().default(true),
  trust: z.boolean().optional().default(false),
  timeout: z.number().int().positive().optional().default(10000),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
}).strict()

// HTTP配置Schema
export const McpHttpConfigSchema = z.object({
  type: z.literal('http'),
  url: z.string().url().describe('HTTP URL of MCP server'),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  trust: z.boolean().optional().default(false),
  timeout: z.number().int().positive().optional().default(10000),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
}).strict()

// SSE配置Schema
export const McpSseConfigSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url().describe('SSE URL of MCP server'),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional().default(true),
  trust: z.boolean().optional().default(false),
  timeout: z.number().int().positive().optional().default(10000),
  includeTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
}).strict()

// 联合Schema（使用discriminatedUnion以提升性能）
export const McpServerConfigSchema = z.discriminatedUnion('type', [
  McpStdioConfigSchema,
  McpHttpConfigSchema,
  McpSseConfigSchema,
])

// 完整配置Schema
export const McpServersConfigSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema),
})
```

### 3.2 类型推导

```typescript
export type McpStdioConfig = z.infer<typeof McpStdioConfigSchema>
export type McpHttpConfig = z.infer<typeof McpHttpConfigSchema>
export type McpSseConfig = z.infer<typeof McpSseConfigSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>
```

---

## 四、Field Descriptions（字段说明）

### 4.1 通用字段

| 字段 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| type | 'stdio' \| 'http' \| 'sse' | 是 | - | 传输类型标识 |
| enabled | boolean | 否 | true | 是否启用该MCP服务器 |
| trust | boolean | 否 | false | 是否信任（跳过额外确认） |
| timeout | number | 否 | 10000 | 连接和工具发现超时（毫秒） |
| includeTools | string[] | 否 | undefined | 工具白名单（仅加载这些工具） |
| excludeTools | string[] | 否 | undefined | 工具黑名单（排除这些工具） |

### 4.2 Stdio特有字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| command | string | 是 | 可执行文件（如 "npx", "node", "python"） |
| args | string[] | 否 | 命令参数数组（如 ["-y", "firecrawl-mcp"]） |
| env | Record<string, string> | 否 | 进程环境变量 |
| cwd | string | 否 | 进程工作目录 |

### 4.3 HTTP/SSE特有字段

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| url | string | 是 | MCP服务器的HTTP/SSE端点URL |
| headers | Record<string, string> | 否 | HTTP请求头（如Authorization） |

---

## 五、Configuration Examples（配置示例）

### 5.1 Stdio本地服务器

**示例1：Firecrawl MCP（参考 Cursor 官方示例）**

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

**示例2：Filesystem MCP（Claude Desktop 官方示例）**

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/username/Desktop"],
      "enabled": true,
      "trust": true,
      "timeout": 15000
    }
  }
}
```

**示例3：Memory MCP（最小配置）**

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

### 5.2 HTTP远程服务器

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_xxxxxxxxxxxx",
        "Accept": "application/json"
      },
      "enabled": true,
      "trust": false,
      "excludeTools": ["delete_repository"]
    }
  }
}
```

### 5.3 SSE远程服务器

```json
{
  "mcpServers": {
    "weather": {
      "type": "sse",
      "url": "https://weather-api.example.com/mcp",
      "enabled": true,
      "includeTools": ["get_weather", "get_forecast"]
    }
  }
}
```

### 5.4 混合配置

```json
{
  "mcpServers": {
    "local-fs": {
      "type": "stdio",
      "command": ["node", "./local-mcp-server.js"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://api.example.com/mcp",
      "headers": {
        "X-API-Key": "secret"
      }
    }
  }
}
```

---

## 六、Validation Rules（验证规则）

### 6.1 类型验证

- type字段必须是'stdio'、'http'或'sse'之一
- 根据type字段验证必需字段：
  - stdio: 必须有command
  - http/sse: 必须有url

### 6.2 值范围验证

- command数组不能为空
- url必须是有效的URL格式
- timeout必须是正整数
- enabled和trust必须是布尔值

### 6.3 逻辑验证

- includeTools和excludeTools不能同时指定同一个工具名
- 服务器名称（mcpServers的键）不能为空字符串

---

## 七、Implicit Type Inference（隐式类型推断）

为兼容性和便利性，支持省略type字段：

### 7.1 推断规则

```typescript
function normalizeConfig(raw: any): McpServerConfig {
  // 已有显式type，直接返回
  if (raw.type) return raw

  // 根据字段推断type
  if (raw.command) {
    return { ...raw, type: 'stdio' }
  } else if (raw.url) {
    return { ...raw, type: 'http' }  // 默认http，可通过headers降级sse
  }

  throw new Error('Invalid MCP server config: missing type or command/url')
}
```

### 7.2 示例

```json
// 原始配置（省略type）
{
  "mcpServers": {
    "local": {
      "command": ["node", "server.js"]
    }
  }
}

// 规范化后
{
  "mcpServers": {
    "local": {
      "type": "stdio",
      "command": ["node", "server.js"]
    }
  }
}
```

---

## 八、Constants（常量定义）

### 8.1 默认值

```typescript
export const DEFAULT_MCP_TIMEOUT = 10000      // 10秒
export const DEFAULT_MCP_ENABLED = true
export const DEFAULT_MCP_TRUST = false
```

### 8.2 配置文件路径

```typescript
export const GLOBAL_MCP_CONFIG_DIR = '~/.ohbaby-agent/mcp'
export const GLOBAL_MCP_CONFIG_FILE = 'settings.json'

export const PROJECT_MCP_CONFIG_DIR = '.ohbaby-agent/mcp'
export const PROJECT_MCP_CONFIG_FILE = 'settings.json'
```

---

## 九、文档自检

- 核心概念定义清晰，无歧义
- 数据类型完整覆盖模块需求
- Zod Schema与TypeScript类型一致
- 验证规则明确
- 配置示例覆盖常见场景
- 类型定义符合TypeScript规范
