# usage 估算重构 · 实施和优化方案

> 实施边界：把 token 估算从"锚点快照 + 尾部启发式"改为"启发式 × 标定因子"；修复双计；压缩控制与 UI 显示共用一个估算、双投影；`shouldCompress` 退休。
> 前置：建议在编排层去三重（improve-3/编排层/）落地后推进——编排层产出工作集，估算是工作集的下游。
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G12
> 评审修正（F1-F6）：sentHeuristic 随 PreparedTurn 带出（F1+F2）、shouldCompress 退休（F3）、factor EMA + 夹值（F5）、点名要重写的测试（F6）
> 评审修正（F7-F9）：heuristic 数整条消息含 tool_calls（F8，§1.2）、撤硬地板后的近上限保护采用 A（F7，§二）、占用率测量收口成单一入口（F9，§三）

---

## 一、标定式估算的核心公式

```
factor(sessionId) = EMA(realPromptTokens / sentHeuristic)    ← 每次 API 响应更新
estimate(sessionId) = heuristic(本轮 wire 载荷) × factor(sessionId)
```

- `heuristic(wire)` = 对**实际发给模型的 wire 载荷**（`ChatCompletionMessage[]`）做 char-to-token 启发式估算
- `factor` = 标定因子，按 sessionId 存，每次 API 响应用 EMA 更新
- 首轮无真实数时 `factor = 1.0`

### 1.1 heuristic 量 wire 载荷，不是 domain serializeHistory（F1+F2）

> **评审修正（F1+F2）**：heuristic 必须量**实际发给模型的 wire 载荷**（`serializeForLlm` 产出的 `ChatCompletionMessage[]`），不是 domain 层的 `serializeHistory`。两者差 whitelist 投影（`projectToolMetadataForModel` 砍字段）、summary→`<context_summary>` 包裹、assistant→tool_calls 拆分。量 wire 载荷让 mask、whitelist、reasoning 注入全部自动计入，factor 退化成纯 tokenizer 偏差。

**关键设计：sentHeuristic 随 PreparedTurn 带出（F1）**

问题：如果让 lifecycle 拿 `sentWorkingSet` 重新 heuristic 一遍，它量和 prepareTurn 估算时用的那一份可能对不上（mask 状态、reasoning 注入、whitelist 投影都可能有差异）。`factor = 真实/heuristic` 一旦分子分母量的不是同一坨字节，factor 就把"漂移"也吸收进去了——而 factor 本该只吸收"char 启发式 vs 真 tokenizer"的偏差。

解决：`prepareTurn` 末尾本来就有 `messages`（wire 载荷），在量 heuristic 后把它存进 `PreparedTurn.sentHeuristic`。lifecycle 拿到 API 响应后直接用这个值——**不重新派生、不二次序列化、与用哪种序列化无关**。

```ts
// PreparedTurn 新增字段
export interface PreparedTurn {
  readonly messages: readonly ChatCompletionMessage[];
  readonly usage: ContextUsage;
  readonly compaction?: CompactResult;
  readonly assembledAt: number;
  readonly hasSummary: boolean;
  readonly sentHeuristic: number;  // ← 新增：本轮 wire 载荷的 heuristic 基线值
}

// prepareTurn 末尾：走单一入口 measureUsage（F9），它同时给出 usage 和 sentHeuristic
const messages = renderForModel(finalHistory, opts);
const { usage, sentHeuristic } = measureUsage({ messages, sessionId, modelId });
// ...
return { messages, usage, sentHeuristic, ... };
```

```ts
// lifecycle 拿到 API 响应后
const realPromptTokens = response.usage.promptTokens;
contextManager.updateCalibrationFactor(sessionId, realPromptTokens, prepared.sentHeuristic);
//                                                      ↑ 直接用 prepared 带出的值，不重新派生
```

**分母钉死为"我们实际发出去的那一份的 heuristic"**，消除漂移。这也顺势把 mask、whitelist 投影、reasoning 注入全收进同一份测量——量最终发出去的那份就行。

### 1.2 heuristic 要把"整条消息"数进去，别只数正文（F8）

