# 6. token 文件职责复核与后续收口方案

> 复核日期：2026-08-25
>
> 性质：improve-5 与 improve-4～5 联合回归后的设计复核；2026-08-25 已批准并按 H1/H2 两批实施。实际 commits、门禁和审查结果见 [07 验收](./07-token-responsibility-follow-up-acceptance.md)。
>
> 范围：provider usage 归一化、请求前 token 估算、prepared request 计量、消息 usage metadata 持久化及相应测试。

---

## 6.1 用户问题

improve-5 完成后，复核以下文件哪些仍然必要、哪些应该删除：

- `packages/ohbaby-agent/src/services/interface-providers/token-usage.ts`
- `packages/ohbaby-agent/src/services/interface-providers/token-usage.unit.test.ts`
- `packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts`
- `packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts`
- `packages/ohbaby-agent/src/core/message/token-usage-metadata.ts`
- `packages/ohbaby-agent/src/core/message/token-usage-metadata.unit.test.ts`
- `packages/ohbaby-agent/src/core/context/token-estimation.ts`

后续问题是：

1. `token-usage-metadata.ts` 应如何修改并接入生产链路？
2. `token-estimation.ts` 应如何升级为不易遗漏字段的接口？
3. `token-usage-metadata.unit.test.ts` 应如何完善？
4. 六个参考项目如何划分同类 token 职责，哪些设计适合 ohbaby-agent？

## 6.2 结论

**当前 improve-5 契约下，这七个文件都不应整文件删除。** 它们处在六项职责中，不是三套互相替代的 token 实现：

```text
请求发送前
  tokenCounting.ts
    └─ 文本如何近似换算为 token、模型窗口预算是多少

  token-estimation.ts
    └─ PreparedModelRequest 中哪些内容参与本次请求估算

请求完成后
  interface-providers/token-usage.ts
    └─ provider 原始 usage 如何变成 canonical inclusive TokenUsage

请求完成后的进程内消费
  ContextManager / compaction-policy / context-window-usage
    └─ provider inclusive input 如何校准 scoped heuristic，如何投影窗口占用

  lifecycle/token-usage.ts
    └─ 多个 agent step 的单请求 usage 如何聚合，并显式标记 partial

消息持久化边界
  message/token-usage-metadata.ts
    └─ canonical usage 如何写入，以及数据库中的新旧 metadata 如何安全读回
```

| 文件 | 结论 | 理由 |
|------|------|------|
| `interface-providers/token-usage.ts` | 必须保留 | OpenAI-compatible、DeepSeek/Kimi 字段与 Anthropic stream usage 的协议归一化边界 |
| `interface-providers/token-usage.unit.test.ts` | 必须保留 | 锁定 inclusive input、互斥 breakdown、observed 与 stream 累积语义 |
| `llm-model/tokenCounting.ts` | 必须保留 | provider 返回真实 usage 以前，compact、预算和 UI context occupancy 仍需要请求前估算 |
| `llm-model/tokenCounting.unit.test.ts` | 必须保留 | 锁定启发式权重、model profile、limit/budget fallback |
| `message/token-usage-metadata.ts` | 保留并收口 | 它是持久化信任边界，但当前 writer 留在 Lifecycle，读写所有权未统一 |
| `message/token-usage-metadata.unit.test.ts` | 保留并扩充 | improve-5 U20 明确要求 canonical round-trip 与 legacy read compatibility |
| `context/token-estimation.ts` | 必须保留并升级接口 | 它决定 prepared request 的计量边界，不能退回 messages/tools 平行参数 |

