# config/mcp 模块 architecture.md

本文档描述 `config/mcp` 模块的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

---

## 一、Architecture Overview（架构概览）

### 模块定位

config/mcp 是 iris-code 配置系统的一部分，专门负责MCP服务器配置的加载和验证。它遵循与config/llm相同的设计模式，保持配置加载逻辑的独立性和纯净性。

### 核心架构

```
config/mcp/
├── types.ts              # 类型定义和Zod Schema
├── loaders.ts            # 配置文件加载逻辑
├── index.ts              # 公开接口导出
└── __tests__/
    ├── loaders.test.ts   # 加载器单元测试
    └── validation.test.ts # Schema验证测试
```

### 数据流向

```
1. loadMcpConfig() 被调用
   ↓
2. 加载全局配置文件 (~/.iris-code/mcp/settings.json)
   ↓
3. 加载项目配置文件 ({project}/.iris-code/mcp/settings.json)
   ↓
4. 合并配置（项目覆盖全局）
   ↓
5. Zod Schema 验证
   ↓
6. 返回 McpServersConfig 对象
```

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 2.1 函数式加载模式

采用纯函数式加载而非单例类管理器。

```typescript
// 函数式模式
export async function loadMcpConfig(): Promise<McpServersConfig>

// 而非单例模式
class McpConfigManager {
  private static instance: McpConfigManager
  private cache: McpServersConfig
}
```

理由：
- 配置加载不需要状态管理
- 缓存由调用方（mcp模块）根据业务需要控制
- 更简单、更易测试
- 遵循config/llm的设计模式

### 2.2 Zod Schema优先验证

使用Zod进行声明式验证，而非手动校验。

理由：
- 类型安全：TypeScript类型自动从Schema推导
- 及早失败：配置错误在加载阶段就被发现
- 清晰的错误信息：Zod自动生成详细的验证错误
- 可维护：Schema即文档，修改配置结构只需修改Schema

### 2.3 分层合并策略

全局配置和项目配置分别加载后合并。

```typescript
const globalConfig = await loadFromPath(globalPath)
const projectConfig = await loadFromPath(projectPath)
return mergeConfigs(globalConfig, projectConfig)
```

理由：
- 全局配置作为默认值，减少项目配置的冗余
- 项目配置可以覆盖全局配置，保持灵活性
- 清晰的优先级：项目 > 全局

---

## 三、Module Structure & File Layout（模块结构与文件组织）

### 3.1 文件职责

#### types.ts

职责：定义配置相关的所有类型和Schema

内容：
- `McpStdioConfig`: Stdio类型MCP服务器配置
- `McpHttpConfig`: HTTP类型MCP服务器配置
- `McpSseConfig`: SSE类型MCP服务器配置
- `McpServerConfig`: 联合类型（Stdio | HTTP | SSE）
- `McpServersConfig`: 完整配置对象
- 对应的Zod Schema定义

#### loaders.ts

职责：实现配置文件的加载和合并逻辑

导出函数：
- `loadMcpConfig()`: 主入口，加载并合并配置
- `loadFromPath(path)`: 从指定路径加载单个配置文件
- `mergeConfigs(global, project)`: 合并多个配置对象

#### index.ts

职责：对外导出公开接口

导出内容：
- `loadMcpConfig` 函数
- 所有类型定义（McpServerConfig、McpServersConfig等）
- 不导出内部实现细节（loadFromPath、mergeConfigs等）

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 4.1 不做配置缓存

当前方案：每次调用loadMcpConfig()都重新读取文件

代价：
- 重复的文件I/O开销
- 无法感知配置热更新

收益：
- 实现简单，代码量少
- 避免缓存失效问题
- 调用方可以根据需要自行缓存

理由：
- MCP配置加载频率低（仅在首次使用MCP工具时加载）
- 文件I/O开销可接受（~10ms）
- 遵循YAGNI原则，避免过度设计

### 4.2 仅支持JSON格式

当前方案：仅支持settings.json

未采用方案：同时支持JSON和TOML

理由：
- JSON是TypeScript原生支持的格式
- 与iris-code其他配置保持一致（model.json）
- TOML需要额外依赖和解析逻辑
- 可在未来根据需求扩展TOML支持

### 4.3 命令格式兼容性

采用市面上主流的分离式命令格式：

