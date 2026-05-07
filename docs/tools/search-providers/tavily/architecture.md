# Tavily Provider - architecture.md

本文档描述 `tavily` provider 的内部架构与设计模式。所有设计基于 `goals-duty.md` 中定义的职责。

> **作用域提示**：本文档只覆盖 `SearchProvider` 接口下的两条路径（search / fetch）。原 Tavily 模块设计的 `tavily_crawl` / `tavily_map` 工具已废弃；`client.crawl()` 如有用，作为 `fetch` 的内部辅助路径出现，不暴露给上层。

---

## 一、Architecture Overview

### 模块定位

Tavily provider 是 search-providers 抽象层的一个具体适配器，对接 `@tavily/core` SDK。其上游消费者是 `tools/web-search` / `tools/web-fetch`，下游是 Tavily HTTP API。

### 核心架构

```
┌──────────────────────────────────────────────────────────┐
│  tools/web-search.ts   tools/web-fetch.ts                │
│         │                       │                        │
│         └──── SearchProvider 接口 ──────┐                 │
└─────────────────────────────────────────┼────────────────┘
                                          ▼
┌──────────────────────────────────────────────────────────┐
│  src/services/search-providers/tavily.ts                 │
│                                                          │
│   createTavilyProvider(config) → SearchProvider          │
│        │                                                 │
│        ├── search(query, options)                        │
│        │     ├─ buildSearchOptions()                     │
│        │     ├─ client.search(query, opts)               │
│        │     └─ normalizeSearchResponse() → SearchResult │
│        │                                                 │
│        └── fetch(urls, options)                          │
│              ├─ buildExtractOptions()                    │
│              ├─ client.extract(urls, opts)               │
│              │   ↳ 必要时辅以 client.crawl() 增强         │
│              └─ normalizeExtractResponse() → FetchResult │
└──────────────────────────────────────────────────────────┘
                                          │
                                          ▼
                            ┌────────────────────────┐
                            │   @tavily/core SDK     │
                            │   tavily()             │
                            │     .search()          │
                            │     .extract()         │
                            │     .crawl()  *内部用*  │
                            └────────────────────────┘
```

---

## 二、Core Components

### 2.1 Adapter Factory

**职责**: 实现 `createTavilyProvider(config: SearchProviderConfig): SearchProvider`

**核心逻辑**:

```typescript
function createTavilyProvider(config: SearchProviderConfig): SearchProvider {
  const client = tavily({
    apiKey: config.apiKey,
    apiBaseURL: config.baseUrl,
    proxies: config.defaults?.proxy,
  });

  return {
    id: 'tavily',
    async search(query, options) {
      const opts = buildSearchOptions(options, config.defaults);
      const response = await client.search(query, opts);
      return normalizeSearchResponse(response);
    },
    async fetch(urls, options) {
      const opts = buildExtractOptions(options, config.defaults);
      const response = await client.extract(urls, opts);
      return normalizeExtractResponse(response);
    },
  };
}
```

### 2.2 参数构造

| 函数 | 输入 | 输出 |
|------|------|------|
| `buildSearchOptions(opts, defaults)` | `SearchOptions` + `TavilyDefaults` | Tavily SDK `SearchOptions`（camelCase） |
| `buildExtractOptions(opts, defaults)` | `FetchOptions` + `TavilyDefaults` | Tavily SDK `ExtractOptions` |

### 2.3 响应归一化

| 函数 | 输入 | 输出 |
|------|------|------|
| `normalizeSearchResponse(response)` | Tavily `SearchResponse` | `SearchResult[]` |
| `normalizeExtractResponse(response)` | Tavily `ExtractResponse` | `FetchResult[]` |

`normalizeExtractResponse` 把 `failedResults` 与 `results` 合并为统一的 `FetchResult[]`，每个 URL 一条记录，`success` 字段标识是否成功。

---

## 三、Design Patterns

### 3.1 Adapter 模式
**应用**: 把 `SearchProvider` 接口适配到 `@tavily/core` SDK。

### 3.2 Pure Function（无状态）
**应用**: 适配器内部所有 helper 函数（buildXxxOptions / normalizeXxxResponse）都是纯函数，便于单测，无副作用。

### 3.3 SDK Client 注入
**应用**: SDK client 由 registry 创建并通过闭包注入；adapter 不自己 `new` SDK，便于测试中替换为 mock。

---

## 四、Module Structure

```
src/services/search-providers/
├── tavily.ts                # 主适配器（包含 helpers）
├── tavily-helpers.ts        # （可选）参数构造与响应归一化辅助函数
└── __tests__/
    └── tavily.test.ts
```

> 与原 `src/extension/tools/sdk/tavily/` 的多文件结构相比，新设计收敛到单文件聚焦：参数构造、SDK 调用、响应归一化都在 `tavily.ts` 中。如 `crawl()` 作为内部增强引入，再考虑拆分。

---

## 五、Architectural Constraints

### 5.1 约束

| 约束 | 说明 |
|------|------|
| 单一接口 | 只对外暴露 `SearchProvider`，不导出独立的 `tavily_crawl` / `tavily_map` |
| 不缓存 | 每次调用都请求 Tavily API |
| 不自动重试 | 失败由调用方决定 |
| 同步等待 | 不支持流式响应 |

### 5.2 权衡

| 选择 | 放弃 | 理由 |
|------|------|------|
| 单文件适配器 | 多文件分拆 | 接口仅 search/fetch 两个，单文件足够 |
| 字段集归一化 | 厂商完整能力 | 工具接口稳定优先；providerExtras 是兜底 |
| crawl 作为内部辅助 | crawl 作为独立工具 | 避免接口扩张；如确有价值，未来再评估 |

---

## 六、Dependencies

### 6.1 外部依赖

| 依赖 | 版本 | 用途 |
|------|------|------|
| @tavily/core | ^0.6.4 | Tavily SDK |

### 6.2 内部依赖

| 模块 | 用途 |
|------|------|
| `search-providers/types` | `SearchProvider` / `SearchOptions` / 等类型 |
| `config/tools/tavily` | 间接（通过 `SearchProviderConfig`） |

---

## 七、文档自检

- [x] 架构服务于 goals-duty.md 中定义的职责
- [x] 仅实现 SearchProvider 两个方法，crawl/map 已废弃
- [x] 设计模式选择有明确理由
- [x] 模块结构与新位置（`src/services/search-providers/`）一致
- [x] 约束和权衡已说明
