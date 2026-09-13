# 4. 测试与验收标准

> 2026-09-13用户修订：live供应商改为指定ZenMux路径，见§4.8。下文原T12“官方endpoint”的证据来源要求由§4.8替代；受限能力、失败必须停、真实工具往返与本地门禁不变。ZenMux通过不记为直连OpenAI官方通过。

项目级 `docs/test-blueprint.md` 不存在；本轮沿用 improve-1 的分层：契约 / 定向单测 / `pnpm preflight` / 官方真实 smoke。不对覆盖率数字负责，对准 01 的高风险项。

本轮只验收“不需要原生 reasoning/output-item 续接”的 Responses 文本与 function-tool 路径。reasoning item、非空 assistant `phase`、refusal、annotation、hosted/custom tool 以及当前请求投影无法无损表达的 Chat 消息形状，都必须在执行工具前 fail-closed。

## 4.1 测试范围

| 类型 | 覆盖 |
| --- | --- |
| 单测 | 新 adapter：请求投影与拒绝矩阵、Mapped 事件、合成 index、终态复验、abort、Rejected 失败、Ignored 可丢 |
| 契约 | Chat / Anthropic 现有 `prompt-cache-wire.contract` 语义不变；Responses 请求无 cache 控制字段 |
| 策略 | `resolvePromptCacheStrategy`：`openai-responses` 在 auto/enabled/disabled 均为 observe-only |
| 工厂 | 显式 kind 才创建 Responses provider；缺省 Chat；**禁止** fallthrough |
| 配置校验 | 接受 `"openai-responses"`；未知 kind 仍拒绝 |
| SDK/UI 边界 | current-model 可回显 Responses；connect/probe/URL 推断仍不产生 Responses 选择 |
| usage | Responses `input_tokens` 等归一化；不得用 Chat parser 误读 |
| observability | usage diagnostic 接受 `protocol: "openai-responses"`，logger 安全枚举与 redaction 不退化 |
| 全量门禁 | `pnpm preflight` |
| 真实 smoke | 有凭据且用户授权时，官方 endpoint 文本 + 无 continuation 要求的 function-tool 多轮 smoke；未执行则明确记录 live 未验证 |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
| --- | --- | --- | --- | --- |
| T1 | 缺省配置 | 单测/契约 | 仍走 `chat.completions.create`，语义 JSON 含既有 cache 规则 | 1 |
| T2 | 显式 kind | 单测 | factory 走 Responses 分支，**禁止** fallthrough 到 Chat | 1–2 |
| T2a | Stage 1 门闩 | 单测 | throw/stub 可；**零次** `chat.completions.create`；enabled+responses 为 observe-only | 1 |
| T3 | cache 与状态负向 | 单测 | 无 `prompt_cache_key` / retention / options；`store === false`；无 `previous_response_id` | 2 |
| T4 | system → instructions | 单测 | 所有 string system 依序以 `\n\n` 合并，并与 `tailDirectives` 进入 `instructions`，不进 `input` | 2 |
| T4a | 请求拒绝矩阵 | 表驱动单测 | developer、legacy function role、数组/多模态 content、assistant audio/refusal/legacy function_call、任意 `name`、`reasoning_content` 与任意未知 own-key 均明确失败；message/tool 嵌套对象执行 allowed-key 校验 | 2 |
| T-config-ui | 配置只读回显边界 | 类型+单测 | current-model 可回显 Responses；connect/probe 联合和 URL 推断仍只产生 Chat/Anthropic；无 cast、无新 UI 选项 | 1 |
| T5 | function 工具多轮 | 单测 | completed、同步、direct/null caller 且无 reasoning/phase 的两个并行 function_call，非连续 `output_index` → 本地 index 0,1；`call_id` 往返 | 2 |
| T-tools | tools 投影 | 单测 | 出站扁平 `{ type, name, parameters, strict: false }`，不是 Chat 嵌套 `function`；非 function tool 拒绝 | 2 |
| T6 | Mapped 文本/finish/usage | 单测 | text delta 只拼接一次；无工具时只发一次 `finishReason === "stop"`；有 function_call 时只发一次 `"tool_calls"`；夹具 `input_tokens=100, input_tokens_details.cached_tokens=40` → input total 100、uncached 60；校验 raw `total_tokens` 冲突诊断的 protocol | 2 |
| T7 | 不可续接输出 | adapter→llm-client→Lifecycle 集成 | 不支持事件位于 function delta 前或后都失败；`beforeToolCall` 与工具调度器均零次；assistant 标 error；无成功 `llm:complete` / turn end | 2 |
| T8 | 事件联合穷尽 | 类型+单测 | SDK 7.13 的 58 个事件 type 全部进入四类处理结果或 payload-gated handler；编译期 `never` 守卫；运行期未知事件失败 | 2 |
| T8a | output item 穷尽 | 类型+单测 | 最多一个 message 且恰好一个 output_text；`output_item.added` 的 message 必为 `in_progress` + `content=[]`，唯一 part 由唯一 `content_part.added` 建立，part done/item done/terminal 须对同一 part 有序相等；预填、缺失、重复或窗口外 part/delta 拒绝。message 若与 function 共存必须在其前，多 message/反序/交错拒绝；added/done/terminal 状态一致；只接受 null/undefined phase、无 annotation/非空 logprobs；function 要求非空 call_id/name 且只接受 completed 同步 direct/null caller、无 namespace；所有其他 item 失败 | 2 |
| T8b | 终态复验 | 单测 | completed / 可映射 incomplete 的 output 按 output_index 有序比较唯一 `(item_id,type)`，message 按 content_index 比较类型/全文，function 比较 call_id/name/arguments；缺、多、重排、重复、不一致均失败，不以终态补 delta | 2 |
| T8c | 错误与 incomplete | 单测 | `error` / `response.failed` 明确失败；message-only 的 `max_output_tokens` → length、`content_filter` → content_filter；任意 function call、缺失/未知 reason、`max_messages` / `steered` 均拒绝 | 2 |
| T8d | 状态机与验证后丢弃 | 表驱动单测 | response id 非空且流内稳定；每个 output/item id 唯一且恰好 added→done；delta 只在其间；call_id 绑定不变；恰好一个末尾 terminal；done 与累积一致则丢弃，乱序/重复/terminal 后事件均失败 | 2 |
| T8e | usage 异常与分派 | 单测 | Responses kind 只调用 Responses parser；read=40/write=10 → uncached=50 且 observed 正确；无 details → 无 breakdown；非法/超额 breakdown 报 conflict、保留可信总量并省略 breakdown；raw total 冲突只诊断且归一化 total 不变；不得调用 Anthropic accumulator | 2 |
| T8f | usage diagnostic 闭集 | 单测 | events schema 与 logger 允许 `openai-responses` protocol，仍拒绝未登记枚举且不放宽敏感字段 | 2 |
| T8g | 通用 usage 链回归 | 只读集成门 | Responses usage 经现有 lifecycle 聚合、message metadata、session cache-hit tracker 后 inclusive input 与 breakdown 不双算；多步缺 breakdown 时 `usageComplete` 语义不变。不得为通过本用例修改这些下游模块；若发现 Responses 专属口径缺口，记录并留后续轮 | 2–3 |
| T9 | abort | 单测+集成 | `isAbortError` 为真，不进入普通重试；收到 function-call 片段后 abort 仍为 cancelled，工具零执行 | 2 |
| T10 | Chat/Anthropic 回归 | 契约+定向 | improve-1 覆盖的 8 个定向文件行为不变 | 3 |
| T11 | preflight | 门禁 | format/lint/typecheck/test/build 全过 | 3 |
| T12 | 官方 smoke | 手工/条件测试 | 官方 endpoint 的文本与无 continuation 要求的 function-tool 多轮跑通；记录模型、时间、请求能力与结果 | 3 |

