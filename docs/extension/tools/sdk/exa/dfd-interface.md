# Exa Tools Module - dfd-interface.md

本文档定义 `exa` 工具模块的数据流与接口设计。

---

## 一、Data Flow Diagrams（数据流图）

### 1.1 整体数据流

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Agent                                       │
│                                                                          │
│  "Search for recent AI news"                                            │
│                                                                          │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      │ Tool Call
                                      │ {
                                      │   name: 'exa_search',
                                      │   params: { query: 'AI news', ... }
                                      │ }
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Tool Scheduler                                  │
│                                                                          │
│  1. 查找工具                                                             │
│  2. 权限检查                                                             │
│  3. 并发控制                                                             │
│                                                                          │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      │ execute(params, context)
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Exa Tools Module                               │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                      exa-search.ts                                │   │
│  │                                                                   │   │
│  │  1. Zod 参数验证                                                  │   │
│  │  2. 获取配置（默认值）                                            │   │
│  │  3. 参数转换 (snake_case → camelCase)                            │   │
│  │  4. 调用 ExaClient                                               │   │
│  │  5. 响应转换 (camelCase → snake_case)                            │   │
│  │  6. 格式化 Markdown                                              │   │
│  │                                                                   │   │
│  └──────────────────────────────────┬────────────────────────────────┘   │
│                                     │                                    │
│                                     ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                       client.ts                                   │   │
│  │                                                                   │   │
│  │  ExaClient.getInstance().getClient()                             │   │
│  │                                                                   │   │
│  └──────────────────────────────────┬────────────────────────────────┘   │
│                                     │                                    │
└─────────────────────────────────────┼────────────────────────────────────┘
                                      │
                                      │ exa.search(query, options)
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           exa-js SDK                                     │
│                                                                          │
│  HTTP Request → Exa API → HTTP Response                                 │
│                                                                          │
└─────────────────────────────────────┬────────────────────────────────────┘
                                      │
                                      │ SearchResponse
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          Response Flow                                   │
│                                                                          │
│  SDK Response → 格式转换 → Markdown → Tool Scheduler → Agent            │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 配置加载数据流

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│      .env        │     │ Project Config   │     │  User Config     │
│                  │     │                  │     │                  │
│  EXA_API_KEY=xxx │     │ .iris-code/      │     │ ~/.config/       │
│                  │     │   tools/exa.yaml │     │   iris-code/     │
│                  │     │                  │     │   tools/exa.yaml │
└────────┬─────────┘     └────────┬─────────┘     └────────┬─────────┘
         │                        │                        │
         │                        │ 优先级: 1              │ 优先级: 2
         │                        │                        │
         │                        ▼                        ▼
         │               ┌─────────────────────────────────────────┐
         │               │        Config Loader                    │
         │               │        (config/tools/exa)               │
         │               │                                         │
         │               │  1. 加载用户级配置                       │
         │               │  2. 加载项目级配置（覆盖）               │
         │               │  3. 合并配置                            │
         │               │                                         │
         │               └────────────────────┬────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ExaConfigManager                              │
│                    (config.ts)                                   │
│                                                                  │
│  1. 从 process.env 读取 EXA_API_KEY                             │
│  2. 从 Config Loader 获取 yaml 配置                             │
│  3. 合并为最终 ExaConfig                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.3 错误处理数据流

```
┌─────────────────────────────────────────────────────────────────┐
│                        exa-js SDK                                │
│                                                                  │
│  throw ExaError { statusCode: 401, message: 'Unauthorized' }    │
│                                                                  │
└─────────────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Tool Execute (catch)                          │
│                                                                  │
│  try {                                                          │
│    const result = await exa.search(...)                         │
│  } catch (error) {                                              │
│    return {                                                     │
│      error: {                                                   │
│        type: 'ExaAPIError',                                     │
│        code: 401,                                               │
│        message: 'Unauthorized',                                 │
│        suggestion: 'Check EXA_API_KEY in .env'                  │
│      }                                                          │
│    }                                                            │
│  }                                                              │
│                                                                  │
└─────────────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Tool Scheduler                             │
│                                                                  │
│  状态更新: executing → error                                     │
│  返回错误给 Agent                                                │
│                                                                  │
└─────────────────────────────────────┬────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Agent                                   │
│                                                                  │
│  处理错误，决定是否重试                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 二、External Interfaces（外部接口）

### 2.1 工具注册接口

```typescript
// 提供给 tool-scheduler 的注册接口
export const ExaTools = [
  ExaSearchTool,
  ExaGetContentsTool,
]

// tool-scheduler 中的注册
import { ExaTools } from '@/extensions/tools/sdk/exa'
toolScheduler.registerTools(ExaTools)
```

### 2.2 配置加载接口

```typescript
// 提供给 config 模块的加载接口
interface ExaConfigLoader {
  /**
   * 加载配置
   * @returns 合并后的配置
   */
  load(): Promise<ExaConfig>

  /**
   * 重新加载配置
   */
  reload(): Promise<ExaConfig>

  /**
   * 验证配置
   */
  validate(): { valid: boolean; errors?: string[] }
}
```

---

## 三、Internal Interfaces（内部接口）

### 3.1 ExaClient 接口

```typescript
interface IExaClient {
  /**
   * 获取单例实例
   */
  getInstance(): ExaClient

  /**
   * 重置实例（测试用）
   */
  resetInstance(): void

