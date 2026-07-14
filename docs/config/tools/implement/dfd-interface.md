# 数据流与对外接口

## 上下文与范围

本模块与以下外部要素交互：

- **文件系统**：读取 `~/.ohbaby/tools/search.json`
- **环境变量**：根据 `apiKeyEnv` 字段读取 `process.env` 中的 API Key
- **`services/search-providers/`**：把解析后的 `SearchConfig` 适配为 provider 工厂的入参
- **`tools/builtin.ts` / `composition.ts`**：消费 `getSearchConfig()` 的结果

本模块**不**直接接触：

- 项目级 `.env` 文件（由 `bin.ts` 在启动时统一加载到 `process.env`）
- Tavily SDK（由 `services/search-providers/tavily.ts` 负责）
- tool scheduler（由 composition 层负责注册）

## 数据流

### 流程 1：首次加载

```
应用启动（bin.ts）
  ↓
findProjectRoot() 向上查找 pnpm-workspace.yaml
  ↓
dotenv.config({ path: <root>/.env, override: false })
  ↓ （此时 process.env.TAVILY_API_KEY 等已就位）
runOhbabyCli() / composition 初始化
  ↓
首次调用 getSearchConfig()
  ↓
config/tools/search Manager 检查内存缓存
  ├─ 缓存存在 → 返回
  └─ 缓存不存在 → 执行加载
    ↓
  尝试读 ~/.ohbaby/tools/search.json
    ├─ 文件不存在 → 使用内建默认 schema 对象
    └─ 文件存在 → 读 + JSON.parse
        ↓
      validateSearchJson()（Zod schema 校验）
        ↓ 若失败 → 抛 SearchConfigError(VALIDATION_FAILED)
    ↓
  根据 apiKeyEnv 读 process.env[apiKeyEnv]
    ↓ 若为空 → 抛 SearchConfigError(MISSING_API_KEY / EMPTY_API_KEY)
    ↓
  合并为 SearchConfig 对象（含完整 defaults）
    ↓
  缓存到内存并返回
```

### 流程 2：热重载

```
（未来如有 /reload 等命令触发）
reloadSearchConfig() 被调用
  ↓
清除 Manager 内存缓存
  ↓
重新执行流程 1 的"加载"分支
  ↓
返回新的 SearchConfig
```

### 流程 3：工具调用时使用

```
LLM 触发 web_search 工具调用
  ↓
ToolScheduler 路由到 web_search 的 execute()
  ↓
web.ts 中的 createProvider() 调用注入的 loadConfig()
  ↓ （等价于 getSearchConfig()，命中缓存）
返回 SearchConfig
  ↓
services/search-providers createSearchProvider(config)
  ↓
provider.search(query, options)
  ↓
返回结果给 tool scheduler
```

## 公开 API

```typescript
// src/config/index.ts 重新导出
export {
  getSearchConfig,
  reloadSearchConfig,
  isSearchConfigCached,
  SearchConfigError,
} from "./tools/index.js";

export type {
  SearchConfig,
  SearchConfigLoadOptions,
  SearchConfigErrorCode,
} from "./tools/index.js";
```

### `getSearchConfig(options?)`

```typescript
function getSearchConfig(
  options?: SearchConfigLoadOptions
): Promise<SearchConfig>;
```

- 首次调用：执行加载流程并缓存
- 后续调用：返回缓存
- 失败：抛 `SearchConfigError`（除"文件不存在"以外的任何异常）

`options` 字段：

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `env` | `NodeJS.ProcessEnv` | 测试场景下注入环境变量；默认 `process.env` |
| `searchJsonPath` | `string` | 覆盖配置文件路径；默认 `~/.ohbaby/tools/search.json` |

### `reloadSearchConfig(options?)`

签名同 `getSearchConfig`，但跳过缓存检查、强制重新加载。

### `isSearchConfigCached()`

```typescript
function isSearchConfigCached(): boolean;
```

主要供调试 / 测试使用。

### `SearchConfigError`

```typescript
class SearchConfigError extends Error {
  readonly code: SearchConfigErrorCode;
  readonly path?: string;
  readonly context?: Record<string, unknown>;
}
```

字段语义与 `McpConfigError` 一致；详细错误码见 [schema.md](schema.md)。

## 与 services 层的适配接口

由于 `services/search-providers` 自身的 `SearchProviderConfig` 接口形状已经存在并被多处使用，config 模块需要一个 thin adapter：

```typescript
// src/config/tools/search/index.ts 或 composition 层
function toServicesConfig(config: SearchConfig): SearchProviderConfig {
  return {
    providerId: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    defaults: { search: config.defaults },
  };
}
```

具体放在哪一层的最终决定见 [migration.md](migration.md)。

## 不属于本模块接口的部分

- **`.env` 文件路径解析**：由 `bin.ts` + `src/utils/project-root.ts` 负责
- **provider 实例化**：由 `services/search-providers/registry.ts` 负责
- **工具注册到 scheduler**：由 `tools/builtin.ts` + composition 负责
- **运行时把 LLM 的 tool call 参数与 `defaults` 合并**：由 `services/search-providers/tavily.ts` 的 `buildSearchOptions` 负责
