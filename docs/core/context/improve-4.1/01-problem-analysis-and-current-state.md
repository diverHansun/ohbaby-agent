# 1. 问题基线与当前实施状态

> 时间口径：分析时仓库 `HEAD` @ `84006096`（improve-4 任务 A/B 已合入，含 `45f6b1f` / `6e5cd82` / `a6a283f` / `d56ee99`）。improve-4.1 **尚未实施**；下文全部是现状，不是目标态。

---

## 1.1 问题陈述

1. **静态占用与手动 compact 仍是 messages-only。** 实时 Lifecycle 已把 tool schema 算进 `estimateWireHeuristic`（`token-estimation.ts:11-12`），但 `ContextManager.getUsage`（`context-manager.ts:1414-1419`）和 `compact()`（`1280-1296`）都不传 `tools`。`composition.getContextUsage` / `compactSession` 也没有解析 schema。
2. **两条路径共用一个 EMA 因子，静态路径因此被 improve-4 拉偏。** `updateCalibrationFactor` 的分母是实时路径的 `sentHeuristic`（现已含 tools）；静态路径拿同一份 factor 去乘一份不含 tools 的启发式。这不是「两档精度」，是口径不一致经共用因子放大。机理见 §1.3.3 / §1.7 U7。
3. **会话身份在静态路径上丢失。** `assemble()` 需要 `isSubagent` / `contextScopeId` / `agentName` 才能正确加载记忆、过滤消息、构建 prompt。`composition.getContextUsage` 只传 `sessionId` + `projectRoot`（`composition.ts:880-886`）。子代理会话若走到这条路径，会按主 agent 口径组装。
4. **`/status` 并行取了两份占用。** `handleStatus` 同时调用 `getContextUsage`（静态现算）和 `getContextWindowUsage`（tracker 优先）（`builtin.ts:258-259`）。TUI 占用条和 `/status` 的 Context 行实际展示的是后者；前者作为 `context` 字段仍被塞进载荷，冷启动回落仍走 messages-only。
5. **工具解析与计量的依赖方向反了。** `SystemPromptProvider` 经 `toolsProvider` 自己拉注册表拿**工具名**（`assembler.ts:49-51, composition.ts:431-434`）；占用计量却拿不到同一轮解析出的 **schema**。解析发生了一次，schema 被丢掉了。

---

## 1.2 已确认的产品/技术分界

见 [00-discussion.md](./00-discussion.md)。本批偿还 improve-4 遗留的静态/手动 tools 计量，统一占用口径，让任何 agent 被同一套逻辑正确测量。不做 cache、不做 breakdown UI、不改压缩策略。

```
实时 Lifecycle          resolveTools → prepareTurn({ tools }) → heuristic(messages+tools)×factor
静态 getContextUsage    assemble() → getUsage() → heuristic(messages)×同一 factor     ← 缺口
手动 compact            assemble() → measureContext(无 tools) → 同一套压缩决策         ← 缺口
```

---

## 1.3 context 模块现状

### 1.3.1 goals-duty

文档 `docs/core/context/goals-duty.md`：

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| D1 组装源：Memory + SystemPrompt + History | `assemble()` 确实只这三项（`context-manager.ts:682-718`）；tools 不进 `AssembledContext` | **与 00 路子三一致，不是缺口。** D1 不必把 schema 列成组装源 |
| D1 子代理：不加载 Memory、专属 prompt、消息隔离 | `assemble(..., isSubagent=true)` 跳过 memory（`690-696`）；prompt 走 `isSubagent` | 静态路径**不传**这个参数，D1 的隔离在查询入口失效 |
| D2：调用 tokenCounting 计算 usage | `measureUsage` → `estimateWireHeuristic` → `tokenCounter.estimateTokens` | D2 没写「计量对象是发给模型的完整载荷」。实时路径已是载荷，静态路径仍是会话组装结果 |
| G2 / D3 阈值 85% | 代码 `COMPRESSION_THRESHOLD = 0.95` | 既有 gap，本批只记录不修（00 §7） |
| G3 `/compact` | `composition.compactSession` → `contextManager.compact` | 手动路径的占用决策不含 tools，可能少压或误判档位 |

### 1.3.2 architecture

分层仍然清楚，improve-4 没有把它弄乱：