  /**
   * 获取 SDK 客户端
   */
  getClient(): Exa
}
```

### 3.2 ExaConfigManager 接口

```typescript
interface IExaConfigManager {
  /**
   * 初始化配置
   */
  initialize(config: ExaConfig): void

  /**
   * 获取配置
   */
  getConfig(): ExaConfig

  /**
   * 验证配置
   */
  validate(): { valid: boolean; error?: string }
}
```

### 3.3 工具执行接口

```typescript
interface ExaToolExecute<TParams, TMetadata> {
  /**
   * 执行工具
   * @param params 工具参数
   * @param context 执行上下文
   * @returns 执行结果
   */
  execute(
    params: TParams,
    context: ToolContext
  ): Promise<
    | { content: string; metadata: TMetadata }
    | { error: ExaToolError }
  >
}
```

---

## 四、Tool Interface Details（工具接口详情）

### 4.1 exa_search

**Tool Definition：**

```typescript
{
  name: 'exa_search',
  description: `Search the web using Exa's neural search engine.

Supports:
- Semantic search: Find content by meaning, not just keywords
- Domain filtering: Include or exclude specific domains
- Date filtering: Filter results by published date
- Category filtering: Focus on specific content types

Best for: Research, fact-checking, finding authoritative sources.`,

  category: 'network',

  parameters: ExaSearchParamsSchema,

  execute: async (params, context) => { ... }
}
```

**Request Example：**

```json
{
  "name": "exa_search",
  "params": {
    "query": "latest developments in artificial intelligence",
    "type": "neural",
    "num_results": 5,
    "include_domains": ["arxiv.org", "nature.com"],
    "start_published_date": "2024-01-01",
    "include_text": true,
    "max_characters": 5000
  }
}
```

**Response Example (Success)：**

```typescript
{
  content: `# Exa Search Results

Found 5 results
Request ID: req_abc123

## Result 1
**Title:** Advances in Large Language Models
**URL:** https://arxiv.org/abs/2024.12345
**Published:** 2024-01-15
**Score:** 0.923

**Content:**
This paper presents significant advances in...

---

...`,
  metadata: {
    num_results: 5,
    request_id: 'req_abc123',
    cost: 0.0012
  }
}
```

**Response Example (Error)：**

```typescript
{
  error: {
    type: 'ExaAPIError',
    code: 401,
    message: 'Invalid API key',
    suggestion: 'Please check your EXA_API_KEY in .env file'
  }
}
```

### 4.2 exa_get_contents

**Tool Definition：**

```typescript
{
  name: 'exa_get_contents',
  description: `Retrieve full content from URLs using Exa.

Capabilities:
- Extract clean text content from web pages
- Get highlights (key excerpts)
- Generate summaries
- Handle multiple URLs in one request

Best for: Extracting detailed information from known URLs.`,

  category: 'network',

  parameters: ExaGetContentsParamsSchema,

  execute: async (params, context) => { ... }
}
```

**Request Example：**

```json
{
  "name": "exa_get_contents",
  "params": {
    "urls": [
      "https://example.com/article1",
      "https://example.com/article2"
    ],
    "text": true,
    "max_characters": 10000,
    "highlights": true,
    "summary": true
  }
}
```

**Response Example (Success)：**

```typescript
{
  content: `# Exa Contents

Retrieved 2 URLs
Request ID: req_xyz789

## Content 1
**URL:** https://example.com/article1
**Title:** Understanding AI

**Summary:**
A comprehensive overview of artificial intelligence...

**Highlights:**
- AI has transformed many industries
- Machine learning enables pattern recognition

**Full Text:**
Artificial intelligence (AI) is a rapidly evolving field...

---

...`,
  metadata: {
    num_urls: 2,
    request_id: 'req_xyz789',
    cost: 0.0008
  }
}
```

---

## 五、SDK Interface Mapping（SDK 接口映射）

### 5.1 exa.search()

```typescript
// 工具调用
execute({ query: 'AI news', num_results: 10, include_text: true })

// 转换为 SDK 调用
exa.search('AI news', {
  numResults: 10,
  contents: {
    text: { maxCharacters: 10000 }
  }
})
```

### 5.2 exa.getContents()

```typescript
// 工具调用
execute({
  urls: ['https://example.com'],
  text: true,
  max_characters: 5000,
  highlights: true
})

// 转换为 SDK 调用
exa.getContents(['https://example.com'], {
  text: { maxCharacters: 5000 },
  highlights: true
})
```

---

## 六、Error Codes（错误码）

| HTTP Code | 错误类型 | 描述 | 建议 |
|-----------|----------|------|------|
| 400 | ExaAPIError | 请求参数错误 | Check parameters |
| 401 | ExaAPIError | API Key 无效 | Check EXA_API_KEY in .env |
| 403 | ExaAPIError | 权限不足 | Check API key permissions |
| 429 | ExaAPIError | 速率限制 | Wait and retry later |
| 500 | ExaAPIError | 服务端错误 | Retry in a few moments |
| - | ExaConfigError | 配置错误 | Check configuration files |
| - | ExaValidationError | 参数验证失败 | Check input parameters |

---

## 七、文档自检

- [x] 数据流图覆盖主要场景
- [x] 所有外部接口定义完整
- [x] 内部接口定义完整
- [x] 工具接口示例完整
- [x] SDK 映射清晰
- [x] 错误码覆盖完整