> **评审修正（F8）**：数 wire 载荷时，必须把**整条消息**都算进去——不只是正文（`content`），还有模型调用工具的那一坨（`tool_calls`：工具名 + 参数）。

**问题点（大白话）**：模型调用工具的那一轮，真正占字数的是"调哪个工具、传什么参数"，这些放在消息的 `tool_calls` 字段里，而正文 `content` 这时候经常是空的（`null`）。如果只数正文，**凡是调用工具的轮次都会被数少**——少则几十、多则几百 token。更麻烦的是：每轮调几个工具、参数多长都不一样，于是"数少了多少"这件事本身忽大忽小，把校正系数（factor）也带得忽高忽低，反而抵消了 F2"量 wire 载荷让 factor 变稳"的好处。

**解决策略**：把**整条消息**序列化后再数。最稳的写法是直接对每条消息 `JSON.stringify`——正文、工具调用、工具结果 id、角色全都计入。JSON 那点固定的符号开销，会被 factor 自动吸收，不影响准确性。

```ts
// heuristic 量的对象是 wire 载荷（ChatCompletionMessage[]），不是 domain history
function estimateWireHeuristic(
  messages: readonly ChatCompletionMessage[],
  tokenCounter: Pick<TokenCounter, "estimateTokens">,
): number {
  // 整条消息一起数：content + tool_calls + tool_call_id + role 全计入。
  // 只数 content 会漏掉工具调用那一坨，导致工具轮被严重低估（F8）。
  const text = messages.map((m) => JSON.stringify(m)).join("\n");
  return tokenCounter.estimateTokens(text);
}
```

> **不再用 `serializeHistory`**（domain 层纯文本）做 heuristic 基础——它和 wire 载荷差 whitelist/summary 包裹/tool_calls 拆分。量整条 wire 消息后这些差异全部自动计入。

### 1.3 factor 的存储与更新（F5：EMA + 夹值）

> **评审修正（F5）**：factor 不再是 last-write-wins（`set = real/heuristic`），改为轻 EMA + 夹值。压掉单轮异常（如大段 base64 导致的病态比例），防退化发送集算出极端值。

```ts
// ContextManager 内部，仿 G4 的每轮计数器
const calibrationFactors = new Map<string, number>();  // sessionId → factor

const FACTOR_EMA_ALPHA = 0.5;        // 新观测权重，压单轮异常
const FACTOR_MIN = 0.5;              // 夹值下限
const FACTOR_MAX = 3.0;              // 夹值上限

function getCalibrationFactor(sessionId: string): number {
  return calibrationFactors.get(sessionId) ?? 1.0;
}

function updateCalibrationFactor(
  sessionId: string,
  realPromptTokens: number,
  sentHeuristic: number,            // ← F1：直接用 prepared 带出的值
): void {
  if (sentHeuristic <= 0) return;   // 防退化发送集
  const observed = realPromptTokens / sentHeuristic;
  const clamped = Math.max(FACTOR_MIN, Math.min(FACTOR_MAX, observed));  // 夹值
  const old = getCalibrationFactor(sessionId);
  const next = FACTOR_EMA_ALPHA * clamped + (1 - FACTOR_EMA_ALPHA) * old; // EMA
  calibrationFactors.set(sessionId, next);
}
```

- **每次 API 响应都更新**：lifecycle 拿到 API 返回的 `usage.promptTokens` 后，调 `updateCalibrationFactor(sessionId, realPromptTokens, prepared.sentHeuristic)`。
- **EMA（α=0.5）**：单轮异常被半衰，不会整个带偏 factor。
- **夹值 [0.5, 3.0]**：防退化发送集（near-empty）算出病态比例。
- **内存态，不写库**：与 G4 的每轮计数、mask 的 cutoff 同性质（单进程 YAGNI）。
- **跨进程恢复重置为 1.0**：首轮用 1.0，第一次 API 响应后纠偏。

---

## 二、双投影：压缩控制 vs UI 显示（F3：shouldCompress 退休）

