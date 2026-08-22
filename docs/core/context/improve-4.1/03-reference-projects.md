# 3. 优秀项目借鉴

> 调研日期：2026-08-22。本文所有结论均来自对三个仓库源码的实读，每条给出 `路径:行号` 锚点。
> 用途：为本批「引入请求载荷层 + 静态路径 tools 计量 + 子代理正确传参」提供外部实践依据。
> 结论摘要见 [00 §3–§5](./00-discussion.md)。

---

## 3.1 借鉴来源

| 项目 | 本地路径 | 语言/形态 | 调研范围 |
|------|---------|----------|---------|
| **pi** | `/Users/hansun025/Projects/code-cli/pi` | TS monorepo（`packages/ai`、`packages/agent`、`packages/coding-agent`） | 请求载荷层、token 估算、system prompt 依赖方向、子代理 |
| **opencode** | `/Users/hansun025/Projects/code-cli/opencode` | TS（`packages/opencode/src`、`packages/schema`、`packages/core`） | 持久层 vs 请求层、工具解析时机、压缩触发口径、子 session |
| **kimi-code** | `/Users/hansun025/Projects/code-cli/kimi-code` | TS pnpm monorepo（`packages/agent-core` 为主） | 请求组装、三条用量口径、`PromptOrigin`、子代理隔离 |

**调研方法与可信度说明**：本轮调研推翻了先前一份摘要中的三处错误记载——kimi-code 并非 Python 项目且不存在 `_build_request_payload`；`KIMI_HOME` 不是其子代理隔离机制（仅见于测试与 docker 脚本）；opencode 的 `Prepared` / `StreamInput` 位于 `session/llm/` 子目录而非 `session/` 根目录。2026-08-22 二次锚点审核后又校正：B2 行号 352→353（UserMessage.tools）、R1 的 pi clamp 路径、E4 的 BTW 例外、D2「双计」措辞。核心 adopt/reject 未改。

---

## 3.2 可借鉴点

### A. 请求载荷层（本批核心）

| # | 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|------|------|---------|-------------|
| A1 | pi | `Context = { systemPrompt?, messages, tools? }`（`packages/ai/src/types.ts:487`），每次 LLM 调用现建（`packages/agent/src/agent-loop.ts:298-302`），不跨轮持久 | 会话/请求二分与路子三一致 | **adapt**：二分 adopt；字段不照抄。ohbaby messages 已含 system，类型为 `{ messages, tools }` |
| A2 | pi | 载荷**计量到** system prompt，而不只是对话 messages | 漏掉 system 会少算 | **adopt（语义）**：ohbaby 通过 `serializeForLlm` 把 system 放进 messages[0]，不另建字段，避免双计 |
| A3 | opencode | 外层 `StreamInput`（`src/session/llm.ts:35`）→ `LLMRequestPrep.prepare` → `Prepared`（`src/session/llm/request.ts:38`）→ `streamText({ tools: prepared.tools, messages: prepared.messages })`（`src/session/llm.ts:280, 317-324`） | 展示了「外层意图对象 → 规范化载荷 → SDK 调用」的两段式 | **adapt**：ohbaby 单段即可，无需两段；YAGNI |
| A4 | kimi-code | 调用处组装 `LLMChatParams`（`packages/agent-core/src/loop/turn-step.ts:146`；类型在 `loop/llm.ts:71`），system prompt 作为 `generate()` 的**独立形参**传入而不进 messages（`packages/agent-core/src/agent/turn/kosong-llm.ts:128-135`） | 另一种切法：system 不入载荷对象 | **reject 其字段切分**：ohbaby 已把 system 折进 messages。计量仍必须覆盖 system 文本 |

### B. 持久层与请求层的边界

| # | 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|------|------|---------|-------------|
| B1 | pi | `SessionContext` 只存工具**名** `activeToolNames: string[] \| null`（`packages/agent/src/harness/types.ts:466`），不存 schema | 证明「会话级只需名字，schema 属请求级」 | **adopt（理念）**：ohbaby 本批 `AssembledContext` 连名字都不必存 |
| B2 | opencode | **UserMessage** 上只存工具**开关** `tools?: Record<string, boolean>`（`packages/schema/src/v1/session.ts:353`，352 是 `system`）；`Session.Info` 无 tools 字段。完整 schema 每 loop step 由 `SessionTools.resolve` 重建（`src/session/prompt.ts:1226-1241`），从不落盘 | 同上，且切分更清晰 | **adopt（理念）** |
| B3 | pi | `SessionContext` 本身不序列化，由 `buildSessionContext()` 从持久 entry tree **按需推导**（`packages/agent/src/harness/session/session.ts:139-148`） | 与 ohbaby `assemble()` 每次重新组装的模型同构 | **已具备**：确认 ohbaby 现有模型无需改动 |

### C. system prompt 与 tools 的依赖方向

