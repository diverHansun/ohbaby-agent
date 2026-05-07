# Tavily Provider - dfd-interface.md

本文档定义 `tavily` provider 的数据流与接口设计。

> **作用域提示**：仅描述 `SearchProvider` 接口下的 search / fetch 两条路径。`tavily_crawl` / `tavily_map` 已不作为独立工具暴露。

---

## 一、Data Flow

### 1.1 Provider 创建

```
config/tools/tavily.getProviderConfig()
    │ 返回 SearchProviderConfig
    │   { providerId: 'tavily', apiKey, baseUrl?, defaults? }
    ▼
search-providers/registry.createSearchProvider(config)
    │
    ├── 选择 createTavilyProvider 工厂
    └── 工厂内部：
         tavily({ apiKey, apiBaseURL, proxies })
    ▼
返回 SearchProvider 实例
```

### 1.2 search() 数据流

```
┌─────────────────────────────────────────────────────────┐
│ tools/web-search.execute()                              │
│   provider.search(query, searchOptions)                 │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ tavily provider                                          │
│                                                          │
│ 1. buildSearchOptions(searchOptions, defaults)           │
│    snake_case → camelCase                                │
│    填默认值（searchDepth=basic 等）                       │
│                                                          │
│ 2. client.search(query, sdkOptions)                      │
│                                                          │
│ 3. normalizeSearchResponse(response)                     │
│    原生 results[] → SearchResult[]                       │
│    应用 maxCharactersPerResult 截断                      │
│    按 score 降序                                         │
│                                                          │
└────────────────────┬────────────────────────────────────┘
                     ▼
            SearchResult[]
```

### 1.3 fetch() 数据流

```
┌─────────────────────────────────────────────────────────┐
│ tools/web-fetch.execute()                               │
│   provider.fetch(urls, fetchOptions)                    │
└────────────────────┬────────────────────────────────────┘
                     ▼
┌─────────────────────────────────────────────────────────┐
│ tavily provider                                          │
│                                                          │
│ 1. buildExtractOptions(fetchOptions, defaults)           │
│                                                          │
│ 2. client.extract(urls, sdkOptions)                      │
│    （未来：必要时辅以 client.crawl() 增强抓取）           │
│                                                          │
│ 3. normalizeExtractResponse(response)                    │
│    results[]      → FetchResult { success: true, ... }   │
│    failedResults  → FetchResult { success: false, ... }  │
│    保持 urls 输入顺序                                     │
│                                                          │
└────────────────────┬────────────────────────────────────┘
                     ▼
              FetchResult[]
```

---

## 二、External Interface

### 2.1 SearchProvider 实现

```typescript
const provider: SearchProvider = createTavilyProvider(config)

// id 标识
provider.id          // 'tavily'

// search
const results: SearchResult[] = await provider.search(
  'TypeScript 5.0 features',
  { numResults: 5, timeRange: 'year' }
)

// fetch
const fetched: FetchResult[] = await provider.fetch(
  ['https://example.com/a', 'https://example.com/b'],
  { format: 'markdown' }
)
```

详细类型见 `docs/tools/search-providers/data-model.md`。

### 2.2 工厂函数

```typescript
function createTavilyProvider(config: SearchProviderConfig): SearchProvider
```

由 `registry.createSearchProvider()` 在 `providerId === 'tavily'` 时调用。

---

## 三、Internal Interfaces

### 3.1 参数构造

```typescript
function buildSearchOptions(
  opts: SearchOptions | undefined,
  defaults: TavilyDefaults | undefined
): TavilySearchSDKOptions

function buildExtractOptions(
  opts: FetchOptions | undefined,
  defaults: TavilyDefaults | undefined
): TavilyExtractSDKOptions
```

特性：纯函数；输入 `undefined` 时使用全部默认值。

### 3.2 响应归一化

```typescript
function normalizeSearchResponse(
  response: TavilySearchResponse
): SearchResult[]

function normalizeExtractResponse(
  response: TavilyExtractResponse
): FetchResult[]
```

特性：纯函数；不丢失原始 URL 输入顺序（fetch 路径）；按 score 排序（search 路径）。

---

## 四、Tool Execution Context（与上层关系）

`SearchProvider` 接口不接收 `ToolExecutionContext`。signal / sessionId 等由工具层处理：

- **工具层** `web-search.ts` / `web-fetch.ts` 持有 `context.signal`，在调用 provider 前检查；如果 signal 已 abort 直接抛错
- **provider 层** Tavily SDK 当前不直接支持 AbortSignal，工具层超时由更上层（tool-scheduler）控制
- 网络类工具采用**软中断**：等待当前请求完成（避免数据损坏），不主动 abort HTTP 请求

---

## 五、Usage Examples

### 5.1 search 示例

**调用**:

```typescript
await provider.search('TypeScript 5.0 新特性', {
  numResults: 5,
  timeRange: 'year',
})
```

**返回**:

```typescript
[
  {
    title: 'TypeScript 5.0 发布公告',
    url: 'https://devblogs.microsoft.com/typescript/...',
    content: 'TypeScript 5.0 正式发布...',
    score: 0.95,
    publishedDate: '2023-03-16',
  },
  // ...
]
```

### 5.2 fetch 示例

**调用**:

```typescript
await provider.fetch(
  ['https://docs.example.com/guide', 'https://docs.example.com/missing'],
  { format: 'markdown' }
)
```

**返回**:

```typescript
[
  { url: 'https://docs.example.com/guide', success: true, content: '# Guide\n...' },
  { url: 'https://docs.example.com/missing', success: false, error: '404 Not Found' },
]
```

---

## 六、Error Handling Flow

```
provider.search() / provider.fetch()
   │
   ├── 参数验证失败 (ZodError 或类型错误)
   │   └── 抛 Error，由工具层捕获并转 Markdown 错误
   │
   ├── API Key 缺失
   │   └── 在 createTavilyProvider 阶段就已经报错；运行时不会触发
   │
   ├── SDK 调用失败 (TavilyError / HTTP 错误)
   │   ├── 401 → 抛 Error("认证失败: API Key 无效")
   │   ├── 429 → 抛 Error("请求频率限制")
   │   ├── 5xx → 抛 Error("Tavily 服务器错误: ...")
   │   └── 其他 → 抛 Error 透传 message
   │
   ├── 网络超时
   │   └── 抛 Error
   │
   └── fetch 单个 URL 失败
       └── 不抛异常，记录到 FetchResult.success=false
```

---

## 七、Data Ownership

| 数据 | 创建者 | 消费者 | 责任边界 |
|------|--------|--------|---------|
| `SearchProviderConfig` | `config/tools/tavily` | tavily provider | provider 仅读取 |
| Tavily SDK client | registry / 工厂 | provider 内部 | 不缓存、不重建 |
| `TavilySearchResponse` / `TavilyExtractResponse` | SDK | provider 内部（瞬时） | 立即归一化，不持有 |
| `SearchResult[]` / `FetchResult[]` | provider | 工具层 | 工具层负责转 Markdown |

---

## 八、文档自检

- [x] 数据流仅覆盖 search / fetch
- [x] 不暴露 crawl / map
- [x] 接口定义与 search-providers/data-model.md 一致
- [x] 错误处理流程清晰