> **评审修正（F3）**：当前 `getContextUsage` 的 budget 分支里 `shouldCompress = remainingInputTokens < COMPACTION_RESERVE_TOKENS`——用的是 `COMPACTION_RESERVE_TOKENS`（16384），不是 `compressionThreshold`（0.95）。生产里 `getBudget` 永远命中 → **0.95 对 `shouldCompress` 根本没生效**。而 `decideCompactionRung` 用的是 `usageRatio >= thresholds.summary`（0.95）。两个不同的触发线会打架。
>
> **决策：`shouldCompress` 退休**。控制信号单一真相 = `decideCompactionRung` 基于 `usageRatio` 对 `thresholds.summary`。`shouldCompress` 字段/方法从 `ContextUsage`/`ContextManager` 接口移除，消费方改用 `decideCompactionRung`。

```ts
export function getContextUsage(
  currentTokens: number,
  modelId: string,
  tokenCounter: Pick<TokenCounter, "getLimit" | "getBudget">,
): ContextUsage {
  const budget = tokenCounter.getBudget?.(modelId, { usedInputTokens: currentTokens });

  if (budget) {
    return {
      contextLimit: budget.contextWindowTokens,
      currentTokens,
      inputBudgetTokens: budget.inputBudgetTokens,
      modelId,
      remainingTokens: budget.remainingInputTokens,
      reservedOutputTokens: budget.reservedOutputTokens,
      safetyMarginTokens: budget.safetyMarginTokens,
      // shouldCompress 退休后，控制信号由 decideCompactionRung 基于 usageRatio 统一决策
      usageRatio: budget.usageRatio,                    // 压缩控制用：usedInput / inputBudgetTokens
    };
  }

  const contextLimit = tokenCounter.getLimit(modelId);
  const usageRatio = contextLimit === 0 ? 1 : currentTokens / contextLimit;
  return {
    currentTokens,
    contextLimit,
    modelId,
    remainingTokens: Math.max(0, contextLimit - currentTokens),
    // shouldCompress 退休后不再出现在 ContextUsage
    usageRatio,
  };
}
```

**两个比率从同一个 `currentTokens` 派生**：

| 比率 | 公式 | 用途 | 偏置 |
|------|------|------|------|
| `usageRatio`（压缩控制） | `usedInputTokens / inputBudgetTokens` | `decideCompactionRung` 判断该不该压 | 允许略高估，偏保守（inputBudget 已扣输出预留） |
| `displayRatio`（UI 显示） | `currentTokens / contextWindowTokens` | 前端/CLI 展示窗口占用率 | 如实反映整个窗口 |

- UI 显示通过 `context-window-usage.ts` 的 `contextUsageToContextWindowUsage` 派生（已有，不改）——它用 `currentTokens / contextLimit`，即 displayRatio。
- 压缩控制用 `usageRatio`（基于 inputBudget）——`decideCompactionRung` 的唯一真相。
- **分子相同**：都是 `currentTokens`（标定式估算的结果）。
- **数学关系**：`contextWindowTokens > inputBudgetTokens`（后者扣了输出预留 + 安全边际）→ 同一 currentTokens 下 `displayRatio < usageRatio`。即"压缩在 0.95（对 inputBudget）触发时，UI 显示约 0.91（对 contextWindow）"——这是预期，不是"状态栏说谎"。

### shouldCompress 退休的影响面

`shouldCompress` 当前被以下位置消费（grep 确认）：

| 位置 | 当前用法 | 退休后改法 |
|------|---------|-----------|
| `context-manager.ts:120`（`decideCompactAction`） | `if (!input.usage.shouldCompress)` | 由 `decideCompactionRung` 取代（G8），不再读 `shouldCompress` |
| `context-manager.ts:737/834/860/1021`（compress/compact/prepareTurn 闸门） | `if (!force && !usage.shouldCompress)` | 由 `runCompaction` 脊椎 P2 的 `decideCompactionRung` 统一判断 |
| `context-manager.ts:1216-1217`（`ContextManager.shouldCompress` 方法） | `return usage.shouldCompress` | 删除方法 |
| `types.ts:68`（`ContextUsage.shouldCompress` 字段） | 接口字段 | 删除字段 |
| `types.ts:141`（`ContextManager.shouldCompress` 方法） | 接口方法 | 删除方法 |
| `events.ts:33`（Zod schema `shouldCompress: z.boolean()`） | 事件 schema | 删除字段 |
| 各测试文件（mock ContextUsage） | `shouldCompress: false/true` | 删除字段 |

