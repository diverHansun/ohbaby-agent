# search-providers 模块的目标与职责

## 模块定位

search-providers 是 `tools/web-search` 与 `tools/web-fetch` 两个内置工具的**实现层**：把不同搜索厂商（Tavily、Exa、SearXNG…）封装在统一的 `SearchProvider` 接口背后，由配置决定当前激活哪一家。

LLM 看到的工具始终是 `web_search` / `web_fetch`，不感知具体后端。

## 设计目标

1. **统一 web_search / web_fetch 的后端协议**
   - 不同厂商的请求/响应差异在 provider 层屏蔽
   - 工具层（`tools/web-*.ts`）只调用 `SearchProvider.search()` / `fetch()`

2. **配置驱动的 provider 切换**
   - 通过 `config/tools/{tavily,exa,...}` 决定当前 provider
   - 切换 provider 不需要改工具代码，也不需要改 prompt

3. **保持 adapter 实现的纯净性**
   - 每个 provider 只做：参数转换 + SDK 调用 + 结果归一化
   - 不持有连接池、不缓存结果、不做 retry

4. **架构上预留多 provider 扩展空间**
   - 当前阶段只激活 Tavily
   - Exa 已有源码与文档保留，按相同接口接入即可启用
   - 未来可按相同模式加入 SearXNG / Firecrawl 等

## 职责

### 1. 定义 SearchProvider 抽象接口

提供统一契约：
- `search(query, options)` —— 语义搜索，返回 `SearchResult[]`
- `fetch(urls, options)` —— 抓取 URL 内容，返回 `FetchResult[]`
- `id` —— provider 标识，用于诊断与日志

### 2. 提供 Provider Registry

- 维护 `providerId → AdapterFactory` 映射
- 提供 `createSearchProvider(config)` 入口：根据 `config/tools/*` 中激活的 provider 创建对应实例

### 3. 实现具体 provider 适配器

阶段当前激活：
- **Tavily**：`tavily.search()` / `tavily.extract()` 映射到统一的 `search` / `fetch`

阶段保留（暂未启用）：
- **Exa**：`exa.search()` / `exa.getContents()` 映射到 `search` / `fetch`

### 4. 归一化请求与响应

- 输入：统一的 `SearchOptions` / `FetchOptions`（支持 `numResults`、`includeDomains` 等通用字段）
- 输出：统一的 `SearchResult` / `FetchResult` 类型，便于工具层直接转 Markdown

## 非职责

### 1. 不直接被 LLM 调用

LLM 只看到 `web_search` / `web_fetch` 两个工具，不能直接看到 `tavily_search`。provider 是工具的实现细节。

### 2. 不暴露厂商独有能力

舍弃：Tavily 的 `crawl` / `map`、Exa 的 `findSimilar`、Anwer API 等。这些能力或者作为内部辅助函数（例如 `extract` 内部调用 `crawl()` 拓展抓取范围），或者直接不实现。如有强需求，后续再单独评估暴露为新工具。

### 3. 不读取或验证配置文件

配置加载、验证由 `config/tools/{provider}` 负责，provider 模块只接收已验证的对象。

### 4. 不做 token 估算或预算决策

输出长度由工具层（`web-search.ts` / `web-fetch.ts`）配合 `tokenCounting` 处理。

### 5. 不做 retry / fallback / 限流

这些策略属于工具调度层（tool-scheduler）或上层 agent，不在 provider 范围内。

### 6. 不缓存结果

每次调用都走真实 API。缓存如有需要，在更上层引入。

## 与其他模块的关系

| 模块 | 关系 | 说明 |
|---|---|---|
| `tools/web-search.ts`、`tools/web-fetch.ts` | 被依赖 | 内置工具调用 `provider.search()` / `provider.fetch()` |
| `config/tools/{tavily,exa}` | 依赖 | 提供已验证的 provider 配置（apiKey、defaults 等） |
| `core/tool-scheduler` | 间接 | 调度工具时不直接接触 provider，但工具的 `execute` 会调用 provider |
| `services/providers`（LLM） | 平行参考 | 与 LLM provider 是同一种设计模式，但二者不互相依赖 |

## 设计约束

### 1. SearchProvider 必须无状态
每次方法调用只依赖入参，不依赖 provider 内部可变字段。便于测试与并发安全。

### 2. SDK client 由 registry 创建
adapter 不在自身内部 `new` SDK 实例，而是由 registry 集中创建并注入。与 LLM provider 的设计一致。

### 3. 归一化类型独立于厂商 SDK
`SearchResult`、`FetchResult` 是 search-providers 自己定义的类型，工具层不依赖任何具体 SDK。

### 4. 流式不在阶段范围
搜索/抓取本身不是流式场景，`search()` / `fetch()` 返回 `Promise<...>` 即可，不引入 AsyncIterable。
