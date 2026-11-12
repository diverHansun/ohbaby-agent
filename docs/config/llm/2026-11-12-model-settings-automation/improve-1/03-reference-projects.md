# dsh、kimi-code、ZCode 对照

调研日期：2026-11-12。仅阅读本地源码，没有修改参考项目、运行其测试或调用其模型服务。下面的数值是各项目在指定提交中的行为，不是 ohbaby 将要采用的默认值。

## 1. 来源与版本

| 项目 | 本地路径 | 提交 |
| --- | --- | --- |
| dsh / DeepSeek Harness | `/Users/hansun025/Projects/code-cli/deepseek-harness` | `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` |
| kimi-code | `/Users/hansun025/Projects/code-cli/kimi-code` | `bb5284cf42b0ddcbb670a3b0d41c3ea1c6445a30` |
| ZCode | `/Users/hansun025/Projects/code-cli/ZCode` | `b95ebaffeab641907b38652f45c1502bd762972d` |

本节代码路径分别相对上表项目根目录。各项目调查由子代理完成，主代理复读了输出参数解析、目录缓存和覆盖合并的关键代码。

## 2. 三项问题对照

| 项目 | Max output | Context window | Reasoning / 保存 |
| --- | --- | --- | --- |
| dsh 原生 DeepSeek | 默认 256000，独立于 effort；始终发送上限 | 未知 fallback 1000000；内置、列表 metadata、用户覆盖 | 静态声明 off/low/high/max；未发现 Save 后逐档请求验证 |
| dsh pi-ai | 128000 是能力 fallback；不自动成为请求 cap | 显式配置、已安装目录、列表 metadata、fallback | 目录或用户声明；不能据上层未传 cap 推断下层 HTTP 不补值 |
| kimi-code | 普通 Chat/Responses 可省略；Anthropic 按模型表或 64000 fallback；Kimi 协议可按剩余 context 计算 | 目录与用户覆盖；手动 provider API 要求 context，不能视为未知可留空的同款实现 | 目录字段、内置规则与后台刷新；运行中的 Save 没有通用逐档 POST 验证 |
| ZCode | 普通运行 fallback 32000，但有模型配置时用模型值；bundled 通用规则输出 max 为 128000 | 压缩 fallback 200000，bundled 通用规则 1000000；不是实测容量 | 基于配置规则解析推荐值，Save 等待解析并刷新 registry；不是供应商能力探测 |

三者没有一个可以直接照搬成 ohbaby 的“32768 + 300000 + Save 自动完整 effort 探测”。可借鉴的是配置意图、缓存、覆盖和异步状态处理。

## 3. dsh 的证据与取舍

