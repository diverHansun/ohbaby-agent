# 2. 优化方案与改动面

> 交给后续开发会话的执行契约。本规划会话不按本文写代码。
> 行号快照见 §2.9，定位以符号为准。

---

## 2.1 方案总览

四条纵切，同一轮 `improve-1`：先让产品请求不再继承旧温度，再修档位按钮与缓存，接着提醒确定的 URL 路径错误，最后让同一份 `UiPromptError` 出现在 Web 与 TUI。Claude 完整运行的 500 暂无根因，须单独复测，不能把温度修复当作它已解决的证明。

```text
Connect 保存 ──清 temperature──► model.json 无该键
       │
       └──目标 route key 已有可信 profile──► 保留 models[].reasoningCapabilities
加载 json ──忽略 temperature 键──► LLMConfig 无该字段
请求编译 ──缺省不传──► provider body 无 temperature 字段
档位 UI ──detecting 转圈 / unknown 英文──► 关不了思考仍保留 select
错误   ──normalizeRunError 有限暴露──► prompt.error.message ──► Web 横幅 + TUI 状态
URL    ──确定的资源路径重复风险──► 保存前显示 warning；不改写、不拦截
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 温度产品默认 | 不写、不继承、不传 | 最小上游请求不传温度全 200；Claude/Luna 上游传 0.7 返回 400，Luna 产品路径还会先被本地校验拦下 | Chat 保留 0.7；思考时改传 1 | 采样完全走服务端默认 |
| 旧 json 的 0.7 | Connect 保存删除键；manager **不把**该键拷进 `LLMConfig` | 用户不一定马上重存 Connect | 只删键、加载仍拷贝 → 未重存继续 400 | 本轮手改 json 加回温度也不会发出；以后做温度框再从 Connect 写入 |
| 档位未知文案 | 按钮英文 `unknown` | 00 统一英文档位字 | 中文「推理默认」 | Web 旧单测要改 |
| 检测中 | 大脑转圈、无文字；`/effort` loading | 转圈 = 档位未确认 | 假档位、空列表 | `/effort` 检测中不能选档 |
| 关不了思考 | 保留强度 `<select>` / 列表，无 Off | 00：按钮不要消失 | 整颗隐藏；改成 “Reasoning on” 纯文字 | binary 无档位时控件只有 On |
| 已有档位复用 | 目标 route key 已有可信 profile 就保留，包括 A→B→A | 切回 A 不该丢掉 A 的已确认档位 | 只和当前 active route 比较 | 目标没有匹配 profile 时仍需探测 |
| URL 提醒 | 对资源路径重复风险及完整请求已证实的精确风险提示 | 不把所有相似地址推断为错误 | 靠通用路径猜协议 | 不能替用户验证所有网关组合 |
| ZenMux `/api/v1` | Chat、Responses 不告警；Anthropic 给精确、非阻断的 `/api/anthropic` 建议 | Claude 完整 Web 请求在 `/api/v1` 连续 500，换地址后成功；此前最小请求 200 不足以验收 | 见 `/api/v1` 就一概判错 | 用户仍可保存原地址 |
| 错误模型 | 只用现有 `UiPromptError` | 00：不多处设计字段 | snapshot.status 长期停在 error；新 banner 字段 | idle 表示「没在跑」，错误挂在 prompt |
| 400 正文 | HTTP 码 + 已识别的安全原因固定句 | 否则看不到 temperature deprecated；任意原始正文可能回显未知格式密钥 | 继续 generic；整段 JSON 或宽松正则脱敏 | 未识别原因只给状态码 |
| 空失败助手 | 可继续丢掉 | 横幅/失败行吃同一 `prompt.error` 即可 | 强制插一条空 assistant | 会话里可能没有失败气泡 |
| DeepSeek v4.1 Flash | 保留精确 profile/probe，不照搬 v4 Flash builtin | 已探测 v4.1 有六档，v4 builtin 只有两档 | 直接加别名 | 首次探测仍可能较慢 |
| 注入 temperature=1 | 不做 | 新 Claude 弃用该字段 | 思考开启时传 1 | — |

不可逆决策：无。删温度键、改文案、改错误映射均可回滚。

## 2.3 分阶段实施

全部 Stage 属于 improve-1。建议按序提交，但不因分阶段开新轮。

### Stage 1 — 温度不传 + 复用目标模型的档位

**目标：** Responses/Claude 不再因旧温度或 pre-send ConfigError 失败；同模型重存及切回已保存的模型都不清档位。这不代表此前 Claude 完整运行的 500 已解决。

**改动：**

- `writer.buildLLMParams`：增加「清除温度」；Connect 保存走清除，不再 `?? existing`。
- `applyActiveModelConfig`：始终 `clearTemperature`（Connect 无该字段）。保存目标 route 时先找相同 provider、model、protocol、归一化 baseUrl 的 profile；若其中已有可信的 discovered capability，保留它，包括 A→B→A。目标没有匹配结果时沿用现有 discovery。不要把 DeepSeek v4.1 Flash 加为 v4 Flash 的 builtin 别名。
- `LLMConfigManager`：加载时忽略 `llmParams.temperature`，不写入 `LLMConfig.temperature`。
- `streaming.ts`：`config.temperature` 缺省则不放入 request。三个 provider 保持「有才写 body」。
- 单测仍可直接构造带温度的 `InterfaceProviderRequest`（T6），不代表产品会从 json 加载。

**DoD：** 残留 0.7 的 json，不重存也不再上线；重存后键消失。同一路由重存，以及 A→B→A 返回已有 profile，`reasoningCapabilities` 都保留。目标 route 从未探测过时才重新发现；旧 route 的 profile 仍保存在配置中。

### Stage 2 — 档位按钮与 `/effort`

**目标：** 检测中只转圈；未知英文 `unknown`；关不了思考按钮仍在。

**改动：**

- Web `ReasoningControl`：`mode === "none"` 且 `identified` 才藏。`detecting` 显示大脑+转圈（无中文）。`unknown` 显示大脑+`unknown`。`identified` + effort/binary 显示 `<select>`；`supportsDisabled === false` 不提供 Off，**不要**退回 “Reasoning on” 纯文字。
- TUI `EffortPanel`：`status === "detecting"` 或 view 尚未返回 → loading；`unknown` → 英文 unknown，不是空列表假档位；`identified` 维持现有 choices。
- 不改 `UiReasoningCapabilityView` 状态枚举。

**DoD：** 无「推理默认」；检测中 `/effort` 非空列表；Claude/Luna（`supportsDisabled: false`）识别后仍能改档。

### Stage 3 — 保存前 URL 路径提醒

**目标：** Base URL 已写入请求资源路径，或精确组合已有完整请求失败证据时轻量提醒，不改写、不拦截。

**改动：**

- 在 `ohbaby-sdk` 紧挨 `inferConnectModelInterfaceProvider` 增加纯函数 `connectUrlPathWarning(baseUrl, interfaceProvider, model?): string | undefined`。
- 仅在该协议的 client 会自行追加请求资源路径，而用户的 baseUrl 已以 `/chat/completions`、`/responses` 或 `/messages` 结尾时提醒。实现前对照各 client 实际拼接方式；不能仅凭 URL 包含某词就告警。
- ZenMux `https://zenmux.ai/api/v1` + Chat、Responses 不因该路径告警。Anthropic Claude Sonnet 5 的完整 Web 请求在此地址连续 HTTP 500，`https://zenmux.ai/api/anthropic` 成功，因此仅对 ZenMux 主机 + Anthropic 协议 + `/api/v1` 路径 + `anthropic/claude-sonnet-5` 模型提醒。不能自动改写，也不据此推断其它网关或模型。
- Web Connect 与 TUI connect-panel：协议、URL 或模型变更时重新计算该句；保存仍成功。`UiConnectModelResult.warning` 可复用同一句。

