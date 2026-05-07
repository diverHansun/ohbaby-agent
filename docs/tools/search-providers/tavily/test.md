# Tavily Provider - test.md

本文档定义 `tavily` provider 的测试策略。

> **作用域提示**：仅覆盖 search / fetch 路径。crawl / map 已废弃，相关测试也一并移除。Markdown 渲染、ToolScheduler 调度由工具层与上层模块自行测试。

---

## 一、Test Strategy

### 1.1 测试层次

| 层次 | 范围 | 方法 | 工具 |
|------|------|------|------|
| 单元测试 | adapter 内部函数 | mock `@tavily/core` | Vitest |
| 集成测试 | adapter ↔ registry ↔ config 协作 | mock SDK | Vitest |
| E2E 测试 | 真实 Tavily API | 真实请求 | 手动/CI |

### 1.2 Mock 策略

| 组件 | Mock 方式 | 说明 |
|------|-----------|------|
| `@tavily/core` | `vi.mock` | 完全 mock SDK |
| `process.env` | `vi.stubEnv` | 注入测试 API Key |

### 1.3 测试边界原则

- provider 单测不测试 Markdown 输出（属于工具层）
- provider 单测不测试权限/调度（属于 ToolScheduler）
- provider 单测专注于「参数转换」「响应归一化」「错误传播」三件事

---

## 二、Unit Tests

### 2.1 createTavilyProvider()

| 用例 | 验证点 |
|---|---|
| 正常创建 | 返回的对象 `id === 'tavily'`，包含 `search` / `fetch` 方法 |
| 缺失 apiKey | 抛 `InvalidProviderConfigError` |
| 自定义 baseUrl | client 被以正确 URL 创建 |
| 设置代理 | client 被以正确 proxies 创建 |

### 2.2 buildSearchOptions()

| 用例 | 验证点 |
|---|---|
| snake/camel case 转换 | `numResults → maxResults` 正确 |
| 默认值合并（无 defaults） | 使用硬编码默认值（searchDepth=basic、topic=general） |
| 默认值合并（有 defaults） | defaults 覆盖硬编码默认值 |
| 用户参数覆盖默认值 | `opts.numResults=10` 优先于默认 5 |
| `includeRawContent=true` | 转为 SDK 的 `'markdown'` |
| `maxCharactersPerResult` | **不**传入 SDK（归一化阶段处理） |

### 2.3 buildExtractOptions()

| 用例 | 验证点 |
|---|---|
| 基本字段透传 | format / includeImages 正确 |
| 默认值合并 | extractDepth=basic 默认 |
| `maxCharactersPerUrl` | 不传入 SDK |

### 2.4 normalizeSearchResponse()

| 用例 | 验证点 |
|---|---|
| 基本归一化 | results 字段映射正确 |
| 按 score 降序 | 输出顺序由 score 决定 |
| `score` 缺失 | 输出 `score === undefined`，不报错 |
| `publishedDate` 为空字符串 | 输出 `publishedDate === undefined` |
| `maxCharactersPerResult` 截断 | `content.length` 不超过限制 |

### 2.5 normalizeExtractResponse()

| 用例 | 验证点 |
|---|---|
| 全部成功 | 所有 URL 返回 `success: true` |
| 全部失败 | 所有 URL 返回 `success: false`，含 error |
| 部分成功部分失败 | 按 input URL 顺序合并两类结果 |
| 输入顺序保持 | 输出顺序与 `inputUrls` 一致 |
| `maxCharactersPerUrl` 截断 | content 不超过限制 |
| `includeImages=true` | `images` 字段被填充 |

### 2.6 search() 端到端

| 用例 | 验证点 |
|---|---|
| 基本搜索 | `client.search` 被以正确参数调用，返回 `SearchResult[]` |
| SDK 抛 401 | adapter 抛 Error 含「认证失败」语义 |
| SDK 抛 429 | adapter 抛 Error 含「频率限制」语义 |
| 网络超时 | adapter 抛 Error，不被误判为成功 |

### 2.7 fetch() 端到端

