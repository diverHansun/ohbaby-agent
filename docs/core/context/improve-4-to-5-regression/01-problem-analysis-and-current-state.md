# 1. 问题基线与当前实施状态

> 分析基线：`301de2da7996703e2c4254b330f981bf51507e1f`。
> 时间口径：本文只描述联合回归启动时的代码与文档；“风险”若尚无失败测试，一律标注为待证实，不冒充已发生 Bug。

## 1.1 核心矛盾

1. **已有测试很多，但证明形状仍是阶段局部的。** `ContextManager` 单元测试覆盖面广，improve-4～5 也有定向 contract/integration/e2e；缺少的是一条能够跨请求、跨压缩、跨 scope、跨重启持续检查不变量的联合证据链。
2. **Context 的本质复杂度来自状态迁移，现有测试主要验证单次方法结果。** 历史、summary、compacted 标记、runtime part、run snapshot、校准、mask、tool epoch 和 Provider usage 分属不同生命周期，只验证其中一个方法“返回成功”不足以证明最终模型视图唯一合法。
3. **压缩持久化由多次独立写组成。** 当前没有显式事务端口、durable begin/end 标记或恢复协议；这构成真实架构风险，但是否在现有存储/调用约束下可达，必须由 failpoint 测试证明。
4. **设计文档明显落后于 improve-4～5 的实现。** 模块文档仍描述 85% 阈值、已不存在的 assembler/compressor/pruner 文件和旧公共接口，使审查者难以判断测试应以哪份契约为准。
5. **测试本身也需要被审查。** 测试数量不能自动等于可靠性：误导性名称、mock 过深、没有重建存储、没有竞态编排或只断言“不抛错”，都可能产生假安全感。

## 1.2 当前请求与状态数据流

当前真实主链可概括为：

```text
initiating user message
  └─ createRunPromptSnapshot
       ├─ primary: load OHBABY.md once
       ├─ build stable system prompt once
       └─ append model-context:runtime:v1 to initiating user part
            ↓
Lifecycle each model step
  ├─ resolve tool names + ordered schemas
  ├─ prepareTurn(sessionId, contextScopeId, promptSnapshot, tailDirectives, tools)
  │    ├─ read scoped history
  │    ├─ serialize model view
  │    ├─ measure messages + tools
  │    ├─ mask / prune / summary when needed
  │    └─ return immutable PreparedModelRequest
  ├─ send PreparedModelRequest.messages/tools unchanged
  │    └─ Provider adapter adds model/cache/transport metadata separately
  ├─ normalize inclusive TokenUsage + cache breakdown
  └─ calibrate by sessionId + contextScopeId
```

承重代码锚点：

- `packages/ohbaby-agent/src/core/context/types.ts`：`PreparedModelRequest`、`PrepareTurnInput`、`PreparedTurn`、`ContextManager`。
- `packages/ohbaby-agent/src/core/context/context-manager.ts:556`：`assembleModelRequest()` 组装并冻结 `messages + tools`。
- `packages/ohbaby-agent/src/core/context/context-manager.ts:580`：`measureUsage()` 对同一 request shape 计量。
- `packages/ohbaby-agent/src/core/context/context-manager.ts:774`：`createRunPromptSnapshot()` 加载 run-local prompt/memory 并附着 runtime part。
- `packages/ohbaby-agent/src/core/context/context-manager.ts:1422`：`prepareTurn()` 驱动 mask、压缩、最终重测和 request 返回。
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:388`：Lifecycle 每个 run 只创建一次 prompt snapshot。
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts:402`：final-step `tailDirectives` 进入 prepare/request 链。

## 1.3 状态所有权现状

把状态按生命周期拆开，是本轮测试可靠性的前提。

