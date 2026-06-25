# 编排层去三重 · 验收和测试标准

> 验收必须基于真实代码与真实测试输出，不能用文档代替实现。
> 本轮是**行为保持型重构**：验收核心是"对外可观察行为零变化 + 结构债清除"。遵循模块级测试规范 `docs/core/context/test.md`，沿用 `manager.unit.test.ts` 既有约定。

---

## AC-0 文档完整性

- `docs/core/context/improve-3/编排层/` 下 `README.md` 与三篇文档齐备。
- 文档明确本轮为纯结构重构，不新增能力，不破坏 `compact`/`prepareTurn` 公共 API。

---

## AC-1 脊椎统一（去三重）

**目标**：`compact` 与 `prepareTurn` 的压缩流程经由单一内部 `runCompaction`，不再各自保留 P5/P6/P7 脊椎副本。

**判定**：

- `context-manager.ts` 中"生成摘要候选 → 投影评估 → 反膨胀拒绝 → 提交"逻辑只出现一处。
- grep 校验反膨胀判断不再三处重复：

```bash
rg -n "projectedUsage" packages/ohbaby-agent/src/core/context/context-manager.ts
# 期望：仅出现在 runCompaction / evaluateProjection 内，不再分散于 compress/compact/prepareTurn
```

- `compact` / `prepareTurn` 公共签名与返回类型不变（`CompactResult` / `PreparedTurn`）。

---

## AC-2 行为保持（characterization 回归）

**目标**：重构前后，对外可观察行为逐位一致。

**判定**（在重构前先固化为 characterization 测试，重构后必须全绿）：

- `compact` 在 not-needed / pruned / compacted / inflated / failed 五种结局下的 `status`、`usageBefore`、`usageAfter`、`prune`、`compression` 字段与重构前一致。
- `prepareTurn` 在 none / prune-summary / force 三种 `decideCompactionRung` 路径下，返回的 `messages`、`usage`、`compaction`、`hasSummary` 与重构前一致。（注：`prune-only` 已合并进 `prune-summary`，由 P4 闸门②判断是否继续跑 summary；[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）
- 事件发布序列不回归：`context.pruned`、`context.compressed`、`context.compactSkipped`(not-needed/inflated/too-short)、`context.turnPrepared` 在对应路径上按原顺序发出。

**建议命令**：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --testTimeout=300000
```

---

## AC-3 读库/装配次数下降

**目标**：消除 §3.2 的冗余装配与回读。

**判定**：

- `compact` 单次调用对 `messageManager.listBySession` 的调用次数较重构前下降（移除 afterPrune / afterCompression 的额外全量 `assemble`）。
- `prepareTurn` 在 skip / prune-only / 候选失败 / 反膨胀拒绝四个**非提交分支**不再调用 `listBySession`（仅前置 `assemble` 一次）。
- 仅"接受并提交摘要"分支保留一次回读（决策 A）。

**建议测试**：用 mock 的 `messageManager` 断言 `listBySession` / `assemble` 调用次数：

```ts
// 非提交分支：listBySession 仅前置 1 次
expect(mockStore.listBySession).toHaveBeenCalledTimes(1)
// 提交分支：前置 1 + 回读 1
expect(mockStore.listBySession).toHaveBeenCalledTimes(2)
```

---

## AC-4 token 口径统一

**目标**：消除 `compress`(全量 serialize) 与 `compact`/`prepareTurn`(锚点估算) 的口径差异。

**判定**：

- 脊椎内 usage 测量只经 `getContextUsage(...)` 一个入口。
- 同一会话历史下，`compact` 与 `prepareTurn` 计算出的 `usageBefore.currentTokens` 一致（同一口径）。

---

## AC-5 compress 删除与测试迁移

**目标**：删除无生产调用方的 `compress`，其验证价值不丢失。

**判定**：

- `ContextManager` 不再暴露 `compress`；`types.ts` / `index.ts` 无 `compress` 残留。

```bash
rg -n "compress\b" packages/ohbaby-agent/src/core/context/context-manager.ts packages/ohbaby-agent/src/core/context/types.ts packages/ohbaby-agent/src/core/context/index.ts
# 期望：无 .compress 公共方法定义（compression/Compressed 等无关命中可忽略）
```

- `manager.unit.test.ts:1137-1795` 原 `compress` 用例已迁移：inflated / failed / too-short / "同轮已修剪文件不进摘要" 等行为改为针对 `runCompaction`（或经 `compact` 等价路径）断言，且全绿。
- 迁移后这批用例断言对象为 `CompactionOutcome`（或 `CompactResult`），不再为已删除的 `CompressionResult` 返回形态。

---

## AC-6 prune 公共方法去留确认

**目标**：确认 `prune` 是否同为死代码。

**判定**：

```bash
rg -n "\.prune\(" packages --glob '!**/*.test.*' --glob '!**/context/**'
# 若无生产调用方：随 compress 一并从 ContextManager 接口移除，并迁移相关测试
# 若有调用方：保留，且让其内部复用 runCompaction 的 prune 段，不另起一份
```

---

## AC-7 架构边界

```bash
rg -n "from .*runtime|from .*adapters|from .*agents" packages/ohbaby-agent/src/core/context
# 期望：无新增跨层依赖
rg -n "TODO|NotImplemented|throw new Error\(\"not implemented" packages/ohbaby-agent/src/core/context
```

- 不引入投影层阶段链 / origin / 压缩多策略（属 improve-3 后续子主题）。
- prune 立即写库语义保留。

---

## AC-8 回归测试矩阵

实现完成后至少运行：

```bash
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --testTimeout=300000
pnpm test
```

`compact` 的 UI 调用方（`adapters/ui-runtime/composition.ts:546`）经回归矩阵覆盖，确认手动压缩路径不回归。