只有产品明确撤销“消息级 usage 可持久化读取和旧记录兼容”时，才可以成组删除 metadata reader、测试、legacy 类型、real-cache metadata 读取和 U20 文档契约；不能只删其中一个文件。当前 [00 §8](./00-discussion.md#8-观测metadata-与持久化边界) 已明确“不做长期统计不等于删除现有消息级 usage metadata”，因此不采用该破坏性方案。

## 6.3 为什么这些 token 职责不是重复实现

### 6.3.1 provider usage 是请求后的事实

`services/interface-providers/token-usage.ts` 处理外部协议差异：OpenAI-compatible nested `cached_tokens`、DeepSeek root hit/miss、compatible cache-write 以及 Anthropic start/delta 的累计字段。它必须保证：

```text
inputBreakdown 存在时：
uncached + cacheRead + cacheWrite = inputTokens

始终：
totalTokens = inputTokens + outputTokens
```

该模块只输出 provider-neutral `TokenUsage`，ContextManager、Lifecycle 和 UI 不应读取 vendor 原始字段。

### 6.3.2 tokenCounting 是请求前的近似能力

真实 provider usage 只有请求完成后才出现，不能用于发送前判断本次请求是否越过 context window。`tokenCounting.ts` 因而继续负责：

- 文本启发式估算；
- model profile 与 context limit；
- input/output/safety margin 预算；
- provider usage 到达后的 calibration 基线。

它应继续被清楚命名为 heuristic，不宣称是 provider tokenizer 的精确结果。可选的小型清理是检查 `HeuristicTokenCounter` 是否需要继续作为导出类型；如果没有包外消费者，可收紧导出，但不删除文件。

### 6.3.3 token-estimation 决定“估算什么”

`tokenCounting.ts` 只回答“给定文本约有多少 token”；`token-estimation.ts` 回答“本次 prepared request 的哪些 wire-shaped 内容要交给 estimator”。当前纳入 messages 和 tools，这是 improve-4.1/5 保证测量与发送同源的关键边界。

### 6.3.4 metadata 是另一条信任边界

provider normalizer 面对网络协议；metadata reader 面对数据库中的 JSON、历史 schema 和可能损坏的数据。两者都检查非负整数和不变量是有意的边界内防御，不属于应强行 DRY 的重复。前者不能理解 legacy `promptTokens`，后者也不应理解 DeepSeek/Anthropic 原始字段。

### 6.3.5 calibration 与 Lifecycle aggregate 也不是 parser

Context calibration 消费单请求的 inclusive `inputTokens`，按 `sessionId + contextScopeId` 修正下一次请求前的启发式估算；它输出的是 `ContextUsage`，不是 provider 事实的另一种存储。Lifecycle aggregate 则把同一 run 中多个 agent step 的 `TokenUsage` 累加成 `LifecycleTokenUsage`，并用 `usageComplete` 表示中间是否缺失 usage。两者均不解析 provider 原始字段，也不读 legacy metadata，不应并入 provider normalizer 或 storage codec。

事件/worker/stream bridge 只传输 canonical usage，是数据投影链而不是第七种计数算法。主代理与子代理共用以上实现，但 calibration、history 和 durable parts 继续按各自 `contextScopeId` 隔离。

## 6.4 `token-usage-metadata.ts` 修改方案

### 6.4.1 目标职责

把当前“Lifecycle 私有 writer + message 公共 reader”的分裂状态收拢为一个双向存储 adapter：

```ts
export function createTokenUsageMetadata(
  tokenUsage: TokenUsage | undefined,
): Pick<PartMetadata, "tokenUsage"> | undefined;

export function readTokenUsageMetadata(
  metadata: unknown,
): TokenUsage | undefined;
```

`create` 准确表达“构造可持久化 metadata，但不执行数据库 I/O”；不采用容易暗示 I/O 的 `write`，也不采用暗示输出字符串的 `serialize`。全仓只保留 `create...` / `read...` 这一组术语。

### 6.4.2 writer 规则

`createTokenUsageMetadata` 应：

1. 只接受 canonical `TokenUsage`，不接受 legacy shape；
2. 对 `inputBreakdown` 和 `observed` 做复制，避免 metadata 与事件对象共享可变引用；
3. 永远用 `inputTokens + outputTokens` 重算 `totalTokens`；
4. `tokenUsage` 缺失时返回 `undefined`，不写空对象；
5. 不在这里计算命中率等派生指标。

Lifecycle 当前私有的 `toPartTokenUsageMetadata` 迁入本模块，正常文本完成和工具调用完成都调用同一个 writer。迁移后删除 Lifecycle 私有 helper，避免两个 writer 漂移。

同一个 model step 的 usage 最多只能持久化到一个 part：有非空 assistant text 时由 text part 承载；没有 text、存在 tool calls 时由第一个 tool part 承载，其他 tool parts 不重复写。reasoning-only 或没有可持久化 part 的 completion 不为 usage 伪造空/synthetic part；此时 `llm:complete` 与 `LifecycleResult` 仍保留运行时 usage 事实。

### 6.4.3 reader 规则

`readTokenUsageMetadata` 应把参数改成 `unknown`，因为数据库 JSON 在运行时并不因 TypeScript 断言自动可信。读取顺序冻结为：

1. 识别 canonical shape；
2. `inputTokens/outputTokens` 合法但 breakdown 非法时，保留 inclusive totals、丢弃 breakdown；
3. canonical 不成立时再识别最小合法 legacy shape：`promptTokens/completionTokens` 均为非负安全整数，且重算结果仍为安全整数；存储的 legacy `totalTokens` 可以缺失或错误，reader 始终重算。同一对象即使带有损坏的 canonical 字段，只要上述两个 legacy 字段合法，仍按 legacy 读取；
4. legacy 读取不虚构 breakdown，并重算 total；
5. 完全非法时返回 `undefined`，不抛错、不补零。

### 6.4.4 收紧写类型，保留读兼容

当前 `PartMetadata.tokenUsage` 的静态类型允许 `TokenUsage | LegacyTokenUsageMetadata`，这等于允许新代码继续写 legacy shape。全仓调查未发现该 legacy 类型的生产写入或包根导出消费者，因此目标直接收紧为：

```ts
export interface PartMetadata {
  readonly tokenUsage?: TokenUsage;
  readonly [key: string]: unknown;
}
```

`LegacyTokenUsageMetadata` 只作为 reader 内部的 runtime compatibility shape，不再作为新写入 API 的可选类型或 message index 导出。旧数据库 JSON 仍由 `readTokenUsageMetadata(unknown)` 在运行时兼容；不在 Message Store hydration 时重写旧记录。

### 6.4.5 集成改动面

| 位置 | 改动 |
|------|------|
| `core/message/token-usage-metadata.ts` | 增加唯一 `create` adapter；reader 接受 `unknown`；canonical/legacy runtime parser 保持私有 |
| `core/message/index.ts` | 同时导出 creator/reader；移除只服务旧可写类型的导出 |
| `core/lifecycle/lifecycle.ts` | 删除私有 `toPartTokenUsageMetadata`，两个写入点改用共享 writer |
| `core/message/database-store.ts` | 保持通用 JSON round-trip；以 integration test 证明旧 metadata 经 reopen 后能由显式 `readTokenUsageMetadata(unknown)` 解析。本批不把局部 token 收口扩大成完整 Message/Part runtime decoder，也不在 hydration 时改写旧 metadata |
| `tests/smoke/real-cache-harness.ts` | 继续使用 production storage reader；优先从 `llm:complete` 取 usage，assistant metadata 作为持久化链的交叉证据。当前产品 UI/runtime 不直接消费该 reader，其保留理由是旧库兼容与审计合同 |
| lifecycle/worker/bridge | 保持传输 canonical usage，不把 metadata parser 反向引入事件链 |

这里不新增 message-level 命中率 UI，也不建设长期统计库；这两项超出本次职责收口。

## 6.5 `token-estimation.ts` 接口升级方案

### 6.5.1 当前问题

当前调用形式仍把同一 request 拆成三个参数：

```ts
estimateWireHeuristic(payload.messages, tokenCounter, payload.tools)
```

虽然 ContextManager 已经拥有统一 `PreparedModelRequest`，这里再次拆开会留下一个小型旁路：未来 prepared request 新增占 token 的字段时，调用点可以忘记同步传入。当前 `ContextMeasurementPayload` 只是该类型的无差异别名，反而给同一个 single source of truth 增加第二个名字。

### 6.5.2 推荐接口

首选以职责命名，并一次接收完整 payload：

```ts
export function estimatePreparedRequestHeuristic(
  request: PreparedModelRequest,
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number;
```

本批直接删除 `ContextMeasurementPayload` 别名，测量、发送、callback 与测试统一使用 `PreparedModelRequest`。函数名已经表达这是 heuristic 计量入口，不需要再用第二个类型名重复表达。

ContextManager 调用变成：

```ts
const sentHeuristic = estimatePreparedRequestHeuristic(
  request,
  options.tokenCounter,
);
```

本批不增加只为穷举字段而存在的 no-op field map。它会复制一个两字段内部对象的字段清单，却不参与实际 serializer，收益不足以覆盖新的维护概念。完整对象入口、独立 helper 测试和 measurement/send 深等价集成测试共同承担当前保护；若未来 `PreparedModelRequest` 真正增加新的 token-bearing 字段，再在该次真实变更中选择直接 serializer 或有行为作用的穷举结构。

### 6.5.3 分两步实施，避免校准漂移

第一步只升级 API，保持现有序列化算法完全不变：逐条 `JSON.stringify(message)`，有非空 tools 时追加 tools JSON，再交给 token counter。这样已有 calibration factor 不会因为一次重构被无意改变。

第二步若要更贴近实际 wire body，可以另立测量实验，比较：

```ts
JSON.stringify({ messages, tools })
```

与现有拼接算法相对 provider inclusive input 的误差分布，再决定是否调整。不能在接口重构中夹带估算公式变化；否则测试全绿也无法区分误差变化来自 API 还是算法。

### 6.5.4 演进规则

- 只有实际占 context token 的字段才能进入 `PreparedModelRequest`；model、temperature、cache key、signal 等控制字段继续留在 request context 外。
- 新增可计量字段时，先扩展 `PreparedModelRequest`，再更新该函数的单一 serializer 并补 fixture；完整 request API 负责集中变更点，测试负责锁定估算与发送同源。
- 函数不得修改 request；prepared request 的 immutable snapshot 语义保持不变。
- 该数值仍是 `sentHeuristic`，真实 calibration 继续使用 inclusive provider `inputTokens`，不能改用 uncached tail。

## 6.6 测试完善方案

### 6.6.1 metadata 单元测试

在 `token-usage-metadata.unit.test.ts` 增加表驱动用例：

| 类别 | 必测情形 | 预期 |
|------|----------|------|
| writer | canonical usage 无 breakdown | 写 canonical totals，total 重算 |
| writer | canonical usage 有完整 breakdown | 深拷贝 breakdown/observed，不共享引用 |
| writer | usage 缺失 | 返回 `undefined` |
| canonical reader | total 与 input+output 冲突 | 忽略存储 total，重新计算 |
| canonical reader | breakdown 之和不等于 input | 保留 totals，丢弃 breakdown |
| canonical reader | observed 缺失或不是 boolean | 保留 totals，丢弃 breakdown |
| canonical reader | 顶层 `inputTokens/outputTokens` 为负数、浮点数、字符串、NaN/Infinity | 整份 usage 返回 `undefined` |
| canonical reader | 顶层 totals 合法，但 breakdown 数字为负数、浮点数、字符串、NaN/Infinity | 保留 inclusive totals，丢弃整个 breakdown |
| legacy reader | 合法 prompt/completion、错误 total | 读取并重算 total，不生成 breakdown |
| mixed reader | 损坏的 canonical 字段与完整合法 legacy 字段共存 | 按完整 legacy shape 读取，不产生 breakdown |
| invalid reader | metadata/tokenUsage 缺失、null、数组、任意对象 | 返回 `undefined` |

### 6.6.2 metadata 集成测试

1. Lifecycle 的普通 assistant text path 使用共享 writer，持久化后 reader 深等于 `llm:complete` usage。
2. tool-call/finalization path 使用同一个 writer，且只有约定的首个 part 携带 usage。
3. hybrid text + tool-call path 只在 text part 携带一次 usage，tool parts 不得重复；reasoning-only path 不为 usage 新造 part。
4. 通过历史 JSON/raw store fixture 存入 legacy metadata，重新加载后 production reader 可读，且不会产生 cache breakdown；不能调用新的 typed creator 伪装旧数据。
5. 把 canonical usage 的两条生产投影分别验证：① provider → Lifecycle → shared metadata creator → database/reader；② LifecycleEvent → run-manager worker → `run.llm.complete` → stream bridge。现有 worker/bridge integration 已锁定第二条链，本批只在受影响门禁中复跑，不重复制造一套同义测试。两条链都不得丢 `inputBreakdown.observed`，但不能把它们误写成一条串行调用链。
6. 主代理与子代理分别写入各自 part，不串 session/context scope；auxiliary request 不伪造 assistant metadata。

### 6.6.3 token estimation 单元与集成测试

新增 `core/context/token-estimation.unit.test.ts`，至少覆盖：

- messages-only；
- messages + non-empty tools；
- `tools: undefined` 与空 tools 的既定等价；
- 多工具顺序保持，不在 estimator 内排序；
- estimator 不修改 frozen request；
- 使用完整 payload 的新接口后，不再存在接受独立 messages/tools 的生产入口。

保留 ContextManager integration：普通、overflow/compact、tail directives、主代理和子代理的 `onRequestMeasured` 必须与最终发送的 `{ messages, tools }` 深等价。接口升级不能用只测 helper 的单元测试替代这条端到端不变量。

## 6.7 六个参考项目的实施后复核

三路子代理于 2026-08-25 对六个本地仓库进行了只读复核，未修改参考仓库或 ohbaby-agent。共同结论是：成熟实现会把 provider usage、请求前 estimation、calibration、aggregation 与 durable storage 分开；没有项目证明把这些职责合成一个 token helper 更简单或更正确。

### 6.7.1 对照摘要

| 项目 | 代码证据 | 职责划分 | 对 ohbaby 的取舍 |
|------|----------|----------|------------------|
| OpenCode | `packages/llm/src/schema/events.ts`；`packages/llm/src/protocols/openai-chat.ts`、`openai-responses.ts`、`anthropic-messages.ts` 的 `mapUsage`；`packages/opencode/src/session/session.ts` 的 `getUsage` | protocol mapper 归一化；session 层投影持久化/计费；新架构以 schema decode 和 SQL migration 管理 durable usage | **借鉴** codec/schema boundary、writer/reader 同 owner；**不照搬** SQL 长期聚合、raw provider metadata；usage 语义以 `schema/events.ts`、mapper 与测试为准，`protocols/shared.ts` 的旧注释不能覆盖现合同 |
| Pi | `pi/packages/ai/src/api/openai-completions.ts` 的 `parseChunkUsage`；`packages/ai/src/utils/estimate.ts`；`context-estimate.test.ts` | adapter 解析 provider usage；真实 usage checkpoint 加 trailing messages/tools heuristic；旧 JSONL 读取较宽松 | **借鉴** measured anchor 与 trailing heuristic 的后续方向；本轮先只升级完整 request 接口；**不照搬** uncached `usage.input` 与未验证 JSON cast |
| claude-code-best | `packages/@ant/model-provider/src/shared/openaiUsage.ts`；`src/services/tokenEstimation.ts`；`src/utils/tokens.ts` | provider normalizer、stream adapter、API/rough estimation 和 transcript usage 各自分层，但 durable usage 读取主要靠 cast | **借鉴** messages+tools 共同估算和 stream contract tests；**不照搬** Anthropic disjoint input 语义及宽松 cast。该仓库是 reverse-engineered/decompiled，只能作为当前代码参考，不能表述为 Anthropic 官方架构 |
| Codex | `codex-rs/codex-api/src/sse/responses.rs`；`protocol/src/protocol.rs`；`core/src/client_common.rs` 的 `Prompt`；`core/src/context_manager/history.rs` | API crate 解析；protocol type 承担 canonical usage；完整 Prompt 由 turn 构建后交给 client；session 的真实 usage update 与 fallback recompute 走不同处理路径，最后投影到同一种 token-count event | **借鉴** prepared object ownership、provider/core 隔离、真实更新与 fallback 重算的路径分离；**注意**其持久化类型没有显式 source 标签，不能据此声称已标记 observed/estimated 来源；**不照搬** Responses 专属 rollout 全套抽象，且其 history estimator 没有完整覆盖 Prompt 的缺口不应复制 |
| DeepSeek Harness | `llm-deepseek/src/translate.ts`；`token-meter/src/index.ts`；`agent-loop/tests/request-cache.e2e.ts` | adapter translator → canonical usage → durable `assistant/message` → token-meter replay/projection；real E2E 从生产 durable event 读 cache usage | **借鉴** durable usage 与真实工具循环 cache 证据、canonical header/request 进入 estimator；**不照搬** disjoint input、完整 replay-aware meter 和较弱的 durable usage 字段校验 |
| Kimi Code | `agent-core-v2/src/kosong/provider/...`；`agent/tokenCounting/tokenCounting.ts` 与 `tokenCountingService.ts`；`agent/usage/usageService.ts` | provider parser；完整 `TokenCountingRequest { systemPrompt, tools, messages }` 估算；独立 `usage.record` 做 replay aggregation | **借鉴** estimator 接收结构化完整请求；**不照搬** disjoint input、独立 durable usage 事件双写和偏弱的 `z.custom<TokenUsage>()` 校验 |

### 6.7.2 对本方案的交叉裁决

参考项目支持以下决定：

1. provider raw usage 继续只停留在 `interface-providers/token-usage.ts`；共同算术可以复用，但 storage codec 不解析 provider 方言。
2. `token-usage-metadata.ts` 保留并升级为 creator/reader 同模块的 storage codec；ohbaby 有旧数据库兼容承诺，不能因 DeepSeek Harness/Kimi 的校验较弱就删除 reader。
3. estimator 接收 core-owned 的完整 `PreparedModelRequest`，而不是 OpenAI/Anthropic wire body，避免 core 反向依赖 provider。
4. 本轮只做接口收拢；Pi、Claude、DeepSeek Harness、Kimi 的“真实 usage anchor + trailing heuristic”可作为以后提升 UI 估算准确度的独立议题，不能夹带进本次重构。
5. ohbaby 继续坚持 inclusive `inputTokens`。Pi、DeepSeek Harness、Kimi 以及 Claude 的 Anthropic-compatible usage 多使用互斥 input 桶，字段名相近但加法语义不同。
6. 不新增第三份 durable usage source。当前 `llm:complete` 是运行事件事实，assistant metadata 是消息持久化投影；再复制 Kimi 的独立 `usage.record` 会制造 source-of-truth 冲突，也违反 improve-5 不做长期统计的范围。

### 6.7.3 可留到以后单独讨论的增强

Pi、Claude、DeepSeek Harness 和 Kimi 都提供了“真实 usage anchor + 后续变化 heuristic”的相关实现，但覆盖范围不同：Pi 明确处理仍适用于当前前缀的 checkpoint、trailing messages 和带标记的 deferred tools；Claude 的 anchor 算法只补 trailing messages，tools 属于另一个完整请求 count/rough-estimation 入口；DeepSeek Harness 和 Kimi 又结合各自的 header、surface 或 event 状态。它们共同说明 anchor 必须能证明仍对应当前 context，并不意味着任一项目已经给出可直接复制的通用 header delta 算法。这一方向可能比单一 calibration factor 更容易解释：

```text
current context estimate
  = provider-measured anchor
  + trailing messages heuristic
  + changed tools/header heuristic
```

但它需要定义 anchor 何时因 compact、tool epoch、prefix 变化或 scope 切换而失效，并需要主/子代理独立状态。本轮没有必要为了升级 16 行 estimation helper 引入 replay/state machine；若后续 context UI 精度仍不足，应另立问题和测试基线再评估。

## 6.8 建议实施批次

本方案作为 improve-5 与联合回归后的一个小型收口批次实施，生产改动分成两个原子 commit；storage/transport 验证随对应 commit 和最终门禁完成，不再制造第三个生产批次：

1. **批次 H1 · metadata storage adapter**：增加 creator、迁移 Lifecycle、收紧 reader 入参和可写类型，并修复 hybrid text + tool-call 重复持久化同一 usage；补单元测试、Lifecycle text/tool/hybrid 写入测试与 database legacy reopen round-trip。运行 message/lifecycle/provider targeted tests，并完成 lint、typecheck、unit 与受影响 integration。
2. **批次 H2 · estimation envelope**：删除无差异 measurement alias，升级完整 `PreparedModelRequest` 接口，保持算法不变；将 helper 行为移入独立 unit test，并复跑 ContextManager、improve-4.1 和 subagent integration。完成 lint、typecheck、unit、contract 与受影响 integration。

最终门禁复跑现有 worker/bridge usage transport integration，确认本批没有影响 canonical usage 的事件投影。由于本批不修改 provider wire、cache key、MCP epoch 或 cache breakdown normalizer，真实 Provider cache smoke 不作为本批硬门；不得把 improve-5 的旧证据冒充新执行结果，也不应为无关代码变化额外消耗外部 credential。

每批都应先验证调用点不存在旧入口，再由只读审查确认没有把 provider 原始字段带入 core、没有让 legacy shape 重新成为可写类型，也没有让主/子代理出现不同路径。

## 6.9 验收门槛

1. `rg` 不再发现 `toPartTokenUsageMetadata`、`estimateWireHeuristic` 或 `ContextMeasurementPayload` 的生产/测试入口。
2. 新代码不增加字段、schema、service、manager、配置项或 provider 方言依赖。
3. creator/reader 是纯函数；reader 在数据库不可信 JSON 边界 fail closed，但 canonical totals 合法时只丢弃损坏 breakdown。
4. 每个 model step 最多一个 durable part 携带 usage；无 part completion 不为 usage 伪造记录。
5. estimator 数值公式在相同 `{ messages, tools }` 下逐字节保持不变，prepared request 继续 deep-frozen。
6. 主代理与子代理走相同 estimator/metadata 实现；scope 隔离由既有 `sessionId + contextScopeId` 测试继续证明。
7. 两个实现 commit 各自 targeted tests 通过；最终 lint、typecheck、unit、contract、受影响 integration 全绿，并完成只读子代理 diff 审查。

## 6.10 非目标与删除门槛

本次不做：

- 精确 tokenizer 接入；
- token pricing 重构；
- 跨 session cache analytics；
- per-message cache hit UI；
- 因代码短小而把 estimation 重新内联到 ContextManager；
- 把 provider normalizer 与 storage parser 合并成一个“万能 token parser”；
- 移动 canonical `TokenUsage` 的模块所有权；这会扩大依赖方向改动，应在有独立收益证据时另立批次。

未来若要删除任一文件，必须先证明其语义边界已经由一个更清晰的单一模块完整接管，并同步迁移生产调用、测试和文档合同；“当前调用少”本身不是删除持久化兼容边界的充分理由。