## 4.3 集成边界

- config → factory → adapter → llm-client 累积 → lifecycle 工具循环：本轮只在 adapter 与 kind 配置处插入，累积器输入形状不变。
- 外部：官方 OpenAI Responses 是 live 可用性的证据来源；中转站不作为本轮必过（默认仍 Chat）。
- 不得依赖真实网络才能证明分类表与 cache 守卫。
- 若因凭据或授权未执行 T12，`05-implementation-acceptance.md` 必须写明“本地实现门通过、live 未验证”；该状态不能声称显式 Responses 已真实可用，也不能合并到 `openai-responses-migration`。

## 4.4 回归清单

- `openai-compatible` 的 `prompt_cache_key` / `include_usage` 契约
- Anthropic cache_control 位置与 usage fixture
- lifecycle 步数、终止、工具顺序
- context 压缩与 cache key 算法（Chat 路径）
- Responses 路径的 context heuristic 不崩溃，但本轮不声称是实际 Responses wire occupancy/composition
- SQLite 无新 migration
- UI/onboarding 不出现协议开关

## 4.5 验收标准

### A. 本地实现门

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 默认兼容 | 未写 kind 的用户路径与 improve-1 后行为一致 | T1、T10、T11 |
| 显式本地可用 | 测试配置 `interfaceProvider: "openai-responses"` 能完成受限 Mapped 主路径 | T2、T4、T4a、T-config-ui、T5、T-tools、T6、T9 |
| 认识完整 | 已知事件与 output item 均穷尽；终态复验；未知/不支持能力不静默成功 | T7、T8、T8a、T8b、T8c、T8d |
| usage/诊断 | parser 按 kind 分派；异常 breakdown、protocol 闭集与下游聚合有证据 | T6、T8e、T8f、T8g |
| cache 未提前对齐 | Responses 不发 cache 控制；也不误用 Anthropic 控制；不 fallthrough Chat | T2a、T3 |
| 文档 | 不声称默认 Responses、不声称已 canonical、不声称 cache 已与 Chat 对齐 | 审 `docs/core/llm-client/` 与本目录 |
| 回滚点 | 无 schema 变更 | git diff 无 SQLite migration |

