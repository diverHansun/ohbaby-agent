# context improve-4 · tool schema 计量、自动压缩过程态

> 状态：实施中（任务 A/B 已编码，待全量验收与审查）
> 日期：2026-08-21
> 基线：`main` @ `e59107b`
> 落点：`docs/core/context/improve-4/`
>
> 主题：在 improve-3 标定估算已落地的前提下，把 **tool schema 纳入请求占用测量**，并补上自动压缩 **后端→前端** 的 in-progress 状态。Prompt cache、长期记忆、占用三类监测/展示不在本批。

---

## 1. 范围

**In-scope（本批，按顺序两刀；实施拆成两个先后任务，仍用本文档）**

1. **Tool schema 计量（任务 A）**：只把实时 Lifecycle 每一步实际 LLM 请求的占用做准。工具 schema 进入占用测量；测量与实际请求使用同一份已解析 tools。现有总量占用条继续用，不改 `tokenCounting.ts` 算法。
2. **自动压缩过程态（任务 B）**：自动压缩会跑，但前端听不到「正在压」。当 ContextManager 已选择实际压缩档位（非 `none/mask`）、且尚未开始 prune/summary 时，补 Lifecycle `context:compacting` → `run.context.compacting` → TUI/Web 把 runtime 状态写成 `Compacting...`。纯 prune 与 prune+summary 都覆盖；成功不 notice，靠现有占用总量变化。不学 pi hooks，不给 Bus 再接 UI。

**Out-of-scope**

- **占用监测 / 三类 UI**：不加 `system / tools / messages` breakdown 字段，不改 TUI/Web 占用展示形态（现有 `38K / 1M (4%)` 总量条保留）。后续批次；分类若做，已锁定 KISS 三类 + `~`（见 00）。
- **静态查询与手动 compact 的 tools 估算**：`composition.getContextUsage` 与手动 `compactSession` 本批保持 messages-only 粗估，不为它们解析动态 tools，也不扩展公开 API。这不是 improve-5/cache 的内容；它必须在后续 context 占用监测与 UI 实施前先优化。
- **Prompt cache**：不新增 cache 字段，不启用 cache policy，不统计命中率/成本，也不预测命中。作为独立 [improve-5](../improve-5/README.md) 继续设计。
- 长期记忆主动工具 / hooks 注入（方向 4，后续 `docs/core/memory/improve-2/`）
- pi 式 `session_before_compact` hooks
- 把 SQLite 换成 JSONL
- 精确 tokenizer / tiktoken
- 打开 mask（仍保持 dark ship，`maskEnabled` 默认 false）
- 五类及以上占比、Claude Code `/context` 级细分、ContextMeter 圆环

---

## 2. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [improve-3](../improve-3/README.md) | 权威前序。标定估算、`measureUsage`、`sentHeuristic` 已实施。本批不回退该方案。 |
| [improve-3/usage-估算](../improve-3/usage-估算/README.md) | D3：factor **不写库**。本批已确认维持；重启后 factor 从 1.0 起，随首次 API usage **重新生成**，不是从磁盘同步。 |
| [problem-lists/compact/05](../../../problem-lists/compact/05-compact-result-and-notice-ui-design.md) | 手动 compact 的 `Compacting...` spinner、成功不粘 notice：与本批 00 一致。自动压缩 in-progress 仍缺，见 01/02 任务 B。 |
| [goals-duty.md](../goals-duty.md) | D2 已规定 context 调用 tokenCounting 模块；G2 仍写 85% 阈值，与代码 0.95 不一致（本批在 01 记录，不在此改阈值）。 |
| [memory/improve-1](../../memory/improve-1/README.md) | 记忆已收缩为只读 Loader。本批不恢复 ghost `memory_*`，也不做 hooks。 |

---

## 3. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状、代码锚点、问题分类 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 分阶段改动面（交给后续实施会话） |
| [03-reference-projects.md](./03-reference-projects.md) | Claude Code / Codex / dsh / Kimi / OpenCode / pi 借鉴与明确不抄 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 风险导向验收 |
| `05-implementation-acceptance.md` | 实施完成后由验收模式写入（规划期不存在） |

推荐阅读：00 → 01 → 02 → 03 → 04。实施以 **02 + 04** 为准，完成事实与验证结果写入 05。

---

## 4. 批次与实施拆分

本目录只约束 improve-4。Prompt cache 已拆到独立 improve-5，不属于本批实施契约。

实施拆成两个先后任务（两个 PR / 两次会话均可）：

| 任务 | 02 | 说明 |
|------|-----|------|
| A tool schema 计量 | Phase 1 | 只修实时 Lifecycle 请求；占用总量会变大，压缩可能稍早触发。单独合，方便 bisect |
| B 自动压缩过程态 | Phase 2 | 自动压缩期间把运行时标题切到 `Compacting...`，结束后恢复 |

A 与 B 是可独立回归、可分别回滚的两个改动面；本次按 A → B 实施，不再把依赖关系作为待确认项。Prompt cache、占用三类 UI、长期记忆都不在这两个任务里。`getContextUsage` / 手动 compact 的估算精化也不属于任务 A，但已登记为后续占用监测/UI 的实施前置条件。
