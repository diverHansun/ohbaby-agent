# 编排层去三重 · 现有问题分析

> 分析日期：2026-06-24
> 对象：`packages/ohbaby-agent/src/core/context/context-manager.ts`（当前 1224 行）
> 框架：learn-swe-before-implement 审阅模式
>
> **缺口评审修正（2026-06-25）**：本文档的"三元 `decideCompactAction`"差异点将由 `decideCompactionRung` 统一取代——`prune-only` 合并进 `prune-summary`，`allowPruneOnly` 参数消失，`force` 显式化为独立档位（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。prune-summary 阈值 0.85→0.95 是 [G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095) 的行为变更，编排层批次只预留 threshold 接缝，真正切换放到 usage 标定后/压缩多策略批次。

---

## 零、核心判断

`context-manager.ts` 在 improve-2 之后从 ~824 行增长到 1224 行，增长几乎全部堆在 `compress` / `compact` / `prepareTurn` 三个编排方法上。这三个方法在做**同一件事的三个变体**——跑同一条"判断 → prune → 摘要候选 → 投影评估 → 提交/拒绝"流水线，其中 P5/P6/P7 三节代码**逐字重复了三遍**。这是 references/03 DRY-of-knowledge（"知识不重复"，而非"代码不重复"）的确凿违反，也是后续每加一个能力都要复制三遍的复杂度放大器。

**重要前置事实**：本问题是纯结构债，**不阻塞任何功能**。

- per-step 压缩：已落地（`prepareTurn` 在 `Lifecycle.run` 的每个 step 前调用，见 `lifecycle.ts:362`）。
- overflow recovery：已落地（捕获 `isContextOverflowError` 后 `force` 重调 `prepareTurn`，见 `lifecycle.ts:447`）。
- reasoning 不持久化、推理态过滤：已落地（`serialization.ts:19-21`、`serializer.ts:148-155`）。

因此本轮定位为 🍒 **低垂果实**：改动可控、风险低，收益是"未来每个新能力少复制两遍 + 读库次数下降 + token 口径统一"。

---

## 一、三重脊椎：同一条流水线的三个变体

### 1.1 共同脊椎（P1–P8）

| 节 | 含义 |
|----|------|
| P1 | 量 `usageBefore` |
| P2 | 闸门①：要不要进场压缩？ |
| P3 | prune 修剪工具输出 → 量 `usageAfterPrune` |
| P4 | 闸门②：prune 完还需要摘要吗？ |
| P5 | `generateSummaryCandidate` 生成摘要候选 |
| P6 | 投影评估：`projectedUsage >= usageAfterPrune` 则摘要反而更大 → 拒绝 |
| P7 | 提交 or 拒绝 |
| P8 | 量 `usageAfter`，拼结果对象，发事件 |

### 1.2 逐字重复的证据

P5/P6/P7（"生成候选 → 投影评估 → 反膨胀拒绝 → 否则提交"）在三处几乎逐字出现：

| 方法 | 行号 | 说明 |
|------|------|------|
| `compress` | `context-manager.ts:767-815` | 返回 `CompressionResult` |
| `compact` | `context-manager.ts:869-930` | 返回 `CompactResult` |
| `prepareTurn` | `context-manager.ts:1044-1172` | 返回 `PreparedTurn`，深层嵌套 5–6 层 if/else |

其中 `projectSummaryCandidate(...)` + `projectedUsage >= usageAfterPrune` 的"反膨胀拒绝"判断，以及 `statusForUncommittedCompression(...)` 的调用模式，三处重复。

### 1.3 `prepareTurn` 的复杂度尤其突出

`prepareTurn`（`context-manager.ts:965-1204`）单方法 240 行、嵌套 5–6 层，把五层职责压进一个函数：全量装配 + 压缩编排 + DB 重查 + 序列化 + 发事件。这是 references/06 "长且嵌套了太多职责层"的反例——它的问题不是行数，是职责层数。

