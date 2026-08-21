# 1. 问题基线与当前实施状态

> 时间口径：分析时仓库 `main` @ `e59107b`（2026-08-20）。improve-3 标定估算、`measureUsage`、`sentHeuristic` **已在代码中**，不是目标态。

---

## 1.1 问题陈述

1. **实时请求占用漏了工具定义。** `prepareTurn` 只量 `messages`，Lifecycle 在其后才 `resolveTools` 并塞给 LLM。实时压缩阈值和 `context:prepared` 总量都看不见 schema。
2. **「两个计数模块」被误读成两套占用账。** 实际是算法层 + 测量层分层；真正的碎片是 **投影层用另一套序列化估 part 大小**，以及 **工具根本没进测量**。
3. **自动压缩会跑，但过程中前端听不到。** 不是触发失败。`lifecycle` 里是一次 `await prepareTurn()`，prune 与可能发生的摘要 LLM 都被包在这个 Promise 里；生成器要等整个准备结束才能 `yield context:prepared`。Bus `ContextEvent` 只有单测订阅，和这个不是同一件事。
4. **静态/手动路径与实时路径的输入条件不同。** `composition.getContextUsage` 与手动 `compactSession` 没有完整的 agent、step/final-step、动态 tools 上下文，目前只能做 messages-only 粗估。本批有意不扩 API；在后续占用监测/UI 实施前必须优化。
5. **占用 UI 只有总量（本批不修）。** 管道已通到 TUI/Web，缺三类 breakdown。这是后续方向，**improve-4 不做**；01 只记现状，避免实施时顺手加字段。

---

## 1.2 已确认的产品/技术分界

见 [00-discussion.md](./00-discussion.md)。本批只动实时 Lifecycle 计量与自动压缩过程态。记忆模块保持只读注入。静态查询、手动 compact 继续 messages-only 粗估，占用三类展示不做。

```
OHBABY.md → MemoryLoader → serializeForLlm 拼进 system
messages  → serializeForLlm → estimateWireHeuristic → ×factor → ContextUsage
tools     → （现状：不经过上述链）→ 直接 streamChatCompletion
```

这里必须区分两条使用路径：

```
实时 Lifecycle 请求    messages + 本 step tools   → improve-4 任务 A 修准
getContextUsage/手动 compact  messages only       → improve-4 明确保留粗估
```

---

## 1.3 context / token-counting 现状

### 1.3.1 goals-duty

文档 `docs/core/context/goals-duty.md`：

- D2：**调用 tokenCounting 模块**计算 usage（与代码分层一致）。
- G2：阈值仍写 **85%**；代码 `COMPRESSION_THRESHOLD = 0.95`（`constants.ts`）。文档过期，本批不改阈值。
- D1 组装源：Memory + SystemPrompt + History。**未把 tool schema 列为组装/计量输入**——这是职责缺口，不是文档笔误。

### 1.3.2 architecture

分层是清楚的，不要合并成一个神模块：

| 层 | 位置 | 职责 |
|----|------|------|
| 算法 | `packages/ohbaby-agent/src/services/llm-model/tokenCounting.ts` | `estimateTokensForText`（ASCII 0.25 / 非 ASCII 1.3）+ `getBudget`/`getLimit` |
| wire 启发式 | `packages/ohbaby-agent/src/core/context/token-estimation.ts` | `JSON.stringify` 整条 `ChatCompletionMessage` 再调 `estimateTokens` |
| 占用入口 | `context-manager.ts` `measureUsage` / `measureContext` | heuristic × EMA factor → `getContextUsage` |
| part 尺寸 | `projection.ts` `collectMaskCandidates` / `protectedMessageIndexes` | 对 **domain 文本** 调同一个 `estimateTokens`，服务 mask/prune 切点，**不是占用账** |
| 校准回写 | `lifecycle.ts` 在拿到 `tokenUsage` 后 `updateCalibrationFactor` | 用 `prepared.sentHeuristic` 作分母（improve-3 F1 已做对） |

SWE：这是算法与测量的关注点分离（02 章），不是 DRY 失败。**不要**为「单一来源」把 mask 的 per-part 估算和 occupancy 的 wire 估算捏成一个函数——输入不同、问题不同。

Composition 注入点：`adapters/ui-runtime/composition.ts` 用 `createHeuristicTokenCounter({ defaultLimit, profiles, provider })` 作为 `TokenCounter`。

