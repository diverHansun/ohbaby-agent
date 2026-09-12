# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
| --- | --- | --- |
| pi | `/Users/hansun025/Projects/code-cli/pi` | `openai-completions` / `openai-responses` 分文件；官方 OpenAI provider 绑 Responses；cache 字段 |
| oh-my-pi | `/Users/hansun025/Projects/code-cli/oh-my-pi` | `model.api` 分派；prompt cache 与 routing session 解耦 |
| OpenCode | `/Users/hansun025/Projects/code-cli/opencode` | `OpenAIChat.protocol` 与 `OpenAIResponses.protocol` 平级；默认 `model()` 走 Responses |
| Kimi Code | `/Users/hansun025/Projects/code-cli/kimi-code` | `type: "openai"` vs `"openai_responses"` 工厂分流 |
| DeepSeek-Reasonix | `/Users/hansun025/Projects/code-cli/DeepSeek-Reasonix` | `openai`（Chat）与 `responses` 分注册；URL 只识别 Responses **厂商口味** |

议题级 investigation 见同目录上级 `investigation/03-reference-projects-and-ecosystem.md`。本文只记录对本轮 02 有约束的取舍。

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
| --- | --- | --- | --- |
| 全部 | Chat 与 Responses 分文件 / 分 type，不在 Chat 实现里加协议 if | 与 00「独立 openai-responses.ts」一致 | **Adopt** |
| Kimi / pi registry | 协议由配置 type/api 决定，不靠 base URL 猜 Chat vs Responses | 官方 OpenAI 同一 host 两条路径 | **Adopt**：扩展 `interfaceProvider` |
| Reasonix | URL 用于 Responses 内部 vendor 差异，不用于选择进不进 Responses | 避免把 cache/host 嗅探当成协议路由 | **Adopt 原则**；本轮甚至不做 vendor 表 |
| pi / OpenCode / Kimi / Reasonix | usage 在 adapter 归一到统一 cache/token 字段，不在应用层加 `responses_cache_*` | 与现有 `InputTokenBreakdown` 同构 | **Adapt**：本轮只观测，不宣称 cache 产品对齐 |
| pi Responses | `store: false` | 与本地 compaction 兼容 | **Adopt** |
| pi / OpenCode 的完整 Responses 路径 | 保存或回传原生 output item / reasoning 状态 | 说明无状态工具续接不能只拼 Chat-shaped 历史 | **不在本轮移植**：先把这些响应分类为 Rejected，留给 provider-continuation/canonical 轮 |

## 3.3 明确不借鉴

| 项目 | 做法 | 为何拒绝（本轮） |
| --- | --- | --- |
| pi / OpenCode / xAI facade | 官方 OpenAI **默认** Responses，Chat 另开入口 | ohbaby 已有用户与中转站；00 规定整套完成后再翻转默认 |
| oh-my-pi / pi GPT-5.6 | `prompt_cache_options`、breakpoint、长 retention | 显式缓存；本轮不做 cache 对齐 |
| pi completions | `api.openai.com` 才发 `prompt_cache_key` | 那是 Chat cache 产品逻辑；Responses 本轮 observe-only |
| Kimi Responses | 不发 key 但也没单独守卫「别掉进另一协议 cache」 | ohbaby 的 `enabled` 会误入 Anthropic，必须有 kind 分支 |
| Reasonix stateful | `previous_response_id` + 前缀校验 | 本轮无状态；状态链留候选 |
| OpenCode | 应用层直接默认 `sdk.responses` | 与「不对用户露出」冲突 |

## 3.4 对 02 方案的影响

- 02 的独立文件、显式 kind、默认 Chat、无 URL 分流，直接来自本节 Adopt / Reject。
- 02 不把参考项目的默认 Responses 或显式缓存写进 Stage。
- cache：借鉴「统一字段、adapter 解析」的方向，但 Stage 2 只做 usage 数字与可选观测，不发送 Chat 已对齐的控制字段。
- reasoning/output item：参考项目证明完整实现需要保留协议原生续接信息；improve-2 不扩大共享接口，因此只借鉴其边界认识，不借鉴其状态承载实现。