- `packages/llm/llm-deepseek/src/defaults.ts:6`：原生 context/output 默认；`serialize.ts:147` 之后把 effort 与输出分别解析，max_tokens 取请求值、模型值、连接值。
- `packages/llm/llm-pi-ai/src/config.ts:147`、`adapter.ts:371`：明确区分能力 fallback 与请求上限；`adapter.ts:463` 仅在请求存在 maxTokens 时向下层库传入。
- `packages/llm/llm-deepseek/src/listed-catalog.ts:107`：用户覆盖应用在目录数据之后。
- `packages/llm/llm-deepseek/src/listing-cache.ts:74`：首次访问等待加载，之后缓存与后台刷新，失败保留最后成功目录；作用域包含凭证身份。
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx:268`：Save/Apply 校验并保存配置、凭证，没有完整 effort probe。

采用：默认值与能力含义分开；失败保留最后成功结果；显式覆盖优先。适配：ohbaby 使用 Save 后触发，沿用新触发取消旧任务的调度方式，不另做同身份请求去重，也不引入它的十分钟周期刷新。不采用：256000/1000000 数值、任意兼容端点套用 DeepSeek 静态档位、用 1M placeholder 暗示未知模型容量。

## 4. kimi-code 的证据与取舍

- `packages/agent-core-v2/src/llm-adapter/model/completion-budget.ts:7`：请求 cap 优先于模型 maxOutputSize；都不存在时可省略。
- `packages/agent-core-v2/src/human/llm/protocol/pipeline.ts:87`：仅对数字设置输出字段。
- `packages/agent-core-v2/src/human/llm/builtin/protocol/anthropic/legalize.ts:163`：Anthropic 64000 fallback；`lower.ts:376` 最终补 max_tokens。
- `packages/oauth/src/model-alias-merge.ts:54`：目录刷新保留独立 overrides；`packages/agent-core-v2/src/llm-adapter/model/model-auth.ts:78` 以覆盖合成 effective 配置。
- `packages/kap-server/src/protocol/rest-modelCatalog.ts:34`：手动添加 provider 时 max_context_size 必填。
- `packages/kap-server/src/routes/modelCatalog.ts:277`、`:429`：创建和替换保存提交的 metadata；不执行逐 effort 探测。
- `packages/agent-core-v2/src/llm-adapter/model/catalog-runtime.ts:243` 使用 upsertEntry，而 `human/provider-catalog/catalog.ts:779` 的该方法只更新配置。不能把相邻 upsert 自动 refresh 的能力误写成运行流程。

采用：用户覆盖与自动数据独立，刷新不丢用户意图。适配：使用 ohbaby 已有模型条目与两个可选覆盖字段，不搬完整 provider catalog。拒绝：context 必填、多个协议各设一套输出默认、引入 models.dev 目录作为本轮依赖。

## 5. ZCode 的证据与取舍

- `apps/zcode-cli/packages/core/src/runtime/methods/model-token-limits.ts:5`：普通请求 fallback 为 32000，resolver 不接收 effort。`:17` 之后按剩余上下文缩小请求上限。
- `apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts:178`：使用 model.optionSpecs.maxOutputTokens.max；不是所有模型统一使用 32000。
- `config/provider/zcode-builtin.json:1272`：通用规则 context 1000000、输出 max 128000，具体规则继续覆盖。这不是 probe 结果。
- `packages/ui/src/settings/model-provider-section/ProviderModelMetadata.ts:201`：填写数字即覆盖，即使等于推荐值；清空才撤销。`:239` 说明其 max output UI 表达模型硬上限，与 ohbaby 的每次请求上限不同。
- `packages/ui/src/settings/model-provider-section/useModelConfigResolution.ts:47`、`:126`：generation、identity 检查以及 A→B→A 旧回包防护。
- `packages/provider/src/facades.ts:239`：从内置/个人规则解析配置；`:396`、`:455`：保存并刷新 registry。独立连通测试不是 Save 的自动 effort probe。

采用：清空表达撤销覆盖、数值相同仍可有不同用户意图、异步结果按 generation 验证。适配：保留 ohbaby 先保存后探测的非阻塞体验，不等待供应商请求才允许 Save。拒绝：把其模型硬上限字段直接搬成每请求偏好、默认最高 reasoning 档位、未验证的 1M 兜底。

## 6. 对 02 的具体影响

| 借鉴 | 方案位置 | 对用户的实际作用 |
| --- | --- | --- |
| 配置与能力分开 | §3、§4 | 前端空值不被后端 fallback 填满 |
| 独立覆盖、清空撤销 | §3、§4 | 手填不会被后续 probe 覆盖，能恢复自动 |
| 同身份最后成功缓存 | §5 | 一次临时失败不丢已识别能力 |
| generation + 路由身份 | §3.1、§5 | 改模型、换 key、A→B→A 时不接收旧结果；不持久化凭证指纹 |
| 默认输出不随 effort 变化 | §2 | 保留用户要求的简单固定规则 |

没有借鉴参考项目的默认数字，也没有把其静态规则/目录刷新说成主动请求探测。剩余 context 动态 cap 是可独立讨论的优化，本轮不增加。
