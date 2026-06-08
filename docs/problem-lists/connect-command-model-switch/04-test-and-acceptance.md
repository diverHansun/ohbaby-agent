# 04 — 测试与验收标准

## 1. 测试分层

```text
Unit
  - connect input validation
  - interface inference
  - profile resolution
  - writer model.json/.env behavior

Contract / Integration
  - CoreAPI.connectModel()
  - ui-inprocess runtime reconnect
  - /connect non-sensitive argv mode

TUI
  - ConnectPanel fields
  - masked API key
  - automatic save
  - running 状态禁止保存

E2E / Manual
  - Zenmux Anthropic URL
  - OpenAI-compatible URL
  - /models and /status after reconnect
```

## 2. Unit Tests

### 2.1 `parseConnectArgs()` 非敏感参数解析

| ID | 输入 | 期望 |
|----|------|------|
| UT-PARSE-01 | `--provider zenmux --base-url https://zenmux.ai/api/anthropic --api-key-env ZENMUX_API_KEY --model anthropic/claude-sonnet-4.6 --interface-provider anthropic` | 解析出完整非敏感配置 |
| UT-PARSE-02 | `--base-url=https://api.example.com/v1 --model=gpt-4o` | 支持 `=` 分隔符 |
| UT-PARSE-03 | `--context-window 200000 --max-output-tokens 8192` | 解析为正整数 |
| UT-PARSE-04 | `--interface-provider invalid` | 报 `INVALID_INTERFACE_PROVIDER` |
| UT-PARSE-05 | `--api-key sk-test` | 报 `UNSUPPORTED_SECRET_ARG` |
| UT-PARSE-06 | 空参数 | TUI surface 打开 ConnectPanel；非 TUI 返回缺字段 |

### 2.2 Interface 推断

| ID | Base URL | 期望 |
|----|----------|------|
| UT-IFACE-01 | `https://zenmux.ai/api/anthropic` | `anthropic` |
| UT-IFACE-02 | `https://api.anthropic.com/v1` | `anthropic` |
| UT-IFACE-03 | `https://api.openai.com/v1` | `openai-compatible` |
| UT-IFACE-04 | `https://open.bigmodel.cn/api/paas/v4` | `openai-compatible` |

### 2.3 `connectModel()` 校验

| ID | 场景 | 期望 |
|----|------|------|
| UT-VALID-01 | provider 为空 | `Provider required` |
| UT-VALID-02 | baseUrl 非 URL | `Invalid base URL` |
| UT-VALID-03 | apiKeyEnv 非 env var | `Invalid API key env` |
| UT-VALID-04 | model 为空 | `Model name required` |
| UT-VALID-05 | contextWindowTokens 非正整数 | `Context window must be a positive integer` |
| UT-VALID-06 | maxOutputTokens 非正整数 | `Max output tokens must be a positive integer` |
| UT-VALID-07 | API key value 未传但 env/.env 存在 | 允许保存 |
| UT-VALID-08 | API key value 未传且 env/.env 不存在 | `API key required` |
| UT-VALID-09 | runtime status 为 running | 拒绝保存，不写磁盘 |

### 2.4 Writer 行为

| ID | 场景 | 期望 |
|----|------|------|
| UT-WRITER-01 | 保存显式 `interfaceProvider` | `model.json.apiConfig.interfaceProvider` 正确 |
| UT-WRITER-02 | API key value 提供 | `.env` 写入对应 `apiKeyEnv` |
| UT-WRITER-03 | API key value 未提供 | 不改写 `.env` |
| UT-WRITER-04 | context/max output 解析成功 | 写入 `llmParams.contextWindowTokens`、`llmParams.maxTokens`、`models[]` profile |
| UT-WRITER-05 | 用户显式 context/max output | 用户值覆盖 resolver |
| UT-WRITER-06 | 新模型无法解析且用户留空 | 不沿用旧 `contextWindowTokens` |
| UT-WRITER-07 | 重复保存同一模型 | 更新已有 `models[]` profile，不重复插入 |

### 2.5 Profile Resolver

| ID | Provider | Model | 期望 |
|----|----------|-------|------|
| UT-PROFILE-01 | `zenmux` | `anthropic/claude-sonnet-4.6` | 命中 Claude profile，200K |
| UT-PROFILE-02 | `zenmux` | `claude-sonnet-4.6` | 命中 Claude profile，200K |
| UT-PROFILE-03 | `openrouter` | `openai/gpt-4o` | 命中 GPT profile，128K |
| UT-PROFILE-04 | `openai` | `gpt-4.1` | 1M |
| UT-PROFILE-05 | `custom` | `unknown-model` | fallback，但不自动污染 active config |

## 3. Contract / Integration Tests

### 3.1 CoreAPI / UiBackendClient

