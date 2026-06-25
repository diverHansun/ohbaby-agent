# 投影层 · 现有问题分析

> 分析日期：2026-06-24
> 对象：`context-manager.ts`（getActiveHistory）+ `serializer.ts` + `serialization.ts` + `tool-metadata-projection.ts` + `filters.ts` + `summary.ts`
> 框架：learn-swe-before-implement 审阅模式
>
> **缺口评审修正（2026-06-25）**：豁免清单语义从"白名单"反转为"黑名单"（[G5](../gaps-and-decisions.md#g5mask-豁免清单语义)）；mask 作用范围限定 ToolPart only（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)）；新增 kill switch + dark ship（[G2](../gaps-and-decisions.md#g2mask-缺-kill-switch)）；新增 mandatory 事件（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)）；prune 读 mask 前历史（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。

---

## 零、核心判断

"存储态 → 推理态"的投影在 ohbaby **已实质存在且部分做得很好**（白名单投影尤其细致），路线图 2.5（存储/推理分离）实质已达成。真正的问题是两条：

1. 投影逻辑**没有被收成一层**，散在 3 个文件、并与 compaction 交缠 → "发什么给模型"的真相被劈开，可读性与可测性差，reasoning 沦为隐藏输入。
2. **缺一道"摘要前的可逆削减"**（路线图 2.2）。ohbaby 把"永久 prune"误当成了这道防线，但二者是不同层的不同机制。

---

## 一、投影层现状：4 个阶段，散落 3 处

| 阶段 | 职责 | 位置 |
|------|------|------|
| S1 选择 | 丢弃 `time.compacted` 的 part | `getActiveHistory`（context-manager.ts:244）→ `isActivePart`（filters.ts:3） |
| S2 排序 | summary 提至最前 | `partitionSummary`（summary.ts:16） |
| S3 序列化 | 丢 error assistant / 空消息；summary→`<context_summary>`；assistant→tool_calls 拆分；历史 reasoning 不回传、活跃 reasoning 注入 | `serializeMessageForLlm`（serializer.ts:82-165） |
| S4 工具结果投影 | 工具输出 + **白名单**元数据 | `formatToolResultContentForModel` / `projectToolMetadataForModel`（tool-metadata-projection.ts:31-147） |

- S1/S2 在 **assemble**（`assembleFromRawHistory` → `getActiveHistory`）里跑。
- S3/S4 在 **serializer** 里跑，由 `prepareTurn` 末尾调用（context-manager.ts:1181）。
- 中间夹着 `runCompaction`。

**后果**：

- 可读性差——理解"模型最终看到什么"要跨 `context-manager.ts` 与 `serializer.ts` 两个文件、绕过 compaction。
- reasoning 成隐藏输入——它在 S3 临时注入（来自 `activeReasoningByMessageId`，serializer.ts:148），不在 S1/S2 产出的 history 里，`AssembledContext` 不持有它。
- usage 测量口径与投影不完全一致——usage 基于 `getActiveHistory`（S1/S2 后）估算，但不含 S3/S4 的渲染差异，也无 mask。

> 白名单投影（S4，tool-metadata-projection.ts）是 improve-2 的成果，做得细（bash 只留 exitCode/signal/truncated，read 只留 path/mtimeMs/…，MCP 只留 structuredContent 等）。**本轮复用、不重写。**

---

## 二、概念混淆：永久 prune ≠ 临时 mask

路线图 2.2"工具结果部分清除"想要的是 gemini `ToolOutputMaskingService` / kimi `MicroCompaction` 那种**构建时遮罩**，但 ohbaby 现有的 `prune` 是另一层的另一种机制。二者真实差异（按 ohbaby 实际情况，存储均不删除）：

| 维度 | ohbaby `prune`（现有） | 2.2 想要的 `mask` |
|------|----------------------|-------------------|
| 写库 | 写 `time.compacted` | 不写，构建时算 |
| 对历史的作用 | 整个工具交换（call+result）从 active history 消失 | 用占位符替换输出，**保留消息结构与动作痕迹** |
| 触发 | 仅压缩时（usage≥0.95） | 每次构建，摘要前（usage≥0.5） |
| 动作痕迹 | 消失，靠摘要 `recent_actions` 找补 | 占位符保住"我做过此动作" |
| 豁免 | 仅尾部 token 窗口（PRUNE_PROTECT 40k） | 按**工具类型豁免**（黑名单：write/edit/skill/subagent/当前轮），未知工具默认可遮罩（[G5](../gaps-and-decisions.md#g5mask-豁免清单语义)） |
| 作用范围 | ToolPart（通过 `isActivePart`） | **ToolPart only**，其他 part 永不扫描（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)） |
| 归属层 | 编排层 | 投影层 |
| 读口径 | 扫描 mask 前历史（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)） | 读 mask 后历史量 usage |