**DoD：** 已包含完整请求资源路径的 baseUrl 有提醒；ZenMux `/api/v1` + Chat/Responses 或其它 Anthropic 模型无专用提醒，仅上述 Claude Sonnet 5 四元组有地址建议。保存仍可继续。

### Stage 4 — 同一份 run 错误，有限暴露

**目标：** 发送失败能看见 HTTP 状态和已识别的安全原因；Web/TUI 同源。

**改动：**

- `normalizeRunError` / `providerMessage`：400 仅把已识别的 temperature deprecated 映射为固定句，402 的余额不足映射为固定句；其它 400/402 和 401/403 用带状态码的固定句。上游原始 `error.message` 不进入持久化错误，避免未知格式的密钥回显。429/5xx 保持现有稳定句。
- 402：单独视为额度/账单类，不要掉进 generic `LLM provider request failed`。
- 预发送 `ConfigError` 已是 `RUNTIME_ERROR` + 原 message，接入同一展示。
- **不新增 SDK 字段。** 展示源 = 当前会话最新 prompt 的状态：最新为 `failed` / `interrupted` 时读其 `prompt.error.message`；最新为 queued/running/succeeded 时不继续显示上一轮失败。
  - Web：`selectPromptProjection` 对 failed prompt **不要**因 userMessage 已在 transcript 就丢弃错误行/横幅。
  - TUI：idle 后状态行仍能读该 `prompt.error`（或等价 queued/completed prompt），不要只依赖 `runtime.kind === "error"`。
