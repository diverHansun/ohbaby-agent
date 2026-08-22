# 3. 优秀项目借鉴

> 调研日期：2026-08-22。结论基于本地源码实读，路径与 HEAD 均在本轮复核。本文只记录对 improve-4.1 有直接影响的 adopt/adapt/reject；压缩算法的完整横向分析留给 4.1 后的第一次压缩闭环审查。

---

## 3.1 借鉴来源

| 项目 | 本地路径 | 复核 HEAD | 本轮关注 |
|------|----------|-----------|----------|
| pi | `/Users/hansunwork26/workspace/projects/code-cli/pi` | `b7bb00b93` | 实际 LLM Context、tools 估算、usage anchor |
| opencode | `/Users/hansunwork26/workspace/projects/code-cli/opencode` | `b155b1569` | StreamInput/Prepared、每 loop 工具解析、overflow/compaction |
| kimi-code | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` | `cfc335048` | LLMChatParams、完整请求估算、prompt/tools 边界 |

旧文档中的 `/Users/hansun025/Projects/code-cli/*` 路径与若干历史行号已失效，本版已更新。

---

## 3.2 请求形态与 measurement 边界

### pi

- `packages/ai/src/types.ts:521-525` 的 `Context` 是实际送入 stream function 的对象：`systemPrompt + messages + tools`。
- `packages/agent/src/agent-loop.ts:294-312` 每次调用现建 `llmContext` 并直接传给 `streamFunction`。
- `packages/ai/src/utils/estimate.ts:114-140` 估算完整 Context：无 provider usage anchor 时加入 system/tools；有 anchor 时只补 anchor 后新增的 tools。

**对 ohbaby 的影响**

- adopt：measurement 必须覆盖实际 wire 中的 messages 与 schemas。
- adapt：ohbaby serializer 已把 system/memory 放进 messages，不能再单列 system。
- reject：不移植 pi 的“usage anchor + trailing delta”算法；ohbaby 当前是全量 heuristic × EMA factor。

### opencode

- `packages/opencode/src/session/llm.ts:35-48` 的 `StreamInput` 同时带 system、messages 与 tools。
- `packages/opencode/src/session/llm/request.ts:38-51` 的 `Prepared` 是规范化后的实际请求材料。
- `packages/opencode/src/session/llm.ts:278-324` 将 `prepared.tools` 与 `prepared.messages` 直接交给 AI SDK。
- `packages/opencode/src/session/prompt.ts:1221-1241` 每个 loop 重新执行 `SessionTools.resolve`。

**对 ohbaby 的影响**

- adopt：tools 属于 step/request 数据，不属于持久会话组装结果。
- adapt：ohbaby 不需要复制 `StreamInput → Prepared` 两层，只需窄 measurement payload。
- reject：不为“看起来像 opencode”而重构现有 provider transport。

### kimi-code

- `packages/agent-core/src/loop/llm.ts:87-101` 的 `LLMChatParams` 带 messages/tools 与 stream callbacks。
- `packages/agent-core/src/loop/turn-step.ts:154-178` 每 step 组装 chat params。
- `packages/agent-core/src/agent/compaction/full.ts:238-244` 的 full-compaction 请求估算包含 system prompt、非 deferred loop tools 与 messages。

**对 ohbaby 的影响**

- adopt：压缩前预算要看完整请求，而不是只看 history。
- adapt：system 在 kimi 的配置/LLM 层独立存在；ohbaby 已序列化进 messages。
- defer：deferred tools、完整 compaction 策略与 origin disposition 留给下一批压缩审查。

---

## 3.3 system prompt 与工具依赖方向

| 项目 | 观察 | 对 ohbaby 的取舍 |
|------|------|------------------|
| pi | system prompt builder 接收调用方选出的工具名；registry 解析不藏在 builder 内 | adopt push 模型 |
| opencode | system prompt 与 `SessionTools.resolve` 是并列数据流，在 request prepare 汇合 | adopt 依赖方向 |
| kimi-code | system prompt renderer 使用 profile/config 数据，不主动查询本轮 registry | adopt 依赖方向 |

三家共同点不是“全局永远只查询一次 scheduler”，而是 **prompt builder 不拥有 registry**。因此 4.1 的承诺限定为：

> 在每条 static/manual/runtime 路径中，同一次完整工具定义解析同时派生 prompt names 与 measurement/provider schemas。

MCP selectable menu prompt 仍有独立查询，本批不做更大范围合并。

---

## 3.4 token usage 与压缩口径

| 项目 | 做法 | 借鉴判断 |
|------|------|----------|
| pi | provider usage 作为已发送前缀 anchor，之后只估 trailing messages/new tools | 只借鉴“避免重复计量”的原则，不移植算法 |
| opencode | overflow/触发更依赖真实 assistant usage；挑选 compact 尾部可使用字符启发式 | 第一次压缩审查重点；4.1 不照搬 |
| kimi-code | UI usage、pending token count、full request estimate 分成不同用途 | 说明多口径可以存在，但必须明确用途和隔离 |

ohbaby 的结构差异是：EMA factor 被多条路径共用。公式为：

```text
sentHeuristic = estimate(messages + tools)
currentTokens = sentHeuristic × factor
factor_next   = EMA(provider_prompt_tokens / sentHeuristic)
```

因此纳入 tools 后，分子分母恢复同量纲；不能在 `currentTokens` 之后再额外加一遍 tool tokens。

三家都存在“触发、尾部选择、UI 展示使用不同估算”的情况。4.1 不以此为理由继续保留 ohbaby 的无意双源；但下一批压缩审查应区分：

- 决策口径是否真实反映下一次请求
- prune/compact 选择器是否只需相对估算
- UI 是否表达最近真实值、估算值或未知值

---

## 3.5 子代理：可借鉴的机制与不可照搬的 identity

### 可借鉴

- 三家主/子代理最终都复用相同的 LLM 请求和压缩核心，不为“caller type”复制一套 token/compaction 算法。
- 子代理通常只把最终摘要/结果回灌父代理，完整 child history 不注入父 transcript。
- 这支持 ohbaby 继续让主/子代理实时运行共用 ContextManager。

### 不可照搬

pi、opencode、kimi-code 的子代理隔离形态与 ohbaby 不同：

- opencode 以独立 child `sessionID` 为主要身份。
- kimi-code 为 child agent 分配独立 agent/session 空间。
- pi 示例以独立进程运行子代理。
- ohbaby 则允许多个 subagent instance 共用 child `sessionId`，依赖 `contextScopeId` 与 record `role` 区分。

因此参考项目中“只按 sessionID 调同一压缩函数”的做法，只能借鉴**核心算法复用**，不能推出“ohbaby 静态只传 sessionId 也能测准”。旧文档把这两层推论混在一起，是本轮被纠正的关键错误。

---

## 3.6 明确不借鉴

| 做法 | 原因 |
|------|------|
| 把 tools 放进 `AssembledContext` 或持久 history | schema 每 step 可变，会污染会话语义 |
| 再建完整 `RequestPayload` 与 `InterfaceProviderRequest` 并存 | 错误抽象、双真相源 |
| pi 的 usage-anchor 算法直接塞进 EMA 路径 | 两套模型混用，可能重复计量 |
| opencode 的字符除四替换当前 tokenizer heuristic | 对 CJK 与已有模型是倒退 |
| 参考项目的“sessionId 即 child identity”假设 | 与 ohbaby shared child-session 数据模型不符 |
| 为子代理 UI 提前扩 HTTP scope 参数和 tracker key | 用户已明确子代理只需内部自动压缩保护 |
| 在 4.1 调整 threshold/prune/summary/cache | 超出本批 |

---

## 3.7 对 02 的直接影响

1. 使用 `ContextMeasurementPayload`，不使用通用 `RequestPayload`。
2. system prompt 改为显式接收 names，registry 解析留在 composition/Lifecycle。
3. static/manual measurement 覆盖 schemas；system 已在 messages 内。
4. final step 在清空 outbound schemas 前解析 names。
5. primary static/manual 与 subagent runtime scoped measurement 分开。
6. 不复制三家的多套 usage 算法；4.1 只修当前无意的输入分叉。
7. 下一批压缩审查继续深入三家手动/自动压缩、tail selection、prune 和 stale usage，但不回灌到本批范围。