| 状态 | 当前所有者/落点 | 生命周期 | 重建后的当前语义 | 联合回归要求 |
|---|---|---|---|---|
| user/assistant/tool message 与 part | Message store | durable | 保留 | 重建后模型视图等价；tool pairing 合法 |
| `context-summary` part | Message store | durable | 保留 | 不能与其替代的原文同时活跃 |
| `time.compacted` | Message part | durable | 保留 | prune/summary 失败后不得形成歧义 |
| `model-context:runtime:v1` | initiating user part | durable、UI/export 隐藏 | 保留 | 同一 initiating message 至多一份，恢复不重写 |
| system prompt + merged memory | `AgentRunPromptSnapshot` | run-local immutable | 新 run 重建 | 同一 run 稳定；下一 user turn 才接纳变化 |
| calibration factor | `ContextManager` scoped Map | process-local | 重置为 1.0 | 文档必须明确重置是设计而非数据丢失 |
| mask cutoff | `ContextManager` scoped Map | process-local | 重置 | 重建不能使 durable history 非法；允许投影不同需明确 |
| thrash lock / per-turn cap | `ContextManager` scoped Map | process/turn-local | 重置 | 压缩尝试仍必须有上限，不能重启即无限抖动 |
| MCP loaded set / tool sequence | dynamic tool menu 与 sequence owner | scope/process-local | 新 epoch | 重启后首次 miss 可接受，随后必须稳定 |
| Provider usage/cache breakdown | Provider response → normalized usage | observation | 不作为模型视图事实 | inclusive 语义与 observed/unavailable 不混淆 |
| UI context window | primary tracker/projection | process/UI projection | 可重建/可能暂空 | 不得伪装成 child scope 的精确占用 |

当前 `ContextManager` 通过四个 scoped Map 保存 calibration、mask cutoff、thrash lock 和 turn compaction count，并提供 `disposeScope()` / `disposeSession()`；代码锚点是 `context-manager.ts:403-483`。这些 Map 是否需要持久化不是本轮预设答案；本轮首先把“有意重置”和“必须恢复”写成可执行契约。

## 1.4 已有设计中值得保留的部分

### 1.4.1 单一请求快照已经消除了重要偶然复杂度

`PreparedModelRequest = { messages, tools }` 是 improve-5 的核心正确设计。Lifecycle 不再分别手工拼接“用于测量”和“用于发送”的两份输入；`prepareTurn()` 返回的 request 是单一真相源。

已有证据：

- `packages/ohbaby-agent/src/core/context/prepared-request.contract.test.ts`
- `packages/ohbaby-agent/src/core/context/manager.unit.test.ts:455`：tail directive 被计量但不持久化。
- `packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts:550`：只发送测量后的 PreparedTurn request。
- `tests/integration/core/context-improve-4-1.integration.test.ts:91`：tool names、measurement schemas、Provider schemas 来自同一解析集合。
- `tests/integration/core/lifecycle-tool-scheduler.integration.test.ts`：真实 ToolScheduler 与 Lifecycle 的 request-shaped 集成。

SWE 判断：这是“单一权威表示”的合理 DRY，不是为复用而抽象。它减少了同一知识的双份状态，直接改善正确性和可测试性。

### 1.4.2 Scope 身份边界已经落到真实 Agent 实例

主代理和子代理共享 Agent/Context 链路，但子代理实例通过 `contextScopeId` 隔离；同一 child session 可以容纳多个 scope。当前已有：

- scoped history 查询；
- scoped calibration/mask/thrash/compaction state；
- scoped MCP loaded set 与清理；
- scoped prompt cache key；
- primary/child 独立自动压缩集成用例。

已有证据：

- `packages/ohbaby-agent/src/utils/scoped-session.ts`
- `packages/ohbaby-agent/src/mcp/integration/dynamic-tool-menu.ts:198,292`
- `packages/ohbaby-agent/src/core/context/manager.unit.test.ts:1124,1162,3235`
- `tests/integration/core/context-subagent-scope.integration.test.ts:27,146`

这是正确的信息隐藏边界：调用方只传稳定身份，Context 内部用它管理必要状态；不应再给 subagent 另造一套特殊 ContextManager。

### 1.4.3 Memory 当前是克制且可解释的长期输入

`packages/ohbaby-agent/src/core/memory/` 只负责 global/project `OHBABY.md` 的发现、读取与合并；主代理 run 开始时加载，subagent 不自动加载。它没有伪装成 LLM 工具、自动记忆或向量数据库。

已有证据：

- `packages/ohbaby-agent/src/core/memory/memory-loader.ts`
- `packages/ohbaby-agent/src/core/memory/loader.integration.test.ts`
- `packages/ohbaby-agent/src/core/memory/memory-surface.unit.test.ts`
- `packages/ohbaby-agent/src/core/context/manager.unit.test.ts:714,2228`
- `docs/core/memory/{goals-duty,architecture,test}.md`

SWE 判断：在没有主动记忆产品契约前保持只读符合 KISS/YAGNI。本轮应把它测牢，而不是把 Codex 的两阶段长期记忆管线照搬进来。

### 1.4.4 TokenUsage/cache 语义已经形成独立适配层契约