- `reconcileRuntimeStatus` 保持失败后 idle（表示没在跑）。`messageToUiMessage` 可继续丢空 parts。

**DoD：** 用显式温度夹具制造本地 ConfigError，另用 mock provider 400；两种失败在 Web 与 TUI 都能看到同一来源的错误，不含密钥。连接错误路径不回退。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `packages/ohbaby-sdk/src/connect-model.ts` | `connectUrlPathWarning` | 合同测试 | 无 | Stage 3 |
| `packages/ohbaby-agent/src/config/llm/` | writer 清除温度 | `writer.ts`、`apply-active-model-config.ts`、`manager.ts` | 无 | Stage 1 |
| `packages/ohbaby-agent/src/core/llm-client/streaming.ts` | 无 | 缺省不传温度 | 无 | Stage 1 |
| `packages/ohbaby-agent/src/services/interface-providers/reasoning.ts` | 无 | 无 | 无 | 不复制 DeepSeek v4 的 builtin 档位给 v4.1 |
| `packages/ohbaby-agent/src/runtime/run-manager/error-detail.ts` | 有限错误类别映射 | `providerMessage` | 无 | Stage 4 |
| `packages/ohbaby-agent/src/adapters/` | 无 | 仅当投影需要把 prompt.error 留在 snapshot 消费者够得到的地方 | 无 | 优先改 Web/TUI 选择器 |
| `apps/ohbaby-web/src/ui/App.tsx` | 无 | ReasoningControl、prompt 投影、Connect 提醒 | 无 | Stage 2–4 |
| `packages/ohbaby-cli/src/tui/components/dialog/` | 无 | `effort-panel.tsx`、`connect-panel.tsx` | 无 | Stage 2–3 |
| `packages/ohbaby-cli/src/tui/` | 无 | runtime 标签或 prompt 错误展示 | 无 | Stage 4 |

## 2.5 API / 协议 / 迁移与兼容

- **SDK：** 不改 `UiPromptError` 形状；可新增 warning 纯函数。`UiConnectModelInput` 继续没有 temperature。
- **`model.json`：** 下次 Connect 保存删除 `llmParams.temperature`。其他字段增删改查仍走现有 writer（profile 按 route key 更新、`getCurrentModel()` 读当前）。
- **请求 wire：** 产品从 `model.json` 加载的 client **忽略**温度键，body 无 `temperature`。单测若直接给 `InterfaceProviderRequest.temperature`，provider 仍可发出（Chat/Qwen/GLM 实测可接受）。
- **UI 文案：** 档位状态英文；Connect 提醒可用中文或英文，但不要出现在档位按钮上。
- **兼容：** 旧 Web 测试「推理默认」必须改掉。responses-migration improve-2「跟 Chat 一样发温度」在产品缺省上被本契约取代（见 00 §6）。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| 某网关缺省温度很差 | 00 接受服务端默认；本轮不做温度 UI | 恢复 inherit 即可，但不建议 |
| 上游错误回显未知格式密钥 | 只把已识别类别映射到固定句，未知正文不入历史 | 退回 generic 句 |
| 目标 profile 判断漏归一化 | 复用 `normalizedEndpoint` + 现有 `modelProfileRouteKey`；测 A→B→A | 暂停缓存优化并修正匹配规则 |
| URL 提醒误报可用网关路径 | 测 ZenMux `/api/v1` + Chat/Responses 无 warning，+ Anthropic 为专用地址建议 | 只保留有完整请求证据的精确规则 |
| 失败横幅在下一轮发送后仍钉死 | 以当前会话最新 prompt 状态为准；新请求开始后旧错误不再占位 | — |

## 2.7 与 00 边界对齐检查