| # | 项目 | 做法 | ohbaby 取舍 |
|---|------|------|-------------|
| C1 | opencode | `SystemPrompt.provider(model: Provider.Model): string[]`（`src/session/system.ts:27`）——**完全不碰工具**；prompt 与 tools 两条平行装配线，在 `LLMRequestPrep.prepare` 才汇合 | **adopt（方向）** |
| C2 | kimi-code | `SystemPromptRenderer = (context: SystemPromptContext) => string`（`packages/agent-core/src/profile/types.ts:47`）——同样不碰运行时 registry，仅用 profile 的**静态工具名列表**决定模板变量（`packages/agent-core/src/profile/resolve.ts:140-166`） | **adopt（方向）** |
| C3 | pi | `buildSystemPrompt(options)` 接收 `selectedTools?: string[]`（`packages/coding-agent/src/core/system-prompt.ts:8-12, 28`）；registry 解析在调用方 `_rebuildSystemPrompt` 完成后**推入**（`packages/coding-agent/src/core/agent-session.ts:1021-1054`） | **adopt**：ohbaby 需要工具名进 prompt，pi 的 push 形态最贴合 |

**共同点**：三家的 registry 解析**一律在调用方**。ohbaby 现状（`SystemPromptProvider` 经 `toolsProvider` 主动拉取）是三家都避免的方向。

### D. 对请求载荷计量（本批要害）

| # | 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|---|------|------|---------|-------------|
| D1 | kimi-code | `estimateRequestTokens` 把 **system prompt + 非 deferred 的 loopTools + messages** 一起算（`packages/agent-core/src/agent/compaction/full.ts:223-230`） | 现成的「对完整请求载荷计量」先例 | **adopt**：本批目标函数的直接对照物 |
| D2 | pi | 估算对 tools **条件计入**：无 provider usage 锚点时计入 systemPrompt + 全部 tools（`packages/ai/src/utils/estimate.ts:105-108, 134-135`）；**有锚点时只补算锚点之后新增的工具**（`addedToolNames`，`118-126`） | 锚点内的真实 usage 已含当时的工具 schema，无条件再加即重复计数 | **reject 整棵移植**：ohbaby 是全量启发式 × EMA，不是锚点+增量。危险是把条件计入**塞进**现有 `heuristic×factor`（两套口径混用）。整棵换成 pi 算法未必双计，但会抛弃已生效的 factor。理念「分子分母必须同量纲」**adopt** |
| D3 | pi | 压缩后 usage 失效检测：按 timestamp 判定 stale usage（`packages/ai/src/utils/estimate.ts:71-73`） | ohbaby 压缩后同样面临「旧 usage 不再代表当前上下文」 | **待评估**：可能属第 3 批 |
| D4 | pi | `ContextUsage.tokens: number \| null`，压缩后无新 usage 时返回 `null`（`packages/coding-agent/src/core/extensions/types.ts:288-293`、`core/agent-session.ts:3195-3197`），UI 显示 `?`（`modes/interactive/components/footer.ts:111, 150-153`） | 「诚实的未知」优于「错误的数字」 | **defer 到第 4 批**：本批不改 UI 形态 |

### E. 子代理（印证已确认决策）

| # | 项目 | 做法 | ohbaby 取舍 |
|---|------|------|-------------|
| E1 | 三家 | 压缩/计量核心逻辑**无 caller-type 分支**：opencode `SessionCompaction.process` 只按 `sessionID`（`src/session/compaction.ts:289-511`）；kimi-code 主/子共用同一 `Agent` + `FullCompaction`（`packages/agent-core/src/agent/index.ts:136-137, 206-207`）；pi 的 `compact()` / `prepareCompaction()` / `estimateContextTokens()` 签名无 subagent 参数（`packages/agent/src/harness/compaction/compaction.ts:232, 640, 733`） | **adopt**：直接支撑「正确传参、不加守卫」 |
| E2 | 三家 | 子代理只回传**最终摘要**：opencode 取最后 text part（`src/tool/task.ts:213`）；kimi-code 取 `lastAssistantText`（`packages/agent-core/src/session/subagent-host.ts:339-357`）；pi 的 `getFinalOutput()` 取最后 assistant 的首个 text block（`examples/extensions/subagent/index.ts:170-179`） | **已具备**：ohbaby 模型一致，确认无需改动 |
| E3 | opencode | 子 session 有独立 `sessionID` + `Session.Info.parentID`（`src/session/session.ts:231`） | **已具备**：ohbaby 的 `contextScopeId` 承担同等职责 |
| E4 | kimi-code | 子代理独立 homedir `<sessionHomedir>/agents/<id>`（`packages/agent-core/src/session/index.ts:524-528`）。**常规 Task** 新 `Agent` + `configureChild` 不拷父 history（`subagent-host.ts:360-378`）。例外：BTW 会 `useProjectedHistoryFrom(parent.context)`（`230`） | **已具备（理念）**：ohbaby 常规子代理也不拷父 history；不引入 BTW 式共享 |

---

## 3.3 明确不借鉴

