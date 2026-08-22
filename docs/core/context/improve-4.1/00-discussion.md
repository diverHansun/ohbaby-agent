# 0. 讨论记录与已确认要点

> 2026-08-22 与用户讨论定稿。本文只记**已确认结论**与**明确未决项**；推理与代码证据见 01，方案见 02。
> 参考项目调研结论见 [03](./03-reference-projects.md)。

---

## 1. 背景与动机

### 1.1 improve-4 制造了一个静态路径的回归

improve-4 任务 A 把实时 Lifecycle 路径的 tool schema 纳入了估算：`estimateWireHeuristic` 增加可选 `tools` 参数，`Lifecycle` 把 `resolveTools` 提前到 `prepareTurn` 之前，`PrepareTurnInput` 携带 `tools`。这条路径现在是准的。

但静态路径（`composition.getContextUsage`）和手动压缩路径（`ContextManager.compact`）仍是 **messages-only**。问题不在于「它们本来就粗」，而在于：

> **两条路径共用同一个 EMA 校准因子。**

improve-4 之前，实时路径也漏 tools，factor 被 provider 真实 usage 拉高以补足缺口，静态路径搭便车获得了一部分「歪打正着」的补偿。improve-4 修好实时路径后，factor 不再需要吸收 tools 缺口而相应回落，这份补偿被抽走，静态路径会系统性少算约 tools 那一截。

> **U7 已在 01 用公式关闭**：纳入 tools 后分子分母同量纲，规划期不实测 factor 数值。量级由 04 TC-2 钉住。

这是 improve-4 引入的回归，不是既有的精度分层。用户对此的判断是：**这属于 improve-4 的收尾，应先于 cache 做。**

### 1.2 improve-4 自己已经登记了这笔债

improve-4 的 00/02/05 均记有「`getContextUsage` / 手动 compact 的 tools-aware 估算」为遗留项，并注明「context 占用监测/UI 实施前必须偿还」「不属于 improve-5」。本批即兑现该登记。

### 1.3 顺带发现的两个问题

- **UI 口径分叉**：占用条读 tracker（含 tools）。`/status` 的 Context 行读 `contextWindow`（tracker 优先）；同时又并行现算一份 `context`（messages-only）塞进载荷。TUI 不展示 `context` 字段。冷启动 tracker 未命中时回落仍少算 tools。
- **子代理上下文测不准**：静态占用查询未传 `isSubagent` / `contextScopeId` / `agentName`，子代理会话若走到这条路径，会按主 agent 口径加载记忆、拉取全量会话消息，得到错误结果。

---

## 2. 已确认：四批顺序

| 顺序 | 批次 | 落点 |
|------|------|------|
| 1 | **本批**：tools 计量 + 占用口径统一 | `improve-4.1/` |
| 2 | prompt cache 观测与计费 | `improve-5/` |
| 3 | context 压缩/管理整体检查 | 待定 |
| 4 | 上下文窗口占用实时监测 + UI | 待定 |

**确认理由**：第 3 批排在 cache 之后，因为 cache 会改动 provider usage 的语义，进而影响压缩决策的输入；让整体检查看到最终形态更划算。第 4 批排最后，因为占用 UI 依赖本批把口径统一。

---

## 3. 已确认：架构路线 —— 路子三（请求载荷层）

### 3.1 结论

引入一个**请求载荷层**：表示「这一次要发给模型的完整载荷」。占用计量对这个载荷做。

落地形状（01 诊断后写入，不改变路子三）：ohbaby 的 `serializeForLlm` 已把 system prompt + memory 折进 `messages[0]`，因此类型是 `{ messages, tools }`，**不再单独复制 `systemPrompt` 字段**。pi 的三分法来自它的 messages 不含 system；照搬会把 system 计两遍。语义上信封仍然包含 system prompt。

**`AssembledContext` 保持不变**，tools 不进入它。

### 3.2 为什么不是路子二（tools 塞进 AssembledContext）

三家参考项目的**默认路径**都不把工具 schema 放进「会话级上下文」：

