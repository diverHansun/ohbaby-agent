# config/mcp 模块 dfd-interface.md

本文档描述 `config/mcp` 模块的数据流和对外接口。

---

## 一、Data Flow Diagram（数据流图）

### 1.1 配置加载流程

```
外部调用
   │
   ▼
loadMcpConfig()
   │
   ├─→ loadFromPath(globalPath)
   │     │
   │     ├─→ fs.readFile()              读取 ~/.ohbaby-agent/mcp/settings.json
   │     ├─→ JSON.parse()               解析JSON
   │     └─→ McpServersConfigSchema.parse()  Zod验证
   │          ↓
   │       globalConfig: McpServersConfig
   │
   ├─→ loadFromPath(projectPath)
   │     │
   │     ├─→ fs.readFile()              读取 {project}/.ohbaby-agent/mcp/settings.json
   │     ├─→ JSON.parse()               解析JSON
   │     └─→ McpServersConfigSchema.parse()  Zod验证
   │          ↓
   │       projectConfig: McpServersConfig
   │
   └─→ mergeConfigs(globalConfig, projectConfig)
         │
         └─→ 按服务器名称合并
              ↓
          finalConfig: McpServersConfig
              ↓
         返回给调用方（mcp模块）
```

### 1.2 错误处理流程

```
配置加载
   │
   ├─→ 文件不存在？
   │     └─→ Yes → 返回空配置 { mcpServers: {} }
   │
   ├─→ JSON解析失败？
   │     └─→ Yes → 抛出 ConfigError('INVALID_JSON')
   │
   └─→ Schema验证失败？
         └─→ Yes → 抛出 ZodError (包含详细验证信息)
```

---

## 二、Public Interface（公开接口）

### 2.1 主入口函数

```typescript
/**
 * 加载MCP服务器配置
 *
 * 从全局和项目配置文件加载MCP服务器配置，项目配置覆盖全局配置。
 *
 * @returns MCP服务器配置对象
 * @throws ConfigError 配置文件格式错误
 * @throws ZodError Schema验证失败
 *
 * @example
 * const config = await loadMcpConfig()
 * console.log(config.mcpServers.github.url)
 */
export async function loadMcpConfig(): Promise<McpServersConfig>
```

### 2.2 类型导出

```typescript
// 配置类型
export type { McpStdioConfig } from './types.js'
export type { McpHttpConfig } from './types.js'
export type { McpSseConfig } from './types.js'
export type { McpServerConfig } from './types.js'
export type { McpServersConfig } from './types.js'

// Schema导出（供测试或高级用户使用）
export { McpStdioConfigSchema } from './types.js'
export { McpHttpConfigSchema } from './types.js'
export { McpSseConfigSchema } from './types.js'
export { McpServerConfigSchema } from './types.js'
export { McpServersConfigSchema } from './types.js'
```

### 2.3 常量导出

```typescript
export { DEFAULT_MCP_TIMEOUT } from './types.js'
export { DEFAULT_MCP_ENABLED } from './types.js'
export { DEFAULT_MCP_TRUST } from './types.js'
```

---

## 三、Internal Functions（内部函数）

这些函数不对外导出，仅在模块内部使用。

### 3.1 loadFromPath

```typescript
/**
 * 从指定路径加载单个配置文件
 *
 * @param filepath 配置文件绝对路径
 * @returns 配置对象，如果文件不存在返回空配置
 * @throws ConfigError JSON解析失败
 * @throws ZodError Schema验证失败
 */
async function loadFromPath(filepath: string): Promise<McpServersConfig>
```

实现逻辑：
```typescript
async function loadFromPath(filepath: string): Promise<McpServersConfig> {
  // 1. 检查文件是否存在
  try {
    await fs.access(filepath)
  } catch {
    return { mcpServers: {} }  // 文件不存在，返回空配置
  }

  // 2. 读取文件内容
  let content: string
  try {
    content = await fs.readFile(filepath, 'utf-8')
  } catch (error) {
    throw new ConfigError(
      `Failed to read MCP config file: ${error.message}`,
      'LOAD_FAILED',
      { path: filepath, cause: error }
    )
  }

  // 3. 解析JSON
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new ConfigError(
      `Invalid JSON in MCP config file: ${error.message}`,
      'INVALID_JSON',
      { path: filepath, cause: error }
    )
  }

  // 4. Zod验证
  try {
    return McpServersConfigSchema.parse(raw)
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw error  // ZodError包含详细验证信息，直接抛出
    }
    throw new ConfigError(
      `Invalid MCP config schema`,
      'VALIDATION_FAILED',
      { path: filepath, cause: error }
    )
  }
}
```

### 3.2 mergeConfigs

```typescript
/**
 * 合并多个配置对象
 *
 * @param global 全局配置
 * @param project 项目配置
 * @returns 合并后的配置（项目覆盖全局）
 */
function mergeConfigs(
  global: McpServersConfig,
  project: McpServersConfig
): McpServersConfig
```

实现逻辑：
```typescript
function mergeConfigs(
  global: McpServersConfig,
  project: McpServersConfig
): McpServersConfig {
  // 项目配置的同名服务器完全覆盖全局配置
  return {
    mcpServers: {
      ...global.mcpServers,
      ...project.mcpServers,
    }
  }
}
```

### 3.3 normalizeConfig（可选）

```typescript
/**
 * 规范化配置对象，补充隐式type字段
 *
 * @param raw 原始配置对象
 * @returns 规范化后的配置对象
 */
function normalizeConfig(raw: any): McpServerConfig
```