Provider 原始 usage 被归一成 inclusive `inputTokens`，可选 breakdown 满足：

```text
uncached + cacheRead + cacheWrite == inputTokens
```

`observed` 区分“Provider 明确报告为 0”和“Provider 没报告”。主要证据：

- `packages/ohbaby-agent/src/services/interface-providers/token-usage.ts`
- `packages/ohbaby-agent/src/services/interface-providers/token-usage.unit.test.ts`
- `packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts`
- `scripts/real-cache-runner.mjs`

联合回归不重新发明字段语义，而要验证该契约通过 Lifecycle、RunManager、UI projection 和 primary/subagent 路径后没有被改变。

## 1.5 已有测试的可信度分析

### 1.5.1 覆盖广度是优势

当前关键测试规模：

| 文件/层 | 当前形状 | 能可靠证明什么 |
|---|---|---|
| `core/context/manager.unit.test.ts` | 约 3701 行 | 组装、mask、prune、summary、校准、thrash、scope、snapshot 的大量局部行为 |
| `core/lifecycle/lifecycle.unit.test.ts` | 约 2073 行 | 每 step prepare、发送、final-step、abort、overflow retry、provider error |
| `context-improve-4-1.integration.test.ts` | 2 个跨组件场景 | 同一工具集合计量/发送；manual compact → status projection |
| `context-subagent-scope.integration.test.ts` | 2 个跨组件场景 | shared child session scope 隔离；primary/child 独立压缩 |
| Provider contract suites | 表驱动 + wire snapshot | OpenAI-compatible/Anthropic/ZenMux 字段与 usage 归一化 |
| real cache / compiled Web scripts | opt-in 外部门禁 | 真实协议命中和编译产物 Web 主路径 |

因此问题不是“没有测试”，而是“缺少联合状态证明”。

### 1.5.2 当前可靠性缺口

| 缺口 | 证据 | 为什么可能假绿 |
|---|---|---|
| 缺少多动作状态机/属性测试 | 仓库未引入 `fast-check`，无 Context seed/trace runner | 人工列举无法覆盖动作排列组合和重复压缩 |
| 缺少存储 failpoint | summary/prune 通过多个 `MessageManager` 写操作提交 | happy-path mock 不会模拟第 N 次写失败或 SIGKILL |
| 缺少重建等价测试 | 现有测试多在同一 manager 实例内断言 | process-local Map、durable parts 与恢复视图的边界没有被同时验证 |
| runtime 幂等只测顺序重复 | `manager.unit.test.ts:495` 连续调用两次 | 两个调用并发经过 read/check/append 时，顺序测试无法暴露竞态 |
| primary/subagent 并发不等于同 message 竞态 | `manager.unit.test.ts:810` 使用不同 session/message | 能证明隔离，不能证明 initiating part 原子幂等 |
| manual compact 只证明 tools 一致 | `manager.unit.test.ts:2525` | 没有证明与 automatic 路径在 mask projection 后等价 |
| 阈值测试名称误导 | `manager.unit.test.ts:2256` 名称写 85%，测试只算 `85/100=0.85` | 它没有调用 `decideCompactionRung()`，不能证明 85% 会触发压缩 |
| 外部门禁依赖环境 | real provider/compiled Web 需要凭据、构建与可用端点 | 外部 skip 不能被当成普通 CI 已证明的能力 |
| Summary 只测结构/体积 | 现有测试检查 structured prompt、inflation 和 metadata 过滤 | 不证明目标、约束、决定和未解决错误被语义保留 |

### 1.5.3 测试设计需要避免的反模式

- 不通过断言私有 helper 被调用多少次来证明恢复正确；应重建并检查最终模型视图。
- 不把 `vi.fn()` 返回预设对象当作 MessageStore 集成；故障/恢复批必须使用真实临时数据库或符合相同 conformance suite 的 store。
- 不把 E2E 的一次 cache hit 当作稳定前缀的充分证据；先做 Provider-relevant request 的确定性差分测试。
- 不用重试掩盖 flaky 竞态；并发测试必须显式控制 barrier/latch。
- 不为了随机而随机；生成器只产生领域合法动作，并在失败时打印 seed、动作序列和最小反例。

## 1.6 待证实的承重风险

### P0-PR-01：压缩提交的部分失败

当前 `commitSummaryCandidate()` 的顺序是：

