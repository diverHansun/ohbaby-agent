# Tavily Tools Module - dfd-interface.md

本文档定义 `tavily` 工具模块的数据流与接口设计。

---

## 一、Data Flow Diagrams（数据流图）

### 1.1 工具执行总体数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Agent / LLM                                   │
│                                                                          │
│  生成工具调用: tavily_search({ query: "..." })                           │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  │ 工具调用请求
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         tool-scheduler                                   │
│                                                                          │
│  1. 查找工具: tavily_search                                              │
│  2. 检查权限: Policy.check('network')                                    │
│  3. 并发控制: 最多 5 个 network 工具并行                                  │
│  4. 调用工具: tool.execute(params, context)                              │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  │ execute(params, context)
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     tavily_search.execute()                              │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 1. 参数验证                                                      │    │
│  │                                                                   │    │
│  │    TavilySearchParamsSchema.parse(params)                        │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 2. 获取配置                                                      │    │
│  │                                                                   │    │
│  │    config = await getConfig()                                    │    │
│  │    // 合并 .env API Key + yaml 默认参数                          │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 3. 获取客户端                                                    │    │
│  │                                                                   │    │
│  │    client = await getClient()                                    │    │
│  │    // 单例，延迟初始化                                            │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 4. 参数转换                                                      │    │
│  │                                                                   │    │
│  │    options = transformSearchParams(params, config.search)        │    │
│  │    // snake_case -> camelCase                                    │    │
│  │    // 合并默认值                                                  │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 5. 调用 SDK                                                      │    │
│  │                                                                   │    │
│  │    response = await client.search(params.query, options)         │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 6. 格式化输出                                                    │    │
│  │                                                                   │    │
│  │    output = formatSearchResult(response)                         │    │
│  │    // 转换为 Markdown                                             │    │
│  │                                                                   │    │
│  └─────────────────────────────────┬─────────────────────────────────┘    │
│                                    │                                     │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
                                     │ output: string (Markdown)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         tool-scheduler                                   │
│                                                                          │
│  更新 ToolCall 状态: executing -> success                                │
│  发布事件: ToolScheduler.Event.ExecutionCompleted                        │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                                  │ ToolPart { status: 'completed', output }
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                            Agent / LLM                                   │
│                                                                          │
│  接收工具结果，继续对话                                                   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 配置加载数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        config.ts (tavily 模块)                           │
│                                                                          │
│  getConfig()                                                             │
│                                                                          │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
                    ▼                           ▼
┌─────────────────────────────┐   ┌─────────────────────────────────────┐
│         .env 文件            │   │      config/tools/tavily             │
│                             │   │                                      │
│  TAVILY_API_KEY=tvly-xxx    │   │  TavilyConfigLoader.load()           │
│                             │   │                                      │
│  读取: process.env          │   │  读取: tavily.yaml                   │
│                             │   │  合并: 项目级 > 用户级 > 默认         │
│                             │   │                                      │
└──────────────┬──────────────┘   └──────────────────┬────────────────────┘
               │                                      │
               │  apiKey: string                      │  TavilyFileConfig
               │                                      │
               └─────────────────┬────────────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    TavilyToolConfig     │
                    │                         │
                    │  apiKey + fileConfig    │
                    │                         │
                    └─────────────────────────┘
```

### 1.3 客户端初始化数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         client.ts                                        │
│                                                                          │
│  getClient()                                                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 检查单例                                                         │    │
│  │                                                                   │    │
│  │ if (client !== null) return client                               │    │
│  │                                                                   │    │
│  └───────────────────┬───────────────────────────────────────────────┘    │
│                      │ client === null                                   │
│                      ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 获取配置                                                         │    │
│  │                                                                   │    │
│  │ config = await getConfig()                                       │    │
│  │                                                                   │    │
│  └───────────────────┬───────────────────────────────────────────────┘    │
│                      │                                                   │
│                      ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 创建客户端                                                       │    │
│  │                                                                   │    │
│  │ client = tavily({                                                │    │
│  │   apiKey: config.apiKey,                                         │    │
│  │   apiBaseURL: config.baseURL,                                    │    │
│  │   proxies: config.proxy                                          │    │
│  │ })                                                               │    │
│  │                                                                   │    │
│  └───────────────────┬───────────────────────────────────────────────┘    │
│                      │                                                   │
│                      ▼                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ 返回客户端                                                       │    │
│  │                                                                   │    │
│  │ return client                                                    │    │
│  │                                                                   │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、External Interfaces（外部接口）

### 2.1 工具定义接口

每个工具使用 `Tool.define()` 定义:

```typescript
interface ToolDefinition<TParams> {
  /** 工具名称 */
  name: string

