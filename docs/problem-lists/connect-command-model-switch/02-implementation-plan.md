# 02 — 实施计划与受影响文件

## 1. 总体方案

本期采用 KISS 的单一闭环：

```text
TUI /connect
  -> 打开 ConnectPanel
  -> 表单字段 Enter 提交
  -> 表单完整且 idle 时自动调用 connectModel(payload)
  -> 后端写 model.json/.env
  -> reload config
  -> 重建 in-process runtime
  -> TUI 显示 Saved
```

同一个后端保存函数同时服务：

- TUI 的安全结构化提交
- `/connect --provider ...` 的非敏感参数模式

不实现复杂 secret store，不做多层 wizard，不把 API key 拼进 slash command argv。

## 2. 新增/修改模块

### 2.1 SDK / Core API

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-sdk/src/client.ts` | 在 `UiBackendClient` 增加 `connectModel()` |
| `packages/ohbaby-sdk/src/rpc/types.ts` | 在 `CoreAPI` 增加 `connectModel()` |
| `packages/ohbaby-sdk/src/index.ts` | 导出 connect input/result 类型 |

建议类型：

```ts
export interface UiConnectModelInput {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: "openai-compatible" | "anthropic";
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface UiConnectModelResult {
  readonly provider: string;
  readonly baseUrl: string;
  readonly interfaceProvider: "openai-compatible" | "anthropic";
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly saved: true;
}
```

`UiConnectModelResult` 不包含 API key。

`connectModel()` 是一个有意保留的业务特化 CoreAPI 例外：它不进入 `executeCommand` 路径，因为 API key value 不能出现在 command invocation 的 `raw/rawArgs/argv/body` 中。这个例外来自安全需求压倒接口一致性的取舍，不应扩展为任意 slash command 的第二执行通道。

### 2.2 Agent 后端

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 实现 `connectModel()`；保存成功后清掉并重建 runtime |
| `packages/ohbaby-agent/src/adapters/ui-persistent.ts` | pass-through `connectModel()` |
| `packages/ohbaby-agent/src/host/core-api-factory.ts` | pass-through `connectModel()` |
| `packages/ohbaby-agent/src/config/llm/writer.ts` | 支持写入/更新当前模型 profile；支持清理旧 context window |
| `packages/ohbaby-agent/src/config/llm/types.ts` | 如有需要，扩展 writer input 类型 |
| `packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts` | 修复代理 provider 与 namespace 模型名匹配 |
| `packages/ohbaby-agent/src/commands/catalog.ts` | 注册 `/connect` |
| `packages/ohbaby-agent/src/commands/connect.ts` | 非敏感参数模式解析和 handler |
| `packages/ohbaby-agent/src/commands/builtin.ts` | 挂接 connect handler，保持 builtin 文件不过大 |

后端核心函数建议命名为 `applyActiveModelConfig()`，负责：

1. 校验输入
2. 解析 context/max output profile
3. 调用 `setActiveLLMConfig()`
4. 写入 `.env` 时同步 `process.env[apiKeyEnv]`
5. `reloadLLMConfig()`
6. 触发 runtime reconnect
7. 返回安全摘要

### 2.3 TUI

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx` | 新增 ConnectPanel |
| `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx` | 增加 interactive panel kind: `connect` |
| `packages/ohbaby-cli/src/tui/app.tsx` | `/connect` 无参数短路打开 ConnectPanel，不调用普通 `executeCommand` |
| `packages/ohbaby-cli/src/tui/components/prompt/index.tsx` | 识别 interactive command route |
| `packages/ohbaby-cli/src/tui/store/snapshot.ts` | 如需要，增加 connect panel draft/state 类型 |

ConnectPanel 采用字段列表形式，参考 gemini-cli 的 `BaseSettingsDialog` 思路，但不照搬自动逐项持久化。字段提交后仅在表单完整且 runtime idle 时保存整张配置。

## 3. `/connect` 命令注册

```ts
{
  id: "connect",
  path: ["connect"],
  acceptsArguments: true,
  argsHint:
    "[--provider <name>] [--base-url <url>] [--api-key-env <ENV>] [--model <name>] [--interface-provider <type>] [--context-window <tokens>] [--max-output-tokens <tokens>]",
  argumentMode: "argv",
  category: "model",
  description: "Connect to an LLM provider",
  source: "builtin",
  surfaces: COMMON_SURFACES,
  title: "Connect Provider",
}
```

参数模式不支持 `--api-key`。如果用户传入，返回 `UNSUPPORTED_SECRET_ARG`，提示使用 TUI ConnectPanel 或环境变量。

## 4. ConnectPanel 表单行为

字段：

| Section | Field | 必填 | 行为 |
|---------|-------|------|------|
| Connection | Provider | 是 | 用户自行填写，不自动隐藏 |
| Connection | Base URL | 是 | 合法 URL；修改后重新推断 Interface 默认值 |
| Connection | Interface | 是 | `openai-compatible` / `anthropic` |
| Connection | API key env | 是 | env var 格式 |
| Connection | API key value | 条件 | masked；已有 env/.env 时可留空 |
| Model | Model name | 是 | 支持 `anthropic/...`、`openai/...` namespace |
| Model | Context window | 否 | 空或正整数 |
| Model | Max output tokens | 否 | 空或正整数；保存后同步 `llmParams.maxTokens` |

键盘：

- `Up/Down` 移动字段
- `PgUp/PgDn` 切 section
- `Enter` 编辑/提交当前字段
- `Esc` 取消编辑或关闭 panel

自动保存：

- 字段 `Enter` 提交后更新本地 draft
- 表单不完整时只显示短错误，不写磁盘
- 表单完整且 runtime idle 时自动保存
- 保存成功显示 `Saved`
- runtime status 为 `running` 时显示 `Busy`，不保存

## 5. Interface 推断

`/connect` 可以根据 `baseUrl` 推断默认 interface，但保存时必须显式写入：

```json
{
  "apiConfig": {
    "baseUrl": "https://zenmux.ai/api/anthropic",
    "apiKeyEnv": "ZENMUX_API_KEY",
    "interfaceProvider": "anthropic"
  }
}
```

建议默认推断：

- URL path 或 host 明确包含 `anthropic`：`anthropic`
- 其他情况：`openai-compatible`

用户可在表单里覆盖该值。后端运行时只读取显式 `apiConfig.interfaceProvider`，不在每次请求时重新猜测。

## 6. 保存数据流

```text
ConnectPanel
  connectModel(payload)
    -> validateConnectInput()
    -> resolveConnectModelProfile()
    -> setActiveLLMConfig()
       - write ~/.ohbaby-agent/model.json
       - write <project>/.env when API key value provided
    -> process.env[apiKeyEnv] = API key value when provided
    -> reloadLLMConfig()
    -> reset runtimePromise / recreate LLM client
    -> emit safe model summary
```

`model.json` 示例：

```json
{
  "provider": "zenmux",
  "defaultModel": "anthropic/claude-sonnet-4.6",
  "apiConfig": {
    "baseUrl": "https://zenmux.ai/api/anthropic",
    "apiKeyEnv": "ZENMUX_API_KEY",
    "interfaceProvider": "anthropic"
  },
  "llmParams": {
    "temperature": 0,
    "maxTokens": 8192,
    "contextWindowTokens": 200000
  },
  "models": [
    {
      "provider": "zenmux",
      "model": "anthropic/claude-sonnet-4.6",
      "contextWindowTokens": 200000,
      "maxOutputTokens": 8192
    }
  ]
}
```

当 context window 无法解析且用户未填写时，不写入新的 `contextWindowTokens`，并清理旧 active override，避免旧模型分母污染新模型。

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| 表单缺字段 | 不保存，显示短错误 |
| URL 无效 | 不保存，显示 `Invalid base URL` |
| API key value 缺失且 env/.env 不存在 | 不保存，显示 `API key required` |
| runtime running | 不保存，显示 `Busy` |
| 写 `model.json` 失败 | 不写 `.env`，显示 `Save failed` |
| 写 `.env` 失败 | 不 reload runtime，显示 `Save failed` |
| runtime reconnect 失败 | 保留已写配置，显示 `Reconnect failed` |

所有错误路径都不得包含 API key 明文。

## 8. 安全策略

- API key 不进入 `/connect` argv
- API key 不进入 transcript、command notice、snapshot、event output 或 panel output
- `model.json` 只存 `apiKeyEnv`
- `.env` 存真实 key
- `connectModel()` 返回安全摘要
- 前端渲染 API key value 字段只显示 `provided` / `configured` / `empty` 或 mask

## 9. 分批建议

1. 后端 connect input/result 类型与保存函数 -> `UT-PARSE-*`, `UT-IFACE-*`, `UT-VALID-*`, `CT-01`~`CT-06`
2. writer/context profile 支持 -> `UT-WRITER-*`, `UT-PROFILE-*`
3. runtime reconnect -> `CT-07`~`CT-10`
4. `/connect` 非敏感参数模式 -> `CT-11`~`CT-14`
5. ConnectPanel 表单 -> `TUI-01`~`TUI-12`
6. TUI 安全与代理 provider 验收 -> `TUI-05`, `TUI-12`, `E2E-01`~`E2E-06`
