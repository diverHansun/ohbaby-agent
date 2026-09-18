# 1. 问题基线与当前实施状态

> 时间口径：2026-09-17 工作区代码（规划基线）。未改生产代码。真实请求证据见 §1.2。

---

## 1.1 问题陈述

1. **旧温度被当成产品默认。** `/connect` 没有温度框，代码也没有写死 `0.7`。但 `model.json` 一旦有 `llmParams.temperature`，writer 每次保存都继承，client 每次请求都带上。Luna Responses 可在 HTTP 前被本地校验拦下；最小 HTTP 请求中，Luna Responses 与 Claude Sonnet 5 带 0.7 都返回 400。用户那次 Claude 完整运行却是重试后的 500，不能直接归因于温度。
2. **档位未知被说成「推理默认」。** 检测中 Web 把大脑按钮换成中文；`/effort` 在 `detecting` / `unknown` 时给出空列表。关不了思考的模型，未识别时整颗控件消失或变成一句状态文字。
3. **发送失败对用户沉默。** 连接错误能显示；run 级 400/401/402 写入账本后被抹成空话，状态拉回 idle，空失败助手被丢掉，Web 在 userMessage 已进会话后不再投影 `prompt.error`。
4. **同路由重存会清掉已确认档位。** Connect 保存永远 `clearDiscoveredReasoning`，大脑重新转很久。
5. **可确认的 URL 风险没有保存前提醒。** Base URL 若已包含 `/chat/completions`、`/responses` 或 `/messages` 等请求资源路径，后续可能再次拼接。ZenMux `/api/v1` + Anthropic 的最小请求虽返回 200，后续完整 Claude Web 对话连续 500；换 `/api/anthropic` 成功。

## 1.2 已确认的产品 / 技术分界

以 [00-discussion.md](./00-discussion.md) 为准。技术上分四条独立链路，不要合成一个「模型能力」上帝模块：

```text
温度：model.json → writer inherit → LLMConfig.temperature → streaming request → provider body
档位：builtin / probe → models[].reasoningCapabilities → reasoningCapabilityView → Web 按钮 / TUI /effort
URL：connect 表单 protocol + baseUrl（现无预检）
错误：provider throw → normalizeRunError → ledger.errorData / prompt.error → UI（现断开）
```

### 1.2.1 2026-09-17 真实三协议请求

对 `tests/models-4-tests.md` 做最小请求（无 agent 工具）。**不传 `temperature` 全部 HTTP 200。**

| 组合 | 不传 | 传 `0.7` |
|------|------|----------|
| Zenmux `openai/gpt-5.6-luna` Chat | 200 | 200 |
| 同上 Responses | 200 | **400** `Unsupported parameter: 'temperature'` |
| Zenmux `deepseek/deepseek-v4.1-flash` Chat / Responses / Anthropic（含 adaptive thinking） | 200 | Chat+0.7 也 200 |
| Zenmux `anthropic/claude-sonnet-5` Anthropic | 200 | **400** `` `temperature` is deprecated for this model `` |
| 同上 + `thinking.type=adaptive` | 200 | **400** `temperature may only be set to 1 when thinking is enabled` |
| Zhipu `glm-5.3-flash` Chat | 200 | 200 |
| Dashscope `qwen3.8-flash` Chat / Anthropic（含 thinking） | 200 | 200 |

另一次对 ZenMux `https://zenmux.ai/api/v1` 的最小 Anthropic Messages 请求返回 200，不能对该协议和地址组合直接报“不匹配”。用户那次 Claude 完整 agent 运行约 48 秒后以 500 和重试耗尽结束；上表只测试最小请求，不解释该 500。

Anthropic 官方 Messages / extended thinking：思考打开时温度只能是 `1` 或不传；Claude 4.7+、Sonnet 5、Opus 5、Fable/Mythos 5 即使思考关闭，非默认 `temperature` / `top_p` / `top_k` 也每条 400。本轮选择**始终不传**，不注入 `1`。

---

## 1.3 config/llm：温度继承与档位缓存

### 1.3.1 goals-duty

`config/llm` 负责把 `/connect` 写成 `model.json` 并 reload client。Connect 输入类型 [`UiConnectModelInput`](../../../../packages/ohbaby-sdk/src/connect-model.ts) **没有 temperature**，职责上本就不该在保存时发明温度。现状 writer 把旧键续命，等于配置模块替产品做了「隐式采样参数」。