| 00 条款 | 02 落点 |
|---------|---------|
| 不做温度框、不主动传 | Stage 1 |
| Responses 请求无该字段 | Stage 1 编译层 |
| unknown 英文、检测中转圈、`/effort` loading | Stage 2 |
| 关不了思考按钮保留 | Stage 2 |
| 已有目标 profile 不清档位 | Stage 1 `clearDiscoveredReasoning` 条件 |
| 保存前对确定的 URL 路径错误提醒、不改写 | Stage 3 |
| 400/401/402 有限暴露、Web/TUI 同一份 | Stage 4 |
| model.json 动态 CRUD | Stage 1 删除温度键；其余沿用 writer |
| 不改 probe 超时 | §2.8 |

## 2.8 不在本轮

- 调整 `PROBE_TIMEOUT_MS`。
- 自动改写 Base URL / 推断 `openai-responses`。
- Agent 配置 `agents.*.temperature`。
- 改 `docs/services/providers/data-model.md` 旧必填温度类型（非本议题权威文档）。
- 尚无证据的跨协议 URL 猜测，以及直接给 DeepSeek v4.1 Flash 复用 v4 Flash builtin 档位。
- 为失败助手强制保留气泡（00 未要求；有横幅即可）。

以上不构成 0.4 分轮事件，只是本轮不做。升 `improve-2` 须验收后再与用户确认。

## 2.9 关键改动清单

> 行号为 2026-09-17 规划基线快照，定位以符号为准。本表不是进度表；实施中不勾选、不回写。

| ID | 类型 | 路径 | 符号/小节 | 行号快照 | 要改什么 | 为何承重 |
|----|------|------|-----------|----------|----------|----------|
| C1 | 代码 | `packages/ohbaby-agent/src/config/llm/writer.ts` | `buildLLMParams` | L103–125 | Connect 保存删除 `temperature`，停止 `?? existing` 继承 | 旧 0.7 的持久化根 |
| C2 | 代码 | `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts` | `applyActiveModelConfig` | L302–317 | 调 clearTemperature；按目标 route 的已有 profile 决定是否保留 discovered 能力 | 保存入口；同路由与 A→B→A 的档位被误清 |
| C3 | 代码 | `packages/ohbaby-agent/src/config/llm/manager.ts` 与 `packages/ohbaby-agent/src/core/llm-client/streaming.ts` | `LLMConfigManager` 组装 config；`streamResponse` 编译 request | manager L223–225；streaming L318–321 | 加载忽略 json 温度；request 缺省不传 | 未重存的旧 0.7 安全网 |
| C4 | 代码 | `packages/ohbaby-agent/src/runtime/run-manager/error-detail.ts` | `providerMessage` / `normalizeRunError` | L34–56, L59–96 | 400/401/402 有限暴露；脱敏 | 否则 UI 只能显示空话 |
| C5 | 代码 | `apps/ohbaby-web/src/ui/App.tsx` | `ReasoningControl` | L2263–2277 | 转圈 / `unknown` / 保留 select | 用户看得见的档位合同 |
| C6 | 代码 | `apps/ohbaby-web/src/ui/App.tsx` | `selectPromptProjection` | L275–302 | failed prompt 在 userMessage 已存在时仍能展示错误 | 发送失败沉默 |
| C7 | 代码 | `packages/ohbaby-cli/src/tui/components/dialog/effort-panel.tsx` | `choicesFor` / 空态 | L24–35, L130–134 | detecting → loading；unknown 非空假列表 | TUI `/effort` 合同 |
| C9 | 代码 | `packages/ohbaby-sdk/src/connect-model.ts` | 新 `connectUrlPathWarning` | （新符号，邻 L72） | 提醒确认的资源路径重复风险，以及 ZenMux Claude Sonnet 5 精确四元组；Web/TUI 同句 | 避免误报与三处文案 |
| D1 | 文档 | 本目录 00–04 | — | — | 实施不改规划正文；偏差记 05 | 本议题权威 |

### 连带影响面（不逐行列出）

- `packages/ohbaby-agent/src/config/llm/manager.ts` 已列入 C3；`manager.unit.test.ts` 断言 json 有 0.7 时 config 仍无温度。
- 三协议 provider 单测：产品缺省 body 无 `temperature` 键；直接构造 request 时 Chat 仍可带温度。
- `writer.unit.test.ts`、`apply-active-model-config.unit.test.ts`：继承与 clear 档位。
- `error-detail.unit.test.ts`：400/402 已识别原因映射到固定句；未知格式密钥与原始正文均不进入错误消息。
- `App.unit.test.tsx`：去掉「推理默认」断言。
- `connect-panel.tsx` / Web Connect 表单：消费 C9。
- TUI runtime 标签或 prompt 条：消费同一 `prompt.error`。
