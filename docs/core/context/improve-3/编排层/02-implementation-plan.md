# 编排层去三重 · 实施和优化方案

> 实施边界：只重构 `core/context` 内部编排，不改 `compact` / `prepareTurn` 对外签名，不触碰 lifecycle / runtime / adapters / agents。
> 前置决策见 [README.md](./README.md) D1–D4。

---

## 一、目标产物：内部脊椎 `runCompaction`

把 P1–P8 脊椎抽成单一内部函数，`compact` / `prepareTurn` 各自只保留薄外壳。

> **缺口评审修正**：编排层直接引入 `CompactionRung`（none/mask/prune-summary/force 四档），mask 档预留 switch 空分支但不返回——压缩多策略阶段只改 `decideCompactionRung` 内部，脊椎 P2 零改动（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。`prune-only` 合并进 `prune-summary`，`allowPruneOnly` 参数消失。

### 1.1 脊椎产物形状（设计草案）

```ts
// 内部类型，不导出到 ContextManager 公共 API
interface CompactionRequest {
  readonly assembled: AssembledContext;     // 由外壳预先装配好（mask 前的 active history）
  readonly usageBefore: ContextUsage;       // 由外壳基于 mask 后工作集预算好（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）
  readonly modelId: string;
  readonly force: boolean;
  readonly sessionId: string;
}

interface CompactionOutcome {
  readonly status: CompactStatus;           // not-needed|pruned|compacted|inflated|failed
  readonly prune: PruneResult;
  readonly compression?: CompressionResult;
  readonly usageBefore: ContextUsage;
  readonly usageAfterPrune: ContextUsage;
  readonly usageAfter: ContextUsage;
  readonly projectedHistory: readonly MessageWithParts[];  // 内存投影，权威（非提交分支即终值）
  readonly committedSummaryId?: string;     // 仅"接受"分支有
  readonly error?: string;
}
```

> **变化说明**：
> - `allowPruneOnly` 消失——`prune-only` 语义合并进 `prune-summary`，由脊椎 P4 闸门②统一判断是否继续跑 summary。
> - `usageBefore` 由外壳预算（基于 mask 后工作集），脊椎内不再自己量 P1——prune 扫描读 `assembled.history`（mask 前），usage 读 `usageBefore`（mask 后），两个口径对应两个不同问题（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。

### 1.2 脊椎内部时序（内存工作集 + commit-once）

> **缺口评审修正**：P2 使用 `decideCompactionRung` 取代 `decideCompactAction`，返回 `CompactionRung`（none/mask/prune-summary/force）。编排层阶段 rung 只返回 none/prune-summary/force 三档，mask 档为预留空分支（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。prune-summary 阈值 0.85→0.95 是 [G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095) 的行为变更，本批次只预留 threshold 接缝，默认值随压缩多策略批次在 usage 标定后切换。

```
（外壳已完成 assemble + mask + usageBefore 预算）
runCompaction(req):
   P1 usageBefore = req.usageBefore                          // 外壳预算好（mask 后），不再自量
   P2 rung = decideCompactionRung({usage: usageBefore, historyLength, force, thresholds})
      switch (rung):
        case "none":          发 CompactSkipped(not-needed)，return outcome(not-needed)  // 正常
        case "mask":          return outcome(not-needed)     // 预留：mask 在投影层处理，脊椎不跑
        case "prune-summary": continue to P3                 // P4 闸门②判断是否跑 summary
        case "force":         continue to P3                 // force 跳过 P4 闸门②
   P3 prune：pruneHistory 标记 + 立即写库①（扫描 req.assembled.history = mask 前）；markCompactedParts 内存投影出 prunedHistory
      usageAfterPrune = getContextUsage(投影)
   P4 闸门②：!force && rung!=force → return outcome(pruned|not-needed)，projectedHistory=prunedHistory，【不回读】
   P5 candidate = generateSummaryCandidate(prunedHistory)
      └─ 非 candidate → 发 CompactSkipped(skippedReason)，return outcome(statusForUncommitted)，【不回读】
   P6 projected = projectSummaryCandidate(prunedHistory, candidate)
      projectedUsage = getContextUsage(projected)
      └─ projectedUsage >= usageAfterPrune → 发 CompactSkipped(inflated)，return outcome(拒绝)，【不回读】
   P7 commit：commitSummaryCandidate 写库②（新摘要消息 + 标记被摘要 part）
   P8 回读一次 listBySession（决策 A），重建 projectedHistory 为权威态
      usageAfter = getContextUsage，发 Compressed，return outcome(compacted)
```

