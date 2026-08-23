# 2. 优化方案与改动面

> 本文是后续实施会话的执行契约。规划轮不修改业务代码。约束来自 [00](./00-discussion.md)，诊断证据来自 [01](./01-problem-analysis-and-current-state.md)，验收门见 [04](./04-test-and-acceptance.md)。

---

## 2.1 目标架构

```text
agent run（primary 或 subagent）
  │
  ├─ scoped identity(sessionId, contextScopeId)
  │      └─ opaque prompt cache key
  │
  ├─ turn admission
  │      ├─ 固定 system / memory / custom snapshot
  │      └─ runtime context → 发起本轮的 user message synthetic part
  │
  ├─ scope tool sequence
  │      ├─ scope-owned mutable ToolSequenceState
  │      └─ 每 step 导出 immutable snapshot；lazy MCP tool 只追加并形成明确 cache epoch
  │
  └─ ContextManager.prepareTurn
         └─ PreparedModelRequest { messages, tools }
                    │
                    ├─ measurement / overflow / compaction projection
                    └─ LLM send（消费同一对象）
                              │
                              ├─ capability resolver
                              │    policy + endpoint → request strategy
                              └─ interface-provider adapter
                                   wire fields ↔ normalized TokenUsage
                                             │
                                             ├─ request metadata
                                             ├─ current-run aggregate
                                             └─ inclusive input calibration
```

这条链路只有一套。主代理与子代理不会各自实现 request assembler、cache parser 或 key 生成器；`contextScopeId` 负责隔离同一 session 下的不同 agent context。

## 2.2 决策与问题追踪

| 决策 | 解决 | 落点 |
|------|------|------|
| inclusive `TokenUsage` + optional breakdown | P1、P9 | adapter、LLM client、metadata、lifecycle |
| attempt-local stream state | P3 | `core/llm-client/streaming.ts` |
| endpoint capability resolver | P2 | config + interface-provider 边界 |
| scoped opaque cache key | P4、P8 | LLM request context |
| 单一 `PreparedModelRequest` | P6、P10 | ContextManager 与 Lifecycle 边界 |
| user-turn runtime snapshot | P5、P8 | message/context/system-prompt |
| scope tool sequence + cache epoch | P7、P8 | tool resolver、MCP menu |
| primary/subagent 对称测试门 | P8 | contract / integration / real smoke |
| 显式 request purpose | P11 | lifecycle、context summary、session title 与 LLM client 边界 |

## 2.3 TokenUsage 的唯一内部契约

### 2.3.1 类型与不变量

