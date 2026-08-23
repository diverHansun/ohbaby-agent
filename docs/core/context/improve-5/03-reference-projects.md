# 3. 参考项目与官方协议取舍

> 调研日期：2026-08-23。六个本地仓库均位于 `/Users/hansunwork26/workspace/projects/code-cli/`，只读检查；官方协议用于裁决参考项目之间的差异，不能用项目代码替代协议事实。

---

## 3.1 结论先行

六个项目没有任何一个可以整套照搬。最适合 ohbaby 的组合是：

- 用 OpenCode 的 inclusive usage 不变量表达领域语义；
- 用 Pi / Kimi 的多 compatible usage parser 覆盖实际网关字段；
- 用 claude-code-best 的 strict official-endpoint 判断，避免给所有 compatible 端点盲发 OpenAI 字段；
- 用 Codex 的 scoped stable key 与 user-side environment context 思路设计可增长前缀；
- 用 deepseek-harness 的真实多步工具 cache E2E 证明服务端确实命中；
- 对所有借鉴加上 ohbaby 自己的 optional breakdown、context-scope 隔离、单一 request payload 和 MCP cache epoch。

## 3.2 OpenCode

重点位置：

- `opencode/packages/llm/src/schema/events.ts:13-58`
- `opencode/packages/opencode/src/provider/transform.ts:1258-1273`
- `opencode/packages/llm/src/protocols/openai-responses.ts:458-470`

观察：

- `inputTokens` 明确是 inclusive total，cache read/write 是互斥拆分，并写出总和不变量。
- provider transform 按 SDK/provider capability 设置不同名字的 cache key，而不是给全部 compatible 请求加同一字段。
- request protocol 层才把 neutral option 翻译成 `prompt_cache_key`。

取舍：

- **Adopt：** inclusive total + disjoint breakdown + adapter-local translation。
- **Adapt：** ohbaby 把 breakdown 整体设为 optional，并用 per-category `observed` 区分“该 bucket 未报告”和“明确 0”。
- **Reject：** 直接使用 session id 明文；ohbaby 还存在同 session 多 context scopes，必须使用 scoped hash。

## 3.3 Pi

重点位置：

- `pi/packages/ai/src/types.ts:382-400,615-672`
- `pi/packages/ai/src/api/openai-completions.ts:763-775`
- `pi/packages/ai/src/api/openai-completions.ts:1060-1130`
- `pi/packages/ai/src/api/openai-completions.ts:1455-1500`

观察：

- 统一 usage 采用 `input/cacheRead/cacheWrite/output`，OpenAI parser 同时兼容 nested cached、DeepSeek hit、Kimi top-level cached 和 compatible cache write。
- OpenAI key 受 base URL/capability/retention 条件控制。
- Anthropic-compatible `cache_control` 会放到特定 content/tool block，而不是假设所有网关支持顶层 automatic。
- parser 用 `Math.max` 防御异常网关。

取舍：

- **Adopt：** 多字段 parser 优先级、协议能力显式化、block marker 的转换位置。
- **Adapt：** 数值冲突时 ohbaby 保留 inclusive total 但丢弃 breakdown 并诊断；单纯 clamp 会隐藏 provider 数据不一致。
- **Reject：** 1h retention、session affinity headers、复杂多 marker 与价格计算，这些不属于 improve-5 最小闭环。

## 3.4 claude-code-best

重点位置：

- `claude-code-best/src/services/api/openai/openaiShared.ts:13-61`
- `claude-code-best/src/services/api/openai/openaiShared.ts:69-102`
- `claude-code-best/src/services/api/claude.ts:3070-3110`
- `claude-code-best/src/services/api/claude.ts:3230-3390`

观察：

- official OpenAI 判断严格校验 scheme、host 与 port；generic compatible provider 不会收到 OpenAI-specific key。
- stable key 不从完整 message body 派生。
- Anthropic 流式合并保留 `message_start` 的 cache usage，避免 delta 的 0 清空旧值。
- block-level cache control 有明确 marker 数量和相对位置约束。

取舍：

- **Adopt：** official-host strictness、stable identity key、start/delta merge 的问题意识。
- **Adapt：** ohbaby 以字段 presence 表达 explicit zero，不把 `>0` 规则扩展成通用领域语义；provider 未报告和 0 仍须区分。
- **Reject：** 项目内部实验开关、全局 cache scope、advisor/TTL 等产品专属逻辑。

## 3.5 Codex

重点位置：

- `codex/codex-rs/core/src/client.rs:477-490,922-937`
- `codex/codex-rs/core/src/context_manager/history_tests.rs:1090-1280`
- `codex/codex-rs/core/tests/suite/turn_input_submission.rs:130-160`
- `codex/codex-rs/core/tests/suite/prompt_caching.rs`

观察：

- model client 默认用 session/thread identity 生成稳定 `prompt_cache_key`，retry/后续请求继续复用。
- `<environment_context>` 作为 user input fragment 进入 model-visible history，并有 history/compaction/request layout 测试。
- prompt-caching suite 直接比较连续请求的布局和 key，而不只测一个 helper 返回值。

取舍：

- **Adopt：** 环境属于 user-side contextual fragment、key 跨 turn/retry 稳定、以完整请求布局做 cache 测试。
- **Adapt：** ohbaby key 还要加入 `contextScopeId` 后 hash；runtime part 需要适配现有 `TextPart.synthetic`、UI 和 store。
- **Reject：** 完整 WorldState、多环境模型和 Codex Responses transport；ohbaby 当前是 Chat Completions / Anthropic Messages。

