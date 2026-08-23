# 讨论记录与已确认要点

> 2026-08-21 首次冻结议题；2026-08-23 完成代码、六个参考项目和官方协议讨论，并由用户确认本轮修订基线。
> 本文只保留已确认结论。诊断证据见 [01](./01-problem-analysis-and-current-state.md)，实施契约见 [02](./02-optimization-plan-and-change-scope.md)。

---

## 1. 背景与动机

improve-4 / 4.1 已经把实际发送给模型的 `messages + tools` 纳入 context occupancy，但当前 LLM client 仍存在三个直接问题：

1. cache read/write usage 在 provider 边界被丢弃，无法知道请求是否命中；
2. cache 请求字段没有按具体端点能力发送，Anthropic 主路径没有启用缓存；
3. system、runtime environment、MCP 菜单和多步工具消息的组装方式会主动破坏精确前缀。

本批不是在客户端实现一套 KV cache，而是把服务端 prompt cache 所需的**请求协议、usage 语义、稳定前缀和可验证性**补完整。

## 2. 用户确认的七项基线

| ID | 决策项 | 已确认结论 |
|----|--------|------------|
| D1 | TokenUsage | 使用 inclusive input + optional cache breakdown 的语义，见 §3 |
| D2 | 缓存能力 | 新增的是缓存能力策略；继续详细对齐 OpenAI-compatible 与 Anthropic 当前请求协议，不新增 client kind |
| D3 | 动态环境 | 删除 environment 中重复的 `Available tools`；借鉴优秀项目的 model context 注入方式，保证客户端生成可缓存的精确前缀 |
| D4 | request 收拢 | improve-4.1 的 `additionalMessages` 在 improve-5 收拢，测量与发送不再手工传播两遍 |
| D5 | MCP/tools | 确认 scope 内稳定顺序；新加载工具形成明确 cache epoch，不得让既有工具顺序漂移 |
| D6 | cache key | 基于 `sessionId + contextScopeId`，生成 opaque、bounded、versioned key |
| D7 | agent 对称性 | 主代理与所有子代理共同使用 improve-5 成果；每个 agent/context scope 隔离，但不得有“只完善主代理”的旁路 |

## 3. TokenUsage 语义

内部目标语义冻结为：

```ts
interface InputTokenBreakdown {
  readonly uncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly observed: {
    readonly cacheRead: boolean;
    readonly cacheWrite: boolean;
  };
}

interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputBreakdown?: InputTokenBreakdown;
}
```

约束：

- `inputTokens` 是 context/calibration 使用的完整输入量。
- breakdown 存在时：`uncached + cacheRead + cacheWrite === inputTokens`。
- breakdown 缺失表示 provider/gateway 没有报告缓存明细，不得补假零。
- `observed.cacheRead/cacheWrite` 表示 provider 是否明确提供该独立 accounting bucket；未提供的分类为满足互斥不变量取 0，但 UI/诊断必须显示 unavailable，不能解释成“后端没有读/写缓存”。
- `uncached` 表示未被 provider 归到 cache-read 或**独立计量的** cache-write bucket 的输入；DeepSeek miss 之后可能自动建缓存，仍属于 uncached，不与 write 重复计数。
- 命中率只在 `observed.cacheRead === true` 且 `inputTokens > 0` 时计算：`cacheRead / inputTokens`；明确 read=0 才是 0% 命中。
- cache write 数值只在 `observed.cacheWrite === true` 时对外解释；OpenAI 旧模型、DeepSeek、智谱/Kimi 不报告独立 write 时显示 unavailable。
- `totalTokens` 由 normalized `inputTokens + outputTokens` 得出；provider 原始 total 只用于交叉校验。
- 当前 run 的 aggregate breakdown 只有在所有非零输入请求都报告 breakdown 时才存在；aggregate 的 observed flag 仅在所有参与请求都观察到对应分类时为 true。否则相应 run 级比率/写入量显示 unavailable，单请求 metadata 仍保留已报告信息。
- 如果任一已完成的 `agent-step` 连整份终态 usage 都没有，run aggregate 必须标记 `usageComplete=false`；已知数字只能作为 partial/lower-bound 展示，run 命中率与写入量都 unavailable，不能把“缺一整个请求”误当成 0 token。