| 项目 | 会话级（持久，跨轮） | 请求级（每轮重建，含 tools） |
|------|---------------------|---------------------------|
| pi | `SessionContext`（`packages/agent/src/harness/types.ts:466`），只存工具**名** `activeToolNames: string[] \| null` | `Context`（`packages/ai/src/types.ts:487`）= `systemPrompt? + messages + tools?: Tool[]` |
| opencode | `Session.Info`（`src/session/session.ts:224`）+ 持久化 parts | `StreamInput`（`src/session/llm.ts:35`）→ `Prepared`（`src/session/llm/request.ts:38`） |
| kimi-code | `ContextMemory._history`（`packages/agent-core/src/agent/context/index.ts:47`） | `LLMChatParams`（`packages/agent-core/src/loop/turn-step.ts:146`）→ `kosong.generate(provider, systemPrompt, tools, messages, …)`（`packages/agent-core/src/agent/turn/kosong-llm.ts:128`） |

理由一致：tools 是**每轮按 mode/permission/MCP 状态重新解析**的，塞进跨轮持久的会话上下文会污染其语义，并制造「这份 context 里的 tools 是哪一轮的」这种不可回答的问题。

opencode 的切分尤其值得参照：持久层只在 **UserMessage** 上存**工具开关**（`tools?: Record<string, boolean>`，`packages/schema/src/v1/session.ts:353`），完整的工具 schema 每个 loop step 由 `SessionTools.resolve` 重新组装（`src/session/prompt.ts:1226-1241`），从不落盘。

pi 是本批请求载荷层最贴近的样板：`Context` 把 `systemPrompt + messages + tools` 三者装在同一个对象里，每次 LLM 调用现建（`packages/agent/src/agent-loop.ts:298-302`），不跨轮持久；跨轮持久的是 session entry tree，`SessionContext` 由 `buildSessionContext()` 从 entries **按需推导**（`packages/agent/src/harness/session/session.ts:139-148`），本身不落盘。这提示载荷层必须**计量到** system prompt（ohbaby 里它已经在 messages 里），而不是再复制一个字段。

**已知例外（如实记录，不影响本批结论）**：kimi-code 的渐进式工具披露会把动态加载的 MCP schema 作为 `role: 'system'` 消息写入持久 history（`packages/agent-core/src/tools/builtin/select-tools.ts:103-109`），其估算函数也会计入 message 上的 `tools` 字段（`packages/agent-core/src/utils/tokens.ts:72-77`）。这是为「按需披露工具」这一**特定功能**付出的刻意代价，默认路径仍是每 step 从 `loopTools` 重新解析（`packages/agent-core/src/loop/turn-step.ts:116-120`）。ohbaby 本批无渐进披露需求，不引入该例外。

ohbaby 的 `AssembledContext` 语义正是「会话级组装结果」。路子三让它保持干净，与三家一致。详见 [03 §3.2](./03-reference-projects.md)。

### 3.3 连带确认：工具解析上浮

采用路子三后，工具解析由**上层做一次**，同时喂给 system prompt 构建与占用计量。

依赖方向从「`SystemPromptProvider` 内部拉取工具注册表」改为「上层注入」。

参考项目分两种形态，但**没有一家**在 prompt 构建内部查运行时 registry：

| 项目 | system prompt 构建签名 | 是否接触工具 |
|------|----------------------|-------------|
| opencode | `SystemPrompt.provider(model: Provider.Model): string[]`（`src/session/system.ts:27`） | 否；tools 由 `SessionTools.resolve` 独立组装，在 `LLMRequestPrep.prepare` 汇合 |
| kimi-code | `SystemPromptRenderer = (context: SystemPromptContext) => string`（`packages/agent-core/src/profile/types.ts:47`） | 否；仅用 profile 的**静态工具名列表**决定模板变量（`profile/resolve.ts:140-166`），不查运行时 registry |
| pi | `buildSystemPrompt(options: BuildSystemPromptOptions)`（`packages/coding-agent/src/core/system-prompt.ts:28`），其中 `selectedTools?: string[]` | **接收工具名**（push 模型）；registry 解析在调用方 `_rebuildSystemPrompt` 完成（`packages/coding-agent/src/core/agent-session.ts:1021-1054`） |