| 层 | 位置 | 现状 |
|----|------|------|
| 算法 | `services/llm-model/tokenCounting.ts` | ASCII 0.25 / 非 ASCII 1.3。本批不动 |
| wire 启发式 | `core/context/token-estimation.ts` | 已能吃 `tools`；调用方不传就当没有 |
| 占用入口 | `measureUsage` / `measureContext` | 唯一入口（improve-3 D11）。`tools?` 已在签名上，**静态调用点没填** |
| 会话组装 | `AssembledContext` | 跨轮、不含 tools。语义正确 |
| 请求发出 | `Lifecycle` → `streamChatCompletion` | 实时路径已是「messages + tools」；这个信封在类型上没有名字 |
| 校准 | `lifecycle.ts:634-646` → `updateCalibrationFactor` | 分母 = `prepared.sentHeuristic`（含该 step 的 tools） |

**架构缺口不是「少一个模块」，是「发给模型的那份东西」没有一等公民类型。** 实时路径用 `PrepareTurnInput.tools` 临时塞；静态路径没有等价物。00 称之为请求载荷层。

需要立刻澄清的一点，避免 02 抄 pi 抄出双计：

> ohbaby 的 `serializeForLlm`（`serializer.ts:47-70`）已经把 `systemPrompt + memory` 折进 `messages[0]`（`role: "system"`）。计量函数吃的是这份 `ChatCompletionMessage[]`。因此载荷层在 ohbaby 里的自然形状是 **`{ messages, tools }`**——system prompt 已经在 messages 里，**不应再单独复制一份 `systemPrompt` 字段**。pi 的 `Context` 三分法来自它的 messages 不含 system；照搬会把 system 计两遍。

SWE：这是关注点分离（02 章），不是再造一个包。载荷是「这一次要发出去的信封」，会话上下文是「跨轮组装结果」。二者本来就该分开；现在缺的是给信封一个名字，并让所有计量走信封。

`SystemPromptProvider` 的依赖方向是现状里真正的架构问题：prompt 模块经 `toolsProvider` 拉工具注册表（`assembler.ts:49-51`），而计量层拿不到 schema。三家参考项目的 registry 解析都在调用方（[03 §3.2 C](./03-reference-projects.md)）。

### 1.3.3 data-model

**`AssembledContext`**（`types.ts:54-63`）：`systemPrompt` / `memory` / `history` / `isSubagent` / `sessionId` / `contextScopeId?`。无 tools。保持不变是 00 已确认决策。

**`ContextUsage`**（`types.ts:65-74`）：只有总量。无 breakdown。本批不加字段。

**`PrepareTurnInput.tools`**（`types.ts:131`）：实时路径专用可选字段。`CompactOptions`（`105-111`）**没有** `tools`、也没有 `agentName`。所以 `compact()` 即使想传也传不进。

**校准状态**：`calibrationFactors: Map<string, number>`，键为 `sessionId` + `contextScopeId`，进程内，clamp `[0.5, 3.0]`，EMA α=`0.5`（`context-manager.ts:53-55, 402-425`）。不写库。默认 `1.0`。

**U7 结论（本批唯一可能推翻方案的技术风险，此处给出诊断）：**

公式是：

```
sentHeuristic = estimateWireHeuristic(messages, tools?)
currentTokens = round(sentHeuristic × factor)
factor_next   = 0.5 × clamp(prompt_tokens / sentHeuristic) + 0.5 × factor_prev
```

improve-4 之后，实时路径的分子（provider `prompt_tokens`）和分母（`sentHeuristic`）**同时含**该 step 的 tools。factor 收敛的是「启发式 vs 真实 tokenizer」的比值，不是「用来补 tools 缺口的系数」。

静态路径现状：分母是 `H_messages`，乘的却是按 `H_messages+tools` 校准出来的 factor → 系统性少算约 `H_tools / H_full` 这一截。

把 tools 纳入静态分母之后：两边同量纲，都是「wire JSON 启发式 × tokenizer 校准」。**不会重复计数。**

pi 的「有 usage 锚点时只补新增工具」（[03 D2](./03-reference-projects.md)）针对的是**另一类算法**：以 provider usage 为基数再往上加增量。ohbaby 从不把真实 usage 当基数，只拿它回归 factor。把 pi 的条件计入搬过来，才会真正重复计数。