旧 `prompt_tokens / completion_tokens / total_tokens` 可在实施中提供窄兼容读取，但不得继续承担含混语义。

## 4. Compatible 与缓存能力策略

### 4.1 两个概念必须分开

- `interfaceProvider`：wire protocol 形状，仍为 `openai-compatible | anthropic`。
- `promptCache`：ohbaby 是否发送缓存相关请求字段，配置策略为 `auto | enabled | disabled`。

`promptCache` 只控制客户端请求增强，不能关闭 DeepSeek、智谱、OpenAI 等上游自行执行的隐式缓存；usage 解析在三种模式下都保持开启。

### 4.2 内部 request strategy

`promptCache` 由 provider id、规范化 base URL、interface kind，必要时再结合 model family，解析为以下内部策略之一：

| Strategy | 行为 |
|----------|------|
| `observe-only` | 不发缓存控制字段，只解析上游 usage |
| `openai-keyed-implicit` | 发送稳定 `prompt_cache_key`；依赖 OpenAI implicit breakpoint |
| `anthropic-top-level-auto` | 官方 Anthropic 发送顶层 automatic，并在最后一个稳定 system block 放一个显式 anchor，保护高 fan-out tool loop 超出 20-block lookback 的基础前缀 |
| `anthropic-explicit-last-block` | 在 Anthropic 转换后的最后一个 eligible content block 放一个显式 `cache_control`，用于已知不支持顶层 automatic 的兼容端点 |

这不是新的 provider 抽象层；它只是 adapter 内部用于隐藏协议差异的窄策略枚举。

### 4.3 `auto / enabled / disabled`

| 模式 | 语义 |
|------|------|
| `auto`（默认） | 只对内置可信 capability map 中的端点发字段；未知网关走 `observe-only` |
| `enabled` | 用户显式授权按当前 interface kind 的保守原生策略发送；若端点拒绝，错误必须可诊断，不做无界隐式重试 |
| `disabled` | ohbaby 不发送 key/control/breakpoint；仍解析上游自动缓存 usage |

官方协议复核发现：同为 compatible 并不表示支持同一字段。例如 ZenMux OpenAI endpoint 明确不支持 `prompt_cache_key`；DeepSeek Anthropic-format endpoint 会忽略 `cache_control`。因此只按 `interfaceProvider` 盲发字段的旧方案已否决。

## 5. 请求与前缀边界

### 5.1 request-shaped 收拢

improve-5 要建立一份权威 payload：

```text
PreparedModelRequest { messages, tools }
```

context measurement、overflow/compaction projection 和实际 LLM send 必须消费同一份 payload。`additionalMessages` 不再作为生命周期层反复传进多个测量分支；max-steps finalization 等尾部指令由统一 request assembler 按明确 placement 生成。

cache identity 与 capability 不属于 context occupancy payload，由 lifecycle/LLM client 在发送边界添加。

### 5.2 动态运行信息的位置

以下内容不再进入每 step 重建的 system：

- date、cwd、platform、osVersion、isGitRepo；
- MCP tool catalog/menu；
- 其他仅在本轮生效的 runtime context。

它们在 turn admission 时生成一次，作为 model-only synthetic text part 固定附着到发起本轮的 user 消息。该 part 必须随历史保留，使之后工具 step 和下一轮请求不会删除或移动旧快照。max-steps finalization 属于真正的 tail directive，不能与 turn context 混用。

如果现有 `synthetic` UI 行为不足以安全隐藏该 part，实施时应增加明确的 model-context metadata/投影，而不是把它退回 system。过滤必须只匹配 `model-context:runtime:v1` 这一窄类型：model serializer 继续可见，但 live UI、持久化 transcript、fallback title 和对外 export 不得把 cwd、OS 或 MCP 名称当成用户文本。该 part 会随消息存入本地数据库，这是恢复能力的一部分；日志和导出不能无意复制完整 prompt/runtime 内容。

### 5.3 稳定 system

主代理稳定 system：base → task → agent addon → subagent roles → custom instructions → 本轮复用的 memory snapshot。

子代理稳定 system：subagent base → task → agent addon。子代理继续遵守当前“不加载主代理 memory/custom instructions”的产品边界，但其 environment/runtime context 同样移到自己的 user turn，不能走旁路。