## 3.6 deepseek-harness

重点位置：

- `deepseek-harness/packages/llm/llm-deepseek/src/translate.ts`
- `deepseek-harness/packages/llm/llm/src/types.ts`
- `deepseek-harness/packages/core/agent-loop/tests/request-cache.e2e.ts:1-105`

观察：

- DeepSeek 顶层 `prompt_cache_hit_tokens` 映射到 provider-neutral cache read。
- key-gated real E2E 不是连续发两个静态字符串：它真实注册工具、执行至少两个 model steps、追加 follow-up，并要求首请求之后每次 `cacheReadTokens > 0`。
- usage 从生产 assistant/message event 读取，同时验证工具结果真的进入最终回答。

取舍：

- **Adopt：** DeepSeek usage 翻译和真实 scheduler/tool-loop smoke 的结构。
- **Adapt：** ohbaby 增加 primary/subagent 两个 scope、MCP load epoch 和 request-shaped occupancy 断言。
- **Reject：** 把 real smoke 当普通单元硬门；它必须 API-key gated、串行、具有超时和成本边界。

## 3.7 Kimi Code

重点位置：

- `kimi-code/packages/kosong/src/providers/openai-common.ts:202-230`
- `kimi-code/packages/kosong/src/providers/anthropic.ts:646-735,790-890`
- `kimi-code/packages/agent-core/src/session/provider-manager.ts:295-380`

观察：

- TokenUsage 使用 `inputOther / inputCacheRead / inputCacheCreation` 的互斥分类。
- OpenAI-compatible parser 同时识别 Moonshot top-level `cached_tokens` 与 nested `prompt_tokens_details.cached_tokens`。
- provider manager 将一个 neutral cache key 映射到不同 provider 参数。
- Anthropic stream 的某些 delta 分支会按字段存在直接覆盖，显式 0 可能清空 start usage；这是可参考项目也可能携带缺陷的例子。

取舍：

- **Adopt：** Moonshot/Kimi 字段兼容、neutral key 向 wire 映射、互斥 usage 分类。
- **Adapt：** 加入 cache write、optional breakdown 与严格不变量。
- **Reject：** 直接复制 stream overwrite；ohbaby 要按事件语义合并并测试 attempt isolation。

## 3.8 官方协议裁决

| 官方来源 | 用来冻结的事实 | 对 ohbaby 的约束 |
|----------|----------------|------------------|
| [OpenAI Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching) | exact prefix、1,024 token 起、key 路由、GPT-5.6 implicit/explicit breakpoint、read/write usage、tools/order 参与前缀 | official endpoint 使用 keyed implicit；本批不默认 explicit breakpoint |
| [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) | opt-in、top-level automatic、block breakpoints/20-block lookback、tools→system→messages、input 三段加法、model minimums | official endpoint 采用 top-level auto + stable-system anchor；inclusive input 必须相加 |
| [Anthropic Tool Use with Prompt Caching](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-use-with-prompt-caching) | tool definitions 位于 cache hierarchy 左侧，deferred tools 可降低 invalidation | 本批先稳定顺序和 epoch，deferred tools 后置 |
| [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache) | 自动 disk cache、exact shared prefix、64-token blocks | observe-only；通过 hit/miss 观测 |
| [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion) | `prompt_cache_hit_tokens / miss_tokens` usage | adapter 解析顶层字段 |
| [DeepSeek Anthropic API](https://api-docs.deepseek.com/guides/anthropic_api/) | Anthropic-format endpoint 忽略 `cache_control` | auto 不能因 interface=anthropic 就发 control |
| [智谱上下文缓存](https://docs.bigmodel.cn/cn/guide/capabilities/cache) | 自动缓存与 nested cached usage | observe-only + nested parser |
| [ZenMux Prompt Cache](https://zenmux.ai/docs/guide/advanced/prompt-cache.html) | 上游模型缓存差异、Anthropic-style block control | endpoint-specific capability |
| [ZenMux OpenAI API](https://zenmux.ai/docs/zh/api/openai/create-chat-completion) | `prompt_cache_key` 不支持 | auto 必须 observe-only |
| [ZenMux Anthropic API](https://zenmux.ai/docs/api/anthropic/create-messages.html) | Anthropic usage shape 与 block cache control | explicit-last-block strategy |

## 3.9 参考如何落到实施

| improve-5 决策 | 来源组合 | 最终选择 |
|----------------|----------|----------|
| TokenUsage | OpenCode + Pi + Kimi + 官方协议 | inclusive total，optional disjoint breakdown + per-category observed |
| cache key | Codex + claude-code-best + OpenCode | `sessionId + contextScopeId` 后 versioned hash |
| capability | claude-code-best + Pi + 官方 compatible 文档 | `auto/enabled/disabled` + endpoint strategy map |
| runtime 注入 | Codex + ohbaby synthetic part | 固定到 initiating user，而非每 step system/tail |
| tool cache | Anthropic 官方 + 当前 MCP 代码 | scope 稳定序列，新 schema 形成 epoch |
| 真实验证 | deepseek-harness + Codex request-layout tests | key-gated multi-step tool loop，并覆盖 subagent |

结论不是“缓存字段加上就完成”。真正的 improve-5 是协议翻译、同一 request payload、scope identity、append-only history、稳定 tools 和真实 provider 观测共同闭环。