```typescript
// 主流格式（iris-code采用）
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "firecrawl-mcp"]
}

// 而非opencode的单数组格式
{
  "type": "local",
  "command": ["npx", "-y", "firecrawl-mcp"]
}
```

理由：
- 主流格式：Claude Desktop、Cursor、VS Code、Cline、Amazon Q 均采用此格式
- MCP官方文档推荐格式
- 更符合直觉：command 是可执行文件，args 是参数列表
- 与 Node.js child_process.spawn() API 一致
- 更好的可读性和维护性

参考资料：
- [MCP Server Configuration - Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Cursor MCP Server Configuration Guide](https://www.cursor.com/docs)
- [VS Code Copilot MCP Servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)

### 4.4 显式type字段

要求所有配置显式声明type字段：

```typescript
// ✅ 正确：显式type
{ "type": "stdio", "command": "npx", "args": [...] }
{ "type": "http", "url": "..." }

// ❌ 错误：缺少type字段
{ "command": "npx", "args": [...] }
```

理由：
- 消除歧义：无需根据字段推断类型
- 符合主流配置习惯（opencode、Claude Desktop）
- 更好的错误提示：缺少type时Schema验证失败
- 便于未来扩展新的传输类型

---

## 五、Error Handling（错误处理）

### 5.1 错误分类

| 错误类型 | 场景 | 处理方式 |
|----------|------|----------|
| 配置文件不存在 | settings.json不存在 | 返回空配置`{mcpServers: {}}` |
| JSON解析失败 | settings.json格式错误 | 抛出ConfigError，包含文件路径 |
| Schema验证失败 | 配置字段类型错误 | 抛出ZodError，包含详细验证信息 |

### 5.2 错误信息

```typescript
// 示例：配置文件格式错误
throw new ConfigError(
  'Invalid JSON in MCP configuration file',
  'INVALID_JSON',
  { path: configPath, cause: parseError }
)

// 示例：Schema验证失败
// Zod自动生成详细错误，包含：
// - 错误字段路径（如 "mcpServers.github.timeout"）
// - 预期类型
// - 实际值
```

---

## 六、Configuration Merge Strategy（配置合并策略）

### 6.1 合并规则

按MCP服务器名称进行合并：

```typescript
// 全局配置
{
  "mcpServers": {
    "filesystem": { ... },
    "github": { "url": "..." }
  }
}

// 项目配置
{
  "mcpServers": {
    "github": { "url": "...", "trust": true },  // 完全覆盖全局
    "local-tool": { ... }  // 新增
  }
}

// 合并结果
{
  "mcpServers": {
    "filesystem": { ... },           // 保留全局
    "github": { "url": "...", "trust": true },  // 项目覆盖
    "local-tool": { ... }            // 新增
  }
}
```

重要：同名服务器配置整体覆盖，不做字段级别合并。

理由：
- 避免字段级别合并的复杂性和歧义
- 项目配置可以完全控制特定MCP服务器
- 简单明确，易于理解

### 6.2 多工作区隔离

每个工作区独立加载配置：

```typescript
// 工作区A的项目配置
{project-a}/.iris-code/mcp/settings.json

// 工作区B的项目配置
{project-b}/.iris-code/mcp/settings.json

// 两者互不影响
```

---

## 七、Integration with Config Module（与config模块集成）

### 7.1 与config/llm的一致性

遵循相同的设计模式：

| 方面 | config/llm | config/mcp |
|------|-----------|-----------|
| 加载方式 | 函数式（loadLLMConfig） | 函数式（loadMcpConfig） |
| 验证工具 | Zod Schema | Zod Schema |
| 缓存策略 | 由manager管理 | 无缓存（调用方管理） |
| 错误处理 | ConfigError | ConfigError（复用） |

### 7.2 导出到config模块

```typescript
// iris-code/src/config/index.ts
export { loadMcpConfig } from './mcp/index.js'
export type { McpServerConfig, McpServersConfig } from './mcp/index.js'
```

消费方使用：
```typescript
import { loadMcpConfig } from '@/config'

const mcpConfig = await loadMcpConfig()
```

---

## 八、文档自检

- 架构服务于goals-duty.md中定义的职责
- 文件职责单一、边界清晰
- 设计模式选择有明确理由（函数式、Schema优先、分层合并）
- 错误处理策略明确
- 与现有config模块设计一致
