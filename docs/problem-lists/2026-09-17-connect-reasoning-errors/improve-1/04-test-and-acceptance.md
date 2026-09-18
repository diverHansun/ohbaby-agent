# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。本议题沿用现有 vitest 分层：`*.unit.test.ts` 测纯逻辑，`*.contract.test.ts` / `App.unit.test.tsx` 测 UI 合同。真实 HTTP 不放进每次本地单测，但发布前必须跑应用内完整请求，尤其是此前 500 的 Claude。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| 单测 | 温度清除/不继承、目标 profile 的档位复用、请求 body 无温度键、`normalizeRunError` 有限暴露、URL warning 纯函数、档位视图文案选择 | 付费全量 agent 跑完 |
| 组件/契约 | Web ReasoningControl 与 prompt 失败投影；TUI `/effort` loading；Connect 表单显示 warning | 视觉回归截图 |
| 集成 | Connect 保存写盘后 json 无 temperature、同路由及 A→B→A 的 profile 仍有 reasoningCapabilities | 真网关 |
| 发布前真实请求 | 用真实 key 经应用内 agent loop 发送；核对请求、工具、保存结果与错误展示 | 不纳入每次本地 vitest，但挡发布 |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
|----|------|------|--------|----------------|
| T1 | Connect 保存，existing json 有 `temperature: 0.7` | 单测 writer / apply | 写回的 `llmParams` **没有** `temperature` 键 | 1 |
| T1b | 仅 reload，json 仍含 `0.7`、未走 Connect | 单测 manager | `LLMConfig` **没有** `temperature` | 1 |
| T2 | Connect 保存未传温度、existing 也无 | 单测 | 不新写入温度 | 1 |
| T3 | 同 provider+model+baseUrl+protocol 再保存 | 单测 apply/writer | `reasoningCapabilities` 仍在；**不**走 `clearDiscoveredReasoning` | 1 |
| T3b | A→B→A，A 曾有已确认的精确 profile | 单测 apply/writer | 切回 A 仍保留 A 的 capabilities；B 的 profile 也在 | 1 |
| T4 | 切到从未保存能力的 protocol、baseUrl 或 model | 单测 | 新目标没有可复用能力，随后 discovery 可重跑；旧 route profile 不被删 | 1 |
| T5 | 产品缺省 `config.temperature === undefined` 编译 Chat / Responses / Anthropic | 单测 provider | JSON body **不含** `temperature` | 1 |
| T6 | 直接构造 `request.temperature = 0.7` 走 Chat provider | 单测 | body 仍可含该字段（协议层允许；**不是**从 model.json 加载） | 1 |
| T7 | ZenMux builtin `temperature: "unsupported"` 且直接构造的 client 请求仍带温度 | 单测 resolver | 仍 throw（协议层防护；产品从 json 加载时已忽略旧温度） | 1 |
| T8 | Web `status=detecting` | App.unit | 有大脑/转圈语义，**无**「推理默认」「检测中」文案 | 2 |
| T9 | Web `status=unknown` | App.unit | 按钮或同等控件上为 `unknown`，无中文档位字 | 2 |
| T10 | Web `identified` + `supportsDisabled=false` + effort | App.unit | 仍有档位 `<select>`，无 Off，不是 “Reasoning on” 纯文字 | 2 |
| T11 | `/effort` 在 detecting | TUI 契约/面板单测 | loading，不是 “No verified reasoning levels”，列表无假档 | 2 |
| T12 | `/effort` 在 unknown | 同上 | 英文 unknown；不能选出未验证档位 | 2 |
| T13 | `connectUrlPathWarning(https://zenmux.ai/api/v1, anthropic, anthropic/claude-sonnet-5)` | sdk 单测 | 有精确、非阻断的 `/api/anthropic` 建议；完整 Claude Web 请求在 `/api/v1` 连续 500，改地址后成功 | 3 |
| T14 | 同地址的 Chat/Responses 或其它 Anthropic 模型 | sdk 单测 | **无**专用 warning | 3 |
| T15 | URL 已以该 client 会自行追加的 `/chat/completions`、`/responses` 或 `/messages` 结尾 | sdk 单测 | 有资源路径重复提醒；其它路径不因包含关键词就误报 | 3 |
| T16 | Web/TUI Connect 改成 T15 的 URL | 组件测 | 保存前能看到同一句提醒；仍可保存 | 3 |
| T17 | `normalizeRunError` mock 400 body `temperature is deprecated` + `Authorization: Bearer sk-secret`；未知密钥前缀 | 单测 | message 含 HTTP 400 与固定 deprecated 句；**不含** Bearer/sk-secret/未知密钥；原始正文不持久化 | 4 |
| T18 | 401 / 402 / 403 | 单测 | 含对应 HTTP 码；402 不是那句空 generic | 4 |
| T19 | Web：snapshot 里 userMessage 已在会话 + prompt.status=failed + prompt.error | App.unit | 用户能看到 `prompt.error.message`（横幅或失败行） | 4 |
| T20 | TUI：runtime idle + 最近 prompt 失败 | 契约/选择器 | 状态或对话区能看到同一 message，不是只有 `idle` | 4 |
| T21 | DeepSeek `deepseek/deepseek-v4.1-flash` 已保存六档探测结果 | 单测 reasoning/profile | 不被 v4 Flash 两档 builtin 覆盖；切回该 profile 后仍是六档 | 1 |
| T22 | Web/TUI 已显示失败，随后刷新会话，再发送并成功 | 组件/集成 | 刷新后当前失败仍可见；新请求开始后旧错误不占位，成功后也不重现 | 4 |
| T23 | Claude 完整 agent 请求含工具，分别试有工具和无工具路径 | 发布前真实 E2E | 记录实际 protocol/baseUrl、脱敏后的请求形状、HTTP 状态、重试次数、工具结果和最终可见回复；此前 500 要查明或确认不再复现 | 发布门 |