---

## 二、真正的差异点（决定如何"吸收"而非"合并")

三者并非可无脑合并，存在四处真实差异：

| 差异点 | `compress` | `compact` | `prepareTurn` |
|--------|-----------|-----------|---------------|
| 生产调用方 | **无**（仅测试） | UI 手动 1 处（`adapters/ui-runtime/composition.ts:546`） | 热路径 2 处（`lifecycle.ts:362,447`） |
| 返回类型 | `CompressionResult` | `CompactResult` | `PreparedTurn`（含 `messages`） |
| 装配范围 | 仅历史（空 memory/systemPrompt） | 全量 `assemble` | 全量 `assemble` |
| prune 机制 | `prune()` 写库 + 重查 | `prune()` 写库 + 重查 | `pruneHistory()` 内存投影 + 末尾才查 |
| 闸门① | 二元 force/shouldCompress | 二元 | 三元 `decideCompactAction`（skip/prune-only/compact） |
| 末尾 | — | — | `serializeForLlm` |

**结论**：差异全在"外壳"（谁调、返回啥、装配多少、末尾要不要序列化），脊椎 P1–P8 完全一致。正确做法是**抽脊椎 + 薄外壳适配**，差异用参数/策略喂入，而非保留三份脊椎。

---

## 三、伴生问题（抽脊椎时可一并消解）

### 3.1 token 口径不一（🟡 设计级）

- `compress` 用 `serializeHistory` 全量数（`context-manager.ts:726-729`）。
- `compact` / `prepareTurn` 用 `estimateAssembledTokens` → 锚点估算（`context-manager.ts:315-326`，依赖 `token-estimation.ts` 的 token-usage 锚点）。

同一个问题"当前用了多少 token"有两个答案，可能导致 `compress` 与 `compact` 对同一会话给出不同的"该不该压缩"判断。脊椎统一后，usage 测量只剩一个口径，问题自然消除。

### 3.2 一个 turn 内重复装配/读库（🟡 设计级）

- `compact` 在一次调用里 `assemble` **三次**（before / afterPrune / afterCompression，`context-manager.ts:822/848/931`），每次都重载 memory、重建 system prompt、重查全部消息。
- `prepareTurn` 在 4 个非提交分支各自 `listBySession`（`context-manager.ts:1026/1053/1106/1139`），其中只有"真提交摘要"分支需要回读，其余分支的内存投影已是权威，重读纯属浪费。

读库现状为每 turn 3–5 次。统一到"内存工作集"后可降至"前置 1 次 + 仅提交分支回读 1 次"。

### 3.3 僵尸公共 API（🟢 代码级）

- `compress` 无任何生产调用方（grep 仅命中 `manager.unit.test.ts`）。
- `prune` 公共方法（`types.ts:149`）同样未搜到生产调用方，疑似也仅剩测试引用 —— **待实施时二次确认**。若确认为死代码，`ContextManager` 接口可从 7 个方法瘦到 5 个。

---

## 四、风险与边界

| 项 | 说明 |
|----|------|
| 主要工作量 | 不在删那 98 行 `compress`，而在迁移 `manager.unit.test.ts:1137-1795` 约 10 个用例（inflated/failed/too-short/同轮已修剪文件不进摘要等），它们当前通过 `compress` 验证脊椎行为，应改为直接测 `runCompaction`。 |
| 行为兼容 | `compact` / `prepareTurn` 对外签名与可观察行为必须保持不变（含事件序列 `CompactSkipped` / `Compressed` / `Pruned` / `TurnPrepared`）。 |
| prune 语义 | prune 标记立即写库（哪怕摘要失败也保住已释放 token）的现有语义必须保留——这是正确行为，不是 bug。 |
| 不做 | 本轮不引入投影层阶段链、不加 origin、不做压缩多策略——那些是 improve-3 后续子主题。 |
