# 实施契约 · 让目录声明的档位走通真实请求

## 一个来源，一条发送链

在现有精确匹配的 `/v1/models` 条目上补两种字段。模型目录负责说明这条路由公开哪些档位；用户所选协议负责决定把档位写进哪个 JSON 字段。判定来自数据，适用于任意域名、provider 或模型 ID。

1. 保留手动/内置来源优先级。目录内依次检查 `reasoningCapabilities`、`reasoning_capabilities`，首个通过现有校验的完整对象获胜。均未通过时独立检查显式 `reasoning: false`。其余情况尝试简写。有效的完整对象继续决定自身的 wire、开关、自定义映射和顺序。
2. 先读 `reasoning_levels` 中的字符串；没有可用正向档位时，再读 `supported_reasoning_levels` 中对象的 `effort` 字符串。两种表示只需一个读取优先级。字段选择在按协议过滤之前完成。首字段如为 [] 或全由畸形项、关闭哨兵组成，可使用第二字段。若首字段为 ["minimal"] 而第二字段为 high，选中 minimal 后 Anthropic 按现有约束进入原兜底，不改选另一字段。跳过畸形项，去除首尾空白和重复项，按现有校验规则忽略大小写识别 none/off/disabled 哨兵（含 OFF），区分大小写并原样保留名称（例如 HIGH 不会改写成 high），保留目录顺序，包括 `ultra` 和今后出现的供应商档位。不从 `reasoning: true`、`supported_parameters` 或模型名猜档位。
3. 用现有 `ReasoningCapabilities` 表达结果（`mode=effort`，来源 `model-metadata`）。用现有 `effortOrder` 表达目录提供的展示顺序，避免标准排序丢掉扩展值。沿用用户已选且兼容的偏好及现有默认规则：优先 medium，否则按有效顺序；不另外声明网关提供了默认档。保留现有正向档位校验；`none/off/disabled` 与强度分开。本轮简写只授予正向强度。新路由的 `supportsDisabled=false`；同一路由、同一 wire 先前已有肯定的 Off 证据时，简写刷新只更新档位，保留已确认的 Off 和仍兼容的显式偏好。完整对象明确给出新结论时依原规则替换。仅含关闭哨兵的数组交给现有兜底。理由是统一模型列表不说明各入口是否支持独立的禁用操作，尤其是 Anthropic 的 `thinking.type=disabled`。
4. 目录缺字段或过滤后没有适用于当前入口的正向档位时，回到原调度器。沿用缓存、Detect again、鉴权/限流、取消、过期写回和旧值保留规则。精确路由有足够目录证据时，保存和手动重测都不发生成探针。复用相同 GET 取得的上下文。
5. 正式请求继续在 `resolveRequestReasoning` 中校验选档属于有效能力，再由现有 serializer 原样发送。取消 Responses 固定枚举对已获准扩展名的二次否决；统一检查 Anthropic 有效能力投影和最终发送器的同类限制。Anthropic 已有明确业务约束（adaptive 的 minimal 与旧偏好迁移，含显式 minimal→low 映射）继续遵守。扩展档位应沿该协议既有字段传输，`ultra` 无须单设分支。已有配置中的 `effortMap` 仍属显式用户选择。目录声明支持、但端点拒绝的值，沿用现有错误报告；不能静默重发为 max。

## 三种协议在哪儿写值

| ohbaby 协议 | Base URL（本机验收） | 发现与实际发送 |
| --- | --- | --- |
| `openai-compatible` | `http://127.0.0.1:3425/v1` | Bearer 读取 `/v1/models`；wire 为 `openai`，在 `/v1/chat/completions` 发送顶层 `reasoning_effort` |
| `openai-responses` | `http://127.0.0.1:3425/v1` | 同一目录和 wire；在 `/v1/responses` 发送 `reasoning.effort`，沿用既有 include、tools、stream |
| `anthropic` | `http://127.0.0.1:3425` | 以 x-api-key 和 anthropic-version 读取 `/v1/models`；wire 为 `anthropic-adaptive`，在 `/v1/messages` 发送 `thinking.type=adaptive` 与 `output_config.effort` |

本机 OpenAI SDK 的静态枚举到 max 为止。把扩展字符串与 SDK 类型的兼容处理限制在发送器的 effort 字段，保留对消息、工具、请求其他字段及响应的现有类型检查。选档未经能力校验的输入，在产品入口继续拒绝或沿用 unknown 时的 service-default。固定候选列表属于主动探针的有限枚举职责，无需让它猜测任意扩展名。

## 工程边界与回退

发现逻辑收在 `config/llm/context-window-probe.ts` 已有条目解析处；能力可用性、历史偏好处理和协议序列化留在 `ohbaby-llm`。先验证现有设置页、会话菜单可消费带 `effortOrder` 的能力。预期不需要新注册表、插件接口、额外网络探针、存储迁移或 Thinking 展示改动。源码对齐后同步模块的架构和测试说明。

审核后建本地临时分支实施。旧配置通过 Detect again 获取目录结果。已有配置结构能存储字符串及顺序；代码回退后旧发送器仍可能拒绝已保存的扩展档位。需要回退的测试环境恢复之前的配置快照，日常环境选择旧版本支持的档位，不批量重写用户模型。按 [04](04-test-and-acceptance.md) 验收。
