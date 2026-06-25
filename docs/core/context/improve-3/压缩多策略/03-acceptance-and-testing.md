# 压缩多策略 · 验收和测试标准

> 验收基于真实代码与真实测试输出。遵循模块级测试规范 `docs/core/context/test.md`，沿用 `manager.unit.test.ts` / `lifecycle.unit.test.ts` 既有约定。
> 本轮含三部分：阶梯归一（行为保持）+ 反抖动锁（新行为）+ 每轮上限（新行为）。

---

## AC-0 文档完整性

- `docs/core/context/improve-3/压缩多策略/` 下 `README.md` 与三篇齐备。
- 文档明确：不建插件接口；只显式化阶梯并补反抖动锁、每轮上限；2.4 定位为触发入口。

---

## AC-1 升级阶梯归一（行为保持）

**目标**：mask 与 summary 阈值同处定义，rung 驱动分派。

**判定**：

- 存在 `decideCompactionRung`，返回 `none | mask | prune-summary | force`。
- `CompactionThresholds`（mask / summary）集中定义于 `constants.ts`，无跨层重复阈值。
- usage < mask 阈值且剩余预算充足 → `none`；mask ≤ usage < summary → `mask`；usage ≥ summary → `prune-summary`；usage < summary 但 `remainingInputTokens < 4096` → `prune-summary`（F7-A 小硬地板）；force → `force`。too-short 历史由 `generateSummaryCandidate` 返回 skipped，不放在 rung policy 里重复判断。
- **summary 阈值默认 0.95**（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)：原 0.85→0.95）——characterization 测试需更新阈值断言。
- **近上限小硬地板默认 4096**（F7-A）：比例未到 0.95 但剩余输入预算不足 4096 时仍触发 prune-summary。
- **`force` 仅由 `input.force=true` 触发**（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)），不从 usage ratio 推导。

**建议命令**：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --testTimeout=300000
```

---

## AC-2 反抖动锁

**目标**：连续低收益压缩后锁定，避免每步昂贵摘要；有解锁路径。

**判定**：

- 连续 `THRASH_WINDOW`（默认 2）次压缩的节省比均 < `THRASH_MIN_SAVINGS_RATIO`（默认 0.10）→ 后续 `decideCompactionRung` 返回 `none`（锁定），且**不再调用 LLM 摘要**。
- 锁定期间发出 `context.compactSkipped`，`reason: "thrash-locked"`。
- 解锁：usage 较锁定时上升 ≥ `THRASH_UNLOCK_DELTA`（默认 0.05）→ 恢复尝试。
- `compact(force)` / overflow force 始终穿透锁。

**建议测试**：

- mock LLM 让每次摘要仅省 ~5%，连续两次后断言第三步**未再调用** `llmClient.generateSummary`，且发出 thrash-locked。
- 锁定后注入大输入抬高 usage，断言解锁并重试。
- force 路径在锁定态仍执行压缩。

---

## AC-3 每轮压缩次数上限

**目标**：单 turn 内 auto 压缩不超过 `MAX_COMPACTION_PER_TURN`。

**判定**：

- 单 turn 多步 tool loop 内，auto `prune-summary` 触发次数 ≤ `MAX_COMPACTION_PER_TURN`（默认 2）。
- 达上限后本 turn 后续 step 即使越阈值也降级为 `mask`，summary 推迟到下一 turn。
- force（overflow / 手动）不受此上限约束。
- 跨 turn 计数清零：lifecycle 在 turn 开始时调 `contextManager.resetTurnCompactionCount(sessionId)`（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。
- **三种触发源计数行为**：自动 per-step 受限且递增；overflow force 穿透但递增；用户手动 `/compact` 不参与计数（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。

**建议命令**：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts --testTimeout=300000
```

---

## AC-4 不引入插件接口（反过早抽象核验）

**目标**：决策保持纯函数，无 `CompactionStrategy` class/接口。

**判定**：

```bash
rg -n "interface CompactionStrategy|class .*Strategy|implements CompactionStrategy" packages/ohbaby-agent/src/core/context
# 期望：无匹配
```

- 阶梯/锁/上限均以纯函数 + 常量 + 内存状态实现，无策略注册表。

---

## AC-5 2.4 入口（若本轮预留）

**目标**：compress 暴露给模型仅为触发入口，复用现有 `compact(force)` 与反抖动。

**本轮结论**：不实现/不预留 `compress_context` 工具桩；入口随后续首个真实消费方与 system-prompt 引导共同设计。

**判定**（仅在本轮预留入口时适用）：

- `compress_context` 工具桩内部转调 `compact(force)`，不引入独立压缩实现。
- 受 AC-2 反抖动锁约束（模型频繁调用不致抖动）。
- 若本轮不实现，文档明确标注为后续，不作为已完成项。

---

## AC-6 架构边界

```bash
rg -n "from .*runtime|from .*adapters|from .*agents" packages/ohbaby-agent/src/core/context
rg -n "TODO|NotImplemented|throw new Error\(\"not implemented" packages/ohbaby-agent/src/core/context
```

- 锁状态 / 每轮计数为内存态，不写库（grep 确认 mask/锁路径不调 `updatePart`、不写 `time.compacted`）。
- 不引入异步/后台压缩。

---

## AC-7 回归测试矩阵

```bash
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --testTimeout=300000
pnpm test
```

真实 provider 下额外人工验证：大会话长 tool 链中，反抖动锁生效后单 turn 的 LLM 摘要调用次数受控（按 `ohbaby-e2e-test.md` 本地配置，不提交密钥）。
