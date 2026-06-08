# 01 — 问题/现状分析与目标

## 1. 现状概述

ohbaby-agent 当前采用全局单模型配置。LLM 连接信息来自 `~/.ohbaby-agent/model.json`，API key 来自项目 `.env` 或进程环境变量。用户现在无法在 TUI 中完成 provider/base_url/model/API key 的完整切换，只能手动编辑配置文件。

当前相关链路：

```text
TUI / CLI
  - /models 只读展示
  - 无 /connect
  - tui-improve-4 已为 interactive panel 预留结构

Agent
  - config/llm/types.ts 已支持 apiConfig.interfaceProvider
  - config/llm/writer.ts 已能原子写 model.json 和 .env
  - config/llm/manager.ts 已能 reload LLM config
  - ui-inprocess.ts 会缓存 runtimePromise，切换后必须重建 runtime

Storage
  - ~/.ohbaby-agent/model.json: 非敏感模型连接配置
  - <project>/.env: API key 明文 key-value
```

## 2. 核心问题

1. **缺少 `/connect` 入口**  
   用户无法在终端内配置 `provider`、`baseUrl`、`apiKeyEnv`、`model` 和 `interfaceProvider`。

2. **API key 不能安全走 slash command 字符串**  
   当前 `executeCommand` 只有 `raw/rawArgs/argv/body`。如果实现 `/connect --api-key ...`，密钥可能进入命令历史、事件、测试快照、错误输出或 transcript。API key 必须通过安全结构化 payload 提交。

3. **interfaceProvider 对用户不可达**  
   代码已支持 `"openai-compatible"` 与 `"anthropic"`，但当前用户只能手动改 JSON。新设计中，`/connect` 根据 `base_url` 推断默认值，并在保存时显式写入 `apiConfig.interfaceProvider`。

4. **切换后 runtime 可能仍使用旧 client**  
   `ui-inprocess.ts` 会缓存 runtime。只调用 `reloadLLMConfig()` 不够，保存新配置后必须清掉并重建当前 LLM runtime。

5. **context window 容易失真**  
   通过 Zenmux、OpenRouter 等代理使用模型时，当前 `modelProfiles.ts` 会因 provider 不匹配或模型名带 namespace 而 fallback 到 128K，导致前端 context 占用率和后端 compact 预算错误。

## 3. 实施目标

### 3.1 TUI `/connect`

`/connect` 无参数时打开 `ConnectPanel` 表单，不执行普通 `executeCommand`。

表单字段：

| Section | Field | Required | Notes |
|---------|-------|----------|-------|
| Connection | Provider | 是 | 用户自行填写；用于配置标识、UI 展示和 profile hint |
| Connection | Base URL | 是 | LLM API endpoint |
| Connection | Interface | 是 | 根据 `base_url` 推断默认值，可手动覆盖 |
| Connection | API key env name | 是 | 环境变量名，例如 `ZENMUX_API_KEY` |
| Connection | API key value | 条件 | masked；当当前 env/.env 已有对应 key 时可留空 |
| Model | Model name | 是 | 模型名，例如 `anthropic/claude-sonnet-4.6` |
| Model | Context window | 否 | 默认空；可填正整数 |
| Model | Max output tokens | 否 | 默认空；可填正整数 |

术语约定：

- **API key env name** 是写入 `model.json.apiConfig.apiKeyEnv` 的变量名，必填。
- **API key value** 是真实密钥值，只写入 `.env` 或进程环境；已有 env/.env 时可不重新输入。

交互规则：

- `Enter`：编辑当前字段；编辑中再次 `Enter` 提交字段
- 字段提交后，如果表单完整且合法，自动保存整张配置
- 保存成功仅显示 `Saved`
- `Esc`：编辑中取消编辑；非编辑中关闭 panel
- `PgUp/PgDn`：切换 section
- runtime status 为 `running` 时禁止落盘保存，显示 `Busy` 或 `Cannot save while running`
- API key 永远只渲染 mask，不进入 transcript、notice、panel output、日志或普通 argv

### 3.2 安全结构化提交

新增一个后端安全 API，例如：

```ts
connectModel(input: UiConnectModelInput): Promise<UiConnectModelResult>
```

TUI ConnectPanel 保存时调用该 API。API key value 只存在于结构化 payload 和后端写入流程中，不拼接到 `/connect --api-key ...`。

### 3.3 非敏感参数模式

保留 `/connect` 的参数模式用于自动化和测试，但不接受 `--api-key`。

```text
/connect --provider <name>
         --base-url <url>
         --api-key-env <ENV_NAME>
         --model <name>
         --interface-provider <openai-compatible|anthropic>
         [--context-window <tokens>]
         [--max-output-tokens <tokens>]
```

参数模式只能使用已有环境变量或 `.env` 中的 API key。缺 key 时返回安全错误，引导用户使用 TUI ConnectPanel 或先设置 env。

### 3.4 配置写入目标

保存成功后：

- 写入 `~/.ohbaby-agent/model.json`
- 如果用户提供了新 API key value，写入项目 `.env`
- 同步更新当前进程 `process.env[apiKeyEnv]`
- 调用 `reloadLLMConfig()`
- 重建当前 in-process runtime，使下一次请求走新 provider/interface/model
- 返回不含 API key 的安全摘要

`provider` 由用户必填。它用于配置标识、UI 展示和 profile hint，不直接决定请求协议。真正的请求协议由显式的 `apiConfig.interfaceProvider` 决定。

### 3.5 Context window 目标

- `Context window` 与 `Max output tokens` 默认留空
- 用户显式填写时优先使用用户值
- 用户留空时，后端尝试根据 `model/provider/interfaceProvider` 解析内置 profile
- 解析成功时写入当前模型 profile，并让 `llmParams.maxTokens` 跟随 `maxOutputTokens`
- 解析失败时不沿用旧模型的 context window，避免错误分母污染 UI 和 compact 预算

## 4. 非目标

- 不做多模型并发或会话级模型切换
- 不做 OAuth
- 不做模型列表自动发现
- 不引入 provider 注册中心
- 不把 API key 写入 `model.json`
- 不让 `/models` 承担本期 provider 切换主流程