> **U7 关闭：方案成立。** 本批采用全量启发式含 tools + 共用 factor。不引入第二套 factor，不引入锚点增量。factor 的实际数值无需在规划期实测；同量纲由公式保证。量级验证放到 04 的单测（含 tools 的 heuristic × 已知 factor）。

**`Session`**（`services/session/types.ts:10-23`）已有 `isSubagent` 和 `agentName`，**没有** `contextScopeId`。`contextScopeId` 是一次 run 内的消息过滤键，不是会话字段。静态「查这个 session 现在多重」的合理默认是不带 scope、列出该 session 全部消息。子代理隔离靠独立 `sessionId` + `isSubagent`，不靠编造 scope。

### 1.3.4 dfd-interface

**实时占用（已修好）**

```
Lifecycle
  tools = isFinalStep ? [] : resolveTools(...)     // lifecycle.ts:401-410
  prepareTurn({ tools, isSubagent, agentName, contextScopeId })
    assemble(..., isSubagent, contextScopeId, agentName)
    measureContext({ tools })                      // 含 prune/投影后的每一次重测
  streamChatCompletion(messages, tools)
  updateCalibrationFactor(prompt_tokens, sentHeuristic)
  context:prepared.usage → tracker.updateFromContextUsage   // run-stream-adapter.ts:514
```

> **现状 vs 4.1 接线陷阱**：今日 prompt 工具名走 `toolsProvider`（`composition.ts`），与 final step `tools=[]` **无关**。4.1 去掉生产 `toolsProvider` 后，`tools`（schema，final 可空）与 `toolNames`（prompt 名字，final **仍非空**）必须拆开传入 `prepareTurn` / `assemble`。禁止从空 schema 推导 names。

**静态占用（缺口）**

```
/status 或 HTTP GET /v1/sessions/:id/context-window
  getContextWindowUsageInternal                    // ui-inprocess.ts:1784
    tracker.get(sessionId) 命中 → 返回（含 tools 的旧实时值）
    未命中 → runtime.getContextUsage({ sessionId, projectRoot })
                composition.assemble(sessionId, projectRoot)   // 三参数全默认
                getUsage(assembled)                            // 无 tools
```

**手动 compact（缺口）**

```
/compact 或 POST /v1/sessions/:id/compact
  assertCanUseAsPrimarySession                     // 挡住子代理当主会话 compact
  composition.compactSession({ isSubagent: false })
    compact() assemble(..., isSubagent, contextScopeId)  // 不传 agentName
    measureContext({ 无 tools })
    runCompaction({ 无 tools })                    // 内部重测同样丢 tools
```

**`/status` 双取**

```
handleStatus
  getContextUsage({ sessionId })           // 静态，写入载荷字段 `context`
  getContextWindowUsage({ sessionId })     // tracker 优先，写入 `contextWindow`
```

TUI `renderStatusPanel` / `StatusPanel` **只展示 `contextWindow`**（`status-panel.ts:54-57`，`command-panel-manager.tsx:222-236`）。占用条读 snapshot 里的 tracker。所以「同屏两个数字」在 TUI 上主要发生在：tracker 未命中（两边都回落到 messages-only），或有消费者去读未被展示的 `context` 字段。载荷里同时带着两份不同口径的数，本身就是口径分叉。

### 1.3.5 use-case

| 用例 | 现状 | 阻碍 |
|------|------|------|
| 主会话跑一轮对话后看占用条 | tracker 有值，含 tools | 可用 |
| 冷启动 / 从未跑过 LLM 就 `/status` | tracker 空，回落静态 messages-only | 少算 tools；冷启动时 factor=1.0，偏差就是 tools 那截 |
| `/compact` | 按 messages-only 决定是否 prune/summary | 真实发出去还要带 schema，可能该压没压 |
| 子代理自己的占用被查询（HTTP `getContextWindowUsage` **没有**主会话守卫） | 按主 agent 装记忆 + 默认 prompt | 测到的不是子代理上下文 |
| 主 agent 看子代理结果 | 子代理只回摘要，本批不改 | 已符合 00 §4 |

手动 compact 的 UI 入口有 `assertCanUseAsPrimarySession`（`ui-inprocess.ts:1731`），所以「子代理被手动 compact」在产品路径上接近零。查询路径（HTTP / `/status`）没有这道守卫。00 要求正确传参而不是加守卫：查询应当能测对，而不是被拒绝。

