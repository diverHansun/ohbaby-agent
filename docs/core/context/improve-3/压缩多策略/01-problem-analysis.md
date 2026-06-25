# 压缩多策略 · 现有问题分析

> 分析日期：2026-06-24
> 对象：`context-manager.ts`（decideCompactAction / getContextUsage / findCutPoint / runCompaction）+ `constants.ts` + `lifecycle.ts`（per-step / overflow）
> 框架：learn-swe-before-implement 审阅模式
>
> **缺口评审修正（2026-06-25）**：prune-summary 阈值从 0.85 提升到 0.95（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)）；不设预防性 force，只保留 overflow 兜底（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)）；每轮计数归属 ContextManager（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。

---

## 零、核心判断

ohbaby 的压缩**决策**早已是分离的纯函数，per-step 与 overflow recovery 也已落地。对照 kimi `CompactionStrategy`，缺的不是"策略接口"抽象，而是三个具体行为缺口：阶梯不连贯、无反抖动锁、无每轮上限。本轮**不引入插件接口**（只有一种 auto 策略，属过早抽象），只显式化阶梯并补护栏。

---

## 一、现状对照 kimi `CompactionStrategy`

| kimi Strategy 成员 | 职责 | ohbaby 现状 | 缺口 |
|---|---|---|---|
| `shouldCompact(used)` | 何时压 | `getContextUsage.shouldCompress`（0.95，纯函数，[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)） | 无 |
| `computeCompactCount(msgs, source)` | 压到第几条 | `findCutPoint` + `getHistoryToCompress`（纯函数） | 无 |
| `reduceCompactOnOverflow` | 溢出降级 | lifecycle 捕获 overflow → `prepareTurn(force)`（lifecycle.ts:447） | 无 |
| `checkAfterStep` | 每步查 | `prepareTurn` 每步调（lifecycle.ts:362） | 无 |
| `shouldBlock` / 异步压缩 | 阻塞 vs 后台 | ohbaby 单进程同步 | 不适用（YAGNI） |
| `maxCompactionPerTurn` | 每轮次数上限 | 无 | **缺口 C3** |
| 反抖动 `minOverflowReductionRatio` | 省太少就锁 | 无 | **缺口 C2** |

**判断**：决策侧 ohbaby 已对齐 kimi 的主要纯函数。差距集中在护栏（C2/C3）与阶梯连贯性（C1）。

---

## 二、缺口 C1：升级阶梯不连贯

编排层（runCompaction）+ 投影层（mask）落地后，形成两道防线、两个阈值：

```
usage ~0.5  ── mask（投影层，可逆、不写库）          ← config 在投影层
usage 0.95  ── prune + summary（编排层，永久、叫 LLM） ← COMPRESSION_THRESHOLD 在 constants（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)：0.85→0.95）
remaining<4096 ── prune + summary（小硬地板）          ← F7-A，防估算低估的简单保险
overflow    ── force（lifecycle 外部捕获，终极兜底）   ← ([G10](../gaps-and-decisions.md#g10去除-095-预防性-force)：不设预防性 force)
```

问题：mask 阈值与 prune/summary 阈值分散在**两层不同的 config**，无单一真相，易漂移（如有人调了 mask 阈值到 0.9，与 summary 的 0.95 形成矛盾的触发顺序而无人察觉）。"哪个 usage 触发哪一级"没有一个权威 policy。

依据：references/02 内聚——同一决策（升级到哪一级）应在一处表达。

---

## 三、缺口 C2：无反抖动锁（真实省钱缺口）

per-step 压缩（`prepareTurn` 每步调）下存在抖动隐患：

- 若会话本身很大，一次 summary 压不到 0.95 以下，`decideCompactionRung` 会**每一步都判定 compact → 每步叫一次 LLM 摘要**。
- 现有的 inflated 拒绝（`projectedUsage >= usageAfterPrune` 则拒绝提交，context-manager.ts:791/905/1096）只挡"提交坏摘要"，**挡不住"反复昂贵地尝试摘要"**——每次尝试都已经付了 LLM 调用成本。

后果：大会话场景下每步一次摘要 LLM 调用，成本高、延迟大，与压缩"省"的初衷相悖。

参照 kimi `DefaultCompactionStrategy.minOverflowReductionRatio`（0.05）：**连续压缩省的 token 低于阈值则锁定**，直到 usage 显著变化或用户重置。ohbaby 缺这道锁。

---

## 四、缺口 C3：无每轮压缩次数上限

一个 turn 的多步 tool loop 内，per-step 压缩可能在单 turn 内触发多次压缩，无封顶。kimi 用 `maxCompactionPerTurn` 限制。ohbaby 无此常量/保护。

后果：极端情况下单 turn 多次 LLM 摘要调用，放大 C2 的成本问题。

---

## 五、路线图 2.4 定位澄清：触发入口，非策略框架

路线图 2.4"compress 暴露给模型"（三入口：模型主动 / 用户手动 / 系统被动 + 反抖动）容易被误读为"需要策略框架"。实际它是**多一个触发来源**：

- 模型主动 = 给模型一个 `compress_context` 工具，内部调现有 `compact(force)`。
- 用户手动 = 已有（`adapters/ui-runtime/composition.ts:546` 调 `compact`）。
- 系统被动 = 已有（per-step `decideCompactAction`）。

真正的工作量在 system-prompt 引导（何时该调）+ 复用 C2 反抖动锁，**不在策略抽象**。本轮至多预留入口，工具实现归后续。

---

## 六、为何不建 `CompactionStrategy` 插件接口

依据 references/03（KISS/YAGNI · 反教条护栏）：

- ohbaby 当前只有**一种 auto 策略**（0.95 → prune+summary，[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)）。给唯一实现套接口 = "机械 SOLID 造没必要的接口"。
- kimi 的 Strategy 接口值钱，是因为它有异步压缩、blockRatio、replay/records、多 source——ohbaby 都没有。
- 决策已是纯函数，可测、可配（`compressionThreshold` 等已在 `ContextManagerOptions`）。包成 class/接口只增间接层，无第二实现来摊薄成本。

**重启条件**：出现第二种真实 auto 策略（如按模型差异化阈值、用户可配压缩算法）时，与该第二实现共同抽接口——与 origin ADR 同一原则。

---

## 七、风险与边界

| 项 | 说明 |
|----|------|
| 反抖动锁与正确性 | 锁定期间若 usage 因新输入显著上升，必须能解锁，避免"该压不压"导致溢出 |
| 阶梯归一与现有阈值 | policy 收口本身应尽量行为保持；summary 阈值从 0.85→0.95 与 F7-A 小硬地板是单独行为变更，需 characterization 覆盖；mask 0.5 是投影层引入的新值 |
| 不做 | 本轮不建插件接口、不引入异步/后台压缩、不实现 2.4 工具本体（仅预留） |
| 依赖 | 依赖编排层 runCompaction 与投影层 mask；建议两者先落地 |
