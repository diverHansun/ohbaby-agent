# 压缩多策略 · 实施和优化方案

> 实施边界：显式化升级阶梯 + 补反抖动锁与每轮上限；决策保持纯函数，不引入插件接口；不改 `compact`/`prepareTurn` 对外签名。
> 前置：编排层 runCompaction、投影层 mask 落地后推进。决策见 [README.md](./README.md) D1–D7。
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G4/G8/G9/G10。

---

## 一、升级阶梯 policy 归一（C1）

> **缺口评审修正**：prune-summary 阈值从 0.85 提升到 **0.95**（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)）；不设预防性 force，`force` 仅由 overflow error 触发（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)）；阶梯为三档（`mask → prune-summary → overflow force`）。F7-A 保留 KISS 小硬地板：`remainingInputTokens < 4096` 也进入 prune-summary 档。

把"哪个 usage 触发哪一级"收到一个纯函数。编排层阶段已引入 `decideCompactionRung`（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)），压缩多策略阶段只在其内部加 mask 档 + 反抖动锁 + 每轮计数，脊椎 P2 零改动。

```ts
export type CompactionRung = "none" | "mask" | "prune-summary" | "force";

export function decideCompactionRung(input: {
  readonly usage: ContextUsage;
  readonly historyLength: number;
  readonly force: boolean;
  readonly thresholds: CompactionThresholds;   // 单一真相，见下
  readonly thrashLock: ThrashLockState;        // 见 §二
  readonly compactionCount: number;            // 本 turn 已压缩次数（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）
  readonly maxPerTurn: number;                 // MAX_COMPACTION_PER_TURN
}): CompactionRung {
  if (input.force) return "force";                                      // overflow 兜底，穿透一切
  if (input.thrashLock.locked) return "none";                           // 反抖动锁锁定
  const needsSummary =
    input.usage.usageRatio >= input.thresholds.summary ||                // 0.95
    input.usage.remainingTokens < input.thresholds.minRemainingInputTokens; // F7-A: 4096

  if (needsSummary) {
    if (input.compactionCount >= input.maxPerTurn) return "mask";       // 每轮上限，降级为 mask
    return input.historyLength <= 2 ? "mask" : "prune-summary";
  }
  if (input.usage.usageRatio >= input.thresholds.mask) return "mask";   // 0.5
  return "none";
}
```

```ts
// constants.ts —— 阶梯阈值单一真相
export interface CompactionThresholds {
  readonly mask: number;      // 默认 0.5（投影层 mask）
  readonly summary: number;   // 默认 0.95（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)：原 0.85→0.95）
  readonly minRemainingInputTokens: number; // 默认 4096（F7-A 小硬地板）
}
```

- mask 与 summary 阈值**同处定义**，消除跨层漂移。
- `minRemainingInputTokens` 是同一 policy 里的简单保护，不新增策略接口；它只兜住估算低估导致的近上限体验，不替代 overflow force。
- `force` 仅由 `input.force=true` 触发（lifecycle 捕获 overflow error 后传入），**不从 usage ratio 推导**（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)）。
- 仍是纯函数，无 class/接口。
- **脊椎 P2 零改动**：编排层阶段已写好 switch 四分支（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)），本阶段只改 `decideCompactionRung` 内部。

---

## 二、反抖动锁（C2）

### 2.1 状态

```ts
interface ThrashLockState {
  readonly recentSavingsRatios: readonly number[];  // 最近 N 次压缩的节省比
  readonly locked: boolean;
}
```

- 每次 `prune-summary` 完成后，记录 `savedTokens / tokensBefore` 到 `recentSavingsRatios`（滑动窗口，长度 `THRASH_WINDOW`，默认 2，对齐 kimi）。
- 当窗口内**全部** < `THRASH_MIN_SAVINGS_RATIO`（默认 0.10）→ `locked = true`。
- session 内内存状态（与投影层 mask 的 cutoff 同性质，不写库）。

### 2.2 解锁条件

- usage 较锁定时显著上升（如再升 `THRASH_UNLOCK_DELTA`，默认 +0.05）→ 解锁重试（避免"该压不压"导致溢出）。
- 用户手动 `compact(force)` → 重置窗口与锁（force 始终穿透锁，见 §一 policy）。

### 2.3 与 inflated 拒绝的区别

- inflated 拒绝：挡"提交坏摘要"（已存在）。
- 反抖动锁：挡"反复昂贵地尝试摘要"（新增）——在**调用 LLM 之前**短路，省的是 LLM 调用本身。

---

## 三、每轮压缩次数上限（C3）

> **缺口评审修正**：计数器归属 ContextManager，lifecycle 在 turn 开始时调 `resetTurnCompactionCount()`（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。三种触发源的计数行为见下表。