1. `createMessage(summary)`；
2. `appendPart(summary)`；
3. 遍历旧 history 的 parts，逐个 `updatePart(compactedAt)`；
4. 发布 `ContextEvent.Compressed`。

代码锚点：`packages/ohbaby-agent/src/core/context/context-manager.ts:983-1020`。

`pruneHistory()` 也逐 part 调用 `updatePart()`，代码锚点：`context-manager.ts:823-890`。`MessageManager` 公共接口只有单条 create/append/update，没有 compaction transaction/batch 契约，见 `packages/ohbaby-agent/src/core/message/types.ts:206-214`。

待证实失败形状：

- summary part 已存在，旧原文只标记一半；
- summary message 已创建但没有 part；
- prune 只裁剪一部分候选；
- 事件未发但 durable 状态已经改变；
- 重建后 summary 与原文双可见，或 tool call/result 配对被破坏。

严重性：P0，因为一旦成立会破坏 durable truth。修复形状必须等 failpoint 证据后决定。

### P0-PR-02：initiating runtime part 的并发幂等

`createRunPromptSnapshot()` 当前执行 read → find → `alreadyAttached` → append。顺序重复调用已经覆盖，但没有同一 message 的 barrier 并发测试。

代码锚点：`context-manager.ts:787-814`；现有顺序测试：`manager.unit.test.ts:495`。

待证实失败形状：两个 run 同时看到 `alreadyAttached=false`，各追加一个 `model-context:runtime:v1`。这既污染模型输入，也破坏稳定缓存前缀。

严重性：P0，因为 identity/幂等属于 correctness；若上层已经保证同一 initiating message 不会并发，应由契约测试证明该不可达，而不是依赖口头假设。

### P0-PR-09：manual compact 与 prompt 没有共用同 scope 写串行边界

`submitPromptAcceptedInternal()` 通过 prompt scheduler 接纳请求，真正执行前使用 `waitForPromptSlot()` 协调同 session prompt。但 `compactSessionInternal()` 直接调用 `runtime.compactSession()`，没有进入这条排队边界；`ContextManager` 内也没有 session/scope mutex。

代码锚点：

- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts:655-688`：prompt 接纳；
- `ui-inprocess.ts:1753-1775`：manual compact 直达 runtime；
- `ui-inprocess.ts:2126-2146`：`waitForPromptSlot()` 只协调 prompt owner；
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts:906-925`：runtime 直接进入 `contextManager.compact()`。

待证实失败形状：prompt 在 compact 生成 summary 期间追加 history，导致 compact candidate、`compactedAt` 标记与下一次 request 基于不同快照，甚至与 PR-01 的部分提交组合。

严重性：P0。推荐契约不是阻塞 UI 接纳，而是让同 scope 的 manual compact 与 prompt Context durable mutation 共用一条 exclusive lane。先用 barrier 测试证明当前竞态，再决定 lane 放在 UI runtime 还是 Context/Message 写边界。

### P1-PR-03：manual/automatic projection 不完全对称

`prepareTurn()` 给 `runCompaction()` 传入 `projectForUsage()`，使压缩候选按 mask 后真实请求投影复测；`compact()` 没有同样的投影 callback。

代码锚点：

- `context-manager.ts:1388-1417`：manual `compact()`。
- `context-manager.ts:1458-1475`：automatic `prepareTurn()` 的 `projectForUsage`。

现有 manual 测试能证明 tools 在测量中保持一致，不能证明 mask 开启时 `usageAfter` 与下一次 `prepareTurn().request` 同量纲。

严重性：P1。需要 metamorphic test 先判断是否是行为差异，还是被现有策略有意允许。

### P1-PR-04：阈值与安全余量契约漂移

代码当前采用：

- summary ratio：`0.95`；
- mask ratio：`0.5`；
- minimum remaining input：严格低于 `4096` 时触发（`remainingTokens < 4096`）；
- occupancy 优先使用 input budget，而非完整 context window。

代码锚点：`packages/ohbaby-agent/src/core/context/constants.ts` 与 `manager.unit.test.ts:2270,2300`。

文档仍有：

- `goals-duty.md`：G2/D3/约束写固定 85%；
- `data-model.md`：示例常量为 `0.85`；
- `dfd-interface.md` 和 `test.md`：大量 85% 场景；
- `architecture.md`：记录 95% 实现但仍把 85% 留作未决产品目标。

这是已证实的文档漂移。推荐在本轮 R0 确认公式后，以当前 95% 保持行为不变，并把 85% 移入历史说明；调参是另一个需要数据的决策。

