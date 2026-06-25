# context improve-3 · 压缩多策略（升级阶梯 + 护栏）

> 状态：**已实施（Batch 5）**

> 本轮目标：把编排层（runCompaction）+ 投影层（mask）落地后形成的两道防线，显式连成一道**可解释的升级阶梯**，并补上两个真实缺口——**反抖动锁**与**每轮压缩次数上限**。
>
> 标题虽叫"多策略"，但结论是：ohbaby **不需要** `CompactionStrategy` 插件接口（只有一种 auto 策略，套接口属过早抽象）。决策继续是纯函数，插件接口推迟到第二个 auto 策略真正出现时与之共同设计。

---

## 核心判断

ohbaby 的压缩**决策**早已是分离的纯函数（`decideCompactAction` / `findCutPoint` / `getContextUsage`），per-step 与 overflow recovery 也已落地。对照 kimi `CompactionStrategy`，ohbaby 真正缺的不是"策略接口"这个抽象，而是三个**具体行为**：

1. 阶梯不连贯——mask 阈值（投影层）与 prune/summary 阈值（编排层）分散在两层 config，会漂移。
2. **无反抖动锁**——per-step 下，大会话可能每步都叫 LLM 摘要却只省一点点（昂贵抖动）。
3. **无每轮压缩次数上限**——单 turn 多步 tool loop 内可能压缩多次，无封顶。

---

## 关键设计决策（讨论已定）

- **D1：不建 `CompactionStrategy` 插件接口/类层级**。决策保持纯函数；插件化推迟到第二个 auto 策略出现时共同设计（与 origin ADR 同一"反过早抽象"原则）。
- **D2：升级阶梯归一**。把"哪个 usage 触发哪一级"收到一个 policy（扩展 `decideCompactionRung` 返回档位 `none | mask | prune-summary | force`），不散在投影层/编排层两处。prune-summary 阈值从 0.85 提升到 **0.95**——充分利用 context window，overflow force 兜底估算误差（[G9](../gaps-and-decisions.md#g9prune-summary-阈值-085--095)）。同时采用 F7-A 小硬地板：`remainingInputTokens < 4096` 也进入 prune-summary 档，保持 KISS，不引入额外策略层。
- **D3：补反抖动锁**。连续若干次压缩省的 token 低于阈值则锁定，直到 usage 显著变化或用户重置。
- **D4：补每轮压缩次数上限**（`MAX_COMPACTION_PER_TURN`，默认 2）。计数器放 ContextManager，lifecycle 在 turn 开始时调 `resetTurnCompactionCount()`（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。
- **D5：路线图 2.4（compress 暴露给模型）定位为"触发入口"**，内部复用 `compact(force)` + D3 反抖动；本轮至多预留入口，工具实现归后续。
- **D6（缺口评审新增）：不设预防性 force**。阶梯为三档（`mask → prune-summary → overflow force`），`force` 仅由 overflow error 触发（lifecycle 传入 `force=true`），不从 usage ratio 推导（[G10](../gaps-and-decisions.md#g10去除-095-预防性-force)）。
- **D7（缺口评审新增）：三种触发源的计数行为**。自动 per-step 受限且递增；overflow force 穿透但递增；用户手动 `/compact` 不参与计数（走独立入口）（[G4](../gaps-and-decisions.md#g4每轮压缩计数归属)）。

---

## 本目录文档

| 文档 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 现状对照 kimi Strategy + 三个真实缺口 + 反过早抽象论证 |
| [02-implementation-plan.md](./02-implementation-plan.md) | 升级阶梯 policy + 反抖动锁 + 每轮上限 + 影响代码点 |
| [03-acceptance-and-testing.md](./03-acceptance-and-testing.md) | 验收口径与测试标准（含抖动场景、上限、阶梯档位） |