**结论**：2.2 不是改进 prune，而是在投影层**新增一道与 prune 互补的防线**——便宜、可逆、摘要前先削（对齐 kimi micro+full）。ohbaby `prune` 现有的"标记不删除 + 协议安全的整对消失"行为保留，作为更重的永久兜底。

> 审计澄清（已核实）：被 prune 的内容不仅从模型消失，**也从 CLI UI 消失**——UI 投影（`adapters/ui-state/persistent-store.ts:125-138` 的 `messageToUiMessage`）同样应用 `isActivePart`，并把摘要替换为 `"Context compacted"` 占位。唯一审计留存是 SQLite 直查。故上表"审计"对 prune/mask **两者都只靠 SQLite，与 UI 无关**；mask 的价值在"频率 + 痕迹"，不依赖审计。message store 存在两条独立兄弟投影（模型投影 `serializeForLlm` 与 UI 投影 `messageToUiMessage`），本轮 mask 只动前者；"UI 展示全量供审计"若需要，是对后者的独立改动。

### 协议配对事实（实现时须保持）

ohbaby `prune` 让 call+result 一起消失是**协议安全的**——二者派生自同一 part，被 `isActivePart` 一并滤除，不产生孤儿 tool_call（serializer.ts:90 在 `serializeAssistantMessage` 之前过滤）。新增的 mask 若改为"保留 call、占位 result"，**必须自行保证 tool_call 与 tool result 的配对完整**，否则触发 provider 协议错误。

---

## 三、临时遮罩的隐藏陷阱：缓存抖动

纯无状态的投影遮罩会**每轮抖动 prompt cache**：本轮遮罩到第 N 条、下轮模型多输出后变第 M 条，发给 provider 的前缀持续变化 → Anthropic/OpenAI 的 prefix cache 失效 → 更贵更慢，与 2.2 "省钱"目标相悖。

kimi 解法（micro.ts）：`cutoff` **单调推进（只增不减）**，并作为 record 记录。即"临时遮罩"不是纯无状态，而是带一个**单调游标**——它是**推理层状态，不是存储变更**，恰是"存储/推理分离"的精确体现。

ohbaby 引入 2.2 须决定 cutoff 游标的归属：本轮采用 session 内单调内存状态（不写库），跨进程恢复重置为 0 并按 usage 重探测（单进程下 YAGNI）。

> **缺口评审新增**：prune-summary 提交后 cutoff 重置为 0（借鉴 kimi `microCompaction.reset()` on full compaction）——被摘要的历史已消失，旧 cutoff 指向的位置已无意义（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）。

---

## 四、风险与边界

| 项 | 说明 |
|----|------|
| 协议配对 | mask 保留 call、占位 result 时必须维持配对完整（见 §2） |
| 缓存单调性 | cutoff 必须单调，否则缓存抖动（见 §3） |
| usage 一致性 | mask 影响 usage 测量，须在压缩门限**之前**应用（见 02 文档削减/渲染拆分） |
| 不做 | 本轮不引入 origin、不引入压缩多策略框架、不持久化 cutoff、不改白名单投影 |
| 与编排层关系 | 依赖编排层 `runCompaction` 工作集；建议编排层去三重先落地 |
