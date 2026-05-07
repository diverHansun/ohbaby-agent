# Tavily Provider - goals-duty.md

本文档定义 `tavily` provider 模块的目标与职责边界。

> **当前定位**：Tavily 是 `search-providers` 当前激活的实现，对接 `@tavily/core` SDK，为 `tools/web-search` / `tools/web-fetch` 两个内置工具提供搜索与抓取能力。
>
> **不包含**：`tavily_crawl` / `tavily_map` 不再作为独立工具暴露给 LLM。`client.crawl()` 如对覆盖率/质量有显著提升，可作为 `tavily-extract.ts` 内部辅助函数被 `fetch()` 调用，但**不出现在 SearchProvider 接口上**。

**模块位置**：
- 代码：`src/services/search-providers/tavily.ts`
- 文档：`docs/tools/search-providers/tavily/`

---

## 一、Module Goals（模块目标）

### 1.1 核心目标

为 `tools/web-search` 与 `tools/web-fetch` 提供基于 Tavily AI 的 Web 搜索和内容提取能力，并把厂商差异收敛在 `SearchProvider` 接口背后。

### 1.2 具体目标

| 目标 | 描述 | 优先级 |
|------|------|--------|
| Web 搜索 | 提供为 LLM 优化的 Web 搜索能力，归一为 `SearchResult[]` | P0 |
| 内容提取 | 从 URL 列表批量提取原始内容，归一为 `FetchResult[]` | P0 |
| 配置灵活 | 支持项目级和用户级配置 | P1 |
| 错误透明 | 将 SDK 错误清晰传递给上层 | P1 |

---

## 二、Module Duties（模块职责）

### 2.1 职责范围

| 职责 | 描述 | 负责方 |
|------|------|--------|
| SDK 封装 | 封装 @tavily/core，提供 `SearchProvider` 接口 | tavily 模块 |
| 参数验证 | 验证 `SearchOptions` / `FetchOptions` 输入 | tavily 模块 |
| 格式转换 | 原生响应 → `SearchResult[]` / `FetchResult[]` | tavily 模块 |
| 配置加载 | 加载 Tavily 配置 | config/tools/tavily |
| 工具注册 | 注册到 ToolScheduler | tool-scheduler |
| 并发控制 | 控制工具执行并发 | tool-scheduler |
| 权限检查 | 检查工具执行权限 | tool-scheduler |

### 2.2 职责边界

**tavily 模块负责**:
- 实现 `SearchProvider` 接口（`search` / `fetch`）
- 调用 @tavily/core 的 `search()`、`extract()`（必要时内部使用 `crawl()` 增强 fetch 覆盖率）
- 参数 snake_case 到 camelCase 的转换
- 响应归一化为统一类型

**tavily 模块不负责**:
- 直接被 LLM 调用（LLM 看到的是 `web_search` / `web_fetch`）
- Markdown 渲染（由 `tools/web-*.ts` 完成）
- 工具执行权限判断（由 tool-scheduler 负责）
- 并发控制、错误重试、API Key 验证
- 配置文件读取（由 config/tools/tavily 负责）

---

## 三、SearchProvider Interface 实现

### 3.1 search()

**职责**: 执行为 LLM 优化的 Web 搜索

**输入**: `query: string` + `SearchOptions`（参见 `docs/tools/search-providers/data-model.md`）

通用字段映射到 Tavily SDK：

| SearchOptions 字段 | Tavily SDK 字段 |
|---|---|
| numResults | maxResults |
| includeDomains | includeDomains |
| excludeDomains | excludeDomains |
| timeRange | timeRange |
| country | country |
| includeRawContent | includeRawContent |
| maxCharactersPerResult | （在归一化阶段截断 content） |

**输出**: `SearchResult[]`（按 score 降序）

**Tavily 特有但当前不暴露的字段**：
- `topic`（general / news / finance）：使用 `general` 默认
- `searchDepth`（basic / advanced）：使用 `basic` 默认
- `includeAnswer`：当前不启用，由上层 LLM 决定是否需要总结
- `includeImages`：当前不启用

如配置文件提供了 defaults，由 adapter 内部应用。

### 3.2 fetch()

**职责**: 从 URL 列表批量提取内容

**输入**: `urls: string[]` + `FetchOptions`