### 1.3.6 non-functional

| 属性 | 现状 | 本批风险 |
|------|------|----------|
| 静态路径延迟 | `assemble` 已调用 `systemPromptProvider.build` → `toolsProvider` → `resolvePromptTools`（`getAvailableTools` + `mcpToolMenu.loadedNames`） | `loadedNames` 是读已加载集合，不新建 MCP 连接（`dynamic-tool-menu.ts:246`）。**U4 关闭：再拿一次 schema 的增量成本是 `toOpenAiTools` 的纯转换，不是二次 MCP 握手。** 正确做法是解析一次、名字给 prompt、schema 给计量，调用次数从「隐式 1 次丢 schema」变成「显式 1 次两用」 |
| 校准稳定性 | 共用 factor | 静态纳入 tools 后应更稳，而不是更晃（U7） |
| 可观测性 | 无 tools 占比 | 本批不加 breakdown |

### 1.3.7 test

项目无独立 `test-blueprint.md`；context 模块有 `docs/core/context/test.md`（仍写 85% 阈值，部分过期）。

| 已覆盖 | 缺口 |
|--------|------|
| `estimateWireHeuristic` 含/不含 tools（`manager.unit.test.ts:330-335`） | 静态 `getUsage` **没有**「传入 tools 则变大」的用例 |
| `prepareTurn` 把 tools 算进 `sentHeuristic`（同文件 ~1262） | `compact()` 带 tools 的计量 / 档位决策无测试 |
| Lifecycle 先 `resolveTools` 再 `prepareTurn`（`lifecycle.unit.test.ts`） | `composition.getContextUsage` 断言的是 `assemble(sessionId, dir)` 两参数（`composition.unit.test.ts:592`）——把错误传参写进了合同 |
| `/status` 同时拿到 `context` 和 `contextWindow`（`commands/service.unit.test.ts:862-868`） | 没有「两字段必须同口径」的断言；当前合同把分叉固化了 |
| 子代理 `assemble(..., true)` 不加载 memory（`manager.unit.test.ts:1545`） | 没有从 `Session.isSubagent` 自动传到 `getContextUsage` 的测试 |
| tracker `updateFromContextUsage` | 没有「`/status` 命中 tracker 时不再走静态现算」 |

高风险未覆盖：共用 factor 下「静态漏 tools」的数值偏差；手动 compact 因漏 tools 选错档位。

---

## 1.4 相邻模块（只记与本批相交的截面）

### system-prompt

`createSystemPromptProvider` 用 `toolsProvider` 拉**名字**拼进 prompt（`assembler.ts:230`）。这是 prompt 需要的，不是 schema。接口要把「谁解析」从 provider 内部改到调用方；provider 继续只消费名字。

### lifecycle

保持「解析 tools 的人是 Lifecycle，ContextManager 不碰 registry」。静态路径的解析人应是 **composition**（它已经有 `resolvePromptTools`），不是 ContextManager。SRP 与实时路径一致。

计量时序不改（仍先 resolve 再 `prepareTurn`），但 Lifecycle **必须**向 `prepareTurn` 透传 `toolNames`：schema 可在 final step 置空，名字不能。

### session

`Session.isSubagent` / `Session.agentName` 是静态路径补参的权威来源。composition 已有 `sessionManager`。不必把这两个字段扩到 HTTP 协议。

### commands / TUI / Web

占用展示权威是 `UiContextWindowUsage` + tracker。`ContextUsage` 是领域测量结果，经 `contextUsageToContextWindowUsage` 投影。`/status` 的 `context` 字段目前是多余的第二来源。

---

## 1.5 跨模块一致性

- improve-3 D11「占用率测量收口成单一入口」仍被遵守：没有第二套计数器。缺口是入口的**输入**不完整。
- improve-4 02 明确把静态/手动列为「本批保持 messages-only，占用监测/UI 前必须偿还」。本批兑现，不回退实时路径。
- `goals-duty` D1 与路子三不冲突：tools 不属于会话组装源。若 02 给信封起名，architecture.md 应补一句「计量对象是请求信封，不是 AssembledContext」（U6）。
- G2 85% vs 0.95 仍在，本批不修。

---