内部只保留 [00 §3](./00-discussion.md#3-tokenusage-语义) 冻结的 camelCase 契约：

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

规范化规则：

1. 所有值必须是有限、非负整数。
2. `totalTokens` 始终由 `inputTokens + outputTokens` 计算；上游 total 只做诊断校验。
3. breakdown 存在时必须严格满足 `uncached + cacheRead + cacheWrite === inputTokens`。
4. 上游完全未报告 cache 分类时省略 breakdown，不能合成全 0。
5. breakdown 存在时，缺失分类为满足互斥不变量取 0，但 `observed` 必须为 false；明确 number 0 才是 observed=true 的真实 0。
6. `uncached` 只表示未归入 read/独立 write accounting bucket，不表示这些 token 之后绝不会被后端自动写入 cache。
7. 若网关返回矛盾值，例如 `read + write > prompt`，保留可信的 inclusive input/output，丢弃 breakdown 并记录结构化诊断；不得产出负数或 >100% 命中率。

`InterfaceProviderTokenUsage`、LLM client `TokenUsage` 和 lifecycle result 不得继续维护三套含义相近但字段不同的类型。实施允许用 type alias 或一次窄映射兼容现有引用，但领域语义只能有一份。

### 2.3.2 provider 映射

| 原始协议 | `inputTokens` | breakdown 形成条件与映射 |
|----------|---------------|---------------------------|
| OpenAI Chat | `prompt_tokens` | cached/write 任一 number 字段存在时形成 breakdown；对应 observed=true，缺失分类=0/observed=false；uncached = prompt-read-write |
| 智谱 OpenAI format | `prompt_tokens` | nested cached number 存在时：read=cached/observed，write=0/unobserved，uncached=prompt-read |
| DeepSeek OpenAI format | 优先 `prompt_tokens`；否则 hit+miss | prompt+hit 推导 miss；prompt+miss 推导 hit；两者都有则验证总和；无 prompt 但 hit+miss 都有时求和。无 prompt 且仅一个分类时整份 input usage 不可信。write=0/unobserved |
| Kimi-compatible | `prompt_tokens` | nested 或顶层 cached number 存在时：read observed，write unobserved；优先级固定 |
| Anthropic Messages | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | read/creation 任一为 number（含 0）时形成 breakdown；每个字段分别决定 observed，uncached=input |

对所有协议，`outputTokens` 取 completion/output，`totalTokens` 最终重算。

OpenAI adapter 使用窄的 `RawCompatibleUsage` extension 描述 nested write 与 DeepSeek/Kimi 顶层字段；从 SDK object 边界做 runtime type guard 后进入 normalizer，不把 vendor extension 或 `any` 泄漏到 canonical usage。

### 2.3.3 stream、retry、aggregate 与 calibration

- Anthropic attempt 内先积累 raw cumulative components：`message_start.message.usage` 初始化；后续任一 usage-bearing `message_delta` 都可更新 input/cache/output。
- 字段缺失不覆盖；对 input/cache 等累计非负计数使用单调合并，后续更大的明确值更新，0 或更小值不能把已有正数清空并应在违反单调性时诊断。这样既兼容 start 后的 placeholder 0，也能接收 server-tool 场景 final delta 增加的 input/cache。
- attempt 结束后再一次性 normalize、设置 observed flags 并验证不变量，不能在 start/delta 各自产出互相覆盖的半成品 TokenUsage。
- 每个 retry attempt 新建 accumulation state；失败 attempt 的 text、reasoning、tool call、finish/raw reason 和 usage 都不能泄漏到下一 attempt。reasoning delta 与 text/tool delta 一样，一旦对外发出就不再做透明 provider retry。
- 单次请求若没有终态 usage，则保持 unavailable，不用上一次请求数字填补。
- run aggregate 额外维护 `usageComplete`。任一已完成 `agent-step` 完全没有终态 usage 时设为 false；已知 input/output/total 仍可累加，但必须标记为 partial/lower-bound，不得伪装成完整 run 总量，也不得计算 run 命中率或写入量。
- 仅在 `usageComplete=true` 且所有 `inputTokens > 0` 的已完成请求都带 breakdown 时，aggregate breakdown 才存在。对应 aggregate observed flag 是参与请求的逻辑 AND；read 未全量 observed 时 run 命中率 unavailable，write 未全量 observed 时 run write unavailable。
- calibration 永远使用 normalized `inputTokens`。cached input 仍占 context window，不使用 `uncached` 或 Anthropic 裸 `input_tokens`。
- assistant part metadata 保存同一 normalized shape；现有 `promptTokens / completionTokens / totalTokens` metadata 只读兼容，不回写两套字段。
- 当前公开 streaming result 若属于既有兼容面，实施期提供一个窄的 deprecated alias view：`prompt_tokens → inputTokens`、`completion_tokens → outputTokens`、`total_tokens → totalTokens`。provider adapter 与内部消费者只使用 canonical fields；移除 alias 必须留到明确的 breaking release。

## 2.4 prompt cache 配置与能力解析

### 2.4.1 用户配置

在 `apiConfig` 增加：

```ts
promptCache?: "auto" | "enabled" | "disabled";
```

默认是 `auto`。配置加载器必须校验枚举并将其解析到 `LLMConfig`。三种模式都解析 usage：

- `auto`：只对内置可信 endpoint capability 发送字段。
- `enabled`：用户显式要求按当前 wire kind 的保守原生策略发送；错误保留 provider 原因与选中 strategy，不能无界降级重试。
- `disabled`：ohbaby 不发送 key/control/breakpoint；无法关闭 provider 自身的自动 cache，仍观测 usage。

### 2.4.2 capability resolver

resolver 的输入至少包含 `provider`、规范化 `baseUrl`、`interfaceProvider`、必要时的 model family；输出为内部 request strategy。它必须是纯函数并有表驱动测试，不能散落成多个 `if (provider === ...)`。

official endpoint 匹配必须解析 URL 后严格比较 lowercase hostname、scheme 与有效 port，并允许已知 `/v1` path；禁止用 `includes("openai.com")` 一类字符串判断。provider id 只能作为辅助信号，不能让 `provider: "openai" + proxy baseURL` 获得 official capability。

`auto` 的首批可信矩阵：

| 端点 | interface | strategy | 原因 |
|------|-----------|----------|------|
| OpenAI official | OpenAI-compatible | `openai-keyed-implicit` | 官方支持 key；当前 agent 历史适合 implicit append-only |
| Anthropic official | Anthropic | `anthropic-top-level-auto` | 顶层 automatic 推进尾部，稳定-system anchor 保护 >20 blocks 的高 fan-out loop |
| DeepSeek official | OpenAI-compatible | `observe-only` | disk cache 自动开启 |
| 智谱 official | OpenAI-compatible | `observe-only` | 自动缓存，不需 ohbaby 私有开关 |
| Kimi official/已知 compatible | OpenAI-compatible | `observe-only` | 先解析 usage，避免假设 OpenAI key 能力 |
| ZenMux OpenAI endpoint | OpenAI-compatible | `observe-only` | 官方文档明确不支持 `prompt_cache_key` |
| ZenMux Anthropic endpoint | Anthropic | `anthropic-explicit-last-block` | 文档支持 block `cache_control`，顶层 automatic 未明确 |
| DeepSeek Anthropic endpoint | Anthropic | `observe-only` | 文档说明 `cache_control` 被忽略 |
| 未知 compatible gateway | 任一 | `observe-only` | wire 兼容不等于扩展字段兼容 |

`enabled` 不改 interface kind：OpenAI-compatible 选择 keyed implicit；Anthropic 优先使用与已知端点匹配的 top-level 或 explicit strategy。未知 Anthropic gateway 使用显式 last-cacheable-block，比假设顶层 automatic 更保守。若没有可缓存 block，则退化为 observe-only，并给出诊断。

### 2.4.3 wire 行为

| strategy | wire 动作 |
|----------|-----------|
| `observe-only` | 不加缓存控制字段 |
| `openai-keyed-implicit` | Chat Completions 顶层发送 `prompt_cache_key`；继续发送 `stream_options.include_usage` |
| `anthropic-top-level-auto` | Messages 顶层发送 automatic `cache_control`；若有稳定 system，则把 string 转为 text blocks 并在最后一个 stable system block 加一个 explicit ephemeral anchor，总 marker 数仍远低于 4 |
| `anthropic-explicit-last-block` | 把 cache breakpoint 放在最后一个可安全缓存的 content block；最多一个，由 adapter 转换时注入，不污染 OpenAI-shaped domain message |

本批不默认发送 GPT-5.6 `prompt_cache_options` 或 content `prompt_cache_breakpoint`。SDK `openai@4.104.0` 类型未覆盖当前字段时，请求与响应都使用隔离的 wire extension type、runtime guards 与快照，不做高风险 major upgrade，也不把 `any` 扩散到 adapter 外。

### 2.4.4 scoped cache key

先使用现有 `scopedSessionKey({ sessionId, contextScopeId })` 得到 canonical identity，再生成：

```text
ob:v1:<base64url(sha256(canonicalIdentity))>
```

约束：

- primary 同一 session 稳定；不同 session 不同。
- 同一 session 的两个 subagent scope 不同；primary 与 subagent 也不同。
- 同一请求 retry 使用同一 key；消息增量、compact、MCP load 不改 key。
- key 不包含 model messages、cwd、用户文本或明文 session id；日志只允许短 fingerprint。
- cache key 是 provider 路由提示，不是客户端内容正确性的 cache lookup key；不需要把 tool epoch 编入 key。
- 该 identity/key 由所有 agent-step 统一生成，但只有支持 key 的 wire strategy 会发送。Anthropic official 依赖 exact content + `cache_control`，不同 scope 若字节完全相同可以由服务端安全复用；context isolation 不能依赖 provider cache key。

### 2.4.5 request purpose 与辅助 LLM 调用

所有生产 `streamChatCompletion` caller 必须显式声明：

```ts
type LLMRequestPurpose =
  | "agent-step"
  | "context-summary"
  | "session-title";
```

规则：

- primary 与 subagent 的 `agent-step` 必须携带 `sessionId + contextScopeId`，并使用用户配置的 prompt-cache policy。
- `context-summary` 必须从 `AssembledContext` 透传同一 session/scope；它走 canonical TokenUsage 与 attempt-local retry，但 improve-5 默认 `observe-only`。summary history 会重组，真实复用收益尚不足以证明 creation 成本合理。
- `session-title` 是短、一次性 auxiliary request；补充 primary session identity 与 purpose，但默认 `observe-only`。
- auxiliary complete response 仍使用 canonical usage；若 owning service 暴露诊断，必须带 purpose/scope。它不混入 agent-step cache hit aggregate，也不用于 context calibration，更不能冒充主代理 usage。本批不为它新建长期统计库。
- 为兼容外部/旧 caller，缺 purpose 或缺 agent-step identity 的调用强制 `observe-only` 并给出诊断，绝不能从空值生成共享 key；仓库内三个生产 caller 则由 contract guard 要求全部显式传入。
- 将来若真实数据证明 summary 值得缓存，应为该 purpose 单独开启策略；任何生成出的 key 仍必须来自其 `sessionId + contextScopeId`，不能改用 prompt hash。

这样既保证共享 LLM client 没有旁路，又避免为了“全都缓存”给一次性请求支付无意义的 cache creation。

## 2.5 收拢 request-shaped payload

### 2.5.1 单一权威对象

`PreparedTurn` 改为携带一份只读 request payload：

```ts
interface PreparedModelRequest {
  readonly messages: readonly ChatCompletionMessage[];
  readonly tools: ChatCompletionCreateParams["tools"];
}

interface PreparedTurn {
  readonly request: PreparedModelRequest;
  // usage / compaction / assembledAt / ...
}
```

ContextManager 的初次测量、overflow projection、prune/compact 后重测、force prepare 和最终发送，都消费或返回这个对象。Lifecycle 不再一边拿 `prepared.messages`、另一边保存旧 `tools`；测试应以对象 identity/深等价证明“量到的就是发出的”。

cache policy、scoped key、temperature、model、signal 等发送控制不进入 `ContextMeasurementPayload`，因为它们不占 context token；它们通过独立的 request context 交给 LLM client。

### 2.5.2 取代 `additionalMessages`

不再用一个含义宽泛的 `additionalMessages` 让 lifecycle 和 ContextManager 在每条分支手工保持同步。改为两类有 placement 的输入：

1. `turnContext`：在 turn admission 时生成并固定到发起 user message，属于历史的一部分。
2. `tailDirectives`：例如 max-steps finalization，仅对当前 model request 生效，由 request assembler 在**一次**位置追加，并自动进入所有 measurement/projection。

实现名称可按现有模块风格调整，但必须保持以上两个语义分开。不得把 environment 当作 ephemeral tail，也不得让 max-steps 指令伪装成历史 runtime snapshot。

## 2.6 稳定 system 与 user-turn runtime snapshot

### 2.6.1 每个 agent run 的 snapshot

每次 primary 或 subagent run 开始时创建一次 `AgentRunPromptSnapshot`：

- system provider 的 base/task/addon/roles；
- primary 的 custom instructions 和 memory snapshot；
- 当前 scope 的 runtime/environment context 与 MCP catalog user-part snapshot。

同一 tool loop 的后续 model steps 与 retry 复用该 run-local prompt snapshot。下一次用户 turn/新的 subagent run 可以重建；新的 runtime/catalog 内容只能成为 append-only user suffix。

snapshot 由具体 Lifecycle run 持有并显式传给 ContextManager，run 结束即释放；禁止在共享 ContextManager 上放一个可变的“当前 snapshot”，否则并行 primary/subagent 会互相覆盖。inspect/manual compact 等非 lifecycle 操作创建自己的 operation-local snapshot。跨 run 仍需保留的是 scope `ToolSequence`/MCP loaded state，不是整份 system/memory 快照。

工具状态不放进 `AgentRunPromptSnapshot`：每个 scope 单独拥有可更新的 `ToolSequenceState { orderedSchemas, epoch }`，每个 model step 在 prepare 时导出 immutable `ToolSequenceSnapshot` 并放入 `PreparedModelRequest`。这样同一 run 中 lazy MCP load 可以合法让**下一 step**进入新 epoch，同时当前已测量请求仍不可变；若把 tool sequence 冻结进整次 run snapshot，这两个要求会直接冲突。

### 2.6.2 system 边界

| agent | 稳定 system | 不再进入 system |
|-------|-------------|-----------------|
| primary | base → task → agent addon → subagent roles → custom instructions → 本 run memory snapshot | date、cwd、platform、osVersion、isGitRepo、MCP menu、`Available tools` |
| subagent | subagent base → task → agent addon | 自己的 date/cwd/platform/isGitRepo、MCP menu |

子代理继续遵守“不读取 primary memory/custom instructions”的现有产品边界；这是内容差异，不是 cache/request 实现差异。

### 2.6.3 runtime context 的附着规则

环境和 MCP catalog 生成结构稳定、带边界标签的文本，例如 `<environment_context>` / `<mcp_tool_catalog>`。它作为 model-only synthetic part 附着到**发起本轮的 user message**：

- 对 model serializer 可见；live UI、持久化 UI transcript、fallback session title 与默认对外 transcript/export 均不把它当用户正文展示。
- 以稳定 metadata kind（例如 `model-context:runtime:v1`）与 user message id 建立幂等约束；与 user turn 一起持久化/恢复，同一 run、崩溃恢复或 resume 都不重复附着。
- tool result、assistant continuation、retry 不重新生成或移动它。
- compaction 前参与 measurement；compaction 后是否被摘要按普通历史策略处理，但不能在 serializer 尾部重新补一份旧快照。
- primary 和 subagent 各自在自己的 transcript/context scope 创建，不跨 scope 复制。

新增独立的 `initiatingUserMessageId?: string`，由 agent runner 只在本次 run 确实创建/接纳新 user turn 时设置，并经 run-manager 透传给 Lifecycle。Lifecycle 校验该消息属于当前 session/scope 且 role=user 后附着 snapshot；现有、会随 assistant/tool lineage 更新的 `parentMessageId` 继续只管消息父子关系。resume 没有新 user message 时，`initiatingUserMessageId` 缺失，必须复用历史中的已有 runtime part，不能猜“最后一条 user”或回写旧消息。

快照内容不得加入 request id、随机 UUID、`assembledAt` 毫秒值等仅为客户端诊断而存在的噪声；date 等确实需要告诉模型的字段使用固定格式。所有 tag/content 做结构转义，避免 cwd 或 catalog 文本破坏边界。

如果 `synthetic` 现有语义无法同时满足持久化与 UI 隐藏，应增加窄的 model-context part 标记及 projection，不得退回每 step system 注入。过滤只识别 `model-context:runtime:v1`（或最终冻结的等价 kind），不能隐藏所有 synthetic text。runtime part 会随 user message 存入本地数据库以支持恢复；默认 export/transcript 应过滤或明确标注这一内部 part，日志禁止复制其完整 cwd/OS/MCP 内容。

`packages/ohbaby-agent/src/core/system-prompt/layers/environment.ts` 中的 `Available tools` 直接删除；正式 `tools` schema 是模型可调用能力的唯一权威描述。

## 2.7 tools 顺序与 MCP 动态加载

### 2.7.1 scope tool sequence

为每个 `{ sessionId, contextScopeId }` 维护 model-facing `ToolSequence`：

1. 初始 built-in/static tools 按 registry 的稳定注册顺序冻结。
2. lazy MCP tool 首次加载时按用户/模型选择顺序追加。
3. 已发送工具永不因 registry filter、字母排序或加载状态回到更早位置。
4. 重复 load 幂等，不改变位置。
5. primary 与各 subagent 分别维护序列；closed scope 与整个 session 都有对应的清理入口。
6. 每个 `PreparedModelRequest` 持有 immutable tool snapshot；prepare 之后到 send 之前发生的 load 只进入下一 model step，不能原地修改已测量请求。

工具 `name/description/input_schema` 任一变化、权限撤销或 MCP 断开都是真实 prefix invalidation。不可用工具必须移除，不能为了命中继续向模型宣传；移除时形成新 epoch，并保持 surviving tools 的相对顺序。

### 2.7.2 cache epoch

首次请求为 epoch 0；每次新 schema 第一次加入递增一次。epoch 只用于测试、诊断和解释 miss，不进入 scoped cache key。每个 epoch 内，连续 model steps 的 tool array 必须 byte/deep stable。

MCP catalog snapshot 使用稳定 tool identity 排序，并保持已经列出的名称不会从同一历史 user part 消失。新一轮可附着新的 catalog/status 快照，但只能作为新 user suffix；不能回写旧 user part 或改 system。

本批不实现 Anthropic `defer_loading`、tool search 或 mid-conversation tool changes；这些是后续在真实命中数据基础上的优化。

### 2.7.3 生命周期、清理与重启

`ContextManager`、`McpToolMenu` 和 tool-sequence owner 都提供同语义的 `disposeScope(sessionId, contextScopeId)`；`cleanupClosedSubagentScope` 必须调用三者，避免共享 child session 中已关闭 agent 的历史、loaded set 和 sequence 残留。`disposeSession(sessionId)` 继续作为删除整个 session 时的批量清理，并覆盖其全部 scope。清理操作应幂等。

当前 MCP loaded set 没有持久化恢复契约。若进程重启后不能从持久化状态重建相同 ordered schemas，则为该 scope 建立一个新的 tool epoch：scoped cache key 仍可相同，但首次请求允许 miss/write，之后同 epoch 必须重新稳定并产生 read。runtime user part 的恢复不等于 tool prefix 在重启后必然 byte-stable。

## 2.8 分阶段实施与完成信号

### 阶段 A — usage 正确性

改动：

- `services/interface-providers/types.ts`
- `services/interface-providers/openai-compatible.ts`
- `services/interface-providers/anthropic.ts`
- `core/llm-client/types.ts`、`streaming.ts`
- `core/message/types.ts`
- `core/lifecycle/lifecycle.ts`
- `runtime/run-manager/worker.ts`、`adapters/ui-runtime/stream-bridge-run-event-source.ts`
- `adapters/ui-runtime/prompt-context.ts`、`services/session/title-generator.ts`
- 对应 provider / streaming / lifecycle tests

完成信号：官方与 compatible fixture 都能输出合法 inclusive usage；Anthropic start usage 不丢；retry 不串 attempt；metadata、aggregate、worker event transport 和 calibration 语义一致；三个 production request purpose 都没有 usage 旁路。

### 阶段 B — request capability

改动：

- `config/llm/types.ts` 及 config loader/validator/writer/tests；`/connect` 等无关重写不得丢掉已配置 policy
- capability resolver 与 scoped cache-key helper
- `InterfaceProviderRequest` 和两 adapter 的 request builder/tests
- 发送链路透传 `purpose + sessionId + contextScopeId + promptCache`

完成信号：表驱动 matrix 与 wire snapshot 全绿；未知 endpoint 在 auto 下无扩展字段；primary/subagent key 稳定且隔离。

### 阶段 C — request/prefix 收拢

改动：

- `core/context/types.ts`、`context-manager.ts`、serializer/message model
- `core/lifecycle/lifecycle.ts`
- `core/agents/runner.ts`、`runtime/run-manager` types/worker（透传独立 initiating user id）
- `core/system-prompt/assembler.ts`、`layers/environment.ts`
- `adapters/ui-runtime/composition.ts`、`adapters/ui-state/persistent-store.ts`
- `services/session/title-fallback.ts` 与默认 transcript/export projection
- `mcp/integration/dynamic-tool-menu.ts` 或一个窄的 scope tool-sequence owner
- 对应 context/system/MCP/lifecycle integration tests

完成信号：`additionalMessages` 双向传播消失；measurement 与 send 使用同一 payload；runtime context 固定在 initiating user；`Available tools` 删除；同 epoch tools 顺序稳定。

### 阶段 D — 联合验收

不再增加新产品能力，只做：

- provider contract + primary/subagent integration；
- 至少两工具的真实 scheduler/tool loop；
- 动态 MCP load 前后 epoch 断言；
- 扩展 `scripts/run-real-smoke.mjs`（或新增 cache 专用 runner/package scripts），让 OpenAI-compatible 与 Anthropic 具有独立 env gate、串行执行和明确 pass/skip/fail；
- key-gated real cache smoke，并覆盖一次真实 epoch 恢复序列；
- improve-4 / 4.1 request-shaped occupancy、compact、summary、calibration 全量回归。

完成信号见 [04 §4.10](./04-test-and-acceptance.md#410-发布门)。D 通过后才进入 context 模块第二轮实现程度复核。

## 2.9 兼容、迁移与观测

- **配置：** `promptCache` 缺失按 `auto`，旧 `model.json` 无需迁移。
- **存储：** 无数据库 schema migration；旧 usage metadata 缺 breakdown 按 unavailable，不按 0。runtime part 随原 user message 本地持久化，但默认 transcript/export 按 metadata kind 过滤，不把 cwd/OS/MCP catalog 当用户正文。
- **SDK：** Anthropic 当前 SDK 原生支持所需字段；OpenAI 使用 adapter-local wire extension。
- **日志：** 可记录 provider、strategy、cache-key fingerprint、scope kind、cache epoch、normalized usage；不得记录完整 key、完整 prompt 或 API key。
- **事件：** agent-step 的 `llm:complete`、`run.llm.complete` worker/bridge payload 和 assistant part 使用同一 normalized usage；auxiliary request 不伪造业务消息。命中率现场计算，不持久化派生百分比。
- **Context 边界：** `core/context` 只认 `{ messages, tools }` 与 inclusive usage，不出现 vendor cache 字段。

## 2.10 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| compatible gateway 拒绝扩展字段 | auto 白名单；enabled 错误带 strategy | 配置改为 disabled，usage 观测不回滚 |
| SDK 类型落后于 wire | adapter-local extension + snapshot | 关闭对应 strategy |
| runtime part 在 UI 泄漏或恢复丢失 | serializer/store/UI 三层 contract tests | 保留 part，临时只隐藏 UI；不能改回每 step 尾插 |
| tool load 造成 miss | 明确 epoch、只追加 | 禁止加载该 lazy tool；不伪造旧 schema |
| inclusive calibration 改变 compact 时机 | 对照 4/4.1 回归与 fixture | 修 normalizer；不得回滚为 uncached 分母 |
| partial usage 被误算为 0% | optional breakdown + aggregate completeness | 隐藏 run hit rate，而不是补 0 |

### 2.10.1 improve-4.1 验收条款的定向替代

improve-5 只替代 improve-4.1 中“final system 含 `Available tools: ...`”这一旧文本断言：正式 tool schemas 已成为唯一权威来源，environment 不再复制工具名称。improve-4.1 的真正正确性约束仍全部保留，尤其 final-step `tools=[]` 时 measurement 与 send 必须同时看到空 tools，max-steps directive 仍只发送一次且必须计入占用。不得把删除重复文本误解成撤销 tools-aware measurement。

## 2.11 本批明确不做

- compact/prune 策略和 95% / 85% 阈值调整；
- GPT-5.6 显式 breakpoint 默认、1h TTL、cache prewarm、价格引擎；
- 第三种 interface-provider kind；
- 完整 Codex WorldState、Anthropic deferred tools；
- 跨 session 的 cache 命中分析库；
- primary/subagent 以外另造一条特殊请求链路。