### 1.3.3 data-model

`ContextUsage`（`core/context/types.ts`）只有聚合字段：`currentTokens` / `contextLimit` / `usageRatio` / `remainingTokens` 等，**无 breakdown**。

`UiContextWindowUsage`（`packages/ohbaby-sdk/src/context-window.ts`）同样只有总量：`currentTokens` / `contextWindowTokens` / `contextWindowRatio`。

`InterfaceProviderTokenUsage`（`services/interface-providers/types.ts`）只有 `prompt_tokens` / `completion_tokens` / `total_tokens`。是否以及如何保留 cache 细分属于独立 improve-5；本批不把未来统计需求预埋进该类型。

校准状态：`calibrationFactors: Map<string, number>`，进程内，按 `sessionId`+`contextScopeId`。clamp `[0.5, 3.0]`，EMA α=`0.5`。**不写库。** 重启后 Map 清空，`getCalibrationFactor` 回落到 `1.0`，直到本进程第一次拿到 `tokenUsage` 再 `updateCalibrationFactor`。不是从 SQLite/磁盘同步旧值。

### 1.3.4 dfd-interface

**占用测量（现状）**

```
Lifecycle
  await prepareTurn()          // 一次 Promise：组装、计量、必要时 generateSummary
                               // 这段期间 Lifecycle 不能向外 yield
  → yield context:prepared { usage, compaction }   // 只有这里前端才第一次听到本步结果
```

`prepareTurn` 内部（现状，不含 tools）：

```
assemble (memory + system + history)
  → renderForModel / serializeForLlm
  → estimateWireHeuristic(messages)
  → × calibrationFactor
  → ContextUsage
  → 可能 runCompaction（prune → 必要时 generateSummary） // 前端此时无事件
```

**真正发给模型**

```
prepareTurn 之后
  resolveTools(...) | []  // 最后一步清空
  → streamChatCompletion(messages, { tools })
  → tokenUsage.prompt_tokens  // provider 返回的现有聚合 usage
  → updateCalibrationFactor(real, sentHeuristic)  // 分母不含 tools
```

时序证据：`lifecycle.ts` 约 401–467 行，`prepareTurn` 在 `resolveTools` **之前**。

**校准**

```
observed = prompt_tokens / sentHeuristic
factor   = 0.5 * clamp(observed) + 0.5 * previous
```

`sentHeuristic` 不含 tools 时，`observed` 长期 > 1，factor 被抬高，看起来「总数还准」。工具集一变（MCP、skill、final step 清空 tools），factor 滞后，压缩决策抖动。这是用校准掩盖测量缺口，不是精度。

**静态查询与手动 compact（现状）**

- `adapters/ui-runtime/composition.ts` 的 `getContextUsage` 只组装 messages，再调用 `contextManager.getUsage(assembled, model)`；它没有 agent/step/final-step 输入，也不会 `resolveTools`。
- 同文件的 `compactSession` 调用 `contextManager.compact(...)`；`CompactOptions` 没有 agentName/tools，因此手动压缩前后的 `usageBefore` / `usageAfter` 同样是 messages-only。
- 若在这两个入口里临时调用动态工具注册表，不仅要扩展 API，还可能引入 MCP/skill 解析副作用和与实时 step 不同的工具集合。当前需求不足以支撑这项复杂度，所以 improve-4 明确接受粗估。

**压缩事件（两条并行通道）**

| 通道 | 事件 | 生产消费者 |
|------|------|------------|
| Bus | `context.compressed` / `pruned` / `masked` / `turn-prepared` / `compact-skipped` | **无**。全仓库 `subscribe(ContextEvent.*)` 仅 `manager.unit.test.ts` |
| Lifecycle | `context:prepared` + `CompactResult` | `run-stream-adapter.ts`：usage → `context.window.updated`；compaction → `noticeFromCompactResult` |

`noticeFromCompactResult`（`prompt-context.ts`）对 `not-needed` / `compacted` / `pruned` **直接 return undefined**，只对 `failed` / inflated 发 warning。手动 `/compact`（`composition.compactSession`）走同一函数。这与 00「成功不 notice」一致，**不是漏接，是产品契约**。

手动 compact 过程态已经有生产消费者：