```ts
// constants.ts
export const MAX_COMPACTION_PER_TURN = 2;   // 对齐 kimi 思路，可配
```

- 在 ContextManager 内维护 `Map<sessionId, number>` 计数器（session 内内存态）。
- lifecycle 在 turn 开始时调 `contextManager.resetTurnCompactionCount(sessionId)` 清零。
- `prune-summary` 触发即 +1。
- 达到上限后，本 turn 后续 step 即使越阈值也降级为 `mask`，把 summary 推到下一 turn。
- force（overflow recovery / 用户手动）不受此上限约束（兜底优先）。

三种触发源的计数行为：

| 触发源 | 检查上限 | 递增计数 | 检查反抖动锁 |
|--------|---------|---------|-------------|
| 自动 per-step | ✅ 受限 | ✅ 递增 | ✅ 受限 |
| overflow force | ❌ 穿透 | ✅ 递增 | ❌ 穿透 |
| 用户手动 `/compact` | ❌ 不参与 | ❌ 不递增 | ❌ 穿透 |

> 用户手动 `/compact` 走 `compact()` 独立入口，不进 `prepareTurn` 的计数轨道（用户在 turn 之间主动触发，与 per-turn 计数无关）。overflow force 递增计数的理由：overflow 压完后，后续 step 的自动压缩应知道"这一轮已经压过了"，避免紧接着又自动压一次。

---

## 四、影响的代码点 / 文件位置

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/core/context/context-manager.ts` | `decideCompactionRung` 内部加 mask 档 + thrashLock + compactionCount；runCompaction 末尾回填 `recentSavingsRatios`；新增 `resetTurnCompactionCount`（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）；rung 驱动 mask/prune-summary 分派 |
| `packages/ohbaby-agent/src/core/context/constants.ts` | 新增 `CompactionThresholds` 默认值（mask=0.5, summary=0.95, minRemainingInputTokens=4096）、`THRASH_WINDOW` / `THRASH_MIN_SAVINGS_RATIO` / `THRASH_UNLOCK_DELTA` / `MAX_COMPACTION_PER_TURN` |
| `packages/ohbaby-agent/src/core/context/types.ts` | 新增 `CompactionRung` / `CompactionThresholds` / `ThrashLockState`；`ContextManager` 接口新增 `resetTurnCompactionCount`；`ContextManagerOptions` 可选注入阈值与窗口配置 |
| `packages/ohbaby-agent/src/core/context/events.ts` | `context.compactSkipped` 增加 `reason: "thrash-locked" | "per-turn-cap"`；同步 Zod schema |
| `packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts` | turn 开始时调 `contextManager.resetTurnCompactionCount(sessionId)`（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）；force 路径不变 |

**不改**：投影层 mask 实现本身（仅消费其阈值）、白名单投影、serializer。

复用零件：`getContextUsage`、`findCutPoint`、`getHistoryToCompress`、runCompaction（编排层）、mask（投影层）。

---

## 五、建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐：本目录 README + 三篇 |
| 2 | `decideCompactionRung` + `CompactionThresholds` 单一真相（summary 阈值 0.85→0.95，[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)；F7-A 小硬地板；mask 档接投影层） |
| 3 | 反抖动锁：状态、滑动窗口、锁/解锁、`compactSkipped(reason:"thrash-locked")` |
| 4 | 每轮压缩次数上限：lifecycle turn 计数 + 降级 |
| 5 | （可选）2.4 入口预留：`compress_context` 工具桩（仅转调 `compact(force)`，system-prompt 引导后续） |

---

## 六、开发护栏

- 先写失败测试再实现（TDD）。
- 阶梯归一本身应尽量行为保持；**summary 阈值从 0.85 提升到 0.95** 与 F7-A 小硬地板是单独行为变更（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)）——需要 characterization 测试覆盖阈值变更与近上限触发。
- 反抖动锁必须有解锁路径，禁止"锁死导致该压不压 → 溢出"。
- force（overflow / 手动）始终穿透锁与每轮上限（兜底优先）。`force` 仅由 overflow error 触发，不从 usage ratio 推导（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)）。
- 锁状态、每轮计数均为内存态，不写库；不引入跨进程持久化（YAGNI）。
- 不建 `CompactionStrategy` 插件接口；不引入异步/后台压缩。
- 修改返回结构/事件时同步核对 `events.ts` 的 Zod schema。
- **usage 估算依赖 [usage-估算](../usage-估算/) 子主题的标定式估算**（[G12](../gaps-and-decisions.md#g12锚点估算器看不见-mask--改标定式估算)）——0.95 阈值的精度依赖 factor 纠偏。
