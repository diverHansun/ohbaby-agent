# LLM 配置模块数据模型

## 磁盘模型库：ModelDocument

`~/.ohbaby/model.json` 只保存 `activeProfileId` 和 `models`。`OHBABY_HOME` 可覆盖配置目录。`activeProfileId` 是全局默认条目的 id；会话保存自己的 `modelEntryId`，未保存时每轮跟随当时的默认。

```json
{
  "activeProfileId": "work",
  "models": [
    {
      "id": "work",
      "provider": "custom",
      "model": "vendor/model",
      "baseUrl": "https://example.com/v1",
      "interfaceProvider": "openai-compatible",
      "apiKeyEnv": "WORK_API_KEY",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 8192,
      "reasoning": { "effort": "high" }
    }
  ]
}
```

每条 `ModelEntry` 独立保存连接信息、上下文窗口、输出上限、默认 reasoning、可选温度和能力检测结果。`apiKeyEnv` 引用环境变量，文件中不保存 key 的明文。地址和协议完整即可使用，key 可以为空。`needsConfiguration` 标识尚未补全的旧条目。

没有默认条目或默认 id 已失效时，创建或补全的第一个完整条目自动成为默认。仍存在但不完整的默认条目不会被其他新条目替代。修改默认只改变 `activeProfileId`，不会修改任何条目的 reasoning。

## 投影与运行配置

`projectModelDocument(document, entryId?)` 把一个条目投影成 LLM 包接收的 `ModelJsonConfig`。省略 id 时投影全局默认。它仍包含 `provider`、`defaultModel`、`apiConfig` 和 `llmParams`，但这些字段只用于传递，不再写入磁盘。

| 条目字段 | 投影字段 |
| --- | --- |
| `maxOutputTokens` | `llmParams.maxTokens`，省略时为 8192 |
| `contextWindowTokens` | `llmParams.contextWindowTokens` |
| `reasoning` | `llmParams.reasoning` |
| `temperature` | `llmParams.temperature` |

`LLMConfig` 是解析 key 后的最终客户端配置，包含实际 `apiKey`。`loadModelEntryConfig(options, entryId?)` 每次读取指定条目和项目环境，不使用默认模型的单槽缓存。`LLMConfigManager` 保留给默认模型的旧调用方。

`resolveModelEntry` 优先取显式条目；条目已删除时返回默认，并携带 `removedEntryId`。存在但不完整时报 `MODEL_CONFIG_INCOMPLETE`，没有可用默认时报配置错误。显式条目有效时不要求存在默认。

## 写入与迁移

Settings 创建、修改、选择和删除条目，以及 `/connect`，都经配置协调锁发布；模型文件采用原子替换。创建和修改可写默认 reasoning，修改时 `null` 清除。能力已识别时校验档位和输出上限，能力未知时保留偏好。重新检测或修改连接后，只清理目标条目不兼容的 reasoning。

读取旧文件仅在内存中迁移：

- 条目没有 `maxOutputTokens` 时继承旧 `llmParams.maxTokens`，已有值保留。
- 旧温度和 reasoning 只迁到原默认条目；已知不兼容的 reasoning 丢弃。
- 只有顶层连接字段的最老格式仍会转成一个默认条目。
- 首次写入新格式前，原始文件备份到配置目录的 `backups/model-json-<UTC 时间戳>/model.json`；后续新格式写入不重复备份。

新格式不能被旧版本直接读取。降级时须恢复备份的 `model.json`。提交记录和会话字段的兼容规则见[会话级模型方案](../../problem-lists/2026-10-25-session-model/improve-1/02-optimization-plan-and-change-scope.md)。