opencode / kimi-code 的 prompt **完全不碰工具**；pi **接收工具名**（不是 schema），且解析动作在调用方。ohbaby 需要工具名进 prompt，因此 pi 的 push 形态最贴合。

**这反过来印证了 ohbaby 当前设计的问题所在**：`SystemPromptProvider` 通过 `toolsProvider` 主动拉取工具注册表，是三家都没有的依赖方向。本批把它改为上层注入，属于向参考实践靠拢，但**需要改 `SystemPromptProvider` 接口**，是必须承担的成本（具体改法见 U2）。

---

## 4. 已确认：子代理 —— 正确传参，不加守卫

### 4.1 结论

让 `isSubagent` / `agentName` 从 `Session` 传到 `assemble`，**任何 agent 的上下文都能被同一套逻辑正确测量**。静态占用查询**默认不传** `contextScopeId`（该字段是 run 内消息过滤键，不在 `Session` 上）；实时路径继续按 Lifecycle 已有方式传。

用户明确**收回**了上一轮讨论中「给子代理占用查询加守卫（直接拒绝）」的提议。

### 4.2 理由

用户对子代理的原则是「**隔离上下文，但主 agent 能看到结果，机制统一**」。三家参考项目全部印证这一模式：

- **隔离**
  - opencode：子 session 有独立 `sessionID`，`Session.Info.parentID` 不为空（`src/session/session.ts:231`），由 `sessions.create({ parentID })` 创建（`src/tool/task.ts:156-172`）。
  - kimi-code：`Session.createAgent({ type: 'sub' })` 为子代理分配独立 homedir `<sessionHomedir>/agents/<id>`（`packages/agent-core/src/session/index.ts:524-528`）。常规 Task 不复制父 history（`subagent-host.ts:360-378`）；BTW 例外会投影父 history（`230`），ohbaby 不引入该例外。
  - pi：**隔离最彻底**。核心不内置子代理，由扩展实现（`packages/coding-agent/examples/extensions/subagent/index.ts`），子代理是独立 OS 进程且带 `--no-session`（`294-296`、`335-338`），既不共享父 session 也不写自己的 session 文件。
- **统一**：核心压缩/计量逻辑**没有 caller-type 分支**，三家一致。opencode 的 `SessionCompaction.process` 只按 `sessionID` 操作，对主/子 session 完全同构（`src/session/compaction.ts:289-511`）；kimi-code 主/子代理共用同一 `Agent` 类与同一 `FullCompaction` / `tokenCountWithPending` 路径（`packages/agent-core/src/agent/index.ts:136-137, 206-207`）；pi 的 `compact()` / `prepareCompaction()` / `estimateContextTokens()` 签名里没有任何 subagent 参数（`packages/agent/src/harness/compaction/compaction.ts:640, 733`、`232`）。
- **结果回灌**：子代理只把最终摘要交回父级，三家一致。opencode 取子 session 最后一条 text part（`src/tool/task.ts:213`）；kimi-code 取 `lastAssistantText(child)` 作为 `resultSummary`（`packages/agent-core/src/session/subagent-host.ts:339-357`）；pi 的 `getFinalOutput()` 只取最后一条 assistant 的第一个 text block（`examples/extensions/subagent/index.ts:170-179`），完整 messages 仅放在 `details` 里供 UI/调试，不注入父 transcript。

守卫是「让子代理成为二等公民」，与「机制统一」相悖。正确传参才是三家的做法。详见 [03 §3.2 C 组](./03-reference-projects.md)。

---

## 5. 已确认：UI 口径统一

| 决策项 | 结论 |
|--------|------|
| 「当前占用」唯一权威 | `ContextWindowUsageTracker`（cache-first） |
| `/status` | 也先读 tracker；tracker 无值时才回落到静态计算 |
| 静态计算的定位 | 冷启动/无实时记录时的**回落**，不再是 `/status` 的首选来源 |