### P1-PR-05：恢复语义没有成为可执行契约

当前 durable、run-local、process-local 状态的划分可以从代码推导，但模块权威文档没有完整状态所有权表。结果是：

- calibration 重启归 1.0 究竟是设计还是丢状态，不明确；
- tool epoch 重建后的首次 cache miss 是否允许，不明确；
- thrash lock 重启清空是否可能导致短时间重复压缩，没有门禁；
- runtime part durable，但 system/memory snapshot run-local，这一差异容易被后续开发误改。

严重性：P1。联合回归应先把预期写清，再判断需不需要持久化新状态。

### P1-PR-06：Summary 语义保真无独立评测

当前结构测试能证明：

- summary 比原文短才提交；
- inflation 有 aggressive retry/thrash 防护；
- file ops 被补入；
- runtime metadata 不进入 summary。

但不能证明 overall goal、用户约束、已完成决定、关键文件变化和未解决错误被保留。`docs/core/context/test.md` 还把“LLM 响应质量”整体排除在外。

结构测试不应承担模型语义质量；需要新增独立 eval，放在 nightly/release，而不是普通 unit。

### P2-PR-07：`ContextManager` 的变化原因过多

当前文件约 1550 行，同时承担：

- system/memory/history assembly；
- request serialization 与 measurement；
- calibration；
- mask projection；
- prune policy 与 durable writes；
- summary generation、candidate projection 与 commit；
- thrash/cap 状态；
- scoped disposal 与 event publication。

这具有领域内聚性，但变化原因已经不止一个。相反，文档声称已有独立 `context-assembler.ts`、`context-compressor.ts`、`context-pruner.ts`，这些文件实际上不存在。

SWE 判断：难测的部分失败和恢复是边界过宽的设计信号；但不能因此立即机械套 SRP 拆成大量类。先用 R1～R3 的测试确认最稳定的切面，再考虑只抽出：

1. 纯 RequestAssembler/measurement；
2. 纯 CompactionPolicy；
3. 有恢复语义的 CompactionCommitter。

## 1.7 文档与实现对照

| 权威文档说法 | 当前代码 | Gap |
|---|---|---|
| `Context.shouldCompress()`、`compress()`、`prune()` 是核心接口 | 公共接口是 `prepareTurn()`、`compact()`、`getUsage()` 等 | 接口文档过期 |
| assembler/compressor/pruner 是独立文件/组件 | 核心协调集中在 `context-manager.ts`，另有 projection/serialization helpers | 文件布局与职责描述失真 |
| 自动压缩固定 85% | `COMPRESSION_THRESHOLD=0.95`，且有 input budget + 4096 floor | 产品目标、当前行为和测试名称冲突 |
| `AssembledContext` 带 `estimatedTokens` | 当前 token usage 在 request measurement 阶段计算 | 数据模型过期 |
| Context 不负责 `toModelMessages` 过滤 | 当前由 Context serializer/projection 形成模型视图 | 旧模块边界描述失真 |
| 测试按不存在的组件分别 mock | 当前主要测试真实 `ContextManager` + MessageManager fixture | test.md 组织过期 |
| LLM 响应质量整体不测 | 结构正确，但 summary 语义可能退化 | 应新增独立 eval 层，不混入 unit |
| Memory 只读，primary 加载、subagent 不加载 | 当前实现一致 | 无 gap，联合回归保持 |

## 1.8 SWE 原则审视

### 做得好的取舍

- **DRY/单一真相源**：`PreparedModelRequest` 消除测量与发送双份请求。
- **信息隐藏**：Context 消费已解析 tool names/schemas，不直接依赖 MCP registry/Provider transport。
- **KISS/YAGNI**：Memory 只读；没有无产品契约的自动记忆系统。
- **可测试性**：TokenCounter、MemoryReader、SystemPromptProvider、ContextLLMClient 都是可替换端口。
- **隔离性**：`sessionId + contextScopeId` 作为 Agent scope 身份，避免 child session 聚合伪精度。

### 偶然复杂度最密集处

- durable writes 与策略/投影混在同一 `ContextManager` 闭包内；
- process-local Map 的恢复语义依赖读代码推断；
- 旧文档继续描述不存在的接口和文件；
- 大量局部测试缺少一个小型参考状态模型把行为串起来。

### 反教条护栏

