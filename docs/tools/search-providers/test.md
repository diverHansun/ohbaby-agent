# search-providers 模块的测试策略

## 测试目标

验证 provider 层的两类职责：

1. 是否把统一的 `SearchOptions` / `FetchOptions` 正确转换为厂商原生请求
2. 是否把厂商原生响应正确归一化为 `SearchResult[]` / `FetchResult[]`

## 测试边界原则

- **provider 单测只验证"协议转换"和"响应归一化"**
- 工具层（`tools/web-search.ts` / `tools/web-fetch.ts`）的测试只关注调用与 Markdown 输出
- 不在 provider 单测中跑真实网络请求；E2E 单独标注

## 单元测试范围

### 1. registry.ts

| 用例 | 验证点 |
|---|---|
| 已知 providerId 创建成功 | 返回 `SearchProvider` 实例，`id` 字段正确 |
| 未知 providerId | 抛 `UnknownProviderError` |
| `apiKey` 缺失 | 抛 `InvalidProviderConfigError` |
| `registerSearchProvider` 注册新工厂 | 后续 `createSearchProvider` 能命中 |

### 2. TavilyAdapter（当前激活）

测试文件：`packages/ohbaby-agent/src/services/search-providers/__tests__/tavily.unit.test.ts`

#### 2.1 search()

| 用例 | 验证点 |
|---|---|
| 基本调用 | `client.search(query, options)` 被以正确参数调用 |
| 参数转换 | `numResults → maxResults`、`includeDomains → includeDomains` 等 snake/camel case 转换 |
| 默认值合并 | adapter 内置默认值（depth、topic）和 config defaults 都生效 |
| 响应归一化 | 原生 `results[]` 字段映射到 `SearchResult` 的 title/url/content/score/publishedDate |
| `includeRawContent=true` | `SearchResult.rawContent` 被填充 |
| `score` 字段缺失 | 归一化结果中 `score` 为 `undefined`（不报错） |

#### 2.2 fetch()

| 用例 | 验证点 |
|---|---|
| 基本调用 | `client.extract(urls, options)` 被以正确参数调用 |
| 部分失败 | 原生 `failedResults` 映射到 `FetchResult { success: false, error }` |
| 全部成功 | 所有 URL 返回 `success: true` |
| `includeImages=true` | `FetchResult.images` 被填充 |
| 空 `urls` 数组 | adapter 抛参数错误（不发起请求） |

#### 2.3 错误处理

| 用例 | 验证点 |
|---|---|
| 401 Unauthorized | 抛 `Error` 含"认证失败"语义 |
| 429 Rate Limited | 抛 `Error` 含"频率限制"语义 |
| 网络超时 | 抛 `Error`，不被错误归类为成功 |

### 3. ExaAdapter（保留，暂未启用）

当前不在 CI 中运行，但代码与 Tavily 同样的测试模板按需启用即可。具体见 `docs/tools/search-providers/exa/test.md`（保留旧文档作为参考）。

### 4. 类型与接口稳定性

| 用例 | 验证点 |
|---|---|
| 接口符合 `SearchProvider` | 编译通过即可（`satisfies SearchProvider`） |
| 不暴露厂商独有字段 | 静态分析：`SearchOptions` / `FetchOptions` 类型不含 topic/category 等 |

## Mock 策略

| 组件 | Mock 方式 | 说明 |
|---|---|---|
| `@tavily/core` | `vi.mock` | 完全 mock SDK |
| `exa-js` | `vi.mock` | 完全 mock SDK（启用 Exa 时） |
| `process.env` | `vi.stubEnv` | 注入测试用 API Key |

## 建议补充的测试

1. **多次调用不持有状态**：连续调用 `search()` / `fetch()`，验证两次互不影响
2. **空 query / 空 urls**：抛参数错误，且不调用底层 SDK
3. **`numResults` 上限**：超过厂商上限（如 Tavily 20）时被裁剪或报错
4. **provider 切换冒烟测试**：把 registry 替换为 ExaAdapter，相同 `SearchOptions` 仍能工作

## 覆盖目标

| 模块部分 | 优先级 | 说明 |
|---|---|---|
| TavilyAdapter | 高 | 当前唯一激活的 provider |
| registry | 高 | 创建路径是所有调用入口 |
| 类型契约 | 中 | 防止未来误把 SDK 类型泄露到 SearchOptions |
| ExaAdapter | 低 | 暂未启用，按 Tavily 模板备好即可 |

## 维护原则

### 1. 文档与代码必须同步
若 `SearchProvider` 接口字段变化，本文档与 data-model.md 同步更新。

### 2. provider 单测不重复工具层逻辑
Markdown 输出、tool-scheduler 注册、权限检查等不在此测试范围内。

### 3. 厂商接入门槛
新增一个 provider 至少要让以下测试全部通过：search 基本调用、fetch 基本调用、fetch 部分失败、参数转换、registry 注册。