### 1.3.2 architecture

保存路径：Web/TUI `connectModel` → [`applyActiveModelConfig`](../../../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts) → [`setActiveLLMConfig`](../../../../packages/ohbaby-agent/src/config/llm/writer.ts) → [`LLMConfigManager`](../../../../packages/ohbaby-agent/src/config/llm/manager.ts) reload。

档位发现：`deferMetadata: true`（[`ui-inprocess.ts` L2517](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts)）先写盘再 `startModelDiscovery`。builtin 命中则跳过 [`probeReasoningCapabilities`](../../../../packages/ohbaby-agent/src/config/llm/reasoning-active-probe.ts)（30s 顺序探测）。

### 1.3.3 data-model

- `llmParams.temperature?: number`（0–2）可选。验证允许缺省（[`validation.ts`](../../../../packages/ohbaby-agent/src/config/llm/validation.ts) 已有 “accepts missing temperature”）。
- `models[]` profile 按 [`modelProfileRouteKey`](../../../../packages/ohbaby-agent/src/config/llm/model-profile.ts)（provider + model + interfaceProvider + baseUrl）区分路由。
- `reasoningCapabilities` / `reasoningCapabilitySource` 挂在 active profile 上。`clearDiscoveredReasoning` 会删这两项。

### 1.3.4 dfd-interface

```text
existing.llmParams.temperature
  → buildLLMParams: input.temperature ?? existing   // L111 无 clear 通道
  → manager: 有则拷进 LLMConfig.temperature         // L223–225
  → streaming.ts: temperature: config.temperature   // L321
  → provider: 有则写入 JSON body
```

Connect 保存同时：`clearDiscoveredReasoning: input.deferMetadata`（[`apply-active-model-config.ts` L317](../../../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts)）。UI 保存永远 defer，所以**每次重存都清档位**，即使 route key 没变。

### 1.3.5 use-case

| 用例 | 现状 |
|------|------|
| 新连 Responses Luna | 若旧 json 有 0.7 → 本地 reasoning 校验可能在 HTTP 前失败；若绕过该校验发到上游，实测返回 400 |
| 再按一次保存（同模型同 URL 同协议） | 已确认档位被清，大脑再转 |
| 只改 max tokens、同路由 | 同样清档位 |
| 不打开 Connect、json 里仍是 0.7 | manager 仍拷进 client，下次发送继续带温度 |

### 1.3.6 non-functional

Probe 超时 30s（`PROBE_TIMEOUT_MS`）。本轮不改。安全上温度不是秘密，但 400 body 里可能夹 request_id；有限暴露允许保留。

### 1.3.7 test

- Writer / validation 大量夹具带 `temperature: 0.7`，测的是「有值时合法」，**没有**「Connect 保存必须删除该键」。
- Writer 有「不主动引入温度」用例（已有 reasoning 配置且 input 无温度时不新增），但 **`?? existing` 仍会保留旧值**。
- 真实 e2e `connect-model.real.e2e.test.ts` 不覆盖 Responses + 残留温度。

**Gap：** 缺「保存后 json 无 temperature」「同 route key 重存及 A→B→A 保留 discovered reasoning」测试。

---

## 1.4 interface-providers：编译请求与档位视图

### 1.4.1 goals-duty

Provider 只应在 `request.temperature !== undefined` 时写字段。这一点 Chat / Responses / Anthropic **已经做到**：

- [`openai-compatible.ts` L75–76](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts)
- [`openai-responses.ts` L152–154](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-responses.ts)
- [`anthropic.ts` L398–399](../../../../packages/ohbaby-agent/src/services/interface-providers/anthropic.ts)

缺口在上游：`streaming.ts` 把 `config.temperature` 传进来。Zenmux builtin 还把 `temperature: "unsupported"`（[`reasoning.ts` L125–129](../../../../packages/ohbaby-agent/src/services/interface-providers/reasoning.ts)），于是 [`resolveRequestReasoning` L293–308](../../../../packages/ohbaby-agent/src/services/interface-providers/reasoning.ts) 在 **HTTP 之前**抛 `ConfigError`。Luna 即使没打到 400，本地也会失败。

### 1.4.2 architecture