目标：同一时刻，占用条与 `/status` 不再出现互相打架的数字。

**为什么这是约束而非偏好**：三家参考项目全都容忍多套口径并存（opencode 触发用真实 usage、选尾部用字符除四；kimi-code 有三条互不相同的口径；pi 的 UI 与 `clampMaxTokensToContext` 也分叉）。但它们**都没有校准因子**，口径各管各的、互不污染。ohbaby 的 EMA factor 由真实 usage 回归得出并被多条路径**共用**，某条路径少算 tools 会经 factor 反噬其余路径——这正是 §1.1 那个回归的机理。**耦合了 factor，就必须统一口径。** 详见 [03 §3.3 R1](./03-reference-projects.md)。

---

## 6. 已确认：计量口径的几条硬约束

| 项 | 结论 |
|----|------|
| 静态路径的 step 语义 | 按「非最后一步」计算，携带完整 tools。**不追求**与实时逐步计量数值相等 |
| 校准因子 | **不**为静态路径单独维护第二个 factor；继续共用 |
| `tokenCounting.ts` 算法 | 不动 |
| 计量入口 | 沿用 improve-3 D11 的单一入口 `measureUsage`，**扩大其输入**，不新建第二个入口 |
| 占用 breakdown | 本批**不**引入 `system / tools / messages` 分类字段 |

---

## 7. 已确认：边界（本批不做）

| 项 | 归属 |
|----|------|
| Prompt cache 字段、policy、命中率与成本统计 | improve-5 |
| 占用三类 breakdown、占用条 UI 改造 | 第 4 批 |
| 子代理占用的 UI 展示入口 | 第 4 批（本批只保证测量正确） |
| 压缩阈值/档位/prune/summary 策略调整 | 第 3 批 |
| 长期记忆工具、hooks 注入 | `docs/core/memory/` |
| 精确 tokenizer / tiktoken | 长期项 |
| 校准因子持久化 | 维持 improve-3 D3 决策 |
| 打开 `maskEnabled` | 不动 |
| `goals-duty.md` G2 的 85% vs 代码 0.95 阈值 gap | 本批只在 01 记录，不修 |

---

## 8. 未决项（规划期收敛状态）

01/02 已给出推荐；**仍须用户在审查闸门拍板**的只剩实现偏好，不再是「方向未定」：

| # | 项 | 状态 |
|---|----|------|
| U1 | 载荷放置与命名 | **02 推荐**：`core/context/types.ts` · `RequestPayload = { messages, tools? }`。请确认 |
| U2 | `SystemPromptProvider` 改法 | **02 推荐**：`build` 收 `toolNames`，生产去掉 `toolsProvider`（一步到位）。请确认 |
| U3 | `getContextUsage` 公开签名 | **02 推荐**：不扩 HTTP；服务端从 `Session` 读身份。请确认 |
| U4 | 静态解析副作用 | **01 关闭**：`loadedNames` 不建连；改为一次解析两用 |
| U5 | 缺参调用点 | **02 Phase 1–2 列清**：assemble 改 options；composition 补传 |
| U6 | architecture.md | **02 Phase 1**：补计量对象=信封，不新画组件 |
| U7 | factor × tools 量纲 | **01 关闭**：同量纲、不双计；不搬 pi 锚点增量。04 TC-2 钉住 |

---

## 9. 用户确认记录

- **顺序**：「建议 improve-4 遗留的 tools 粗估先于 improve-5 来做……improve-5 之后来做 context 上下文压缩/管理的整体检查，最后来做 context 上下文窗口占用的实时监测和 UI 显示」
- **架构**：「改走路子三：引入请求载荷层（类似 pi 的 Context / opencode 的 Prepared），tools 装在那儿，AssembledContext 不变」
- **子代理**：「正确传参（我收回上一轮的加守卫建议）：让任何 agent 的上下文都能被同一套逻辑正确」
- **子代理原则**（前序讨论）：隔离上下文，但主 agent 能看到结果，机制统一
- **文档节奏**：「先写 readme + discussion + reference-projects」，之后做文档自检并与优秀项目对比，同时启用子代理审查
