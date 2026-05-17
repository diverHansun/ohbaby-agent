# search-providers 模块架构设计

## 架构概览

search-providers 由三层组成：

```
search-providers Module
├── SearchProvider Interface（抽象）
│   └── search() / fetch()
│
├── Concrete Adapters（具体实现）
│   ├── TavilyAdapter      ← 当前激活
│   └── ExaAdapter         ← 文档与源码保留，暂未启用
│
└── Provider Registry（注册中心）
    └── createSearchProvider(config) → SearchProvider
        ├── 根据配置选择 AdapterFactory
        ├── 创建厂商 SDK client（tavily() / new Exa()）
        └── 返回 SearchProvider 实例
```

**调用关系：**

```
config/tools/{tavily,exa}
    │ getProviderConfig()
    ▼
search-providers/registry
    │ createSearchProvider(config)
    ▼
tools/web-search.ts、tools/web-fetch.ts
    │ provider.search() / provider.fetch()
    ▼
ToolScheduler → LLM
```

## 设计模式

### 1. Strategy / Adapter 模式
不同厂商的请求和响应结构差异大（Tavily 与 Exa 的字段命名、嵌套层级、time_range 表达都不同），用 Strategy 封装，工具层只看到统一接口。

### 2. Registry 模式
显式的 `providerId → factory` 映射。新增厂商时往 registry 注册即可，工具代码不动。

### 3. 无状态 adapter
Adapter 是纯转换器，不持有对话状态、不缓存。便于单测，并发安全。

### 4. SDK client 在 registry 创建
Adapter 不自己 new SDK，client 由 registry 集中创建、注入到 adapter。与 `services/providers` 的 LLM provider 设计一致。

## 模块结构

```
src/services/search-providers/
├── types.ts              SearchProvider 接口、SearchResult / FetchResult 等
├── registry.ts           createSearchProvider() 与 providerId → factory 映射
├── tavily.ts             TavilyAdapter（当前激活）
├── exa.ts                ExaAdapter（保留，暂未启用）
├── index.ts              公开接口导出
└── __tests__/
    ├── tavily.unit.test.ts
    └── registry.unit.test.ts
```

> **注**：`web_search` / `web_fetch` 是 `tools` 入口，search-providers 是其后端服务适配层，源码挂在 `services/` 下与 LLM provider 平行；上层 `tools/web-*.ts` 通过 registry 拿到 SearchProvider，不直接 import 具体 adapter。

## 架构权衡

### 1. 归一化字段集 vs 厂商完整能力
**选择：** 归一化字段集（query、numResults、includeDomains、excludeDomains、timeRange、country 等通用字段）
**代价：** Tavily 的 `topic`、Exa 的 `category` 等厂商独有字段无法直接传入
**收益：** 工具接口稳定，切换 provider 无破坏

如有需求，可在 `SearchOptions` 上加 `providerExtras?: Record<string, unknown>` 字段透传，但默认不暴露。

### 2. 流式 vs 同步
**选择：** 同步（Promise）
**理由：** 搜索/抓取本质是一次性请求，无流式需求。

### 3. 厂商独有能力如何处理
**选择：** Tavily 的 `crawl` / `map` 不暴露为单独工具
**实现思路：** 如果 `crawl()` 对 `fetch()` 的覆盖率/质量有显著提升，可在 `tavily.ts` 内部把 `client.crawl()` 作为 `fetch()` 的实现细节使用，但不出现在 SearchProvider 接口上。

### 4. SDK client 在 registry 创建
副作用集中在 registry，adapter 保持纯函数式。便于单测时直接注入 mock client。

### 5. 无状态 + 不缓存
每次调用都新建 adapter / 走真实 API。缓存交给上层，避免 provider 模块陷入失效策略复杂度。

## 与 goals-duty 对应关系

| Architecture 要素 | 对应职责 |
|---|---|
| SearchProvider 接口 | Duty 1：定义统一抽象 |
| Provider Registry | Duty 2：配置驱动的切换 |
| TavilyAdapter / ExaAdapter | Duty 3：具体厂商适配 |
| SearchResult / FetchResult 归一化类型 | Duty 4：归一化请求与响应 |
| 无状态 adapter | Goal 3：保持纯净性 |
| Registry 扩展点 | Goal 4：预留多 provider 空间 |