`reasoningCapabilityView`（L478–517）：无 capability 时 `detecting` 或 `unknown`，`efforts: []`。Web 把非 `identified` 整段换成中文，不渲染 `<select>`。

Builtin 精确匹配：ZenMux Claude 必须 `https://zenmux.ai/api/anthropic` + `anthropic/claude-sonnet-5` + protocol `anthropic`。用 `/api/v1` 则 `source: unknown`，走 probe；这个结果不能证明该地址不可用。DeepSeek builtin 型号是 `deepseek/deepseek-v4-flash`，清单是 `deepseek/deepseek-v4.1-flash`，同样 miss。当前已保存的 v4.1 Flash 实测档位为 `minimal/low/medium/high/xhigh/max`，v4 Flash builtin 只有 `high/max`；两者不能当作等价别名。

### 1.4.3–1.4.5 数据 / 流 / 用例

档位视图已是 UI 合同 [`UiReasoningCapabilityView`](../../../../packages/ohbaby-sdk/src/connect-model.ts)：`detecting | identified | unknown`。产品要的英文 `unknown` 与转圈是 **视图渲染**问题，不必改合同状态机。

关不了思考：`supportsDisabled: false` 时 `choicesFor` 已不推 Off。Web 在 `binary && !supportsDisabled` 时改成纯文字 “Reasoning on”（[`App.tsx` L2276–2277](../../../../apps/ohbaby-web/src/ui/App.tsx)），强度按钮消失——与 00 冲突。

### 1.4.7 test

`reasoning.unit.test.ts` 覆盖「显式温度 + unsupported → throw」。产品改为不传温度后，这条仍应保留（手改 json 的防护），但主路径测试要断言 **body 无 `temperature` 键**。

---

## 1.5 runtime / UI 投影：错误双缺

### 1.5.1 goals-duty

`normalizeRunError` 的设计意图是有限暴露、去掉密钥。实现走过头：400 丢掉服务端 `error.message`，402 无分支。

### 1.5.2–1.5.4 数据流

```text
provider HTTP 400
  → normalizeRunError.providerMessage → "LLM provider request failed"   // error-detail.ts L56
  → ledger.errorData (UiPromptError) + record.error (string)
  → prompt.error（prompt-mapper 已接 errorData）
  → runToUiRun: 用 record.error，不读 errorData                         // persistent-store.ts L221–231
  → reconcileRuntimeStatus: 无 activeRun → idle                         // ui-inprocess.ts L1192+
  → snapshotStatus: 忽略已失败 run，保持 idle                           // L416–431
  → messageToUiMessage: parts.length===0 → undefined                    // L163–164
```

Web [`selectPromptProjection` L276](../../../../apps/ohbaby-web/src/ui/App.tsx)：`formalMessageIds.has(prompt.userMessageId)` 则丢掉整行。Run 已启动时 user 消息已在会话里 → **失败 prompt 行被跳过**。横幅 `actionError ?? view.error` 来自 store/连接错误，不是 `prompt.error`。

TUI `selectRuntimeLabel` 只在 `runtime.kind === "error"` 时 `formatError`。idle 后标签是 `idle`。`formatError` 本身可用，缺的是把 `prompt.error` 接上去。

`UiPromptError`（[`packages/ohbaby-sdk/src/prompt.ts`](../../../../packages/ohbaby-sdk/src/prompt.ts)）已有 `code/message/statusCode/source`。**不要新字段。**

### 1.5.5 use-case

| 场景 | 用户看到什么 |
|------|----------------|
| Connect 保存失败 | 有（actionError / connect panel error） |
| 密钥 401 在发送时 | 账本有「authentication failed」，界面无 |
| Luna Responses + 0.7 | 400；界面无；或本地 ConfigError 同样无 |
| 空失败助手 | 被投影丢掉，会话像只有用户句 |

### 1.5.7 test

[`error-detail.unit.test.ts`](../../../../packages/ohbaby-agent/src/runtime/run-manager/error-detail.unit.test.ts) **断言** 429/401 **不**序列化原始 body（防密钥）。这是对的，但没有「保留非秘密的 `error.message`」用例，也没有 400/402。Web 有「unknown 显示推理默认」用例（[`App.unit.test.tsx`](../../../../apps/ohbaby-web/src/ui/App.unit.test.tsx)），与 00 直接相反，实施时要改断言而不是迁就旧文案。

---