要点：

- **读库次数**：前置 `assemble` 1 次 + 仅 P7/P8 提交分支回读 1 次。非提交分支零回读。
- **写库点**：仅 prune 标记（P3）与 summary 提交（P7）两处，与现状一致。
- **token 口径**：`usageBefore` 由外壳基于 mask 后工作集预算（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）；脊椎内 `usageAfterPrune`/`usageAfter` 用 `getContextUsage(...)` 统一测量。prune 扫描读 `assembled.history`（mask 前），保证 prune 不被 mask 的占位符干扰。
- **反膨胀拒绝**（P6）抽成一个 `evaluateProjection()`，三处合一。
- **脊椎 P2 switch 一次写定**：压缩多策略阶段只改 `decideCompactionRung` 内部（加 mask 档 + 反抖动锁 + 每轮计数），脊椎代码零改动（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。

---

## 二、外壳适配

### 2.1 `compact`（保持签名）

```
compact(sessionId, opts):
   assembled = assemble(全量, isSubagent)
   usageBefore = getContextUsage(assembled)           // mask 关闭时直接用 assembled
   outcome   = runCompaction({assembled, usageBefore, force: opts.force, ...})
   return mapOutcomeToCompactResult(outcome)   // usageAfter 直接取自 outcome，不再 assemble 第三遍
```

### 2.2 `prepareTurn`（保持签名）

> **缺口评审修正**：`prepareTurn` 在 `runCompaction` 量 usage **之前**插入 `reduceForModel`（mask 削减段），usage 基于削减后工作集（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。mask 跑两次幂等——第一次在 runCompaction 前（影响 usage），第二次在 runCompaction 后（对 prune/summary 后的 history 重新应用同一 cutoff）。

```
prepareTurn(input):
   assembled = assemble(全量, isSubagent)
   maskedHistory = reduceForModel(assembled.history, cutoffState, maskConfig)   // mask 第 1 次
   usageBefore = getContextUsage({...assembled, history: maskedHistory})
   outcome   = runCompaction({assembled, usageBefore, force: input.force, ...})  // prune 扫描 assembled.history（mask 前）
   projectedHistory = outcome.projectedHistory
   finalHistory = reduceForModel(projectedHistory, cutoffState, maskConfig)      // mask 第 2 次, 幂等
   messages  = renderForModel({
                 history: finalHistory,
                 memory: assembled.memory,
                 systemPrompt: assembled.systemPrompt,
                 activeReasoningByMessageId: input.activeReasoningByMessageId,
                 isSubagent,
               })
   发 TurnPrepared
   return { messages, usage: outcome.usageAfter, compaction: mapOutcomeToCompactResult(outcome), ... }
```

> 注：`serializeForLlm` 当前未接收 `onSecurityFinding`，导致 memory 注入扫描发现被静默丢弃（独立的问题 #4）。本轮可顺手把 `onWarning`/finding 回调接上，但若想保持本轮纯结构化，也可留给投影层子主题统一处理——二选一在实施时确认。

### 2.3 删除 `compress`

- 删除 `compress` 实现（`context-manager.ts:719-816`）与 `ContextManager.compress`（`types.ts:142-146`）。
- 同步从 `index.ts` 移除任何导出（确认无再导出）。
- 测试迁移见 [03-acceptance-and-testing.md](./03-acceptance-and-testing.md)。

