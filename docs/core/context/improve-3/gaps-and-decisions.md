# context improve-3 · 缺口与决策记录

> 本文档记录 improve-3 规划评审中识别的 12 个技术缺口及其决策结论。各子主题文档通过链接引用本文，本文通过链接指回相关子主题。
>
> 评审日期：2026-06-25
> 框架：learn-swe-before-implement 审阅模式 + 参考 claude-code / gemini-cli / kimi-code / oh-my-pi 四项目遮罩实现

---

## 决策总览

| 缺口 | 主题 | 决策一句话 | 影响子主题 |
|------|------|-----------|-----------|
| [G1](#g1mask-与-prune-的时序交互读口径) | mask/prune 读口径 | prune 读 mask 前历史；mask 跑两次幂等 | [投影层](./投影层/) · [编排层](./编排层/) |
| [G2](#g2mask-缺-kill-switch) | mask 总开关 | `maskEnabled` 默认 false + dark ship | [投影层](./投影层/) |
| [G3](#g3mask-事件-mandatory) | mask 事件 | mandatory + 全列表 + dark ship 也发 | [投影层](./投影层/) |
| [G4](#g4每轮压缩计数归属) | 计数器归属 | ContextManager 持有，lifecycle 调 reset | [压缩多策略](./压缩多策略/) · [编排层](./编排层/) |
| [G5](#g5mask-豁免清单语义) | 豁免清单语义 | 默认可遮罩 + 豁免黑名单 | [投影层](./投影层/) |
| [G6](#g6mask-只动-toolpart) | mask 作用范围 | 只动 ToolPart，其他 part 永不扫描 | [投影层](./投影层/) |
| [G7](#g7性能验证缺位) | 经济性验证 | 补阈值边缘延迟 + 长会话次数对比测试 | [投影层](./投影层/) |
| [G8](#g8decidecompactaction--decidecompactionrung-双触) | 决策函数演进 | 编排层引入 CompactionRung，mask 档预留空分支 | [编排层](./编排层/) · [压缩多策略](./压缩多策略/) |
| [G9](#g9prune-summary-阈值-085--095) | 压缩阈值 | 0.85 → 0.95，充分利用 context window | [压缩多策略](./压缩多策略/) · 全局 |
| [G10](#g10去除-095-预防性-force) | force 触发源 | 只保留 overflow 兜底，不加预防性 force | [压缩多策略](./压缩多策略/) |
| [G11](#g11借鉴四项目的-mask-设计) | 借鉴点 | 占位符带原大小 + 小结果不遮 + cutoff reset + 不加缓存冷触发 | [投影层](./投影层/) |
| [G12](#g12锚点估算器看不见-mask--改标定式估算) | 估算器结构性冲突 | 锚点→标定式估算，mask 天然可见，双计消失，解耦 | [usage-估算](./usage-估算/) · [投影层](./投影层/) · [压缩多策略](./压缩多策略/) |

---

## G1：mask 与 prune 的时序交互（读口径）

**问题**：`prepareTurn` 里顺序是 `reduceForModel`(mask) → `runCompaction`(prune)。两者瞄准同一批旧工具输出。如果 prune 读 mask 后的工作集，它看到的全是占位符（几乎零 token）→ 判定"没东西可 prune"→ prune 永久失灵，summary 永不触发。

**决策**：**方案 A —— prune 读 mask 前历史，mask 跑两次幂等。**

数据流：
```
activeHistory = assemble()                              【mask 前】
maskedHistory = reduceForModel(activeHistory)           【mask 第 1 次】
usageBefore = getContextUsage(maskedHistory)            【基于 mask 后】
rung = decideCompactionRung(usageBefore)
if rung >= prune-summary:
    outcome = runCompaction(activeHistory, usageBefore) 【prune 扫描 mask 前】
    projectedHistory = outcome.projectedHistory
else:
    projectedHistory = activeHistory
finalHistory = reduceForModel(projectedHistory)         【mask 第 2 次, 幂等】
messages = renderForModel(finalHistory)
```

**为什么正确**：
- usage = "实际发给模型多少"（mask 后），prune 扫描 = "档案里可回收多少"（mask 前）。两个不同的问题，两个口径。
- mask 跑两次但幂等：cutoff 单调，第二次不推进，只是对 prune/summary 后的 history 重新应用同一 cutoff。开销是纯函数遍历，可忽略。
- prune 行为零回归：扫描输入和 improve-3 前完全一样。

> **前提依赖 [G12](#g12锚点估算器看不见-mask--改标定式估算)**："usage = mask 后实际发送量"这一前提，在当前的锚点估算器下不成立——锚点是快照数字，mask 削的旧内容落在锚点之前，削减不可见。必须改为标定式估算（方案 ③）后 G1 才真正生效。

→ 详见 [投影层/02-implementation-plan.md §一](./投影层/02-implementation-plan.md) 削减/渲染拆分数据流

---

## G2：mask 缺 kill switch

**问题**：mask 是 improve-3 里唯一改变模型可观察输入的新行为——模型突然在历史里看到占位符。如果占位符让模型困惑（误以为工具失败而重试），需要一键关掉。

**决策**：**`maskEnabled` 默认 false + dark ship。**

- `maskEnabled=false` 时，mask 逻辑仍然跑——算 cutoff、算可遮罩量、产出统计 + 发 `context.masked` 事件，但**不替换占位符**，history 原样返回。
- dark ship 期能观察："如果开了 mask，会遮多少、cutoff 推进到哪、是否真的延迟了 summary 触发"。
- 翻 `maskEnabled=true` 的时机：dark ship 数据显示"mask 本会延迟 ≥1 次 prune-summary"且无异常。这是可逆决策（改 config 不改代码）。

**为什么默认 false**：
- improve-3 基调是"先地基后能力、反过早抽象"。mask 是新能力，不是地基。
- 占位符对模型行为的影响是经验问题，不是理论问题。默认关 = 先观察再开。
- dark ship 比直接开更省心：出问题只是多了几个事件，用户无感知。

→ 详见 [投影层/02-implementation-plan.md §二](./投影层/02-implementation-plan.md) mask 阶段设计

---

## G3：mask 事件 mandatory

**问题**：mask 是静默改变模型输入的行为。如果 mask 出 bug，表现为"模型突然忘了某个工具结果"——没有事件就难诊断。文档原标为"可选"。

**决策**：**mandatory，dark ship 期也发，带全列表。**

```ts
export interface ContextMaskedEvent {
  readonly type: typeof ContextEvent.Masked;    // "context.masked"
  readonly sessionId: string;
  readonly enabled: boolean;                     // false=dark ship, true=实际替换中
  readonly maskedPartIds: readonly string[];    // 全列表，诊断时需知道具体遮了哪个 part
  readonly maskedTokens: number;
  readonly cutoff: number;
  readonly usageRatio: number;
  readonly skippedReason?: "below-threshold" | "below-batch" | "all-exempt";
}
```

- 每次 `reduceForModel` 调用都发（即使 `enabled=false`、即使最终没遮任何 part——`skippedReason` 记录为什么没遮）。
- `enabled` 字段让消费方区分"这是观测"还是"这是真改了模型输入"。
- Zod schema 同步更新。

**为什么不降级为可选**：事件一直发着不影响性能，保留 mandatory 反而避免将来有人删事件引入回归。与 `Pruned`/`Compressed` 事件对齐，consistency。

→ 详见 [投影层/02-implementation-plan.md §三](./投影层/02-implementation-plan.md) 影响代码点

---

## G4：每轮压缩计数归属

**问题**：`MAX_COMPACTION_PER_TURN` 的计数器放哪？信息在 ContextManager（它知道何时 prune-summary 发生），但 turn 生命周期在 lifecycle（它知道 turn 边界）。

**决策**：**计数器放 ContextManager，lifecycle 调 `resetTurnCompactionCount()`。**

三种触发源的计数行为：

| 触发源 | 检查上限 | 递增计数 | 检查反抖动锁 |
|--------|---------|---------|-------------|
| 自动 per-step | ✅ 受限 | ✅ 递增 | ✅ 受限 |
| overflow force | ❌ 穿透 | ✅ 递增 | ❌ 穿透 |
| 用户手动 `/compact` | ❌ 不参与 | ❌ 不递增 | ❌ 穿透 |

- `resetTurnCompactionCount(sessionId)` 由 lifecycle 在 turn 开始时调用。
- `compact()` 走独立入口，不进 `prepareTurn` 的计数轨道（用户在 turn 之间主动触发，与 per-turn 计数无关）。
- overflow force 递增计数的理由：overflow 压完后，后续 step 的自动压缩应知道"这一轮已经压过了"，避免紧接着又自动压一次。
- `MAX_COMPACTION_PER_TURN` 默认 2，可配。

→ 详见 [压缩多策略/02-implementation-plan.md §三](./压缩多策略/02-implementation-plan.md) 每轮压缩次数上限

---

## G5：mask 豁免清单语义

**问题**：文档原写"可遮罩白名单 + 豁免"，即未知工具默认不遮。但 MCP 工具输出通常很大，不遮浪费严重。

**决策**：**默认可遮罩 + 豁免黑名单（反转默认）。**

```ts
/** 豁免工具——不可逆或不可重建的工具结果，永不遮罩 */
export const MASK_EXEMPT_TOOLS = new ReadonlySet([
  "write", "edit",           // 不可逆变更
  "task", "skill",           // 不可重建的子代理/技能结果
  // agent_* 前缀匹配，见 maskOldToolOutputs 实现
]);
// 默认：未知工具（含 MCP）可遮罩。MCP 工具输出通常很大，应遮罩。
```

- 未知工具（含 MCP）默认可遮罩——与 gemini-cli / oh-my-pi / kimi-code 三个参考项目对齐。
- 不加工具自声明 `maskable` 字段（波及工具注册系统，improve-3 范围外，YAGNI）。
- **重启条件**：MCP 工具增长到手动维护清单不可行，或出现"条件可遮罩"工具时，再评估工具自声明。

→ 详见 [投影层/02-implementation-plan.md §二](./投影层/02-implementation-plan.md) mask 阶段设计

---

## G6：mask 只动 ToolPart

**问题**：ohbaby 的 Part 类型有多种。mask 是否扫描 SubtaskPart / TextPart / ReasoningPart 文档没明确。

**决策**：**mask 只动 ToolPart，其他 part 类型永不扫描。**

| Part 类型 | mask 是否扫描 | 理由 |
|-----------|--------------|------|
| `ToolPart` | ✅ 扫描，按工具名豁免 | 唯一目标——工具输出是 token 大头且常可重建 |
| `SubtaskPart` | ❌ 永不扫描 | 子代理结论不可重建（要重跑整个子代理），且可能含关键决策 |
| `TextPart` | ❌ 永不扫描 | 用户消息和助手文本，小且关键 |
| `ReasoningPart` | ❌ 永不扫描 | reasoning 已有独立处理机制（不持久化、渲染时注入活跃 reasoning） |

- 如果子代理结果既出现在 `SubtaskPart` 也可能出现在 `ToolPart`（tool name = `task`/`agent_*`），双重保险：SubtaskPart 不扫描（类型过滤）+ ToolPart 按工具名豁免。
- 4 个参考项目全部只对工具结果做遮罩，不碰其他类型。

→ 详见 [投影层/02-implementation-plan.md §二](./投影层/02-implementation-plan.md) mask 阶段设计

---

## G7：性能验证缺位

**问题**：mask 的经济前提是"便宜地延迟 prune-summary 触发"。如果前提不成立，mask 就是纯开销。文档验收测试只有正确性测试，没有经济性验证。

**决策**：**补两类自动化测试 + dark ship 遥测。**

**a) 单元测试：阈值边缘延迟验证**
```
构造会话：usage 恰好在 prune-summary 边缘（mask 关闭时会触发）
验证：
  - mask 关闭 → decideCompactionRung 返回 "prune-summary" → 触发
  - mask 开启 → mask 削减后 usage 降到阈值以下 → 返回 "mask" → 不触发
  - 断言：mask 开启时 prune-summary 调用次数 = 0
```

**b) 集成测试：长会话压缩次数对比**
```
构造会话：10 步 tool loop，每步产生大量工具输出
场景 1：mask 关闭，统计 prune-summary 触发次数 N₁
场景 2：mask 开启，统计 prune-summary 触发次数 N₂
断言：N₂ < N₁
```

**c) dark ship 遥测**：靠 G3 的 `context.masked` 事件（mandatory）收集真实数据。

**翻开关决策条件**：dark ship 数据显示"mask 本会延迟 ≥1 次 prune-summary"且无异常。

**不做的**：
- 不 benchmark mask 本身的执行耗时（纯函数遍历，开销可忽略）。
- 不测"模型对占位符的反应"（模型行为问题，靠 dark ship 运行观察）。
- 不设"mask 必须省 X% 才合格"的硬指标（经济性是经验数据，不是测试断言）。

> **前提依赖 [G12](#g12锚点估算器看不见-mask--改标定式估算)**：G7 的验收测试"mask 开启 → usage 降到阈值以下"在当前锚点估算器下会失败——锚点吞掉 mask 削减。必须改为标定式估算后 G7 测试才能通过。

→ 详见 [投影层/03-acceptance-and-testing.md](./投影层/03-acceptance-and-testing.md) 新增 AC-9

---

## G8：decideCompactAction → decideCompactionRung 双触

**问题**：编排层（先做）引入 `runCompaction`，压缩多策略（后做）要把 `decideCompactAction` 换成 `decideCompactionRung`。如果编排层硬编码调 `decideCompactAction`，脊椎 P2 会被改两次。

**决策**：**方案 B —— 编排层直接引入 CompactionRung，mask 档预留空分支。**

编排层阶段的 `decideCompactionRung`（三档，mask 档不返回）：
```ts
export type CompactionRung = "none" | "mask" | "prune-summary" | "force";

export function decideCompactionRung(input: {
  readonly usage: ContextUsage;
  readonly historyLength: number;
  readonly force: boolean;
  readonly thresholds: CompactionThresholds;
}): CompactionRung {
  if (input.force) return "force";
  if (input.usage.usageRatio >= input.thresholds.summary) return "prune-summary";
  return "none";
  // mask 档：压缩多策略阶段加 `if (usage >= thresholds.mask) return "mask"`
}
```

脊椎 P2 的 switch 一次写好，永不再改：
```ts
switch (rung) {
  case "none":          发 CompactSkipped(not-needed); return not-needed
  case "mask":          return not-needed  // 预留：mask 在投影层处理，脊椎不跑
  case "prune-summary": continue to P3
  case "force":         continue to P3     // force 跳过 P4 闸门②
}
```

压缩多策略阶段只改 `decideCompactionRung` 内部（加 mask 档判断 + 反抖动锁 + 每轮计数），**脊椎 P2 零改动**。

**附带消除**：
- `prune-only` 合并进 `prune-summary`——P4 闸门②统一处理是否继续跑 summary。
- `allowPruneOnly` 参数从 `CompactionRequest` 消失。
- `force` 从隐式（`decideCompactAction(force=true) → "compact"`）变为显式档位。

→ 详见 [编排层/02-implementation-plan.md §一](./编排层/02-implementation-plan.md) 目标产物

---

## G9：prune-summary 阈值 0.85 → 0.95

**问题**：原 `COMPRESSION_THRESHOLD = 0.85` 在 0.85 就触发 LLM 摘要压缩，context window 的 0.85–1.0 区间未被充分利用。

**决策**：**`COMPRESSION_THRESHOLD` 从 0.85 改为 0.95。**

**落地时序**：编排层批次只引入 `CompactionRung`/threshold 接缝，保持行为可对照；真正把默认 summary 阈值切到 0.95，应在 usage 标定式估算落地后，随压缩多策略批次一起切换。否则行为保持型重构会夹带行为变更，测试口径不清。

这是对现有行为的改变，需要 characterization 测试覆盖。好处是充分利用 context window，overflow force 兜底估算误差。

阶梯定稿：
```
usage ~0.5   mask           投影层可逆遮罩（便宜、不写库）
usage 0.95   prune-summary  编排层自动压缩（反抖动锁 + 每轮上限护栏）
overflow     force          lifecycle 外部捕获 overflow error，终极兜底
```

mask 阈值维持 0.5 不动——mask 便宜，早跑无妨，在 0.5–0.95 区间持续削，延迟 prune-summary 触发。

> **精度依赖 [G12](#g12锚点估算器看不见-mask--改标定式估算)**：0.95 阈值顶部余量更薄，估算误差容忍度更小。当前锚点估算器的双计问题 + "看不见 mask" 会让 0.95 线不可信。必须改为标定式估算后 0.95 阈值才安全。

→ 详见 [压缩多策略/02-implementation-plan.md §一](./压缩多策略/02-implementation-plan.md) 升级阶梯 policy

---

## G10：去除 0.95 预防性 force

**问题**：讨论中曾提出在 0.95 加一个"预防性 force"档位。但这是过度设计——如果 0.95 的 prune-summary 没压下来（反膨胀拒绝/反抖动锁/每轮上限），再触发 force 只是重复尝试。

**决策**：**不设预防性 force，只保留 overflow 兜底。**

阶梯为三档（不是四档）：
```
mask(0.5) → prune-summary(0.95) → overflow force
```

- `decideCompactionRung` 返回 `none | mask | prune-summary | force`。
- `force` 仅由 `input.force=true` 触发（lifecycle 捕获 overflow error 后传入），**不从 usage ratio 推导**。
- 不设"usage ≥ 某值就自动 force"的逻辑。

→ 详见 [压缩多策略/02-implementation-plan.md §一](./压缩多策略/02-implementation-plan.md) 升级阶梯 policy

---

## G11：借鉴四项目的 mask 设计

**问题**：参考 claude-code / gemini-cli / kimi-code / oh-my-pi 四个项目的遮罩实现，ohbaby 的 mask 应借鉴哪些？

**决策**：**接受 4 个借鉴点，不借鉴 4 个过重设计。**

### 借鉴（接受）

| 借鉴点 | 来源 | ohbaby 落地 |
|--------|------|------------|
| **占位符带原大小** | oh-my-pi `[Output truncated - N tokens]` | `[Old tool result cleared (was ~N tokens)]`——模型能判断"丢了多少信息" |
| **小结果不遮** | oh-my-pi `MIN_PRUNE_TOKENS=50` | `MASK_MIN_PART_TOKENS=50`——占位符本身约 20 token，遮小于 50 token 的结果反而变大 |
| **prune-summary 后 cutoff 重置** | kimi `microCompaction.reset()` on full compaction | 被摘要的历史已消失，旧 cutoff 指向的位置已无意义，归零重新开始 |
| **不加"缓存冷才触发"** | （反借鉴 claude-code/kimi 的 60min 条件） | ohbaby 的 cutoff 单调推进已防抖动，不绑定特定 provider 的缓存策略 |

### 不借鉴（过重或不适用）

| 不借鉴项 | 来源 | 理由 |
|---------|------|------|
| 完整输出落盘 | gemini-cli | ohbaby 已有 SQLite 存全量，不需要额外文件 |
| 三重缓存守护（cacheWarmSuffixTokens + idle flush） | oh-my-pi | ohbaby 单进程同步，prefix cache 命中率本就不高，cutoff 单调已够 |
| 工具自声明 useless | oh-my-pi | 波及工具注册系统，improve-3 范围外（YAGNI） |
| cache_edits API | claude-code | Anthropic 专有 API，ohbaby 不绑定单一 provider |

→ 详见 [投影层/02-implementation-plan.md §二](./投影层/02-implementation-plan.md) mask 阶段设计

---

## G12：锚点估算器看不见 mask → 改标定式估算

**问题**：improve-3 的 G1（"usage = mask 后实际发送量"）和 G7（"mask 开启后 usage 降到阈值以下"）在当前的锚点估算器下不成立。

**根因**（`token-estimation.ts:17-36`）：锚点估算器的逻辑是 `estimate = anchor.tokens（快照数字）+ heuristic（锚点之后的尾部）`。锚点之前的所有消息，不管内容是什么、有没有被 mask 改过，只贡献 `anchor.tokens` 这一个数。而 mask 削的是"保护窗口外的旧工具输出"——这些几乎必然在锚点之前（锚点是最近的 assistant 轮，很新）。所以 mask 的削减被锚点完全吞掉，usage 数字不下降。

**三个伴生问题**：

1. **G1/G7 失效**：mask 开启后 `getContextUsage(maskedHistory)` 走锚点分支，锚点之前的削减不可见，usage 不降。
2. **system + memory 双计**（`context-manager.ts:315-326`）：`estimateAssembledTokens` = `tokenCount(systemPrompt + memory)` + `estimateContextTokens(history).tokens`。而锚点的 `totalTokens`（API 返回的 `promptTokens`）已含 system + memory → 双计。
3. **估算器反向耦合 context 管理**：`markCompactedParts`（`context-manager.ts:264-301`）在 prune 时调 `removeTokenUsageMetadata` 清掉 part 的 `tokenUsage`——估算器在参与 context 管理的内部状态管理，否则旧锚点残留导致估算错乱。

**决策**：**方案 ③ —— 启发式 + 标定因子（calibration）。**

```
factor = 上轮 API 真实 promptTokens / heuristic(上轮发送集)
本轮 estimate = heuristic(本轮工作集) × factor
```

**一招解四件事**：

| 解决的问题 | 如何解决 |
|-----------|---------|
| G1/G7 失效 | 每轮重量当前（mask 后）工作集，占位符是小 ASCII，heuristic 直接反映 → mask 天然可见 |
| 双计消失 | 只量一次真实工作集（含 system+memory），不再"锚点已含 + 又加一遍" |
| 0.95 线精度 | factor 吸收 char 权重偏差、信封/JSON 开销、tokenizer 差异 → 0.95 阈值可信 |
| 估算器解耦 | 估算器只认"工作集"这一个值，不再扫 summary 边界、不再参与 prune 清元数据 |

**契约**：

```
ContextManager   ── 产出 projectedWorkingSet（post mask/prune/summary）
        │ 值传递，单向
        ▼
TokenEstimator   ── measure(workingSet, systemPrompt, memory, modelId, factor) → currentTokens
        ▲
Calibrator       ── 每次 API 响应：factor = realPromptTokens / heuristic(本轮发送集)
                    （按 sessionId 存，仿 G4：状态在 ContextManager，lifecycle 喂数）
        │
        ▼
getContextUsage(currentTokens, modelId) → ContextUsage
   ├─ controlRatio = usedInput / inputBudgetTokens   （压缩控制；允许略高估，偏保守）
   └─ displayRatio = currentTokens / contextWindowTokens  （UI 显示；整个窗口）
```

**两个比率从同一个 `currentTokens` 派生，分母不同**——压缩控制和 UI 显示共用一个估算机制，各自投影。与 message store 的"模型投影 / UI 投影"两条兄弟投影是同一架构思想。

**factor 更新时机**：每次 API 响应都更新——每次都是真实数据，都能纠偏。

**代价**：factor 是全局标量，假设"heuristic 的相对偏差在一次会话内稳定"。会话内容风格剧烈切换（纯散文 → 大段代码）时偏差有二阶波动。但比锚点的"前缀必须不可变"假设健壮得多，且 overflow force（G10）兜底。首轮无真实数时 factor=1.0，此时上下文小，无所谓。

**推迟的决策**：mask 真开（`maskEnabled=true`，目前 G2 默认 false dark ship）后，UI 显示数字会因 mask 而下降，用户可能困惑"我没干啥怎么掉了"。但 dark ship 期 mask 不真替换、显示不受影响，所以这个决策推到翻开关时再定，不阻塞现在。

→ 详见 [usage-估算/](./usage-估算/) 子主题（01-problem-analysis / 02-implementation-plan / 03-acceptance-and-testing）

### G12 评审修正（F1-F6）

G12 在二次评审中发现 9 处需要修正的问题，已在 usage-估算 子主题文档中落地：

| 编号 | 问题 | 修正 |
|------|------|------|
| **F1** | 标定分母会漂移——lifecycle 重新序列化"发送集"与实际 wire 载荷对不上 | `sentHeuristic` 随 `PreparedTurn` 带出，lifecycle 不重新派生 |
| **F2** | heuristic 量 domain `serializeHistory` 而非 wire 载荷，差 whitelist/summary/tool_calls | heuristic 改量 wire 载荷（`ChatCompletionMessage[]`），mask/whitelist 全自动计入 |
| **F3** | budget 分支 `shouldCompress` 用 `COMPACTION_RESERVE` 不用 0.95，与 `decideCompactionRung` 打架 | `shouldCompress` 退休，控制信号单一真相 = `decideCompactionRung` 基于 `usageRatio` |
| **F4** | AC-6 不等号方向写反 | `displayRatio <= usageRatio`（分母越大比率越小） |
| **F5** | factor 是 last-write-wins，抗不住单轮异常 | 改 EMA（α=0.5）+ 夹值 [0.5, 3.0] |
| **F6** | `manager.unit.test.ts:280-418` 5 个锚点形状测试会被删锚点打红 | 提交拆分点名重写；AC-2 限定有锚点/无锚点场景 |
| **F7** | `shouldCompress` 退休会带走 16384 token 硬地板，0.95 顶部余量偏薄 | 采用 KISS 小硬地板：`remainingInputTokens < 4096` 也进入 prune-summary 档 |
| **F8** | heuristic 若只数 `content` 会漏掉 assistant `tool_calls` | `estimateWireHeuristic` 数整条 wire 消息（含 tool_calls/tool_call_id/role） |
| **F9** | factor 乘法散在调用点会漏乘 | 新增单一入口 `measureUsage`，只有这里做 `heuristic × factor` |

---

## 横向参考：四项目遮罩机制对比

| 维度 | claude-code | gemini-cli | kimi-code | oh-my-pi | ohbaby(improve-3) |
|------|------------|------------|-----------|----------|-------------------|
| 占位符 | `[Old tool result content cleared]` | `<tool_output_masked>预览+文件路径` | `[Old tool result content cleared]` | `[Output truncated - N tokens]` 等 | `[Old tool result cleared (was ~N tokens)]` |
| 豁免语义 | 白名单（未知不遮） | 黑名单（未知可遮） | 无按工具名（结构判定） | 黑名单+自声明（未知可遮） | **黑名单（未知可遮）** |
| 单调 cutoff | 无 | 无 | **有**（显式字段） | 无（prunedAt 幂等等价） | **有**（显式 cutoff，借鉴 kimi） |
| 作用范围 | tool_result block | functionResponse | role=tool 消息 | 工具结果 content | **ToolPart only** |
| 与压缩关系 | 第一道（有序管道） | 并行（先压缩后遮罩） | 第一道（micro before full） | 第一道（prune before compaction） | **第一道（mask before prune-summary）** |
| 状态持久化 | 内存为主 | 写回 history | 内存 + records 跨会话 | durable（rewriteEntries） | **内存态，不写库** |