## 4.3 集成边界

- **写盘：** `setActiveLLMConfig` 是温度键删除与 profile 保留的权威点；apply 只负责何时 clear。
- **请求：** `streaming.ts` 不传 → 三个 provider 都不写键。不要只改其中一个 provider。
- **发现：** v4.1 Flash 沿用精确 profile/probe，不抄 v4 Flash builtin 档位。已确认能力应随目标 profile 保存与恢复。
- **错误：** `errorData` → `prompt.error` 已由 `prompt-mapper` 连接；Stage 4 不要再复制一份 message 到 Web 本地 state。
- **URL 提醒：** 只从 sdk 纯函数取句；禁止 Web 写一句、TUI 写另一句。

## 4.4 回归清单

- Connect 保存成功、`getCurrentModel()` 仍返回当前 provider/model/url/protocol/reasoning 视图。
- `mode === "none"` 且 identified 的模型仍然**没有**大脑按钮。
- Gemini 首次 probe 仍可能用满现有 30 秒；本轮只改善等待期间的展示和已有能力的复用，不把“更快完成探测”写成验收结果。
- 能关思考的模型，`/effort` 与 Web 仍有 Off。
- 401 映射不要重新把 raw `Authorization` 头放进 UI。
- 429/5xx 稳定句可保留，不必摊 body。
- 标题生成、agent 配置温度本轮不改路径；缺省 client 无温度后标题请求也不带该字段——若现有单测硬编码 title `temperature: 0.8`，只改「未注入时不出现」，不要删掉显式注入用例。
- Writer 对其它字段（maxTokens、reasoning、contextWindow）的 merge 行为保持。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 自动化 | T1、T1b、T2–T22 对应测试全绿 | 改动包内 vitest；至少包括 writer、manager、apply-active-model-config、error-detail、connect-model、App.unit、effort-panel/connect-panel |
| 温度 | 产品 Connect 路径请求 body 无 `temperature` | T5；发布前用 Luna Responses 真实应用请求核对 |
| 档位 UX | 无「推理默认」；unknown 英文；检测中转圈/loading | T8–T12 |
| 档位缓存 | 同路由重存与 A→B→A 保留可信 capabilities | T3、T3b、T21 |
| URL | 提醒资源路径重复风险；ZenMux + Anthropic + `/api/v1` + Claude Sonnet 5 精确给专用地址建议，Chat/Responses 和其它 Anthropic 模型不误报 | T13–T16 |
| 错误 | 400/402 可见已识别的安全原因固定句；未知原始正文不显示；Web 与 TUI 同源字段，刷新与下一轮状态正确 | T17–T20、T22 |
| Claude 500 | 完整应用请求有可见回复及正确工具结果；若再现 500，先定位实际请求与重试路径再决定发布 | T23，记录模型、协议、地址、状态、耗时和脱敏日志 |
| 范围 | 无温度 UI、无 URL 改写、无 probe 超时改动 | diff 审查 |

