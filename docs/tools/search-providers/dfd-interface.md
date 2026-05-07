# search-providers 模块的数据流与接口设计

## 上下文与范围

search-providers 位于工具实现层与厂商 SDK 之间：

- `config/tools/{tavily,exa}` 提供已验证的 provider 配置
- `tools/web-search.ts`、`tools/web-fetch.ts` 调用 provider 完成实际搜索/抓取
- `@tavily/core` / `exa-js` 是底层依赖

本文档描述对外接口与数据流，不涉及 adapter 内部的字段映射细节（参见各 adapter 子目录）。

## 数据流描述

### 流程 1：Provider 创建

```
config/tools/{激活的 provider}
    │ getProviderConfig() → ProviderConfig
    ▼
createSearchProvider(config)
    │
    ├─ 根据 config.providerId 查找 AdapterFactory
    ├─ 创建厂商 SDK client
    │    ├─ Tavily: tavily({ apiKey, baseURL })
    │    └─ Exa:    new Exa(apiKey, { baseURL })
    └─ 实例化对应 Adapter，注入 client
    ▼
返回 SearchProvider 实例
```

**特性：**
- 同步操作（不发起网络请求）
- 配置无效或 providerId 未注册时抛 `UnknownProviderError`
- 每次调用返回独立实例，不缓存

### 流程 2：搜索

```
tools/web-search.ts.execute(params, context)
    │
    ▼
provider.search(query, options)
    │
    ├─ adapter 内部：snake_case → camelCase 参数转换
    ├─ 应用 provider 自带的默认值
    ├─ 调用厂商 SDK：client.search(...)
    └─ 归一化响应：原生结果 → SearchResult[]
    ▼
返回 SearchResult[]
    │
    ▼
tools/web-search.ts 把 SearchResult[] 转为 Markdown 输出
```

### 流程 3：抓取

```
tools/web-fetch.ts.execute(params, context)
    │
    ▼
provider.fetch(urls, options)
    │
    ├─ adapter 内部：参数转换 + 默认值合并
    ├─ 调用厂商 SDK：
    │    ├─ Tavily: client.extract(urls, options)
    │    │   或 client.crawl(...) 作为 extract 的内部增强（仅 Tavily）
    │    └─ Exa:    client.getContents(urls, options)
    └─ 归一化响应：原生结果 → FetchResult[]
    ▼
返回 FetchResult[]
    │
    ▼
tools/web-fetch.ts 把 FetchResult[] 转为 Markdown 输出
```

## 接口定义

### 接口 1：createSearchProvider()

```typescript
function createSearchProvider(config: SearchProviderConfig): SearchProvider

interface SearchProviderConfig {
  providerId: 'tavily' | 'exa';   // 当前激活的 provider
  apiKey: string;
  baseUrl?: string;
  defaults?: ProviderDefaults;     // 来自配置文件的默认值
}
```

- **输入：** 由 `config/tools` 模块根据激活 provider 提供的配置
- **输出：** `SearchProvider` 实例
- **错误：**
  - `providerId` 未注册时抛 `UnknownProviderError`
  - `apiKey` 缺失时抛 `InvalidProviderConfigError`

### 接口 2：SearchProvider

```typescript
interface SearchProvider {
  readonly id: string;

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

#### SearchProvider.search()
- **输入：** query 字符串 + 通用搜索选项（参见 data-model.md）
- **输出：** 归一化的 `SearchResult[]`，按相关性排序
- **特性：** 异步、无副作用、不缓存

#### SearchProvider.fetch()
- **输入：** URL 列表 + 通用抓取选项
- **输出：** 归一化的 `FetchResult[]`，含成功项和失败项
- **特性：** 异步、对部分失败容错（不会因一个 URL 失败抛整体异常）

### 接口 3：registerSearchProvider()（扩展点）

```typescript
function registerSearchProvider(
  providerId: string,
  factory: SearchProviderFactory
): void

type SearchProviderFactory = (config: SearchProviderConfig) => SearchProvider;
```

**用途：** 第三方扩展、单元测试 mock。

## 数据归属与责任

| 数据 | 创建者 | 所有者 | 责任边界 |
|---|---|---|---|
| `SearchProviderConfig` | `config/tools/{provider}` | config 模块 | search-providers 仅读取 |
| SDK client | registry | 调用方（通常工具层缓存） | search-providers 不重建、不缓存 |
| `SearchOptions` / `FetchOptions` | `tools/web-*.ts` | 工具层 | adapter 仅读取并映射 |
| 厂商原生响应 | SDK | adapter 内部（瞬时） | adapter 立即归一化，不持有 |
| `SearchResult` / `FetchResult` | adapter | 工具层 | 工具层负责转 Markdown |

**关键原则：**
- search-providers 是"翻译官"，不持有任何业务数据
- 不缓存 SDK client、不缓存配置、不缓存搜索结果
- 所有方法在并发下安全调用

## 禁止的操作

以下操作**不**在本模块的接口范围内：

- 直接被 LLM 调用（LLM 看到的是 `web_search` / `web_fetch`）
- 暴露厂商独有 API 为公开接口（如 Tavily 的 `crawl/map`、Exa 的 `findSimilar`）
- 加载或验证配置文件（由 `config/tools/{provider}` 负责）
- 缓存 SDK client 或搜索结果
- 做 retry / fallback / 限流（由更上层决定）
- 调用其他 provider 作为 fallback（每次只走一家）
- 暴露原生 SDK 类型（`SearchResult` / `FetchResult` 必须是本模块自定义类型）
