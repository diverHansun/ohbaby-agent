# LLM 配置模块数据模型

## 磁盘模型库：ModelDocument

`~/.ohbaby/model.json` 保存 `schemaVersion: 2`、可选 `activeProfileId` 和 `models`。`OHBABY_HOME` 可覆盖配置目录。默认 id 属于模型库；会话的 `modelEntryId` 属于会话，未指定时每轮跟随当时的默认模型。

```json
{
  "schemaVersion": 2,
  "activeProfileId": "work",
  "models": [
    {
      "id": "work",
      "provider": "custom",
      "model": "vendor/model",
      "baseUrl": "https://example.com/v1",
      "interfaceProvider": "openai-compatible",
      "apiKeyEnv": "WORK_API_KEY"
    }
  ]
}
```

`ModelEntry` 独立保存连接、用户覆盖、reasoning 偏好和能力证据。`apiKeyEnv` 引用凭证，不保存 key 明文或指纹。地址和协议完整即可配置无鉴权端点；引用了缺失 key 时不发起探测。`needsConfiguration` 标识尚未补全的旧条目。

| 字段 | 含义 |
| --- | --- |
| `contextWindowTokens?` | 用户 context 覆盖，省略表示自动 |
| `maxOutputTokens?` | 用户输出上限覆盖，省略使用产品默认 |
| `detectedContextWindowTokens?` | 最后一次可靠检测容量 |
| `detectedRouteKey?` | context 与自动 reasoning 共用的检测身份 |
| `reasoningCapabilities?` / `reasoningCapabilitySource?` | 能力证据及来源；有效能力另作协议过滤 |
| `reasoning?` / `temperature?` | 模型默认偏好 |

`detectedRouteKey` 使用 `modelProfileRouteKey`，由 provider、model、协议和规范化 base URL 组成，不包含 API key 或凭证派生值。路由改变清除两类自动证据；只换 key、apiKeyEnv 或 promptCache 时保留 context、重新探测 reasoning。读取时身份缺失或不匹配的自动证据无效，用户覆盖保留。

没有默认条目或默认 id 已失效时，第一个完整条目可成为默认。存在但不完整的默认条目不会被其他新条目替代。修改默认不会改写条目的 reasoning 偏好。

## 投影与运行配置

`projectModelDocument(document, entryId?)` 生成供 LLM 包消费的完整 `ModelJsonConfig`；其中的 `provider`、`defaultModel`、`apiConfig` 和 `llmParams` 不再作为顶层存储格式写回。

| 有效值 | 解析顺序 |
| --- | --- |
| context | 用户覆盖 → 同路由检测值 → 300000 |
| 普通输出上限 | 用户覆盖 → 32768 |

默认常量统一定义在 `services/llm-model/modelProfiles.ts`。运行层 `maxTokens` 仍为必填数字，主、子代理共用解析后的 RunModel；effort 不改变普通输出上限。标题、摘要和 probe 的专用上限独立。300000 是本地预算兜底，不代表已知模型容量。

Settings 和 current-model 读取视图保留可选覆盖值、可选检测值，并必返 `effectiveContextWindowTokens`、`effectiveMaxOutputTokens`、`contextDiscovery`。context 状态为 `detecting | identified | unknown`，可带内存中的失败 `reason`。reasoning 复用能力视图，重新探测失败且有旧证据时保持 identified 并附 reason，不再使用 stale。

context 放不下输出与安全余量时，保存和读取仍成功，视图带 `tokenBudgetIssue: { code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE", contextWindowTokens, maxOutputTokens }`；仅该模型的新 run 被拒绝。`configurationComplete` 只描述连接完整性。

`LLMConfig` 包含解析后的实际 key，仅供运行使用。`loadModelEntryConfig` 按条目和项目环境读取；默认模型旧调用方仍可使用 `LLMConfigManager`。已删除的显式条目可回退默认；存在但不完整的条目报 `MODEL_CONFIG_INCOMPLETE`。

## 写入与迁移

Create 的数值省略表示无覆盖，正整数设置覆盖，null 无效。Patch 省略表示保持原值，正整数设置覆盖，null 删除覆盖；0、负数、小数、空字符串无效。connect 同样支持省略和 null，`maxOutputTokens`（包括 null）优先于旧 `maxTokens` 别名。任何路径都不把检测值或 fallback 写进覆盖字段。

只有缺少版本属性的文档在读取时执行一次性数字迁移：先展开旧顶层格式，再把旧 context 转入检测字段、为旧自动证据补充当前 routeKey，删除恰好为 8192 的旧输出值。混合格式残留的顶层 `llmParams.maxTokens` 不再补到条目。版本 2 中用户明确设置的 8192 保留；其他版本拒绝。读取不写盘，首次成功落盘前备份原文件到 `backups/model-json-<UTC 时间戳>/model.json`，并保存版本 2；后续不重复备份。降级须恢复备份。

Anthropic adaptive 的有效能力只发布正式请求可发送的 low/medium/high/xhigh/max。原始证据保留，只有 minimal 的证据投影为 unknown。无版本及版本 2 文档中实际会发送 minimal 的模型默认偏好在读取时清理，下一次正常保存或探测写回后持久化；新 Create/Patch 明确选择该无效偏好直接拒绝。明确的 minimal→low 映射、budget/binary 配置及不发送该 effort 的偏好不误清理。

清理产生 `reasoningNotice: "unsupported-anthropic-effort-cleared"`，Settings/current-model 均可读取；它仅在当前进程按模型保留，不写磁盘，后续 probe 不清除。用户下一次成功保存明确 reasoning 选择后清除。不会修改历史消息、在途 run 或批量重写会话偏好。
