# 讨论记录与已确认要点

> 2026-09-12 与用户讨论定稿。正式方案见 01–04。讨论来源包括本会话、improve-1 切割结论，以及知识库 / ChatGPT / Codex 调查材料。

---

## 1. 背景与动机

improve-1 只升级 OpenAI / Anthropic SDK，明确不引入 `/v1/responses`。Responses 已是 OpenAI 原生能力层的首选协议，但 Chat Completions 仍是跨供应商兼容基线。ohbaby 需要第三条协议实现，而不是在 `openai-compatible.ts` 里加分支。

本轮目标是把门开出来：协议能跑、默认不变、用户无感。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
| --- | --- |
| 文档落点 | `docs/problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-2/` |
| 轮次 | 新开 improve-2；不回填 improve-1 |
| 三个 provider | `openai-compatible`、`openai-responses`、`anthropic`，共享现有 `InterfaceProviderInstance` |
| 方法名 | 本轮保留 `streamChatCompletion()`；canonical 化时再订命名规范 |
| 配置字段 | 扩展现有 `interfaceProvider`，增加 `"openai-responses"`。这就是以后的 type，不另造字段 |
| 默认与 UI | **缺省 / 未写 kind** 仍落 `openai-compatible`；**未知字符串由 validation 拒绝**（不静默当 Chat）。UI 与 onboarding 不露出切换 |
| 协议选择 | 只认显式 kind；不用 base URL、不用模型名自动切 |
| 以后产品默认 | 整套接完后再把默认改为 Responses，Chat 另开入口，仍按 type，不用 URL |
| 认识完整性 | `openai-responses.ts` wire-complete：完整认识当前 SDK 的 Responses 协议 |
| 能力边界 | capability-limited：本轮只支持无需原生 reasoning/output-item 续接的文本与 function-tool 路径；不是完整推理模型支持 |
| 三层 | ① Responses 原生协议层（本轮）② 现有统一 provider 接口（不暴露 OpenAI 专属状态）③ 未来 canonical 层 |
| 事件分类 | Mapped / Validated then discarded / Rejected / Ignored by design；未知事件不得静默吞掉 |
| 状态 | `store: false`；不用 `previous_response_id` / Conversations |
| 请求翻译 | 关在 adapter：当前项目实际产生的字符串 system/user/assistant/tool 与 function calls 按冻结规则投影；Chat 联合中的其他形状显式拒绝 |
| 工具累积 | lifecycle / llm-client 不改；adapter 合成本地 `index`，`call_id` 填现有 `id` |
| temperature | 与 Chat 一样原样发出；不为 Responses 单独建模型表 |
| cache | 本轮不做对齐、不做显式缓存。`openai-responses` 必须单独落到 `observe-only`，防止 `enabled` 掉进 Anthropic 分支。不发 `prompt_cache_key` / options / breakpoint / retention |
| usage | 解析 `input_tokens` / `output_tokens`；若带 `cached_tokens` 可观测进现有 breakdown，不宣称与 Chat cache 产品对齐 |
| reasoning / phase | 当前 Chat-shaped 历史无法可靠保存并重放；响应一旦出现 `reasoning` item 或非空 assistant `phase`，本轮明确失败 |
| refusal / annotation | 共享事件与持久化模型尚无无损表示，本轮明确失败，不伪装成普通文本 |
| 关键改动清单 | 不写 02 §2.9 |

## 3. 已确认：边界（不做的事）

| 项 | 本轮不做 / 后续做 |
| --- | --- |
| 重命名 `streamChatCompletion` | 后续与 canonical 一起制定规范后分批改 |
| 内部消息 canonical IR | 后续轮；本轮内部继续 Chat 形状，adapter 门口翻译 |
| 显式 prompt cache（breakpoint / options） | 后续；等 Responses 完全接入后再考虑 cache 完全对齐 |
| 把 Chat 的 keyed-implicit 套到 Responses | 本轮不做，避免 Responses 字段绑死 Chat cache 成果 |
| context / lifecycle 为 cache 或 IR 改行为 | 本轮不做 |
| `previous_response_id`、Conversations、`store: true` | 后续可选能力 |
| hosted tools（web/file search、computer、MCP） | Rejected：收到明确失败 |
| reasoning item / assistant phase 的续接 | 后续 canonical/provider-continuation 轮；本轮 Rejected |
| refusal、annotation 与多模态输入输出 | 后续能力设计；本轮 Rejected |
| 默认改走 Responses、UI 开关 | 产品默认翻转在整套完成之后 |
| 删除 Chat Completions | 永不作为本议题目标 |
| SQLite schema 迁移 | 本轮不做 |
| 按 base URL 在 Chat / Responses 之间分流 | 明确拒绝 |

## 4. 已确认：与关联议题的关系

- improve-1：SDK 已升到 OpenAI `7.13.0`、Anthropic `0.124.0`；本轮输入，不修订其 05。
- investigation/：协议调查仍有效；本轮把其中「独立 Responses provider」落地为可实施边界。
- Chat / Anthropic cache 对齐：已完成的产品能力，本轮冻结，不为 Responses 提前改策略表（除 observe-only 防掉坑）。
- llm-client 权威文档仍写 kind 仅有两种、消息为 Chat 形状：本轮实施后需同步「第三种 kind 存在但不默认」，不把文档写成已 canonical。

## 5. 参考项目

pi / oh-my-pi、OpenCode、Kimi Code、DeepSeek-Reasonix：协议是 type/api 一等配置，不是 URL 嗅探。统一 cache 字段、adapter 消化 wire 差异。本轮只借鉴「独立协议文件 + 显式 type」；不借鉴它们把官方 OpenAI 默认切 Responses，也不在本轮照搬显式缓存。详见 03。

## 6. 用户确认记录

- 默认仍走 Chat；新增独立 `openai-responses.ts`；三者共享现有接口。
- 本轮不重命名；下一轮 canonical 时再订名称改造规范。
- wire-complete 分类表 + capability-limited 映射；三层边界。
- 不按 base URL 自动切；不对用户暴露开关；kind 先给测试/开发者手工使用。
- 缺省仍 Chat；未知 kind 由校验拒绝，不静默当 Chat。
- 以后默认 Responses、Chat 另开入口，按配置 type，不用 URL。
- cache 本轮只做 observe-only + 防掉进 Anthropic；显式缓存与完全对齐推迟。
- 工具调用用 adapter 过渡本地 index；后续完全接入后再原生 `call_id`。
- temperature 跟 Chat 一样发。
- 文档落点确认；完成后自检并用子代理审查。
- 2026-09-12 复审确认：不扩大 improve-2 范围；对 reasoning/output-item 续接 fail-closed。分支链固定为 `main` → 本地长期集成分支 `openai-responses-migration` → 每一波临时分支；当前为 `codex/improve-2-responses-migration`。每波验收后只合回集成分支，Responses 后端、token estimation/counting、cache 命中统计、context 占用统计与 lifecycle 全部通过后，集成分支才可合并 `main`。
