# Tavily Provider - data-model.md

本文档定义 `tavily` provider 内部使用的概念与类型。

> **作用域提示**：仅覆盖 search / fetch 路径所需类型。`tavily_crawl` / `tavily_map` 已废弃，相应类型不再维护。

---

## 一、Core Concepts

### 概念 1: TavilyClient
由 `@tavily/core` 提供的 SDK 客户端实例。包含 `search` / `extract` / `crawl` / `map` 四个方法，但本 provider 只使用前两个（必要时 `crawl()` 作为 fetch 内部辅助）。

### 概念 2: 通用层 vs SDK 层
- **通用层**: `SearchOptions` / `FetchOptions`（`docs/tools/search-providers/data-model.md` 定义）
- **SDK 层**: Tavily SDK 自己的 camelCase 选项

provider 内部维护 `通用层 → SDK 层` 的映射函数。

---

## 二、TavilyDefaults（来自配置文件）

```typescript
interface TavilyDefaults {
  /** API 端点 */
  baseURL?: string

  /** 代理配置 */
  proxy?: {
    http?: string
    https?: string
  }

  /** search 默认值 */
  search?: {
    searchDepth?: 'basic' | 'advanced'
    topic?: 'general' | 'news' | 'finance'
    maxResults?: number
    includeAnswer?: boolean
    includeImages?: boolean
    includeRawContent?: false | 'markdown' | 'text'
    timeout?: number
  }

  /** extract 默认值 */
  extract?: {
    extractDepth?: 'basic' | 'advanced'
    format?: 'markdown' | 'text'
    includeImages?: boolean
    timeout?: number
  }
}
```

`TavilyDefaults` 作为 `SearchProviderConfig.defaults` 由 `config/tools/tavily` 在加载阶段构造，provider 仅读取。

---

## 三、SDK 层类型（仅供参考）

来自 `@tavily/core`，列出供 adapter 内部映射时参照：

```typescript
interface TavilySearchSDKOptions {
  searchDepth?: 'basic' | 'advanced'
  topic?: 'general' | 'news' | 'finance'
  maxResults?: number
  includeAnswer?: boolean
  includeImages?: boolean
  includeRawContent?: false | 'markdown' | 'text'
  includeDomains?: string[]
  excludeDomains?: string[]
  timeRange?: 'year' | 'month' | 'week' | 'day'
  country?: string
  timeout?: number
}

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

interface TavilyExtractSDKOptions {
  extractDepth?: 'basic' | 'advanced'
  format?: 'markdown' | 'text'
  includeImages?: boolean
  timeout?: number
}

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
```

---

## 四、Parameter Mapping

### 4.1 SearchOptions → TavilySearchSDKOptions

| 通用字段 | SDK 字段 | 备注 |
|---|---|---|
| `numResults` | `maxResults` | |
| `includeDomains` | `includeDomains` | |
| `excludeDomains` | `excludeDomains` | |
| `timeRange` | `timeRange` | |
| `country` | `country` | |
| `includeRawContent` | `includeRawContent` | `true` → `'markdown'` |
| `maxCharactersPerResult` | （归一化阶段截断） | 不传给 SDK |
| —（默认 'basic'） | `searchDepth` | 来自 defaults 或硬编码 |
| —（默认 'general'） | `topic` | 来自 defaults |

### 4.2 FetchOptions → TavilyExtractSDKOptions

| 通用字段 | SDK 字段 | 备注 |
|---|---|---|
| `format` | `format` | |
| `includeImages` | `includeImages` | |
| `maxCharactersPerUrl` | （归一化阶段截断） | 不传给 SDK |
| —（默认 'basic'） | `extractDepth` | 来自 defaults |

### 4.3 转换函数示意

```typescript
function buildSearchOptions(
  opts: SearchOptions | undefined,
  defaults: TavilyDefaults | undefined
): TavilySearchSDKOptions {
  const searchDefaults = defaults?.search ?? {}
  return {
    searchDepth: searchDefaults.searchDepth ?? 'basic',
    topic: searchDefaults.topic ?? 'general',
    maxResults: opts?.numResults ?? searchDefaults.maxResults ?? 5,
    includeRawContent: opts?.includeRawContent
      ? (searchDefaults.includeRawContent ?? 'markdown')
      : false,
    includeDomains: opts?.includeDomains,
    excludeDomains: opts?.excludeDomains,
    timeRange: opts?.timeRange,
    country: opts?.country,
    timeout: searchDefaults.timeout ?? 60,
  }
}
```

---

## 五、Response Normalization

### 5.1 SearchResponse → SearchResult[]

```typescript
function normalizeSearchResponse(
  response: TavilySearchResponse,
  maxCharsPerResult?: number
): SearchResult[] {
  return response.results
    .map((r) => ({
      title: r.title,
      url: r.url,
      content: maxCharsPerResult ? r.content.slice(0, maxCharsPerResult) : r.content,
      rawContent: r.rawContent,
      score: r.score,
      publishedDate: r.publishedDate || undefined,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}
```

### 5.2 ExtractResponse → FetchResult[]

```typescript
function normalizeExtractResponse(
  response: TavilyExtractResponse,
  inputUrls: string[],
  maxCharsPerUrl?: number
): FetchResult[] {
  // 按输入顺序输出
  return inputUrls.map((url) => {
    const success = response.results.find((r) => r.url === url)
    if (success) {
      return {
        url,
        success: true,
        content: maxCharsPerUrl
          ? success.rawContent.slice(0, maxCharsPerUrl)
          : success.rawContent,
        images: success.images,
      }
    }
    const failed = response.failedResults.find((f) => f.url === url)
    return {
      url,
      success: false,
      error: failed?.error ?? 'Unknown extraction failure',
    }
  })
}
```

---

## 六、Default Values

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| baseURL | https://api.tavily.com | Tavily 官方 API |
| search.searchDepth | basic | |
| search.topic | general | |
| search.maxResults | 5 | |
| search.includeRawContent | false | |
| search.timeout | 60 | 秒 |
| extract.extractDepth | basic | |
| extract.format | markdown | |
| extract.timeout | 60 | 秒 |

---

## 七、文档自检

- [x] 仅维护 search / extract 相关类型
- [x] crawl / map 相关类型已移除
- [x] 通用层与 SDK 层映射规则清晰
- [x] 默认值明确