### 发布前真实验证（不在每次本地 vitest 中运行，但必须完成）

- 用 `tests/models-4-tests.md` 的真实 key 和模型，经产品 Connect 与 agent loop 跑 Luna Responses、Claude Anthropic；另以 ZenMux `google/gemini-3.8-flash` 跑 Gemini Chat 的连接、探测、选档和对话。最小 HTTP 200 只能证明接口可调用，不能替代应用内请求。
- Claude 带工具的完整请求按 T23 复测。若再次 500，把脱敏后的实际请求形状与最小成功请求逐项比较；不能把它归为温度 400，或因为错误横幅可见就算故障修复。
- ZenMux `/api/v1` + Anthropic Claude Sonnet 5 出现精确、非阻断的专用地址提醒；`/api/anthropic` 完整 Web 对话必须成功。Chat/Responses 和其它 Anthropic 模型使用 `/api/v1` 不出现此提醒。
- 旧 `~/.ohbaby/model.json` 含 0.7：不重存时请求也不带温度；重存一次后键消失。Luna Responses 不再因旧值在本地被拦下，也不会因该值收到上游 400。

## 4.6 对抗性审查要点

1. **最可能失败的集成点：** Stage 4 只改 `normalizeRunError` 却忘了 Web L276 仍丢弃 failed prompt → 横幅依旧空。T19 必须红。
2. **文档说做了、其实没测：** 「未重存的旧 0.7 也不上线」若只测 writer 删除、manager 仍拷贝，用户不打开 Connect 就可能继续失败。必须有：json 仍含 0.7 时 `LLMConfig` 无 temperature（T1b），以及 T5 body 无键。
3. **发布门：** Claude 完整请求曾经返回 500。若实施后仍失败且原因不明，不能仅凭自动化全绿发布。
4. **竞态：** 同路由保存时 discovery 仍在跑。DoD 是「不要因为这次保存把已写入的 capabilities 清掉」。若 version 变了，现有 `startModelDiscovery` 已 abort；不要为了保留档位而禁止合法的换模型 discovery。
5. **误报：** ZenMux `/api/v1` 不能一概判错。T13 只覆盖 Anthropic Claude Sonnet 5 专用地址建议，T14 验证 Chat/Responses 与其它 Anthropic 模型无提醒。
6. **密钥：** 400 body 若把用户 API key 回显，sanitize 失败会进横幅。T17 用含 `sk-` 的 fixture。

## 4.7 Stage → 验收映射

| Stage | DoD | 用例 |
|-------|-----|------|
| 1 温度 + 目标 profile 缓存 | 02 §2.3 Stage 1 | T1, T1b, T2–T7, T3b, T21 |
| 2 档位 UX | 02 §2.3 Stage 2 | T8–T12 |
| 3 URL 提醒 | 02 §2.3 Stage 3 | T13–T16 |
| 4 run 错误 | 02 §2.3 Stage 4 | T17–T20, T22 |
| 发布前完整请求 | 04 §4.5 | T23 |