- TUI：`command.started` 且 `commandId === "compact"` → runtime title `Compacting...`（`packages/ohbaby-cli/src/tui/store/events.ts`）
- Web overlay：`runOverlayAction(..., "Compacting session")`（`apps/ohbaby-web/src/ui/App.tsx`）

自动压缩**会触发**（阈值 0.95 / remaining<4096 / overflow force）。缺口只是过程不可见：`lifecycle.ts` 的 `await contextManager.prepareTurn(...)` 是一次阻塞的 Promise。`runCompaction` 中的 prune 与可选 summary 全部发生在这次 await 内部。Lifecycle 是 async generator，只有 `prepareTurn` **返回之后**才 `yield context:prepared`。这就是「返回前不 yield」——不是压缩没跑，是跑的时候没法给前端发事件。用户只看到外层 run 仍在 working，无法区分「在压缩」还是「在等主模型」。

结论：Bus 是无 UI 消费者的第二通道（可保留给单测/mask dark ship）；Lifecycle 才是成功占用与失败 notice 的生产通道；**缺口是自动压缩的后端→前端过程事件，不是「自动压缩无法触发」，也不是成功 notice。**

### 1.3.5 use-case

| 用例 | 现状 |
|------|------|
| 自动压缩 | 能跑（0.95 / remaining<4096 / overflow force） |
| 手动 `/compact` | 能跑；成功无 notice；压缩决策及 `usageBefore/After` 为 messages-only 粗估 |
| 看窗口用了多少 | 实时 run 的 `context:prepared` 会持续更新 tracker；空闲态/主动 `getContextUsage` 仍为 messages-only 粗估。TUI `formatContextWindowUsage` → `38K / 1M (4%)`；Web `getContextWindowUsage`。无分类 |
| 看压缩刚发生了什么 | 成功：占用数字变化（当前仅总量）。失败：warning。过程：仅手动 `/compact` 有 spinner |
| mask dark ship | 逻辑跑、事件发，占位符不替换；Bus 事件无人读，dark ship **验不了经济性**（improve-3 G7 依赖） |

### 1.3.6 non-functional

- **正确性**：漏 tools → 占用与压缩阈值对工具集变化不敏感。
- **精度分层**：improve-4 后实时 Lifecycle 准于当前静态查询/手动 compact；这是已确认的批次边界，不应包装成全局精确。
- **可观测性**：总量有、构成无；成功压缩靠占用数字（数字本身仍缺 tools 故不够真）；自动压缩会跑但过程无后端→前端事件。Bus 遥测无生产读者。
- **稳定性**：α=0.5 单轮可拉 50% factor；final step tools=`[]` 使同一会话测量目标跳变。
- **持久化**：factor 重启丢失并在本进程内重新生成。improve-3 有意为之，本批 00 已确认维持。小上下文首轮 factor=1.0 可接受。

### 1.3.7 test

已有且对准过 improve-3 风险：

- `tokenCounting.unit.test.ts`：启发式权重
- `manager.unit.test.ts`：压缩档位、校准、Bus 事件（仅测发布）
- `prompt-context.unit.test.ts`：**明确断言成功 compact 不发 notice**
- `context-window-usage.unit.test.ts`、TUI `usage.unit.test.ts`：总量格式

缺口：

- 无「messages + tools 的 heuristic vs 仅 messages」契约测试
- 无「Lifecycle 先 tools 再 prepareTurn」的集成时序测试
- 无明确保护「`getContextUsage` / 手动 compact 本批不得隐式 resolveTools」的边界测试
- 无「自动压缩实际档位确定后、prune 前，Lifecycle 能向外发出过程事件」的测试；尤其没有纯 prune、`none/mask` 不误报和 overflow force 的时序覆盖
- （后续批次）无 breakdown 字段/SDK 契约 — 本批不补

项目无独立 `test-blueprint` 文件；04 按模块现有 vitest 惯例写。

---

## 1.4 provider usage / prompt cache（移出本批）

ohbaby 当前以 `anthropic` 与 `openai-compatible` 表示两种 client 请求接口形状；具体 cache 匹配、TTL、读写计费和扩展 usage 字段由上游服务端决定。该问题跨越 interface-provider、LLM client、context 与未来 cost projection，不能在 improve-4 中用几个可选字段提前固定。

已确认移到 [improve-5](../improve-5/README.md)：本批不扩展 cache usage 类型、不启用 cache policy、不统计命中率/成本、不预测命中。

