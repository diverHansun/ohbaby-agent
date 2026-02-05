# Tavily Tools Module - data-model.md

本文档定义 `tavily` 工具模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### 概念 1: TavilyClient

**定义**: Tavily SDK 客户端实例，由 @tavily/core 提供，封装所有 API 调用。

**特点**:
- 通过 `tavily()` 工厂函数创建
- 包含 search, extract, crawl, map 四个方法
- 需要 API Key 初始化

### 概念 2: Tool Parameters

**定义**: 工具调用时 Agent/LLM 传入的参数，使用 snake_case 命名。

**特点**:
- 由 Zod Schema 定义和验证
- 需要转换为 camelCase 传给 SDK
- 部分参数有配置文件默认值

### 概念 3: SDK Options

**定义**: 调用 Tavily SDK 方法时的选项参数，使用 camelCase 命名。

**特点**:
- 直接传给 @tavily/core
- 由 Tool Parameters 转换而来
- 合并配置文件默认值

### 概念 4: Tool Output

**定义**: 工具执行后返回给 Agent 的结果，Markdown 格式字符串。

**特点**:
- 符合 ToolStateCompleted.output 类型要求
- 人类可读，LLM 可解析
- 包含结构化信息（标题、URL、内容等）

---

## 二、Type Definitions（类型定义）

### 2.1 配置类型

```typescript
/**
 * Tavily 工具完整配置
 */
interface TavilyToolConfig {
  /** API 密钥（来自 .env） */
  apiKey: string

  /** API 端点 */
  baseURL: string

  /** 代理配置（来自 yaml） */
  proxy?: TavilyProxyConfig

  /** 搜索默认配置 */
  search: TavilySearchDefaults

  /** 提取默认配置 */
  extract: TavilyExtractDefaults

  /** 爬取默认配置 */
  crawl: TavilyCrawlDefaults

  /** 映射默认配置 */
  map: TavilyMapDefaults
}

/**
 * 代理配置
 */
interface TavilyProxyConfig {
  http?: string
  https?: string
}

/**
 * 搜索默认配置
 */
interface TavilySearchDefaults {
  defaultSearchDepth: 'basic' | 'advanced'
  defaultTopic: 'general' | 'news' | 'finance'
  defaultMaxResults: number
  defaultIncludeAnswer: boolean
  defaultIncludeImages: boolean
  defaultIncludeRawContent: false | 'markdown' | 'text'
  defaultTimeout: number
}

/**
 * 提取默认配置
 */
interface TavilyExtractDefaults {
  defaultExtractDepth: 'basic' | 'advanced'
  defaultFormat: 'markdown' | 'text'
  defaultIncludeImages: boolean
  defaultTimeout: number
}

/**
 * 爬取默认配置
 */
interface TavilyCrawlDefaults {
  defaultMaxDepth: number
  defaultMaxBreadth: number
  defaultLimit: number
  defaultExtractDepth: 'basic' | 'advanced'
  defaultFormat: 'markdown' | 'text'
  defaultAllowExternal: boolean
  defaultIncludeImages: boolean
  defaultTimeout: number
}

/**
 * 映射默认配置
 */
interface TavilyMapDefaults {
  defaultMaxDepth: number
  defaultMaxBreadth: number
  defaultLimit: number
  defaultAllowExternal: boolean
  defaultTimeout: number
}
```

### 2.2 工具参数类型（snake_case）

```typescript
/**
 * tavily_search 参数
 */
interface TavilySearchParams {
  query: string
  search_depth?: 'basic' | 'advanced'
  topic?: 'general' | 'news' | 'finance'
  max_results?: number
  include_answer?: boolean
  include_images?: boolean
  include_raw_content?: false | 'markdown' | 'text'
  include_domains?: string[]
  exclude_domains?: string[]
  time_range?: 'year' | 'month' | 'week' | 'day'
  country?: string
}

/**
 * tavily_extract 参数
 */
interface TavilyExtractParams {
  urls: string[]
  extract_depth?: 'basic' | 'advanced'
  format?: 'markdown' | 'text'
  include_images?: boolean
}

/**
 * tavily_crawl 参数
 */
interface TavilyCrawlParams {
  url: string
  max_depth?: number
  max_breadth?: number
  limit?: number
  instructions?: string
  extract_depth?: 'basic' | 'advanced'
  format?: 'markdown' | 'text'
  select_paths?: string[]
  exclude_paths?: string[]
  select_domains?: string[]
  exclude_domains?: string[]
  allow_external?: boolean
  include_images?: boolean
}

/**
 * tavily_map 参数
 */
interface TavilyMapParams {
  url: string
  max_depth?: number
  max_breadth?: number
  limit?: number
  instructions?: string
  select_paths?: string[]
  exclude_paths?: string[]
  select_domains?: string[]
  exclude_domains?: string[]
  allow_external?: boolean
}
```

### 2.3 SDK 响应类型

以下类型来自 @tavily/core，此处列出供参考:

```typescript
/**
 * 搜索响应
 */
interface TavilySearchResponse {
  query: string
  answer?: string
  responseTime: number
  images: Array<{ url: string; description?: string }>
  results: Array<{
    title: string
    url: string
    content: string
    rawContent?: string
    score: number
    publishedDate: string
  }>
  requestId: string
}

/**
 * 提取响应
 */
interface TavilyExtractResponse {
  results: Array<{
    url: string
    rawContent: string
    images?: string[]
  }>
  failedResults: Array<{
    url: string
    error: string
  }>
  responseTime: number
  requestId: string
}

/**
 * 爬取响应
 */
interface TavilyCrawlResponse {
  baseUrl: string
  responseTime: number
  results: Array<{
    url: string
    rawContent: string
    images: string[]
  }>
  requestId: string
}

/**
 * 映射响应
 */
interface TavilyMapResponse {
  baseUrl: string
  responseTime: number
  results: string[]
  requestId: string
}
```

---

## 三、Zod Schemas（参数验证 Schema）

### 3.1 tavily_search Schema

```typescript
import { z } from 'zod'

export const TavilySearchParamsSchema = z.object({
  query: z.string()
    .min(1, '搜索查询不能为空')
    .describe('搜索查询'),

  search_depth: z.enum(['basic', 'advanced'])
    .optional()
    .describe('搜索深度: basic 快速搜索, advanced 深度搜索'),

  topic: z.enum(['general', 'news', 'finance'])
    .optional()
    .describe('搜索主题'),

  max_results: z.number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('最大结果数量 (1-20)'),

  include_answer: z.boolean()
    .optional()
    .describe('是否包含 AI 生成的答案'),

  include_images: z.boolean()
    .optional()
    .describe('是否包含图片'),

  include_raw_content: z.union([
    z.literal(false),
    z.enum(['markdown', 'text'])
  ])
    .optional()
    .describe('原始内容格式'),

  include_domains: z.array(z.string())
    .optional()
    .describe('包含的域名列表'),

  exclude_domains: z.array(z.string())
    .optional()
    .describe('排除的域名列表'),

  time_range: z.enum(['year', 'month', 'week', 'day'])
    .optional()
    .describe('时间范围'),

  country: z.string()
    .optional()
    .describe('国家代码 (如 US, CN)')
})

export type TavilySearchParams = z.infer<typeof TavilySearchParamsSchema>
```

### 3.2 tavily_extract Schema

```typescript
export const TavilyExtractParamsSchema = z.object({
  urls: z.array(z.string().url())
    .min(1, '至少需要一个 URL')
    .max(20, '最多支持 20 个 URL')
    .describe('URL 列表'),

  extract_depth: z.enum(['basic', 'advanced'])
    .optional()
    .describe('提取深度'),

  format: z.enum(['markdown', 'text'])
    .optional()
    .describe('输出格式'),

  include_images: z.boolean()
    .optional()
    .describe('是否包含图片 URL')
})

export type TavilyExtractParams = z.infer<typeof TavilyExtractParamsSchema>
```

### 3.3 tavily_crawl Schema

```typescript
export const TavilyCrawlParamsSchema = z.object({
  url: z.string().url()
    .describe('起始 URL'),

  max_depth: z.number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('最大爬取深度'),

  max_breadth: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('每层最大链接数'),

  limit: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('最大返回页面数'),

  instructions: z.string()
    .optional()
    .describe('自然语言指令，引导爬取方向'),

  extract_depth: z.enum(['basic', 'advanced'])
    .optional()
    .describe('提取深度'),

  format: z.enum(['markdown', 'text'])
    .optional()
    .describe('输出格式'),

  select_paths: z.array(z.string())
    .optional()
    .describe('包含的路径'),

  exclude_paths: z.array(z.string())
    .optional()
    .describe('排除的路径'),

  select_domains: z.array(z.string())
    .optional()
    .describe('包含的域名'),

  exclude_domains: z.array(z.string())
    .optional()
    .describe('排除的域名'),

  allow_external: z.boolean()
    .optional()
    .describe('是否允许爬取外部链接'),

  include_images: z.boolean()
    .optional()
    .describe('是否包含图片')
})

export type TavilyCrawlParams = z.infer<typeof TavilyCrawlParamsSchema>
```

### 3.4 tavily_map Schema

```typescript
export const TavilyMapParamsSchema = z.object({
  url: z.string().url()
    .describe('起始 URL'),

  max_depth: z.number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('最大映射深度'),

  max_breadth: z.number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('每层最大链接数'),

  limit: z.number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe('最大返回 URL 数'),

  instructions: z.string()
    .optional()
    .describe('自然语言指令，筛选特定页面'),

  select_paths: z.array(z.string())
    .optional()
    .describe('包含的路径'),

  exclude_paths: z.array(z.string())
    .optional()
    .describe('排除的路径'),

  select_domains: z.array(z.string())
    .optional()
    .describe('包含的域名'),

  exclude_domains: z.array(z.string())
    .optional()
    .describe('排除的域名'),

  allow_external: z.boolean()
    .optional()
    .describe('是否包含外部链接')
})

export type TavilyMapParams = z.infer<typeof TavilyMapParamsSchema>
```