| 用例 | 验证点 |
|---|---|
| 基本提取 | `client.extract` 被以正确参数调用 |
| 部分失败 | `failedResults` 被映射到 `success: false` |
| 空 URLs | adapter 抛参数错误，不调用 SDK |
| URL 数量超限 | adapter 抛参数错误（最多 20） |

---

## 三、Integration Tests

### 3.1 与 registry 集成

| 用例 | 验证点 |
|---|---|
| `createSearchProvider({ providerId: 'tavily', ... })` | 返回的实例 `.id === 'tavily'`，可调用 search/fetch |
| `registerSearchProvider('mock', mockFactory)` | 后续 `createSearchProvider({ providerId: 'mock' })` 命中 mock |

### 3.2 与 config/tools/tavily 集成

| 用例 | 验证点 |
|---|---|
| 配置文件 defaults 被消化 | `searchDepth: 'advanced'` 配置生效 |
| `apiKey` 缺失时拒绝创建 | 在 createTavilyProvider 阶段就报错 |

---

## 四、Error Handling Tests

| 用例 | 验证点 |
|---|---|
| ZodError | 参数验证失败，抛错信息含字段名 |
| ConfigError | 提示 .env 缺少 TAVILY_API_KEY |
| TavilyError 401 | 错误信息含「认证失败」 |
| TavilyError 429 | 错误信息含「请求频率限制」 |
| TavilyError 5xx | 错误信息含「服务器错误」 |
| 未知错误 | 错误信息透传 + 包装前缀 |

---

## 五、Test Fixtures

```typescript
// __tests__/fixtures/config.ts
export const mockConfig: SearchProviderConfig = {
  providerId: 'tavily',
  apiKey: 'test-api-key',
  baseUrl: 'https://api.tavily.com',
  defaults: {
    search: {
      searchDepth: 'basic',
      topic: 'general',
      maxResults: 5,
      timeout: 60,
    },
    extract: {
      extractDepth: 'basic',
      format: 'markdown',
      timeout: 60,
    },
  },
}

// __tests__/fixtures/responses.ts
export const mockSearchResponse: TavilySearchResponse = {
  query: 'test query',
  responseTime: 1000,
  images: [],
  results: [
    {
      title: 'Test Result 1',
      url: 'https://example.com/1',
      content: 'Test content 1',
      score: 0.95,
      publishedDate: '2024-01-01',
    },
  ],
  requestId: 'req-123',
}

export const mockExtractResponse: TavilyExtractResponse = {
  results: [
    { url: 'https://example.com', rawContent: '# Page\n\nContent.' },
  ],
  failedResults: [
    { url: 'https://failed.com', error: 'Not found' },
  ],
  responseTime: 2000,
  requestId: 'req-456',
}
```

---

## 六、Test Coverage Requirements

| 模块部分 | 语句覆盖 | 分支覆盖 | 函数覆盖 |
|---|---|---|---|
| createTavilyProvider | > 90% | > 80% | 100% |
| buildSearchOptions / buildExtractOptions | > 95% | > 85% | 100% |
| normalizeSearchResponse / normalizeExtractResponse | > 95% | > 90% | 100% |
| search / fetch 端到端 | > 85% | > 75% | 100% |

---

## 七、E2E Test Considerations

### 7.1 条件
- 有效的 `TAVILY_API_KEY`
- 网络访问
- 会产生 API 调用费用

### 7.2 场景

| 场景 | 验证点 |
|------|--------|
| 基本搜索 | 返回有效结果 |
| 带选项搜索 | timeRange / numResults 生效 |
| 内容提取 | 正确提取内容 |
| 部分失败 | failedResults 映射到 success=false |

### 7.3 执行

```bash
export TAVILY_API_KEY=tvly-xxx
pnpm test:e2e -- --grep "tavily"
```

---

## 八、文档自检

- [x] 测试范围只覆盖 search / fetch
- [x] crawl / map 测试已移除
- [x] 单元测试覆盖参数转换、响应归一化、错误传播三件事
- [x] 与 search-providers 抽象层接口一致