  /** 工具描述（供 LLM 理解） */
  description: string

  /** 参数 Schema */
  parameters: z.ZodSchema<TParams>

  /** 工具分类 */
  category: ToolCategory

  /** 执行函数 */
  execute: (params: TParams, context: ToolExecutionContext) => Promise<string>
}
```

### 2.2 工具注册接口

```typescript
/**
 * 注册所有 Tavily 工具到调度器
 */
function registerTools(scheduler: ToolScheduler): void

/**
 * 使用示例
 */
import { registerTools } from '@/extension/tools/sdk/tavily'

scheduler.registerExtensionTools('tavily', registerTools)
```

### 2.3 配置获取接口

```typescript
/**
 * 获取 Tavily 工具配置
 */
async function getConfig(): Promise<TavilyToolConfig>

/**
 * 使用示例
 */
const config = await getConfig()
console.log(config.apiKey)  // API Key
console.log(config.search.defaultMaxResults)  // 默认搜索结果数
```

### 2.4 客户端获取接口

```typescript
/**
 * 获取 Tavily SDK 客户端（单例）
 */
async function getClient(): Promise<TavilyClient>

/**
 * 重置客户端实例（测试用）
 */
function resetInstance(): void

/**
 * 使用示例
 */
const client = await getClient()
const response = await client.search('query')
```

---

## 三、Internal Interfaces（内部接口）

### 3.1 参数转换接口

```typescript
/**
 * 搜索参数转换
 */
function transformSearchParams(
  params: TavilySearchParams,
  defaults: TavilySearchDefaults
): TavilySearchOptions

/**
 * 提取参数转换
 */
function transformExtractParams(
  params: TavilyExtractParams,
  defaults: TavilyExtractDefaults
): TavilyExtractOptions

/**
 * 爬取参数转换
 */
function transformCrawlParams(
  params: TavilyCrawlParams,
  defaults: TavilyCrawlDefaults
): TavilyCrawlOptions

/**
 * 映射参数转换
 */
function transformMapParams(
  params: TavilyMapParams,
  defaults: TavilyMapDefaults
): TavilyMapOptions
```

### 3.2 结果格式化接口

```typescript
/**
 * 格式化搜索结果
 */
function formatSearchResult(response: TavilySearchResponse): string

/**
 * 格式化提取结果
 */
function formatExtractResult(response: TavilyExtractResponse): string

/**
 * 格式化爬取结果
 */
function formatCrawlResult(response: TavilyCrawlResponse): string

/**
 * 格式化映射结果
 */
function formatMapResult(response: TavilyMapResponse): string
```

### 3.3 错误处理接口

```typescript
/**
 * 格式化错误消息
 */
function formatError(error: unknown): string

/**
 * 错误类型判断
 */
function isConfigError(error: unknown): error is ConfigError
function isTavilyError(error: unknown): error is TavilyError
function isZodError(error: unknown): error is ZodError
```

---

## 四、Tool Execution Context（工具执行上下文）

### 4.1 上下文结构

```typescript
/**
 * 工具执行上下文（由 tool-scheduler 传入）
 */
interface ToolExecutionContext {
  /** 中断信号 */
  signal: AbortSignal

  /** 会话 ID */
  sessionId: string

  /** 消息 ID */
  messageId: string

  /** 调用 ID */
  callId: string
}
```

### 4.2 中断处理

Tavily 工具属于 `network` 类别，采用**软中断**策略:
- 收到中断信号后，等待当前请求完成
- 不主动终止 HTTP 请求

```typescript
async execute(params, context) {
  // 检查中断（执行前）
  if (context.signal.aborted) {
    throw new Error('Tool execution aborted')
  }

  // 执行 SDK 调用
  const response = await client.search(params.query, options)

  // 检查中断（执行后，返回前）
  if (context.signal.aborted) {
    throw new Error('Tool execution aborted')
  }

  return formatSearchResult(response)
}
```

---

## 五、Usage Examples（使用示例）

### 5.1 tavily_search 调用示例

**Agent 调用**:
```json
{
  "tool": "tavily_search",
  "params": {
    "query": "TypeScript 5.0 新特性",
    "max_results": 5,
    "include_answer": true,
    "time_range": "year"
  }
}
```

**输出示例**:
```markdown
## 搜索结果: TypeScript 5.0 新特性