## 1.6 Web / TUI Connect 表单

### goals-duty / use-case

Connect 字段：provider、Base URL、协议、模型、窗口、密钥。无温度，符合 00。[`inferConnectModelInterfaceProvider`](../../../../packages/ohbaby-sdk/src/connect-model.ts) L72–81 只从 URL 猜 `anthropic` vs `openai-compatible`，**从不推断 `openai-responses`**。Zenmux Chat 与 Responses 共用 `/api/v1`，不能靠 URL 区分——00 已确认不要误报。

缺口：URL 已含 `/chat/completions`、`/responses`、`/messages` 时可能拼出双路径，也无提醒。`https://zenmux.ai/api/v1` + `anthropic` 的最小请求曾返回 200，但 2026-09-18 完整 Claude Sonnet 5 Web 对话连续返回 HTTP 500；改用 `/api/anthropic` 后成功。该精确组合需要非阻断提醒，不能推广成所有 `/api/v1` 都不可用。

TUI [`connect-panel.tsx`](../../../../packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx) 保存成功可显示 `warning`。Web Connect 同样能吃 `UiConnectModelResult.warning`。缺的是**保存前**同一句预览（00 要求保存前）。

`/effort`：[`choicesFor`](../../../../packages/ohbaby-cli/src/tui/components/dialog/effort-panel.tsx) L25 在非 identified 返回 `[]`，L133–134 显示 “No verified reasoning levels”。`view === null` 才是 “Loading reasoning options...”。`getCurrentModel()` 在 detecting 时已返回 view，所以检测中走空列表而不是 loading。

---

## 1.7 跨模块一致性

| 模块 | 温度 | 档位 | 错误 |
|------|------|------|------|
| config/llm | 继承旧键 | 每次 defer 保存都清 discovered | 保存失败有 warning |
| llm-client | 原样传入 request | 调 resolveRequestReasoning | ConfigError / provider error |
| providers | 有则写 body | wire 映射 | HTTP 原始错误 |
| run-manager | — | — | 抹平 400 |
| ui-inprocess / persistent-store | — | 发布 capability view | idle + 丢空消息 |
| Web / TUI | 无输入框 | 中文默认 / 空 effort | 连接错误有、run 错误无 |

会话标题生成走同一 LLM client 的 `config.temperature`。产品不传温度后标题请求也会不再带该字段；不要在 title-generator 里另开一套温度。`agents.*.temperature` 是另一配置面，本轮不动。

## 1.8 改动影响面（现状视角）

包：`ohbaby-agent`（config/llm、llm-client、error-detail、ui 投影）、`ohbaby-sdk`（URL 提醒纯函数）、`ohbaby-web`、`ohbaby-cli`。对外 SDK 不新增错误类型。`model.json` 迁移：下次 Connect 保存删除 `llmParams.temperature`；未重存时靠请求编译层不传，避免旧文件继续 400。

未超出单轮承载。不构成 0.4 分轮。

## 1.9 SWE 原则审视摘要

- **偶然复杂度**：温度框不存在却仍发送 0.7；「推理默认」把 unknown 说成已有默认。
- **KISS / YAGNI**：不按协议维护温度策略表，不注入 `1`。
- **DRY**：错误文案以 `UiPromptError.message` 为单一权威；URL 提醒一个纯函数给 Web/TUI/保存结果。
- **信息隐藏**：有限暴露保留 provider 一句，剥离 Authorization / `sk-` / Bearer。
- **反教条**：不把「llm-client 架构写了填充 temperature」读成「必须每次都发」。

## 1.10 与既有文档关系

| 文档 | 权威性 | 本议题 |
|------|--------|--------|
| 本目录 00–04 | 本议题权威 | 产品 Connect 路径缺省不传温度 |
| responses-migration improve-2 00「temperature 跟 Chat 一样发」 | 被本议题 **supersede**（仅产品缺省；协议仍可选） | 01/00 已标注 |
| llm-client architecture「为请求填充 temperature」 | 仍成立，语义收窄为可选 | 不强制改那篇，除非实施时发现表述会误导 |
| providers data-model 里 `temperature: number` 必填 | 已过时（代码已是可选） | 本轮不修那份旧模块文档 |
| test-blueprint | 仓库无项目级文件 | 04 按现有 vitest 分层：单测改行为、契约改投影、手工补三协议 |
