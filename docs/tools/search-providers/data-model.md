# search-providers 模块的数据模型

## 模块边界

search-providers 自定义两组归一化类型：搜索相关（`SearchOptions` / `SearchResult`）与抓取相关（`FetchOptions` / `FetchResult`）。这些类型独立于具体厂商 SDK，工具层只依赖它们。

```
┌──────────────────────┐
│ @tavily/core SDK     │
│ exa-js SDK           │
└──────────────────────┘
           ▲
           │ adapter 内部映射
           │
┌──────────────────────┐
│ search-providers     │
│  ─ SearchOptions     │
│  ─ SearchResult      │
│  ─ FetchOptions      │
│  ─ FetchResult       │
│  ─ SearchProvider    │
└──────────────────────┘
           ▲
           │ import
           │
┌──────────────────────┐
│ tools/web-search.ts  │
│ tools/web-fetch.ts   │
└──────────────────────┘
```

## 核心类型

### SearchProvider（适配器实例）

```typescript
interface SearchProvider {
  readonly id: string;              // 'tavily' | 'exa' | ...

  search(
    query: string,
    options?: SearchOptions
  ): Promise<SearchResult[]>;

  fetch(
    urls: string[],
    options?: FetchOptions
  ): Promise<FetchResult[]>;
}
```

### SearchOptions（搜索通用选项）

```typescript
interface SearchOptions {
  /** 返回结果数量；adapter 自带默认值 */
  numResults?: number;

  /** 仅包含这些域名 */
  includeDomains?: string[];

  /** 排除这些域名 */
  excludeDomains?: string[];

  /** 时间范围 */
  timeRange?: 'day' | 'week' | 'month' | 'year';

  /** 国家/地区码，如 'US'、'CN' */
  country?: string;

  /** 是否返回网页原文（提升 token 消耗） */
  includeRawContent?: boolean;

  /** 截断每条结果的原文长度 */
  maxCharactersPerResult?: number;
}
```

**约定：**
- `query` 是必填位置参数，不放进 options
- 厂商独有字段（如 Tavily 的 `topic`、Exa 的 `category`）当前**不**暴露
- 后续如需透传，再加 `providerExtras?: Record<string, unknown>`

### SearchResult（归一化的搜索结果）

```typescript
interface SearchResult {
  title: string;
  url: string;

  /** 摘要内容（厂商通常已截断） */
  content: string;

  /** 完整原文，仅当 includeRawContent=true 时存在 */
  rawContent?: string;

  /** 相关性分数（0-1），不一定可用 */
  score?: number;

  /** ISO 日期串，如 '2024-03-15' */
  publishedDate?: string;
}
```

### FetchOptions（抓取通用选项）

```typescript
interface FetchOptions {
  /** 输出格式 */
  format?: 'markdown' | 'text' | 'html';

  /** 截断每个 URL 的内容长度 */
  maxCharactersPerUrl?: number;

  /** 是否包含图片链接列表 */
  includeImages?: boolean;
}
```

### FetchResult（归一化的抓取结果）

```typescript
interface FetchResult {
  url: string;

  /** 成功标志 */
  success: boolean;

  /** 抓取到的内容（success=true 时存在） */
  content?: string;

  /** 错误信息（success=false 时存在） */
  error?: string;

  /** 图片链接列表（仅当 includeImages=true 时存在） */
  images?: string[];
}
```

**约定：**
- 部分失败不抛异常，每个 URL 一条记录
- 调用方按 `success` 字段分流

### SearchProviderConfig（创建参数）

```typescript
interface SearchProviderConfig {
  providerId: 'tavily' | 'exa';
  apiKey: string;
  baseUrl?: string;

  /** 来自 config/tools/{provider} 的默认值，由 adapter 内部消化 */
  defaults?: ProviderDefaults;
}

type ProviderDefaults = Record<string, unknown>;
```

**说明：** `defaults` 是 adapter 私有字段，类型由具体 adapter 定义（如 `TavilyDefaults`、`ExaDefaults`），registry 仅做透传。

### SearchProviderFactory

```typescript
type SearchProviderFactory = (config: SearchProviderConfig) => SearchProvider;
```

注册到 registry 时使用，单元测试 mock 也通过它注入。

## 设计约束

### 1. 归一化类型独立于 SDK
工具层（`tools/web-*.ts`）和 LLM 都不直接接触 `@tavily/core` 或 `exa-js` 的类型。即使将来增删 provider，工具层接口不变。

### 2. 字段集保守、按需扩展
当前字段集只覆盖搜索/抓取的**通用**能力。厂商独有字段（topic、category、findSimilar、crawl 深度等）默认不暴露。如确需透传，扩展点是 `SearchOptions.providerExtras`，但要慎用。

### 3. FetchResult 用 success 字段而非异常
单个 URL 失败不影响其它 URL 的结果。调用方按 `success` 分流处理，能力上等价于 Tavily 的 `failedResults`。

### 4. 不暴露 requestId / responseTime
厂商通常会返回 requestId、响应时间等元数据。这些不归一化到公开类型上；如需诊断/日志，adapter 内部记录即可。