实现逻辑：
```typescript
function normalizeConfig(raw: any): McpServerConfig {
  // 已有显式type
  if (raw.type) return raw

  // 隐式推断
  if (raw.command) {
    return { ...raw, type: 'stdio' }
  } else if (raw.url) {
    return { ...raw, type: 'http' }
  }

  throw new Error('Invalid MCP server config: missing type or command/url')
}
```

---

## 四、Integration with mcp Module（与mcp模块集成）

### 4.1 调用方式

```typescript
// mcp模块中使用
import { loadMcpConfig } from '@/config'

export class McpManager {
  private async initialize(): Promise<void> {
    // 加载配置
    const config = await loadMcpConfig()

    // 遍历配置创建MCP客户端
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      if (!serverConfig.enabled) continue

      const client = new McpClient(name, serverConfig)
      await client.connect()
      // ...
    }
  }
}
```

### 4.2 数据流向

```
config/mcp 模块
   │ loadMcpConfig()
   ▼
McpServersConfig 对象
   │ 传递给
   ▼
mcp 模块
   │ 遍历 config.mcpServers
   ▼
创建 McpClient 实例
   │ 使用 serverConfig
   ▼
连接 MCP 服务器
```

---

## 五、Configuration File Locations（配置文件位置）

### 5.1 全局配置

路径：`~/.ohbaby-agent/mcp/settings.json`

用途：
- 用户级别的默认MCP服务器配置
- 跨项目共享的MCP服务器（如公共API）

示例：
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_global_token"
      }
    }
  }
}
```

### 5.2 项目配置

路径：`{project}/.ohbaby-agent/mcp/settings.json`

用途：
- 项目特定的MCP服务器配置
- 覆盖全局配置的服务器设置

示例：
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_project_token"
      },
      "trust": true
    },
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/mcp-server.js"]
    }
  }
}
```

### 5.3 最终配置（合并后）

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer ghp_project_token"
      },
      "trust": true
    },
    "local-tools": {
      "type": "stdio",
      "command": "node",
      "args": ["./tools/mcp-server.js"]
    }
  }
}
```

---

## 六、Error Scenarios（错误场景）

### 6.1 场景1：配置文件不存在

输入：
- 全局配置不存在
- 项目配置存在

行为：
```typescript
const globalConfig = { mcpServers: {} }  // 空配置
const projectConfig = await loadFromPath(projectPath)
return mergeConfigs(globalConfig, projectConfig)
// 结果：仅使用项目配置
```

### 6.2 场景2：JSON格式错误

输入：settings.json内容
```json
{
  "mcpServers": {
    "github": {
      "url": "...",  // 缺少结束大括号
```

行为：
```typescript
throw new ConfigError(
  "Invalid JSON in MCP config file: Unexpected end of JSON input",
  "INVALID_JSON",
  { path: "/path/to/settings.json", cause: SyntaxError }
)
```

### 6.3 场景3：Schema验证失败

输入：settings.json内容
```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "timeout": "10000"  // 应该是number，不是string
    }
  }
}
```

行为：
```typescript
// Zod抛出ZodError
ZodError: [
  {
    "code": "invalid_type",
    "expected": "number",
    "received": "string",
    "path": ["mcpServers", "github", "timeout"],
    "message": "Expected number, received string"
  }
]
```

### 6.4 场景4：缺少必需字段

输入：settings.json内容
```json
{
  "mcpServers": {
    "github": {
      "type": "http"
      // 缺少url字段
    }
  }
}
```

行为：
```typescript
ZodError: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": ["mcpServers", "github", "url"],
    "message": "Required"
  }
]
```

---

## 七、Performance Considerations（性能考虑）

### 7.1 文件I/O

- 每次调用loadMcpConfig()都执行2次文件读取（全局+项目）
- 平均耗时：~10ms（取决于文件系统性能）
- 缓存策略由调用方（mcp模块）决定

### 7.2 Schema验证

- Zod验证开销：~1ms（典型配置）
- discriminatedUnion优化：根据type字段快速分发到对应Schema

### 7.3 优化建议

调用方可缓存配置：
```typescript
class McpManager {
  private configCache: McpServersConfig | null = null

  async getConfig(): Promise<McpServersConfig> {
    if (!this.configCache) {
      this.configCache = await loadMcpConfig()
    }
    return this.configCache
  }

  reloadConfig(): void {
    this.configCache = null
  }
}
```

---

## 八、Testing Interface（测试接口）

### 8.1 测试辅助函数（可选导出）

```typescript
/**
 * 仅用于测试：从对象创建配置（跳过文件读取）
 */
export function createMcpConfigForTest(
  servers: Record<string, McpServerConfig>
): McpServersConfig {
  return McpServersConfigSchema.parse({ mcpServers: servers })
}
```

### 8.2 Mock示例

```typescript
// 测试中Mock loadMcpConfig
jest.mock('@/config', () => ({
  loadMcpConfig: jest.fn().mockResolvedValue({
    mcpServers: {
      test: {
        type: 'stdio',
        command: ['node', 'test.js']
      }
    }
  })
}))
```

---

## 九、文档自检

- 数据流图清晰展示配置加载过程
- 公开接口文档完整（参数、返回值、异常）
- 内部函数实现逻辑明确
- 与mcp模块的集成方式清晰
- 错误场景覆盖常见情况
- 性能考虑点已说明