- 不因 DeepSeek/Kimi 使用事件重放就全量重写；当前 OhBaby 已有 MessageStore，先解决可证明的提交/恢复边界。
- 不因 `ContextManager` 很长就按方法数量拆类；只按独立变化原因和可测试边界拆。
- 不为追求缓存命中率冻结本应变化的权限、工具或环境信息；正确性优先。
- 不把随机测试数量当质量；不变量、生成动作合法性和 shrinking 质量更重要。

### 当前 Design Goals 符合度结论

| Design Goal | 当前判断 | 依据 | 联合回归要补的证据 |
|---|---|---|---|
| 正确性 | **部分符合，请求链较强** | `PreparedModelRequest`、inclusive TokenUsage、tool pairing 结构测试已有 | Provider 最终输入身份、并发 runtime 幂等、部分提交后唯一 view |
| 可靠性/鲁棒性 | **未充分证明** | 已有 retry/abort/inflation 局部用例 | failpoint、store reopen、SIGKILL、manual compact/prompt 交叉 |
| 隔离性 | **设计上较强，组合证据不足** | `sessionId + contextScopeId`，primary/subagent 共用 Context 契约 | sibling scopes 长序列、并发 compact/MCP/dispose/restart |
| 可测试性 | **部分符合** | clock、TokenCounter、LLM client、Memory/System provider 有端口 | durable mutation failpoint、barrier、store conformance、Reference Model |
| 可观测性 | **部分符合** | usage/cache/compaction 已有 event/UI projection | 失败要显示 scope、seed、diff、cache break 来源和恢复结果 |
| 可维护性 | **存在明确缺口** | `ContextManager` 变化原因过多，模块文档过期 | R0 活文档；只在测试压力证明后抽窄边界 |
| 简单性 | **目前取舍正确** | 未引入主动 Memory/全量 event sourcing/两套 Agent 链路 | 防止用全局锁、catch rollback 或大重写解决局部竞态 |
| 缓存效率 | **协议与结构已改善，外部效果待验证** | stable runtime prefix、tool epoch、scoped key、cache usage 归一化 | deterministic prefix diff + OpenAI-compatible/Anthropic 真实 hit/miss/write |

总结：improve-4～5 不是“架构错了”；它已有正确的请求单一真相源和 scope 身份。当前不能给出“鲁棒”结论的根本原因，是缺少对持久化边界、并发调度和重建恢复的可执行证据，而不是 happy-path 用例数量不够。

## 1.9 风险地图

| ID | 问题 | 严重性 | 证据状态 | SWE 依据 | 下一步 |
|---|---|---|---|---|---|
| PR-01 | 压缩多写部分失败可能导致双可见 | 架构级 P0 | 待 failpoint 证实 | 可靠性、状态管理、原子性 | R3 故障/重建测试 |
| PR-02 | runtime part 并发重复注入 | 设计级 P0 | 待竞态证实 | 幂等、正确性 | barrier concurrency test |
| PR-03 | manual/automatic projection 不对称 | 设计级 P1 | 代码差异已证实，行为影响待测 | 单一知识、最小惊讶 | metamorphic test |
| PR-04 | 85/95 与 input floor 文档漂移 | 设计级 P1 | 已证实 | 可读性、共享理解 | R0 契约统一 |
| PR-05 | 重启状态所有权未文档化 | 架构级 P1 | 已证实 | 信息隐藏、可恢复性 | replay/restart matrix |
| PR-06 | Summary 语义无 eval | 产品质量 P1 | 已证实 | AI eval、正确性 | nightly corpus/eval |
| PR-07 | ContextManager 多变化原因 | 架构级 P2 | 已证实 | SRP、可测试性 | 先测后选择性抽边界 |
| PR-08 | 模块 architecture/test 文档过期 | 设计级 P1 | 已证实 | 活文档、维护性 | R0/R6 更新权威文档 |
| PR-09 | manual compact/prompt 同 scope 并发写未串行 | 架构级 P0 | 调度缺口已证实，状态损坏待 barrier 证实 | 竞态自由、原子性、最小惊讶 | LIF-08 + CMP 交叉测试 |

## 1.10 结论

联合回归不应重复证明“字段存在”，而应建立三种新证据：

1. **状态机证据**：长动作序列始终满足模型视图不变量。
2. **故障/恢复证据**：任意承重写入点失败后，重建仍得到唯一合法状态。
3. **架构证据**：测试难度真实反馈模块边界；只对被证据证明的耦合做窄修复。

这三类证据比继续增加 happy-path 示例更能验证 improve-4～5 的设计完成度。
