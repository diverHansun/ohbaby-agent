# 06 — 已确认设计

本文件记录本轮 brainstorming 已确认的设计决定，作为后续实施计划的依据。

## 1. 入口

- `/connect` 无参数打开 TUI `ConnectPanel`
- ConnectPanel 是表单，不是后端逐步问答 wizard
- ConnectPanel 提交时调用安全结构化 API，例如 `connectModel(payload)`
- API key 不走 `/connect --api-key ...`
- `/connect` 参数模式保留，但只支持非敏感参数

## 2. 表单

字段：

```text
Provider
Base URL
API key env
API key value
Model name
Context window
Max output tokens
```

确认：

- `Provider` 用户自行填写，必填
- `Base URL` 必填
- `Interface` 不展示为用户字段；根据 `base_url` 自动推断，但保存时显式写入
- `API key env` 必填
- `API key value` masked；已有 env 时可不重新输入
- `Context window` 默认空
- `Max output tokens` 默认空

## 3. 键盘行为

- `Up/Down` 移动字段
- `Enter` 是字段级操作：进入编辑或提交当前字段
- 字段提交后，若表单完整且合法，自动保存整张配置
- `Esc` 编辑中取消编辑，非编辑中关闭 panel
- 不使用 `Ctrl+S`

保存成功只显示：

```text
Saved
```

不在 UI 中显示长的写入路径或 runtime reconnect 说明。

## 4. 运行状态

当 runtime status 是 `running`：

- ConnectPanel 可以查看和编辑本地 draft
- 不允许保存到磁盘
- 显示 `Busy` 或 `Cannot save while running`
- 等运行结束后，下一次字段提交再触发自动保存

## 5. Interface Provider

`/connect` 根据 `base_url` 推断 `interfaceProvider`：

- URL host 含 `anthropic`、path 包含 `/api/anthropic` 或 Anthropic messages endpoint 时为 `anthropic`
- URL path 包含 `/api/v1` 或其他 OpenAI-compatible base URL 时为 `openai-compatible`

保存时必须显式写入：

```json
{
  "apiConfig": {
    "interfaceProvider": "anthropic"
  }
}
```

运行时只读取显式字段，不每次根据 URL 重新推断。

## 6. 保存行为

后端保存流程：

1. 校验必填字段和 URL/env/number 格式。
2. 写 `~/.ohbaby-agent/model.json`。
3. 如果传入 API key value，写项目 `.env`。
4. 同步 `process.env[apiKeyEnv]`。
5. 调用 `reloadLLMConfig()`。
6. 重建当前 in-process runtime。
7. 返回不含 API key 的安全摘要。

## 7. Context Window

- 用户显式填写 `Context window` 或 `Max output tokens` 时优先使用用户值
- 留空时后端尝试通过 profile resolver 解析
- resolver 要支持代理 provider 和 namespace 模型名
- 解析成功时写入 active context 和当前模型 `models[]` profile
- 解析失败且用户留空时，不沿用旧模型的 context window
- `llmParams.maxTokens` 跟随最终 `maxOutputTokens`

## 8. 安全约束

- API key 永远只渲染 mask
- API key 不进入 slash command argv
- API key 不进入 transcript、command notice、panel output、events、snapshot 或测试快照
- `model.json` 只存 `apiKeyEnv`
- `connectModel()` result 不含 API key
