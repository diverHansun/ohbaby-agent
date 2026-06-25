# context improve-3 · 编排层（去三重）

> 本轮目标：消除 `context-manager.ts` 中 `compress` / `compact` / `prepareTurn` 三个方法对**同一条压缩流水线**的重复实现（一个知识、三处实现），把脊椎抽成单一内部编排 `runCompaction`，并顺手统一 token 口径与读库时机。
>
> 本轮**不新增能力**——per-step 压缩、overflow recovery、reasoning 过滤在 improve-2 / reasoning-display 已落地。本轮是纯粹的结构债偿还（🍒 低垂果实），为后续投影层 / origin / 压缩多策略打地基。

---

## improve-3 整体推进顺序

improve-3 分五个子主题，**逐个走"问题分析 → 实施方案 → 验收测试"三段式**，本目录是第一个：

| 顺序 | 子主题 | 目录 | 状态 |
|------|--------|------|------|
| 1 | **编排层去三重** | `improve-3/编排层/` | 设计完成，待实施 |
| 2 | usage 估算重构（锚点→标定） | `improve-3/usage-估算/` | 设计完成，待实施 |
| 3 | 投影层阶段链（storage→inference） | `improve-3/投影层/` | 设计完成，待实施 |
| 4 | Origin 来源追踪 | `improve-3/origin/` | ADR 已接受，待实施小收口 |
| 5 | 压缩多策略（升级阶梯+护栏） | `improve-3/压缩多策略/` | 设计完成，待实施 |

五者有依赖：编排层抽出 `runCompaction` 后，usage 估算基于稳定工作集重做 token 口径；投影层 mask 依赖 usage 能看见削减；压缩多策略在 `runCompaction` 与 mask 都落地后挂载护栏。origin 是旁路收口，不阻塞主链。**先做地基（1、2），再做能力（3、5），origin 轻量插入。**

---

## 本目录文档

| 文档 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 现有问题分析：三重脊椎的逐字重复、token 口径不一、冗余读库、僵尸 API |
| [02-implementation-plan.md](./02-implementation-plan.md) | 实施和优化方案 + 影响的代码点/文件位置 + 提交拆分 |
| [03-acceptance-and-testing.md](./03-acceptance-and-testing.md) | 验收口径与测试标准（含 compress 测试迁移） |

---

## 关键设计决策（讨论已定）

- **D1：删除 `compress` 公共方法**，其测试迁移到内部 `runCompaction`。理由：无任何生产调用方，仅测试引用。
- **D2：prune 统一到"内存工作集 + commit-once"语义**。历史在内存里以投影形式流转，DB 只在两个提交点（prune 标记、summary 消息）被写；读库只在前置 `assemble` 一次 +「真提交摘要」分支回读一次。
- **D3：「接受」分支拿真摘要走方案 A**（提交后重读一次 `listBySession`），不走内存拼接，避免两条投影逻辑必须永远对齐的脆性。
- **D4：保持 `ContextManager` 对外 API 兼容**（`compact` / `prepareTurn` 签名不变），仅删除无调用方的 `compress`（与疑似无调用方的 `prune`，见 01 文档待确认项）。
- **D5（缺口评审新增）：编排层直接引入 `CompactionRung`**（none/mask/prune-summary/force），mask 档预留 switch 空分支但不返回。`prune-only` 合并进 `prune-summary`，`allowPruneOnly` 参数消失。脊椎 P2 switch 一次写定，压缩多策略阶段零改动脊椎（[G8](../gaps-and-decisions.md#g8decidecompactaction--decidecompactionrung-双触)）。
- **D6（缺口评审新增）：prune 读 mask 前历史，usage 读 mask 后历史**。`CompactionRequest` 携带外壳预算好的 `usageBefore`（基于 mask 后工作集），prune 扫描读 `assembled.history`（mask 前）。两个口径对应两个不同问题（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。