---

## 1.5 UI 占用展示现状

链路已通，不必重挖：

```
context:prepared.usage
  → worker `run.context.prepared`
  → run-stream-adapter.handleContextWindowUsage
  → ContextWindowUsageTracker.updateFromContextUsage
  → 事件 `context.window.updated` + snapshot.contextWindowUsages
  → TUI formatContextWindowUsage / Web getContextWindowUsage
```

映射函数 `contextUsageToContextWindowUsage` 丢掉一切可选预算字段，只留总量。**本批保持这条总量管道**：实时 Lifecycle 推送的 `currentTokens` 会因任务 A 更准，但主动 `getContextUsage` 回填仍是 messages-only 粗估。加 breakdown 是后续占用 UI 批次（SDK 字段 + 映射透传 + 展示几行），不是本批改动面；在做该 UI 前，必须先统一静态/手动路径所需的 tools 上下文与估算语义。

---

## 1.6 memory 现状（本批只读，方向 4 预备）

只读 `MemoryLoader.load` → 主会话 `assemble` → `<memory>` 进 system。无 LLM 工具、无 lifecycle hooks。详见 `docs/core/memory/improve-1/`。本批不改记忆模块。后续占用三类若做，memory 文本应计入 system，不单列。

---

## 1.7 跨模块一致性

| 模块 | 与本议题 |
|------|----------|
| Lifecycle | 测量与 tools 解析顺序错位；校准回写已接上；`await prepareTurn()` 把自动压缩过程包死，无法中途通知前端 |
| interface-providers | 本批保持现状；cache usage 与 policy 留给 improve-5 |
| adapters / SDK / TUI / Web | 实时 tracker 与主动静态查询可能出现不同精度；本批只复用 spinner 与总量条，不为静态/手动入口解析 tools，不加分类字段 |
| Bus | ContextEvent 与 Lifecycle 事件语义重叠，后者才有消费者 |
| tokenCounting | 算法 SoT，职责符合 goals-duty D2 |

---

## 1.8 改动影响面（现状视角）

- 方向 1（任务 A）：只改实时请求链路的 `lifecycle.ts` 时序、`PrepareTurnInput`、`measureUsage` / `measureContext` 的 tools 输入。
- 方向 2（任务 B）：自动压缩 in-progress 信号（复用 spinner，不发成功 notice）、**不**新增 Bus 订阅。
- 方向 3：占用三类 UI — **本批不动**。

不改：`composition.getContextUsage` 与手动 `compactSession` 的参数/解析行为、SQLite schema、memory 工具/hooks、mask 开关、压缩阈值、`UiContextWindowUsage` 形态、TUI/Web 占用展示文案。

---

## 1.9 SWE 原则审视摘要

- **本质 vs 偶然**（00）：漏 tools 是测量没对准真实请求；Bus 第二通道无消费者是偶然复杂度。
- **单一职责**（03）：ContextManager 不应去 resolve 工具注册表；应由 Lifecycle 把已解析 tools **传入**测量。
- **DRY 针对知识**（03）：占用数字只能有一个权威（`measureUsage`）。Bus 与 Lifecycle 重复描述同一压缩事实，权威在 Lifecycle。
- **YAGNI**：不抄 pi hooks、本批不加三类占比、不换存储、不加记忆 hooks。
- **最小闭环 / SRP**：实时 Lifecycle 已拥有本 step 的真实 tools，由它传给 ContextManager；静态/手动入口缺少这些上下文时不反向依赖 registry。先保留可解释的粗估，等 UI 需求给出完整输入契约再扩展。
- **错误抽象比重复更糟**：不要为「单一计数模块」合并 occupancy 与 mask per-part 估算。

---

## 1.10 与既有文档关系

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| improve-3：量 wire 载荷 × factor | 已做 | 载荷仍缺 tools |
| improve-3 D3：factor 不写库 | Map 内存；重启回 1.0 再生成 | 本批确认维持 |
| improve-3 D11：单一测量入口 | `measureUsage` 存在 | 调用点未覆盖 tools |
| goals-duty G2：85% | 0.95 | 文档过期 |
| compact/05：成功不粘 notice、running 用 spinner | 手动路径已有；自动压缩无 in-progress | Phase 2 补自动路径 |
| memory improve-1：只读 Loader | 只读注入 | 本批不恢复工具/hooks |