---

## 四、Parameter Mapping（参数映射）

### 4.1 snake_case 到 camelCase 映射

| 工具参数 (snake_case) | SDK 参数 (camelCase) |
|----------------------|---------------------|
| search_depth | searchDepth |
| max_results | maxResults |
| include_answer | includeAnswer |
| include_images | includeImages |
| include_raw_content | includeRawContent |
| include_domains | includeDomains |
| exclude_domains | excludeDomains |
| time_range | timeRange |
| extract_depth | extractDepth |
| max_depth | maxDepth |
| max_breadth | maxBreadth |
| select_paths | selectPaths |
| exclude_paths | excludePaths |
| select_domains | selectDomains |
| exclude_domains | excludeDomains |
| allow_external | allowExternal |

### 4.2 转换函数

```typescript
/**
 * 将工具参数转换为 SDK 选项
 */
function transformSearchParams(
  params: TavilySearchParams,
  defaults: TavilySearchDefaults
): TavilySearchOptions {
  return {
    searchDepth: params.search_depth ?? defaults.defaultSearchDepth,
    topic: params.topic ?? defaults.defaultTopic,
    maxResults: params.max_results ?? defaults.defaultMaxResults,
    includeAnswer: params.include_answer ?? defaults.defaultIncludeAnswer,
    includeImages: params.include_images ?? defaults.defaultIncludeImages,
    includeRawContent: params.include_raw_content ?? defaults.defaultIncludeRawContent,
    includeDomains: params.include_domains,
    excludeDomains: params.exclude_domains,
    timeRange: params.time_range,
    country: params.country,
    timeout: defaults.defaultTimeout
  }
}
```

---

## 五、Output Format（输出格式）

### 5.1 搜索结果格式

```markdown
## 搜索结果: {query}

响应时间: {responseTime}ms

### AI 回答

{answer}

### 搜索结果

#### 1. {title}
- URL: {url}
- 相关性: {score}
- 发布日期: {publishedDate}

{content}

---

#### 2. {title}
...
```

### 5.2 提取结果格式

```markdown
## 内容提取结果

响应时间: {responseTime}ms

### 成功提取

#### {url}

{rawContent}

---

### 提取失败

- {failedUrl}: {error}
```

### 5.3 爬取结果格式

```markdown
## 网站爬取结果

起始 URL: {baseUrl}
响应时间: {responseTime}ms
爬取页面数: {results.length}

### 页面内容

#### 1. {url}

{rawContent}

---

#### 2. {url}
...
```

### 5.4 映射结果格式

```markdown
## 网站结构映射

起始 URL: {baseUrl}
响应时间: {responseTime}ms
发现 URL 数: {results.length}

### URL 列表

1. {url1}
2. {url2}
3. {url3}
...
```

---

## 六、Default Values（默认值）

### 6.1 默认值表

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| baseURL | https://api.tavily.com | Tavily 官方 API |
| search.defaultSearchDepth | basic | 基础搜索 |
| search.defaultTopic | general | 通用主题 |
| search.defaultMaxResults | 5 | 返回 5 条结果 |
| search.defaultIncludeAnswer | false | 不包含 AI 答案 |
| search.defaultIncludeImages | false | 不包含图片 |
| search.defaultIncludeRawContent | false | 不包含原始内容 |
| search.defaultTimeout | 60 | 60 秒超时 |
| extract.defaultExtractDepth | basic | 基础提取 |
| extract.defaultFormat | markdown | Markdown 格式 |
| extract.defaultIncludeImages | false | 不包含图片 |
| extract.defaultTimeout | 60 | 60 秒超时 |
| crawl.defaultMaxDepth | 2 | 爬取 2 层 |
| crawl.defaultMaxBreadth | 10 | 每层 10 个链接 |
| crawl.defaultLimit | 20 | 最多 20 个页面 |
| crawl.defaultExtractDepth | basic | 基础提取 |
| crawl.defaultFormat | markdown | Markdown 格式 |
| crawl.defaultAllowExternal | false | 不爬取外部链接 |
| crawl.defaultIncludeImages | false | 不包含图片 |
| crawl.defaultTimeout | 120 | 120 秒超时 |
| map.defaultMaxDepth | 2 | 映射 2 层 |
| map.defaultMaxBreadth | 10 | 每层 10 个链接 |
| map.defaultLimit | 100 | 最多 100 个 URL |
| map.defaultAllowExternal | false | 不包含外部链接 |
| map.defaultTimeout | 60 | 60 秒超时 |

---

## 七、文档自检

- [x] 每个概念都能用自然语言解释
- [x] 类型定义完整覆盖所有场景
- [x] Zod Schema 与类型定义对应
- [x] 参数映射规则清晰
- [x] 输出格式有明确示例
- [x] 默认值明确定义
