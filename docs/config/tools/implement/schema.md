# search.json 字段规范

## 文件位置

- **绝对路径**：`~/.ohbaby-agent/tools/search.json`
- **存在性**：可选。文件不存在 → 模块返回内建默认配置，不报错
- **格式**：UTF-8 编码、严格 JSON（不接受 JSONC / 注释）

## 顶层字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `provider` | `"tavily"`（枚举） | 否 | `"tavily"` | 搜索 provider 标识，必须与 `services/search-providers` 已注册的工厂一一对应 |
| `apiKeyEnv` | `string` | 否 | `"TAVILY_API_KEY"` | API Key 所在的环境变量**名字**。不接受 key 字面值 |
| `baseUrl` | `string`（URL 格式） | 否 | provider SDK 自身默认 | 自托管或代理场景下覆盖默认 endpoint |
| `defaults` | `object` | 否 | `{}` | provider 默认参数（见下表）；可被工具调用时的参数覆盖 |

## `defaults` 字段（provider 默认参数）

仅暴露最常用的 4 个 Tavily 搜索参数。其他参数（`extract`、`proxy` 等）暂不开放，遵循 YAGNI。

| 字段 | 类型 | 默认值 | 校验规则 |
| --- | --- | --- | --- |
| `searchDepth` | `"basic" \| "advanced"` | `"basic"` | 枚举值 |
| `maxResults` | `integer` | `5` | 1 ≤ n ≤ 20 |
| `topic` | `"general" \| "news" \| "finance"` | `"general"` | 枚举值 |
| `timeout` | `integer` | `60` | 1 ≤ n ≤ 600（秒） |

> 注：tool 调用时如果 LLM 显式传 `num_results`、`time_range` 等参数，**调用参数优先**于 `defaults`。这是 services 层的合并逻辑，不属于 config 模块职责。

## 解析后的内存数据结构

```typescript
export interface SearchConfig {
  readonly provider: "tavily";
  readonly apiKey: string;            // 从 process.env[apiKeyEnv] 解析后填入
  readonly apiKeyEnvName: string;     // 原字段名，保留供错误信息引用
  readonly baseUrl?: string;
  readonly defaults: {
    readonly searchDepth: "basic" | "advanced";
    readonly maxResults: number;
    readonly topic: "general" | "news" | "finance";
    readonly timeout: number;
  };
}
```

注意：

- 文件中的 `apiKeyEnv` 是**变量名字符串**；`SearchConfig.apiKey` 是**解析后的实际 key 值**
- `defaults` 字段在内存中始终是完整对象（缺失项填充默认值），减少消费方 `?? default` 散落

## 验证规则与错误码

所有错误均抛 `SearchConfigError`（参见 `architecture.md`），`code` 字段取值：

| 错误码 | 触发条件 | 错误消息要点 |
| --- | --- | --- |
| `FILE_NOT_FOUND` | search.json 不存在（**不视为错误**，仅当代码内部需要显式读取时使用） | — |
| `INVALID_JSON` | search.json 存在但 JSON 解析失败 | 指出文件路径和具体语法错误位置 |
| `VALIDATION_FAILED` | 字段不符合 schema（类型错误、枚举越界、数字越界） | 列出所有 Zod issue（field path + message） |
| `UNKNOWN_PROVIDER` | `provider` 字段值未在 `providerFactories` 注册 | 列出当前支持的 provider 列表 |
| `MISSING_API_KEY` | `process.env[apiKeyEnv]` 不存在或为空字符串 | 指出哪个环境变量名缺失 |
| `EMPTY_API_KEY` | `process.env[apiKeyEnv]` 存在但 trim 后为空 | 提示用户检查 `.env` 是否被 bin 入口加载 |

## 配置文件示例

**最简形式**（仅覆盖 baseUrl）：

```json
{
  "baseUrl": "https://my-tavily-proxy.example.com"
}
```

其他字段全部回退到默认值；`apiKey` 仍从 `TAVILY_API_KEY` 读取。

**完整形式**：

```json
{
  "provider": "tavily",
  "apiKeyEnv": "TAVILY_API_KEY",
  "baseUrl": "https://api.tavily.com",
  "defaults": {
    "searchDepth": "advanced",
    "maxResults": 10,
    "topic": "news",
    "timeout": 120
  }
}
```

**无文件**：等价于

```json
{
  "provider": "tavily",
  "apiKeyEnv": "TAVILY_API_KEY"
}
```

— `baseUrl` 走 provider SDK 默认，`defaults` 全部走表中默认值。