| # | 项目 | 做法 | 不借鉴的理由 |
|---|------|------|-------------|
| R1 | **三家全部** | **容忍多套用量口径并存**。opencode：压缩触发用 provider 真实 usage（`src/session/overflow.ts:22-34`），压缩选尾部用 `length / 4` 字符估算（`packages/core/src/util/token.ts:3-5`）。kimi-code：UI 只用 provider `tokenCount`（`services/session/sessionService.ts:458-459`），压缩触发用 `tokenCountWithPending`，overflow 预算才用含 tools 的 `estimateRequestTokens`——**三条口径互不相同**。pi：UI `getContextUsage` 走 messages-only（`packages/coding-agent/src/core/agent-session.ts:3200-3201` 对 `this.messages` 估），`clampMaxTokensToContext` 另走完整 `Context`（`packages/ai/src/api/simple-options.ts:15-18`） | **这正是 ohbaby 要修的病，不是要学的招。** 三家敢分叉，是因为**它们都没有校准因子**（见 R2）；口径各管各的，互不污染。ohbaby 的 EMA factor 由真实 usage 回归得出、并被多条路径**共用**，一旦某条路径少算 tools，偏差会经 factor 反噬其余路径——这正是 improve-4 制造静态路径回归的机理。**耦合了 factor，就必须统一口径。** |
| R2 | **三家全部** | **均无对 provider usage 的校准因子**（pi、opencode、kimi-code 三份核实均确认「未发现」） | 不借鉴其「无因子」。ohbaby 的 factor 是 improve-3 的既有决策且已生效，本批不动（[00 §6](./00-discussion.md)）。但需认识到：**有 factor 是 ohbaby 与三家的关键结构差异**，凡涉及「多路径口径」的借鉴都要先过这一层过滤 |
| R3 | kimi-code | 渐进式工具披露把动态 MCP schema 作为 `role: 'system'` 消息写入**持久 history**（`packages/agent-core/src/tools/builtin/select-tools.ts:103-109`），估算函数也计入 message 上的 `tools` 字段（`packages/agent-core/src/utils/tokens.ts:72-77`） | ohbaby 无「按需披露工具」需求。这是为特定功能付出的刻意代价，引入会直接破坏本批「tools 不进 `AssembledContext`」的核心决策 |
| R4 | pi | 子代理为**独立 OS 进程** + `--no-session`（`examples/extensions/subagent/index.ts:294-296, 335-338`），且核心不内置子代理、由扩展提供 | 进程级隔离成本远高于收益；ohbaby 已有 `contextScopeId` 实现会话内隔离，够用。且 ohbaby 的子代理是核心能力，不宜外置为扩展 |
| R5 | opencode | `Token.estimate = round(length / 4)`（`packages/core/src/util/token.ts:3-5`） | ohbaby 已有 `tokenCounter` 且区分 CJK；退回字符除四是倒退 |
| R6 | kimi-code | `PromptOrigin`（实为 **12** 种，非传闻的 10 种；`packages/agent-core/src/agent/context/types.ts:89-101`）影响压缩后消息去留（`compactionUserMessageDisposition`，`agent/compaction/handoff.ts:61-80`） | 与本批无关（本批不动压缩策略）。已有 [improve-3/origin](../improve-3/origin/README.md) 单独跟踪，不在此重复 |

---

## 3.4 对 02 方案的影响

以下决策**直接来自**本文调研，02 应据此展开：

1. **载荷层形态取 pi 的「会话 / 请求二分」，字段按 ohbaby 落地**（A1 + A2）——每轮现建、不进 `AssembledContext`。ohbaby 的 messages 已含 system，故类型为 `{ messages, tools }`，不照抄 pi 的独立 `systemPrompt` 字段（避免双计）。放置：`core/context/types.ts`（见 02 U1）。

2. **不采用 opencode 的两段式（A3）**——ohbaby 无 `StreamInput → Prepared` 的规范化需求，单一载荷类型即可。避免为想象中的未来分层。

3. **`SystemPromptProvider` 改为接收工具名（C3）**——按 pi 的 push 形态：上层解析一次 → 同时推给 prompt 构建与载荷计量。这收敛了 [00 U2](./00-discussion.md) 的方向：`toolsProvider` 字段退役，改为入参。

4. **计量目标函数对齐 kimi 的 `estimateRequestTokens`（D1）**——对载荷整体计量，而非对 messages 计量后再补 tools。

5. **tools 计量与 EMA factor（D2 + R1 + R2）** — 01 已关闭：ohbaby 保持全量启发式 × factor。不把 pi 的条件计入塞进这条公式。04 TC-2 钉住「禁止再加一遍 tools」。

6. **UI 口径统一的理由被强化（R1）**——三家分叉皆因无 factor；ohbaby 有 factor 故必须统一。[00 §5](./00-discussion.md) 的决策据此从「偏好」升格为「约束」。

7. **子代理「正确传参、不加守卫」获三家一致背书（E1）**——无一家在压缩/计量核心逻辑里做 caller-type 分支。[00 §4](./00-discussion.md) 无需再议。

8. **`ContextUsage.tokens` 可为 null 的设计（D4）留给第 4 批**——本批不改 UI 形态，但 02 在设计载荷层返回值时**不应排除**未来表达「未知」的可能。