### B. 合入 `openai-responses-migration` 门

| 项 | 标准 | 如何验证 |
| --- | --- | --- |
| 本地实现 | A 表全部通过，05 有命令、结果与差异证据 | T1–T11 + 05 |
| live 证据 | 官方 endpoint 的受限文本与 function-tool 主路径已验证 | T12 + 05 证据表 |
| 分支门禁 | A、T12 与子代理代码审查均通过后，才可从临时分支合入本地集成分支 | 核对分支、05、测试与审查记录 |

`pnpm build` 必须含强制 tsc；不得用增量 typecheck 代替（improve-1 已踩过）。

## 4.6 对抗性审查要点

1. **enabled 掉进 Anthropic cache / factory 打到 Chat**：防御 = T2a + T3；残余 = 其他未来 kind 仍要显式开口。
2. **hosted tool 当文本**：防御 = Rejected；残余 = SDK 新增 item 需更新分类表。
3. **call_id / index 错位导致工具结果对不上**：防御 = T5 固定夹具；残余 = 并行 tool 顺序与 output_index 不一致时要在测试里钉死规则。
4. **usage 嗅探撞 Anthropic**：防御 = kind 分支 parser；残余 = 网关把 Chat usage 塞进 Responses 响应时只观测、不猜协议。
5. **temperature 400**：防御 = T12 + 02 风险；残余 = 本轮无模型表，失败则停并回审，不擅自省略字段。
6. **reasoning/phase 被压扁后继续**：防御 = T7 + T8a + T8b；残余 = 后续必须设计 provider-continuation/canonical 表达后才能开放推理模型工具多轮。
7. **只看增量、漏看终态**：防御 = T8b；残余 = SDK 新增 output item 时由 `never` 守卫和 fixture 同时暴露。

## 4.7 分支与整体验收门禁

```text
main
└── openai-responses-migration        # 本地长期集成分支
    └── codex/improve-2-responses-migration  # 本轮临时实施分支
```

- 本轮文档、实现和验证只落在 `codex/improve-2-responses-migration`。
- improve-2 通过本文件门禁并完成 05 后，才合并到 `openai-responses-migration`；不直接合并 `main`。
- 后续每一波从 `openai-responses-migration` 新建独立临时分支，完成该波验收后再回合到集成分支。
- 只有 Responses 后端兼容、token estimation/counting、cache 命中统计、context 占用统计与 lifecycle 全部通过各自验收，集成分支才具备合并 `main` 的资格。

## 4.8 用户指定ZenMux的live门修订（2026-09-13）

用户授权使用仓库根.env中的ZENMUX_API_KEY，最初指定openai/gpt-5.6-luna和deepseek/deepseek-v4.1-flash走Responses；两者预检失败后，用户明确批准另选ZenMux模型，先预检再调整矩阵。x-ai/grok-4.2-fast-non-reasoning已通过文本及llm-client工具往返预检，现替代原两条Responses必过行；完整lifecycle验收尚未执行。DeepSeek Chat及qwen/qwen3.8-flash的Anthropic路径仍用于兼容回归和improve-3完整矩阵。端点与详细用例见[improve-3/04 §4.6](../improve-3/04-test-and-acceptance.md#46-zenmux真实请求矩阵2026-09-13用户指定)，预检证据见05 §5.11。

T12现验收Grok这条Responses路径的普通文本和无原生续接需求的function-tool往返，仍须经过生产LLM/lifecycle链；不得将认证成功、Chat通过或adapter/llm-client预检代替完整T12。失败结果保留，模型/协议不静默替换。这是受限Responses协议的证据，不是原两款模型或OpenAI原生模型的兼容性证明。通过最新本地门、T12及独立审查后才合入既有openai-responses-migration；不是新建拼写相近的另一条集成分支。

如果指定模型不接受当前必传temperature，或返回reasoning/phase等受限输出，T12仍失败；需要用户批准兼容修正或调整模型/阶段，不能通过测试时过滤输出、删请求参数、改用Chat来关闭此门。官方直连接口未验证作为残余记录，不冒充本次证据。
