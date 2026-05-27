# 测试策略

## 测试范围

**覆盖的职责**：

- 从 `~/.ohbaby-agent/tools/search.json` 加载配置
- Zod schema 校验（字段类型、枚举值、数字范围）
- 从 `process.env` 读取 API Key（根据 `apiKeyEnv` 字段）
- 文件不存在时回退到默认 schema
- 缓存命中 / 失效
- `reloadSearchConfig()` 强制刷新
- 错误码与错误信息的准确性
- `findProjectRoot()` 工具的三种情形

**不覆盖**：

- `dotenv` 包本身的行为（假设其正确）
- Tavily SDK 的网络行为
- `process.env` 的底层行为
- tool scheduler 如何调用 provider（属于 services 测试范围）

## 测试矩阵

| 测试类型 | 文件 | 关注点 |
| --- | --- | --- |
| Unit | `src/config/tools/search/__tests__/loaders.unit.test.ts` | 路径定位、文件读取、ENOENT 处理 |
| Unit | `src/config/tools/search/__tests__/validation.unit.test.ts` | Zod schema 各字段校验、defaults 填充 |
| Unit | `src/config/tools/search/__tests__/manager.unit.test.ts` | 缓存、reload、错误传播 |
| Unit | `src/utils/__tests__/project-root.unit.test.ts` | 找到 / 找不到 / 嵌套 monorepo |
| Integration | `src/config/tools/search/__tests__/integration.test.ts` | 真实临时目录 + 真实环境变量端到端 |
| Contract | `src/services/search-providers/__tests__/registry.unit.test.ts`（更新） | 移除已删除函数的测试，保留 `createSearchProvider` 契约 |
| Integration | `src/tools/web.integration.test.ts`（更新） | 通过 `getSearchConfig` 注入，验证完整链路 |

## 关键场景

### Loaders（loaders.unit.test.ts）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| 文件存在且 JSON 合法 | 临时目录写入完整 search.json | 返回原始解析对象 |
| 文件不存在 | 不创建 search.json | 返回 `null`（loader 层用 null 表示"无文件"，manager 负责回退到默认 schema） |
| 文件存在但 JSON 非法 | 写入 `{` | 抛 `SearchConfigError(INVALID_JSON)`，包含路径 |
| getSearchJsonPath() | — | 返回 `<homedir>/.ohbaby-agent/tools/search.json` |

### Validation（validation.unit.test.ts）

| 用例 | 输入 | 期望 |
| --- | --- | --- |
| 完整有效对象 | 含所有字段 | 返回 typed 对象，defaults 透传 |
| 全部字段缺失（空对象） | `{}` | 返回填充了所有默认值的对象 |
| `provider` 是未知字符串 | `{provider: "unknown"}` | 抛 `VALIDATION_FAILED`，issue 指向 `provider` |
| `defaults.maxResults` 超范围 | `{defaults: {maxResults: 100}}` | 抛 `VALIDATION_FAILED`，issue 指向 `defaults.maxResults` |
| `defaults.searchDepth` 非枚举 | `{defaults: {searchDepth: "deep"}}` | 抛 `VALIDATION_FAILED` |
| `baseUrl` 非 URL | `{baseUrl: "not a url"}` | 抛 `VALIDATION_FAILED` |
| `apiKeyEnv` 为空字符串 | `{apiKeyEnv: ""}` | 抛 `VALIDATION_FAILED` |

### Manager（manager.unit.test.ts）

| 用例 | 设置 | 操作 | 期望 |
| --- | --- | --- | --- |
| 首次加载成功 | mock loaders 返回有效对象，env 有 key | `getSearchConfig()` | 返回完整 `SearchConfig` |
| 二次调用走缓存 | 同上 | 连续调用两次 | loader 只被调用一次 |
| reload 清缓存 | 同上 | `getSearchConfig` → `reloadSearchConfig` | loader 被调用两次 |
| 文件不存在 + env 有 key | loader 返回 null | `getSearchConfig()` | 返回默认 schema 填充后的对象 |
| 文件不存在 + env 无 key | loader 返回 null，env 无 | `getSearchConfig()` | 抛 `MISSING_API_KEY` |
| 文件有效但 env key 空字符串 | env 设为 `""` | `getSearchConfig()` | 抛 `EMPTY_API_KEY` |
| 文件 INVALID_JSON | loader 抛 | `getSearchConfig()` | 异常透传 |
| `isSearchConfigCached()` | 加载前 / 后 | 调用 | 返回 false / true |

### project-root.unit.test.ts

| 用例 | 设置 | 期望 |
| --- | --- | --- |
| 找到 pnpm-workspace.yaml | 临时目录 a/b/c，a 含 yaml，传入 a/b/c 中的文件 url | 返回 a |
| 找不到 | 临时目录 a/b/c，无 yaml | 返回 `process.cwd()` |
| 当前目录就含 | 临时目录 a，a 含 yaml，传入 a 中的文件 url | 返回 a |

### Integration（integration.test.ts）

| 用例 | 设置 | 期望 |
| --- | --- | --- |
| 端到端：文件 + env 都正确 | 临时 home 目录写真 search.json，设 process.env | `getSearchConfig` 返回拼装好的对象，包含真实 key |
| 端到端：仅 env | 临时 home 目录不创建 search.json，设 process.env | 返回默认 schema，含真实 key |
| 端到端：仅文件，env 缺 | 临时 home 目录有 search.json，env 无 key | 抛 `MISSING_API_KEY` |

> 集成测试通过 `getSearchConfig({ env, searchJsonPath })` 注入临时路径和环境，不污染全局。

### 既有测试的同步修改

- `services/search-providers/__tests__/registry.unit.test.ts`：
  - 删除 `loadDefaultSearchProviderConfig` 的测试
  - 保留 / 新增 `createSearchProvider(config)` 的契约测试（验证 `UnknownProvider`、`InvalidProviderConfig` 抛错）
- `tools/web.integration.test.ts`：
  - 替换原 `searchProvider: { loadConfig: () => ({...}) }` 的硬编码为 `loadConfig: () => toServicesConfig(testConfig)`
- LLM 模块测试中移除涉及"读 `.env` 文件"的用例，新增"环境变量已注入 process.env"的用例

## 测试运行

```powershell
# 全量
pnpm test

# 仅 config/tools/search
pnpm vitest run packages/ohbaby-agent/src/config/tools/search

# 仅 integration
pnpm test:integration
```

## 覆盖率目标

- **types.ts**：通过 schema 测试覆盖；不强制行覆盖
- **loaders.ts** / **validation.ts** / **manager.ts**：≥ 95%（核心，纯逻辑）
- **utils/project-root.ts**：100%（小函数）
- composition 层的接入逻辑：通过 `web.integration.test.ts` 覆盖一条 happy path