通用字段映射到 Tavily SDK：

| FetchOptions 字段 | Tavily SDK 字段 |
|---|---|
| format | format（'markdown' / 'text'） |
| maxCharactersPerUrl | （归一化阶段截断 content） |
| includeImages | includeImages |

**输出**: `FetchResult[]`，每个 URL 一项；失败 URL 通过 `success: false, error` 表达，不抛整体异常

**Tavily 内部实现细节**：
- 默认调用 `client.extract(urls, options)`
- 如未来发现某些场景下 `client.crawl()` 比 `extract()` 提取更全或更稳定，可在 `tavily-extract.ts` 内部把 `crawl()` 作为补充策略调用，但**这是实现细节**，不暴露给上层

---

## 四、Component Duties（组件职责）

> **代码位置变更说明**：随着 search-providers 模块落地，原 `src/extension/tools/sdk/tavily/` 下的多文件结构会收敛到 `src/services/search-providers/tavily.ts` 一个适配器文件 + 必要的 helpers。具体源码组织以代码 PR 为准；本节仅保留组件级职责说明。

### 4.1 client 创建

| 职责 | 描述 |
|------|------|
| 客户端实例化 | 由 registry 注入的 SDK client（`tavily({ apiKey, apiBaseURL, proxies })`） |
| 不缓存 | 每次 `createSearchProvider()` 创建新实例 |

### 4.2 配置消费

| 职责 | 描述 |
|------|------|
| 接收已验证配置 | 从 `SearchProviderConfig.defaults` 接收 `TavilyDefaults` |
| 应用默认值 | 在 search/fetch 调用中合并 defaults 与运行时 options |

不负责：配置文件读取（由 config/tools/tavily 负责）

### 4.3 search 实现

| 职责 | 描述 |
|------|------|
| 参数转换 | snake/camel case 转换、默认值合并 |
| SDK 调用 | `client.search(query, mappedOptions)` |
| 响应归一化 | 原生 results[] → `SearchResult[]` |

### 4.4 fetch 实现

| 职责 | 描述 |
|------|------|
| 参数转换 | snake/camel case 转换、默认值合并 |
| SDK 调用 | `client.extract(urls, mappedOptions)`，必要时内部辅以 `client.crawl()` |
| 响应归一化 | 原生 results + failedResults → `FetchResult[]` |

---

## 五、Non-Goals（非目标）

以下功能明确不在本模块范围内:

| 非目标 | 理由 |
|--------|------|
| `tavily_crawl` / `tavily_map` 暴露为独立工具 | 接口收敛到 SearchProvider 后，crawl/map 的语义被 fetch 覆盖；如有强需求未来再单独评估 |
| Tavily Research API | 高成本异步 API，需轮询结果 |
| 结果缓存 | 不缓存搜索/抓取结果 |
| 自动重试 | 由更上层（agent / scheduler）决定 |
| 流式响应 | 搜索/抓取无流式需求 |
| `topic` / `searchDepth` 等厂商独有字段透传 | 当前不暴露；如需可在 `SearchOptions.providerExtras` 透传 |

---

## 六、Quality Attributes（质量属性）

### 6.1 可靠性
- 错误清晰传递，不吞没异常
- 参数严格验证，防止无效请求
- fetch 部分失败明确通过 `FetchResult.success` 表达

### 6.2 可维护性
- 适配器单文件聚焦，对外只暴露 `SearchProvider` 接口
- 类型完备，便于重构

### 6.3 可测试性
- adapter 无状态，client 可注入
- 参数转换/响应归一化可独立单测

---

## 七、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `search-providers/registry` | 被实例化 | 由 registry 调用工厂创建 |
| `tools/web-search.ts` / `tools/web-fetch.ts` | 被调用 | 通过 `SearchProvider` 接口 |
| `config/tools/tavily` | 依赖 | 提供已验证的 `TavilyDefaults` |
| `core/tool-scheduler` | 间接 | 调度的是 `web_search` / `web_fetch`，不直接接触 tavily |

---

## 八、文档自检

- [x] 模块目标明确
- [x] 职责边界清晰，仅实现 `SearchProvider` 接口
- [x] crawl/map 已明确不作为独立工具
- [x] 厂商独有字段处理策略清晰（默认不暴露）
- [x] 与 search-providers 抽象层接口一致