> 退休顺序：编排层引入 `decideCompactionRung` 时，脊椎 P2 不再读 `shouldCompress`；usage-估算 子主题正式从 `ContextUsage`/`ContextManager`/`events.ts` 移除字段；测试同步更新。

### 撤掉硬性安全垫之后的近上限风险（F7）

> **评审修正（F7）**：`shouldCompress` 退休等于撤掉了一道"硬性安全垫"，近上限的余量要重新算一笔账。

**问题点（大白话）**：原来除了看比例，还有一道硬性保险——只要离上限不到 16384 个 token，不管比例多少都强制压。退休 `shouldCompress` 把这道硬保险也一起撤了，现在统一只看比例（用到 0.95 才压）。

对**大窗口**模型（如 20 万 token），这笔账是这样的：

- 旧的硬保险其实在 `usageRatio ≈ 0.914` 就触发了（剩 16384 时）。所以今天的真实触发线本来就是 ~0.91，不是 constants 里那个只在 fallback 分支生效的 0.85。
- 新的 0.95 触发时，剩余输入预算只有约 **9500 token**。
- 而我们的估算本身有误差（首轮 factor=1.0 还没校正，或会话中 ±10%）。18 万的 10% ≈ 1.8 万，**误差量级比那 9500 余量还大**。

后果：万一某一轮估**少**了，真实用量可能直接冲过上限，只能靠最后的兜底（overflow force，G10）——它能防崩，但代价是一次失败请求 + 重来的体验。

**解决策略（已决策：A，保持 KISS）**：

- **采用 A：保留一道小的硬性地板**。除了 0.95 比例线，再加一条"剩余输入预算 < 4096 也压"。它独立于比例，专门防估算误差在近上限处把人坑了。代价：极个别情况下会比纯比例稍早压一点。
- **不采用 B**：完全靠 factor 收敛 + overflow force 兜底虽然更简单，但首轮和误差大的轮次有冲过上限、吃一次失败请求的风险。overflow force 仍保留为终极兜底，但不作为常规近上限体验的唯一保护。

**附带**：小窗口模型（4k/8k）原来主要靠这道硬地板触发压缩，撤掉后改成纯比例，行为会变，需要专门测一下别压得太晚。

---

## 三、契约

```
ContextManager   ── 产出 projectedWorkingSet（post mask/prune/summary）
        │ 值传递，单向
        ▼
TokenEstimator   ── estimateWireHeuristic(wire载荷) × factor → currentTokens
        ▲                                    │
        │                                    ▼
Calibrator       ── factor = EMA(realPromptTokens / prepared.sentHeuristic)  →  getContextUsage → ContextUsage
   (每次 API 响应更新, EMA+夹值)                                               ├─ usageRatio（压缩控制 → decideCompactionRung）
                                                                              └─ displayRatio（UI 显示 → context-window-usage）
```

**单向值传递，不回指**：
- ContextManager 产出工作集 + wire 载荷 → 估算器测量 → ContextUsage
- `sentHeuristic` 随 `PreparedTurn` 带出（F1）→ Calibrator 从 lifecycle 拿真实 promptTokens + sentHeuristic → EMA 更新 factor → 下轮估算用
- 估算器不知道"context 管理做了 mask/prune/summary"，只认"wire 载荷"这一个值

### 单一测量入口：校正系数只在一处乘（F9）

> **评审修正（F9）**：`getContextUsage` 改成直接收一个数字（`currentTokens`）后，"数字数 × 校正系数"这一步会散落在每个调用点，容易漏乘。

**问题点（大白话）**：现在每个想知道"占用率"的地方，都得自己先算一遍"wire 字数 × factor"，再交给 `getContextUsage`。但 `context-manager.ts` 里这种地方有八九处（压缩前、prune 后、投影后、最终发送前……）。只要有一处忘了乘 factor，同一轮里算出来的占用率就自相矛盾——有的按校正后、有的按校正前，压缩决策和 UI 显示对不上。

**解决策略**：收口成**一个**测量入口，把"序列化 → 数字数 → 乘系数 → 算占用率"一条龙包进去：