响应时间: 1250ms

### AI 回答

TypeScript 5.0 引入了多项重要新特性，包括装饰器（Decorators）、
const 类型参数、枚举改进等...

### 搜索结果

#### 1. TypeScript 5.0 发布公告 - Microsoft DevBlogs
- URL: https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/
- 相关性: 0.95
- 发布日期: 2023-03-16

TypeScript 5.0 正式发布，带来了装饰器、const 类型参数等新特性...

---

#### 2. TypeScript 5.0 新特性详解
- URL: https://example.com/typescript-5-features
- 相关性: 0.89
- 发布日期: 2023-03-20

详细介绍 TypeScript 5.0 的各项新功能...
```

### 5.2 tavily_extract 调用示例

**Agent 调用**:
```json
{
  "tool": "tavily_extract",
  "params": {
    "urls": [
      "https://docs.example.com/guide",
      "https://docs.example.com/api"
    ],
    "format": "markdown"
  }
}
```

**输出示例**:
```markdown
## 内容提取结果

响应时间: 2100ms

### 成功提取

#### https://docs.example.com/guide

# 快速入门指南

本指南将帮助您快速上手...

---

#### https://docs.example.com/api

# API 参考文档

## 认证

所有 API 请求需要在 Header 中携带...
```

### 5.3 tavily_crawl 调用示例

**Agent 调用**:
```json
{
  "tool": "tavily_crawl",
  "params": {
    "url": "https://docs.example.com",
    "max_depth": 2,
    "limit": 10,
    "instructions": "查找所有关于认证和授权的页面"
  }
}
```

### 5.4 tavily_map 调用示例

**Agent 调用**:
```json
{
  "tool": "tavily_map",
  "params": {
    "url": "https://docs.example.com",
    "max_depth": 3,
    "limit": 50,
    "select_paths": ["/api/", "/guide/"]
  }
}
```

---

## 六、Error Handling Flow（错误处理流程）

```
工具执行
   │
   ├── 参数验证失败 (ZodError)
   │   └── 返回: "参数验证失败: {具体错误}"
   │
   ├── API Key 缺失 (ConfigError)
   │   └── 返回: "配置错误: TAVILY_API_KEY 未设置\n请在 .env 文件中配置"
   │
   ├── SDK 调用失败 (TavilyError)
   │   │
   │   ├── 401 Unauthorized
   │   │   └── 返回: "认证失败: API Key 无效"
   │   │
   │   ├── 429 Rate Limited
   │   │   └── 返回: "请求频率限制: 请稍后重试"
   │   │
   │   ├── 500 Server Error
   │   │   └── 返回: "Tavily 服务器错误: {message}"
   │   │
   │   └── 其他错误
   │       └── 返回: "Tavily API 错误: {message}"
   │
   ├── 网络超时 (TimeoutError)
   │   └── 返回: "请求超时: 请检查网络连接或稍后重试"
   │
   └── 未知错误
       └── 返回: "执行失败: {error.message}"
```

---

## 七、Integration with tool-scheduler（与调度器集成）

### 7.1 工具注册

```typescript
// tool-scheduler 初始化
class ToolScheduler {
  async initialize() {
    // 注册 Core Tools
    this.registerCoreTools()

    // 注册 Extension Tools
    await this.registerExtensionTools()
  }

  async registerExtensionTools() {
    // 检查 Tavily 配置
    const tavilyConfig = await loadTavilyConfig()

    if (tavilyConfig.apiKey) {
      // 已配置，注册工具
      const { registerTools } = await import('@/extension/tools/sdk/tavily')
      registerTools(this)
    } else {
      // 未配置，注册占位工具（返回配置提示）
      this.registerPlaceholder('tavily_search', 'tavily')
      this.registerPlaceholder('tavily_extract', 'tavily')
      this.registerPlaceholder('tavily_crawl', 'tavily')
      this.registerPlaceholder('tavily_map', 'tavily')
    }
  }
}
```

### 7.2 工具元数据

```typescript
// 注册时的元数据
{
  name: 'tavily_search',
  source: 'extension',
  category: 'network',
  provider: 'tavily'
}
```

---

## 八、文档自检

- [x] 数据流图清晰完整
- [x] 外部接口定义完整
- [x] 内部接口定义完整
- [x] 使用示例覆盖所有工具
- [x] 错误处理流程清晰
- [x] 与 tool-scheduler 集成明确
