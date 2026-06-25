# context improve-3 · usage 估算重构（锚点 → 标定）

> 本轮目标：把 token 估算从"锚点快照 + 尾部启发式"改为"启发式 × 标定因子"，一招解决四个问题——mask 天然可见、双计消失、0.95 线精度可信、估算器与 context 管理解耦。
>
> 这是 G1/G7/G9 的前提修复——不修这个，improve-3 的 mask 经济性验证（G7）、usage = mask 后实际发送量（G1）、0.95 阈值精度（G9）都不成立。
>
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G12。

---

## 核心判断

ohbaby 的 token 估算当前用**锚点机制**（`token-estimation.ts`）：找最近一条带 `tokenUsage` 元数据的消息当锚点，`estimate = anchor.tokens（快照）+ heuristic（锚点之后尾部）`。这在"历史不可变"的假设下工作良好，但 improve-3 的 mask/prune/summary 就是在改历史——锚点假设被打破。

锚点机制有三个结构性问题（[G12](../gaps-and-decisions.md#g12锚点估算器看不见-mask--改标定式估算)）：

1. **看不见 mask**：mask 削的旧内容落在锚点之前，只贡献 `anchor.tokens` 快照数，削减不可见。
2. **system + memory 双计**：锚点 `totalTokens` 已含 system+memory，`estimateAssembledTokens` 又量一遍。
3. **反向耦合 context 管理**：估算器在 prune 时调 `removeTokenUsageMetadata` 清元数据，参与 context 管理的内部状态。

---

## 关键设计决策（讨论已定）

- **D1：方案 ③ —— 启发式 + 标定因子**。`estimate = heuristic(wire 载荷) × factor`，`factor = EMA(realPromptTokens / sentHeuristic)`。
- **D2：factor 每次 API 响应都更新**——每次都是真实数据，都能纠偏。首轮无真实数时 factor=1.0。
- **D3：factor 状态按 sessionId 存**，仿 G4（状态在 ContextManager，lifecycle 喂真实数）。内存态，不写库。
- **D4：压缩控制与 UI 显示共用一个估算、双投影**。同一个 `currentTokens`，两个分母：`controlRatio = usedInput / inputBudgetTokens`（压缩控制）、`displayRatio = currentTokens / contextWindowTokens`（UI 显示）。
- **D5：估算器只认"wire 载荷"这一个值**——单向值传递，不扫 summary 边界、不参与 prune 清元数据。`removeTokenUsageMetadata` 那一摊在确认无其他消费方后删除。
- **D6（评审修正 F1+F2）：`sentHeuristic` 随 `PreparedTurn` 带出，heuristic 量 wire 载荷**。prepareTurn 末尾算好 heuristic 存进 `PreparedTurn.sentHeuristic`，lifecycle 直接用——不重新派生、不二次序列化。heuristic 量 `ChatCompletionMessage[]`（wire 载荷）而非 `serializeHistory`（domain 纯文本），mask/whitelist/reasoning 注入全部自动计入。
- **D7（评审修正 F3）：`shouldCompress` 退休**。budget 分支的 `shouldCompress = remainingInputTokens < COMPACTION_RESERVE_TOKENS` 从未用过 0.95 阈值，与 `decideCompactionRung` 打架。`shouldCompress` 字段/方法从 `ContextUsage`/`ContextManager`/`events.ts` 移除，控制信号单一真相 = `decideCompactionRung` 基于 `usageRatio` 对 `thresholds.summary`。
- **D8（评审修正 F5）：factor 用 EMA + 夹值**。`factor = α·new + (1−α)·old`（α=0.5），夹值 [0.5, 3.0]。压单轮异常，防退化发送集算出病态比例。
- **D9（评审修正 F8）：heuristic 数整条消息**。`estimateWireHeuristic` 用 `JSON.stringify(m)` 把整条消息（含 `tool_calls`）算进去，不只数正文——否则工具调用轮被严重低估、factor 抖。
- **D10（评审修正 F7）：撤硬地板后的近上限保护采用 A**。`shouldCompress` 退休带走了 16384 token 的硬地板，大窗口在 0.95 触发点只剩 ~9500 余量、和估算误差同量级。采用 KISS 小硬地板：`remainingInputTokens < 4096` 也进入 prune-summary 档；不引入额外策略层。小窗口模型行为变化需回归。
- **D11（评审修正 F9）：占用率测量收口成单一入口**。新增 `measureUsage`（序列化 → heuristic → ×factor → getContextUsage），所有测量都走它，factor 只乘一次，杜绝调用点漏乘。

---

## 本目录文档

| 文档 | 内容 |
|------|------|
| [01-problem-analysis.md](./01-problem-analysis.md) | 锚点机制三个结构性问题 + 估算器与 context 管理的耦合分析 + 三个方案对比 |
| [02-implementation-plan.md](./02-implementation-plan.md) | 标定式估算实现 + factor 存储/更新 + 双投影 + 契约 + 影响代码点 |
| [03-acceptance-and-testing.md](./03-acceptance-and-testing.md) | 验收口径与测试标准（含 mask 可见性、双计修复、factor 收敛、双投影） |