| ID | 场景 | 验证 |
|----|------|------|
| CT-01 | `client.connectModel(payload)` 成功 | 返回安全摘要，不含 API key |
| CT-02 | persistent client | pass-through 到 in-process client |
| CT-03 | core-api-factory | 暴露 `connectModel()` |
| CT-04 | 保存后 `/models` | current provider/model/interface 更新 |
| CT-05 | 保存后 `/status` | context window denominator 更新 |
| CT-06 | 保存失败 | draft 保留，输出不含 secret |

### 3.2 Runtime Reconnect

| ID | 场景 | 验证 |
|----|------|------|
| CT-07 | 保存新 baseUrl/model | 下一次 prompt 使用新 LLM client |
| CT-08 | 保存后 reload | `reloadLLMConfig()` 被调用 |
| CT-09 | 旧 runtimePromise 清理 | 新 runtime 读取新 config |
| CT-10 | 注入固定 fake `llmClient` | switching/connect 能力按设计禁用或返回不可用 |

### 3.3 `/connect` 参数模式

| ID | 场景 | 验证 |
|----|------|------|
| CT-11 | 非敏感参数完整且 key 已存在 | 保存成功 |
| CT-12 | 参数模式传 `--api-key` | 安全拒绝 |
| CT-13 | 缺 key | 安全错误提示使用 TUI 或设置 env |
| CT-14 | 缺必填参数 | 安全错误，不写磁盘 |

## 4. TUI Tests

| ID | 场景 | 期望 |
|----|------|------|
| TUI-01 | `/connect` 无参数 | 打开 ConnectPanel，不调用普通 `executeCommand` |
| TUI-02 | Provider/Base URL/API key env/Model 输入 | `Enter` 提交字段 |
| TUI-03 | Base URL 输入 Anthropic URL | Interface 默认显示 `anthropic` |
| TUI-04 | 手动覆盖 Interface | 保存使用用户选择 |
| TUI-05 | API key 输入 | 只显示 mask，不出现在 rendered output |
| TUI-06 | 表单不完整 | 不保存，显示短错误 |
| TUI-07 | 表单完整 | 自动保存，显示 `Saved` |
| TUI-08 | `PgUp/PgDn` | 切换 section |
| TUI-09 | `Esc` 编辑中 | 取消编辑 |
| TUI-10 | `Esc` 非编辑中 | 关闭 panel |
| TUI-11 | runtime running | 显示 `Busy`，不提交 |
| TUI-12 | snapshots/events | 不包含 API key 明文 |

## 5. E2E / 手动验收

| ID | 场景 | 验收 |
|----|------|------|
| E2E-01 | Zenmux Anthropic URL + `anthropic/claude-sonnet-4.6` | 下一次真实请求走 Anthropic adapter |
| E2E-02 | OpenAI-compatible URL + OpenAI 风格模型 | 下一次真实请求走 OpenAI-compatible adapter |
| E2E-03 | `/models` | 显示 provider/model/interface |
| E2E-04 | `/status` | context window 分母正确 |
| E2E-05 | 安全 | `model.json`、events、render output 中没有 API key 明文 |
| E2E-06 | 代理 provider + namespaced 内置模型 | `provider=zenmux` + `model=anthropic/claude-sonnet-4.6` 保存后 context window 为 200K |
| E2E-07 | root `.env` 中的真实 `ZENMUX_API_KEY` | `connect-model.real.e2e.test.ts` 保存临时 config 后完成一次真实 Anthropic-compatible streaming 请求 |

手动 checklist：

```text
□ /connect 出现在 slash command 补全中
□ /connect 无参数打开 ConnectPanel
□ PgUp/PgDn 可以切换 Connection/Model section
□ API key 输入显示 mask
□ 字段 Enter 后自动保存完整有效配置
□ 保存成功只显示 Saved
□ running 状态下显示 Busy 且不落盘
□ ~/.ohbaby-agent/model.json 写入 provider/baseUrl/apiKeyEnv/interfaceProvider/model
□ 项目 .env 写入 API key
□ process.env 热更新后下一次请求无需重启即可使用新 key
□ /models 显示新模型
□ /status 显示正确 context window
□ Zenmux + anthropic/claude-sonnet-4.6 显示 200K context window
□ /connect 参数模式不接受 --api-key
```

## 6. Definition of Done

1. 单元测试覆盖输入校验、writer、profile resolver
2. Contract 测试覆盖 `connectModel()` 和 runtime reconnect
3. TUI 测试覆盖 ConnectPanel 交互和 secret redaction
4. 参数模式测试确认不支持 `--api-key`
5. 手动或 E2E 验证 Anthropic-compatible、OpenAI-compatible 与代理 provider profile 匹配都可用
6. `pnpm test` / 类型检查通过，现有 `/models`、`/status` 无回归