```ts
// 唯一测量入口：所有想知道占用率的地方都调它。
// 返回 usage + sentHeuristic 两样——后者给 prepareTurn 带进 PreparedTurn（F1），
// 避免别处重新数一遍 wire 载荷造成漂移。
function measureUsage(input: {
  readonly messages: readonly ChatCompletionMessage[];
  readonly sessionId: string;
  readonly modelId: string;
}): { readonly usage: ContextUsage; readonly sentHeuristic: number } {
  const sentHeuristic = estimateWireHeuristic(input.messages, tokenCounter);
  const currentTokens = Math.round(sentHeuristic * getCalibrationFactor(input.sessionId)); // ← factor 只在这里乘一次
  return { usage: getContextUsage(currentTokens, input.modelId, tokenCounter), sentHeuristic };
}
```

`context-manager.ts` 里所有原来调 `getContextUsage` 的地方，统一改调 `measureUsage`（只要 usage 的就取 `.usage`，prepareTurn 末尾顺便取 `.sentHeuristic` 带出）。**factor 只在这一个函数里乘一次**，从源头杜绝"有的乘、有的没乘"。这也和编排层"内存工作集 commit-once"的收口思路一致。

---

## 四、`removeTokenUsageMetadata` 的处理

### 4.1 现状

`markCompactedParts`（`context-manager.ts:264-301`）在 prune 时调 `removeTokenUsageMetadata` 清掉 part 的 `tokenUsage`——因为锚点估算器依赖它，不清会导致旧锚点残留。

### 4.2 标定式估算后

标定式估算**不再依赖 `tokenUsage` 元数据**——`findLatestUsageAnchor` 和 `findLatestSummaryIndex` 都不调了。所以 `removeTokenUsageMetadata` 的"为估算器清"这个理由消失。

### 4.3 删除条件

**先确认 `tokenUsage` 元数据是否还被别处消费**：

```bash
rg -n "tokenUsage" packages/ohbaby-agent/src --glob '!**/*.test.*'
# 若只有 token-estimation.ts + context-manager.ts 引用 → 安全删除 removeTokenUsageMetadata
# 若有别处（如 UI per-message 展示）→ 保留元数据，但估算器不再依赖它
```

- 若无其他消费方：删除 `removeTokenUsageMetadata` + `markCompactedParts` 里的调用，简化 prune 路径。
- 若有其他消费方：保留元数据写入，但估算器不再读它——解耦依然达成。

---