---

## 三、影响的代码点 / 文件位置

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/core/context/context-manager.ts` | 抽出 `runCompaction` + `evaluateProjection` + `mapOutcomeToCompactResult`；删除 `compress`；`compact` / `prepareTurn` 改为薄外壳；移除 `compact` 的冗余 `assemble`、`prepareTurn` 非提交分支的 `listBySession` |
| `packages/ohbaby-agent/src/core/context/types.ts` | 删除 `ContextManager.compress`（与待确认的 `prune`）；如需可新增内部类型 `CompactionRequest`/`CompactionOutcome`（不导出） |
| `packages/ohbaby-agent/src/core/context/index.ts` | 移除 `compress` 相关导出（如有） |
| `packages/ohbaby-agent/src/core/context/manager.unit.test.ts` | 迁移 `compress` 用例（L1137-1795）到 `runCompaction` 或经 `compact`/`prepareTurn` 验证 |
| `packages/ohbaby-agent/src/core/context/events.ts` | 不改 schema，仅核对事件发布序列不回归 |

**不改**：`serialization.ts`、`serializer.ts`（除可选的 finding 回调）、`filters.ts`、`summary.ts`、`token-estimation.ts`、`file-ops.ts`、`tool-metadata-projection.ts`、`lifecycle.ts`、`composition.ts`。

复用的现有零件（不重写）：`findCutPoint`、`getContextUsage`、`pruneHistory`、`markCompactedParts`、`getActiveHistory`、`generateSummaryCandidate`、`projectSummaryCandidate`、`commitSummaryCandidate`、`statusForUncommittedCompression`、`compressionFromRejectedCandidate`、`pruneReducedContext`。本轮主要是**重排编排顺序**，而非新写算法。

> **`decideCompactAction` → `decideCompactionRung`**：编排层阶段将 `decideCompactAction` 升级为 `decideCompactionRung`（返回 `CompactionRung` 而非 `CompactAction`），`prune-only` 合并进 `prune-summary`，`force` 显式化为独立档位。脊椎 P2 switch 一次写定，压缩多策略阶段只改 `decideCompactionRung` 内部（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。

> **`shouldCompress` 退休（F3）**：脊椎 P2 改用 `decideCompactionRung` 后，不再读 `ContextUsage.shouldCompress`。编排层阶段先把 `context-manager.ts:120/737/834/860/1021` 的 `!usage.shouldCompress` 闸门替换为 `decideCompactionRung` 判断；usage-估算 子主题正式从 `ContextUsage`/`ContextManager`/`events.ts` 移除 `shouldCompress` 字段/方法。详见 [usage-估算/02-implementation-plan.md §二](../usage-估算/02-implementation-plan.md)。

---

## 四、建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐：本目录 README + 三篇 |
| 2 | characterization 测试：先用现有 `compact`/`prepareTurn`/`compress` 固化当前可观察行为（事件序列、状态、token 数），作为重构安全网 |
| 3 | 抽出 `runCompaction` + `evaluateProjection`，让 `compact` / `prepareTurn` 改调它（行为不变） |
| 4 | 收敛 prune 到内存工作集：移除 `compact` 冗余 `assemble` 与 `prepareTurn` 非提交分支 `listBySession` |
| 5 | 删除 `compress`（与确认后的 `prune`），迁移其测试到 `runCompaction` |
| 6 | （可选）接通 `serializeForLlm` 的 security finding 回调 |

---

## 五、开发护栏

- 每个提交先写/跑失败测试再改实现（TDD），先固化行为再重构。
- `compact` / `prepareTurn` 公共签名与事件序列零破坏。
- prune 立即写库语义保留；摘要失败不回滚已 prune 的释放。
- `core/context` 不新增对 `runtime`/`adapters`/`agents`/UI 的依赖。
- 修改返回结构时同步核对 `events.ts` 的 Zod schema。
- 本轮不引入投影层阶段链、origin、压缩多策略。