custom instructions、memory、system provider 的结果在一次 agent run/tool loop 内使用同一 snapshot；下一用户 turn 可重新加载，变化时视为合法 cache invalidation。

## 6. cache key 与 agent scope

canonical identity 使用现有 `scopedSessionKey({ sessionId, contextScopeId })` 语义，然后生成类似：

```text
ob:v1:<base64url(sha256(scopedSessionKey))>
```

要求：

- 主代理同一 session 稳定；
- 同一 child session 下两个 subagent context scope 的 key 不同；
- retry 使用同一 key；
- key 不包含 messages、cwd、用户文本或可读 session id；
- 不把完整 key 作为普通日志字段输出；诊断只保留截断 fingerprint。

OpenAI 官方建议每个 key 的相关流量维持在约 15 requests/min；scope 化 key 同时降低不同子代理共享热 key 的风险。

## 7. 工具顺序与 MCP 动态加载

1. `Available tools` 文本从 environment 删除，正式 tools schema 是工具定义的唯一权威来源。
2. MCP catalog 文本排序稳定，不能因为某个工具已加载就从历史快照里消失。
3. 每个 `{ sessionId, contextScopeId }` 独立维护工具顺序；主代理与子代理不能共享可变顺序状态。
4. 初始工具序列一旦发送即冻结；新加载 MCP 工具按选择顺序追加，不把已有工具重新按 registry/alphabetical order 排列。
5. 新工具第一次加入会改变 provider 最左侧 tools prefix，这是当前协议下不可避免的 cache epoch；完成加载后，后续请求必须复用新序列。
6. run-local prompt snapshot 不拥有可变工具序列：scope 维护 `ToolSequenceState`，每个 model step 导出一份 immutable `ToolSequenceSnapshot` 进入 `PreparedModelRequest`。
7. 子代理 scope 关闭时必须按 `{sessionId, contextScopeId}` 同时释放 ContextManager、MCP loaded state 和 tool-sequence state；删除整个 session 时再做批量清理。进程重启若没有重建已加载工具状态，应明确视为新 tool epoch，而不是承诺原工具前缀仍可命中。
8. Anthropic `defer_loading`、tool search、mid-conversation tool changes 能进一步保存工具前缀，但模型/协议限制较多，本批只记录为后续选项。

## 8. 观测、metadata 与持久化边界

- agent-step：`llm:complete` 和 assistant part metadata 保存 normalized TokenUsage；`run.llm.complete` worker transport 与 stream bridge 也必须无损携带同一 usage，不能在跨线程/事件投影时丢掉。auxiliary request 没有业务 assistant part，不为它伪造消息级 metadata。
- 当前 run：LifecycleResult 聚合 usage；不存派生命中率。
- 所有生产 LLM caller 显式标记 `agent-step / context-summary / session-title`；后两类先走 `observe-only`，但 summary 必须透传主/子代理的 session/scope，且 auxiliary usage 不混进 agent-step 命中率。
- 不建设跨 session 的聚合分析库；“不做长期统计”不等于删除现有消息级 usage metadata。
- cache breakdown 与 context occupancy 是两个投影：前者描述 provider 如何处理 input，后者描述 input 是否占窗口。

## 9. 本批不做

| 项 | 原因 |
|----|------|
| compact/prune 策略与阈值调整 | improve-5 先修正观测和请求；实施后再做第二次压缩复核 |
| GPT-5.6 显式 breakpoint 默认启用 | 当前 agent 历史本来 append-only；先用 implicit + key 取得真实 read/write 数据，再决定是否承担 content-block 复杂度 |
| 1h TTL、cache prewarm、价格引擎 | 成本和产品策略尚未确认 |
| 完整 WorldState/deferred tools | 超出本批最小闭环，且会扩大模型/端点兼容面 |
| 子代理专属 UI | 子代理必须正确观测和聚合，但仍遵守当前不进入用户主占用 UI 的边界 |

## 10. 用户确认记录（2026-08-23）

用户明确确认 D1–D7，并要求文档修订后启动子代理做独立验收和对齐。正式文档由主代理维护；子代理只提供只读 findings，最终修改由主代理吸收。