## 1.6 改动影响面（现状视角）

| 区域 | 会动到 | 不会动到 |
|------|--------|----------|
| `core/context/types.ts`、`context-manager.ts` | `getUsage` / `CompactOptions` / 可能新增载荷类型 | `AssembledContext` 字段、校准公式、阈值 |
| `core/system-prompt/assembler.ts` | `build` 入参接收 tool names；`toolsProvider` 退役或降为测试回落 | prompt 文本结构 |
| `core/lifecycle/lifecycle.ts` | 向 `prepareTurn` 透传 `toolNames`（与 schema 拆开） | `resolveTools` 相对 `prepareTurn` 的时序 |
| `adapters/ui-runtime/composition.ts` | `getContextUsage` / `compactSession` 解析 tools、从 session 补参 | 实时路径的 resolve 时序（由 Lifecycle 自己改透传） |
| `adapters/ui-inprocess.ts`、`commands/builtin.ts` | `/status` 不再并行现算第二份；查询路径按 session 身份传参 | HTTP 路径形状、SDK `UiContextWindowUsage` 字段 |
| 测试 | manager / composition / commands 合同 | tokenCounting 算法单测、Web/TUI 占用条样式 |

兼容：领域 API 是进程内 TypeScript，无外部版本化协议要迁。`/status` 载荷若停止填充 `context` 或改为与 `contextWindow` 同源，属于对内合同，TUI 当前不展示该字段。

---

## 1.7 SWE 原则审视摘要

| 透镜 | 判断 |
|------|------|
| 本质 vs 偶然复杂度 | 「tools 每轮重解析、会话上下文跨轮持久」是本质复杂度。把 schema 塞进 `AssembledContext` 或照搬 pi 的三字段（导致 system 双计）都是偶然复杂度 |
| 耦合方向 | ContextManager 不解析 registry——保持。prompt 拉 registry——应改成调用方注入（DIP） |
| SRP | 计量入口已经单一；不要为静态路径再写一个计数器 |
| YAGNI | 载荷层是类型 + 让 `measureUsage` 吃它，不是新包、不是 `StreamInput → Prepared` 两段式（03 A3 reject） |
| DRY 的正确对象 | 要单一化的是「计量对象=发出去的信封」，不是把 mask 的 per-part 估算和 occupancy 捏成一个函数 |
| LSP | 主/子代理走同一套 `assemble` / `measure` / `compact`，用参数区分，不加守卫把子代理变成不可替换的特例 |

---

## 1.8 与既有文档关系

| 文档 | 关系 |
|------|------|
| [00](./00-discussion.md) | 约束来源。U4、U7 在本文关闭。U1/U2/U3/U5/U6 的推荐答见 02 |
| [03](./03-reference-projects.md) | 路子三、正确传参、不学三家的多口径。U7 与 pi D2 的算法差异在本文消解 |
| [improve-4](../improve-4/README.md) | 前序。实时路径是基线，不是重做对象 |
| [improve-5](../improve-5/README.md) | 后序。本文不引入 cache 字段；improve-5 不回退本批占用模型 |
| [goals-duty.md](../goals-duty.md) / [architecture.md](../architecture.md) | D1 无需为 tools 改组装源；architecture 是否补信封说明见 02 U6 |

---

## 1.9 承重问题清单（02 必须逐条回应）

| ID | 问题 | 去向 |
|----|------|------|
| P1 | 静态 `getUsage` / 手动 `compact` 不计 tools | 02 Phase 1 |
| P2 | 共用 factor 放大 P1（U7：纳入 tools 后同量纲，不双计） | 02 决策表；04 用数值用例钉住 |
| P3 | 静态路径丢失 `isSubagent` / `agentName` | 02 Phase 2 |
| P4 | `/status` 双取、`context` 与 `contextWindow` 口径可能不同 | 02 Phase 3 |
| P5 | prompt 拉 registry、计量拿不到同一次解析的 schema；去掉 `toolsProvider` 后须拆开 `tools`/`toolNames` | 02 Phase 1；04 TC-3 / TC-13 |
| P6 | `CompactOptions` 无 `tools` / `agentName` | 02 Phase 1–2 |
| P7 | 既有测试把「两参数 assemble」和「status 双字段」写成合同 | 04 必须改这些合同，否则实施会被旧测试锁死 |