## 五、影响的代码点 / 文件位置

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/core/context/token-estimation.ts` | `estimateContextTokens` 从"锚点+尾部"改为"heuristic × factor"；删除 `findLatestUsageAnchor` / `findLatestSummaryIndex` / `readTokenUsage`；新增 `estimateWireHeuristic(messages, tokenCounter)`（**数整条消息，含 tool_calls，F8**） |
| `packages/ohbaby-agent/src/core/context/context-manager.ts` | `estimateAssembledTokens` 改为调 `estimateWireHeuristic`（量 wire 载荷，消除双计）；**新增单一测量入口 `measureUsage`，所有 usage 测量收口于此、factor 只在此乘一次（F9）**；新增 `calibrationFactors` Map + `getCalibrationFactor` + `updateCalibrationFactor`（EMA+夹值，F5）；`markCompactedParts` 中 `removeTokenUsageMetadata` 调用按 §4.3 处理；删除 `shouldCompress` 相关逻辑（F3）；近上限硬地板采用 F7-A：`remainingInputTokens < 4096` 也触发 prune-summary |
| `packages/ohbaby-agent/src/core/context/types.ts` | `PreparedTurn` 新增 `sentHeuristic: number`（F1）；删除 `ContextUsage.shouldCompress` 字段（F3）；删除 `ContextManager.shouldCompress` 方法（F3）；`ContextManager` 接口新增 `updateCalibrationFactor(sessionId, realPromptTokens, sentHeuristic)` |
| `packages/ohbaby-agent/src/core/context/events.ts` | 删除 Zod schema 中的 `shouldCompress` 字段（F3） |
| `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts` | API 响应后调 `contextManager.updateCalibrationFactor(sessionId, response.usage.promptTokens, prepared.sentHeuristic)`（F1：直接用 prepared 带出的值） |
| `packages/ohbaby-agent/src/core/context/context-window-usage.ts` | **不改**——`contextUsageToContextWindowUsage` 已用 `currentTokens / contextLimit`，天然是 displayRatio |

**不改**：`serialization.ts`、`serializer.ts`（wire 载荷由它产出，但本身不改）、`filters.ts`、`summary.ts`。

---

## 六、建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐：本目录 README + 三篇 + [gaps-and-decisions.md](../gaps-and-decisions.md) G12 |
| 2 | **重写** characterization 测试：`manager.unit.test.ts:280-418` 的 5 个锚点形状测试（`anchorIndex`/`anchorTokens`/`tailTokens`）改为测 `estimateWireHeuristic` 的输出（F6） |
| 3 | 新增 `estimateWireHeuristic`（数**整条消息**含 tool_calls，F8）+ 单一入口 `measureUsage`（factor 只在此乘一次，F9）+ `PreparedTurn.sentHeuristic` 字段；factor=1.0 时行为等价于纯 heuristic；接入 `estimateAssembledTokens`，消除双计 |
| 4 | 新增 `calibrationFactors` Map + `updateCalibrationFactor`（EMA+夹值）；lifecycle API 响应后用 `prepared.sentHeuristic` 喂数（F1） |
| 5 | `shouldCompress` 退休：从 `ContextUsage`/`ContextManager`/`events.ts` 移除字段/方法（F3）；消费方改用 `decideCompactionRung`；测试同步更新 |
| 6 | 近上限保护（F7-A）：加 `remainingInputTokens < 4096` 小硬地板；小窗口模型回归 |
| 7 | 确认 `tokenUsage` 元数据消费方后，处理 `removeTokenUsageMetadata`（删除或保留） |
| 8 | mask 可见性验证测试（[G7](../gaps-and-decisions.md#g7性能验证缺位) 前提）：mask 开启后 usage 下降 |

---

## 七、开发护栏

- 先写失败测试再实现（TDD）；先重写锚点测试（F6），再切换标定式。
- factor=1.0 时（首轮），估算结果 = 纯 heuristic（量 wire 载荷），与无锚点时行为一致——这是安全退化。
- **F6 注意**：`manager.unit.test.ts:280-418` 的 5 个锚点形状测试（`anchorIndex`/`anchorTokens`/`tailTokens`）在删 `estimateContextTokens` 旧形状前必须先迁移为 `estimateWireHeuristic` 的测试。
- **F6 注意**：AC-2 的 `after ≈ before − tokenCount(system+memory)` 只在**有锚点**时成立（双计只发生在有锚点时）；无锚点 fixture 上 `after ≈ before`——断言要限定场景，否则误红。
- 消除双计后，`estimateAssembledTokens` 的结果应**低于**重构前（有锚点时少了重复的 system+memory）——characterization 测试需更新断言。
- factor 更新只在 API 响应后，不在 prepareTurn 内部——避免估算自激。
- factor 用 EMA（α=0.5）+ 夹值 [0.5, 3.0]（F5），防单轮异常带偏。
- `sentHeuristic` 随 `PreparedTurn` 带出（F1），lifecycle 不重新派生、不二次序列化。
- `shouldCompress` 退休后，控制信号唯一真相 = `decideCompactionRung` 基于 `usageRatio` 对 `thresholds.summary`（F3）。
- `estimateWireHeuristic` 必须数**整条消息**（`JSON.stringify(m)`），含 `tool_calls`——只数 `content` 会漏掉工具调用、让工具轮严重低估、factor 抖（F8）。
- 近上限保护按 §二 F7-A 落地：加一道"剩余输入预算 < 4096 也压"的小硬地板。小窗口模型行为变化需专门回归（F7）。
- 所有占用率测量统一走单一入口 `measureUsage`，factor 只在该入口乘一次，禁止在调用点手算 `heuristic × factor`（F9）。
- `core/context` 不新增跨层依赖；factor 内存态不写库。
- 修改返回结构时同步核对 `events.ts` 的 Zod schema（`shouldCompress` 字段删除）。
- `tokenUsage` 元数据删除前必须 grep 确认无其他消费方。
