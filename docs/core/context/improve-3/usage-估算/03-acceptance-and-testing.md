# usage 估算重构 · 验收和测试标准

> 验收基于真实代码与真实测试输出。遵循模块级测试规范 `docs/core/context/test.md`。
> 本轮含三部分：标定式估算（行为变更）+ 双计修复（行为变更）+ mask 可见性（G7 前提修复）。
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G12

---

## AC-0 文档完整性

- `docs/core/context/improve-3/usage-估算/` 下 `README.md` 与三篇齐备。
- 文档明确：锚点→标定式估算；mask 天然可见；双计消失；压缩控制与 UI 显示共用一个估算、双投影。

---

## AC-1 标定式估算（行为变更）

**目标**：`currentTokens = estimateWireHeuristic(wire 载荷) × factor`，factor=1.0 时等价于纯 heuristic。

**判定**：

- `estimateWireHeuristic(messages, tokenCounter)` 存在且可独立单测——它**不含 factor**，只负责数 wire 载荷的字数。
- factor 在外面单独乘（统一在 `measureUsage` 里，见 AC-14），不混进 `estimateWireHeuristic`。
- factor=1.0 时，`currentTokens = estimateWireHeuristic(messages)`（纯 char 估算）。
- factor=1.2 时，`currentTokens = Math.round(estimateWireHeuristic(messages) × 1.2)`。
- 首轮（无 API 响应历史）factor=1.0。

**建议测试**：
```ts
const h = estimateWireHeuristic(messages, tokenCounter);  // 不含 factor
// factor 默认 1.0，等价纯 heuristic
expect(measureUsage({ messages, sessionId, modelId }).usage.currentTokens).toBe(h);
// factor 纠偏
setCalibrationFactor(sessionId, 1.2);
expect(measureUsage({ messages, sessionId, modelId }).usage.currentTokens).toBe(Math.round(h * 1.2));
```

---

## AC-2 双计修复

**目标**：system + memory 只量一次，不再"锚点已含 + 又加一遍"。

**判定**：

- `estimateAssembledTokens` 的结果 **低于** 重构前（有锚点时，少了重复的 system+memory）——characterization 测试需更新断言。
- **F6 限定场景**：`after ≈ before − tokenCount(system + memory)` 只在**有锚点**时成立（双计只发生在有锚点时）。无锚点 fixture 上 `after ≈ before`（纯 heuristic 量 wire 载荷，无双计）——断言要限定场景，否则误红。

**建议测试**：
```ts
// 有锚点的 fixture：双计消除
const before = oldEstimateAssembledTokens(system, memory, historyWithAnchor);  // 含双计
const after = newEstimateAssembledTokens(system, memory, historyWithAnchor);   // 单计
expect(after).toBeLessThan(before);
expect(after).toBeApproximately(before - tokenCount(system + memory));

// 无锚点的 fixture：无双计，after ≈ before
const beforeNoAnchor = oldEstimateAssembledTokens(system, memory, historyNoAnchor);
const afterNoAnchor = newEstimateAssembledTokens(system, memory, historyNoAnchor);
expect(afterNoAnchor).toBeApproximately(beforeNoAnchor);  // 无双计可消除
```

---

## AC-3 mask 可见性（G7 前提修复）

**目标**：mask 开启后，usage 数字下降——标定式估算天然反映 mask 削减。

**判定**：

- 构造会话：含大量旧工具输出，usage 接近 0.95。
- mask 关闭：`getContextUsage` 返回 `usageRatio ≈ 0.95`。
- mask 开启（`maskEnabled=true`）：`getContextUsage` 返回 `usageRatio < 0.95`（占位符比原输出小，heuristic 直接反映）。
- **断言：mask 开启时 usage 下降**——这是 G7 验收测试的前提。

**建议测试**：
```ts
const historyWithLargeToolOutputs = buildHistory(/* 大量旧工具输出 */);
// 渲染成实际发给模型的 wire 载荷（mask 开 / 关两版）
const maskedMessages = renderForModel(reduceForModel(historyWithLargeToolOutputs, cutoff, { enabled: true }));
const unmaskedMessages = renderForModel(reduceForModel(historyWithLargeToolOutputs, cutoff, { enabled: false }));

const masked = measureUsage({ messages: maskedMessages, sessionId, modelId });
const unmasked = measureUsage({ messages: unmaskedMessages, sessionId, modelId });

expect(masked.usage.currentTokens).toBeLessThan(unmasked.usage.currentTokens);
```

---

## AC-4 factor EMA 稳态（F5 修正）

**目标**：factor 在稳定输入下达到 EMA 稳态，单轮异常被半衰。

**判定**：

- mock API 返回 `promptTokens = 100000`，`sentHeuristic = 80000` → 新观测 = 1.25。
  - 首次（old=1.0）：`factor = 0.5×1.25 + 0.5×1.0 = 1.125`。
  - 第二次（old=1.125，类似内容）：`factor = 0.5×1.25 + 0.5×1.125 = 1.1875`。
  - 多次后收敛到 ≈1.25（EMA 稳态）。
- **单轮异常被半衰**：某轮 `sentHeuristic` 异常小（near-empty），observed = 10.0 → 夹值到 3.0 → `factor = 0.5×3.0 + 0.5×1.25 = 2.125`（不是 3.0）→ 下一轮恢复正常后继续半衰回 1.25。
- **夹值生效**：observed < 0.5 → factor 用 0.5；observed > 3.0 → factor 用 3.0。
- **断言：稳定输入下 factor 趋近真实比率（EMA 稳态），单轮异常不整体带偏**（不是 last-write-wins）。

**建议测试**：
```ts
// EMA 稳态
updateCalibrationFactor(sessionId, 100000, 80000);  // observed=1.25, factor=1.125
updateCalibrationFactor(sessionId, 120000, 96000);  // observed≈1.25, factor≈1.1875
updateCalibrationFactor(sessionId, 100000, 80000);  // observed=1.25, factor≈1.21875
// 多次后趋近 1.25
// 单轮异常
updateCalibrationFactor(sessionId, 100000, 1000);   // observed=100, 夹值到3.0, factor=0.5*3+0.5*1.25=2.125
expect(getCalibrationFactor(sessionId)).toBeLessThan(3.0);  // 不是 3.0，EMA 半衰了
```

---

## AC-5 factor 更新时机

**目标**：每次 API 响应都更新 factor，用 `prepared.sentHeuristic` 不重新派生（F1）。

**判定**：

- lifecycle 在 API 响应后调 `contextManager.updateCalibrationFactor(sessionId, response.usage.promptTokens, prepared.sentHeuristic)`。
- **F1**：`prepared.sentHeuristic` 是 prepareTurn 末尾算好的值，lifecycle 不重新序列化、不重新派生。
- prepareTurn 内部不更新 factor（避免估算自激）。
- factor 为内存态，不写库：

```bash
rg -n "calibrationFactor|updateCalibrationFactor" packages/ohbaby-agent/src/core/context
# 期望：仅 context-manager.ts + lifecycle.ts 引用，不涉及 database-store
```

---

## AC-6 双投影

**目标**：压缩控制与 UI 显示共用一个 `currentTokens`，分母不同。

**判定**：

- `getContextUsage` 返回的 `usageRatio`（压缩控制用）基于 `inputBudgetTokens`。
- `contextUsageToContextWindowUsage`（UI 显示用）基于 `contextWindowTokens`。
- 两者分子相同（`currentTokens`）。
- **F4 修正**：同一 `currentTokens` 下，`displayRatio <= usageRatio`——因为 `contextWindowTokens > inputBudgetTokens`（后者扣了输出预留 + 安全边际），分母越大比率越小。
- 即"压缩在 0.95（对 inputBudget）触发时，UI 显示约 0.91（对 contextWindow）"——这是预期，不是"状态栏说谎"。

---

## AC-7 `shouldCompress` 退休（F3）

**目标**：`shouldCompress` 字段/方法从 `ContextUsage`/`ContextManager`/`events.ts` 移除，控制信号由 `decideCompactionRung` 统一决策。

**判定**：

```bash
rg -n "shouldCompress" packages/ohbaby-agent/src/core/context/types.ts packages/ohbaby-agent/src/core/context/events.ts
# 期望：无匹配（字段/方法已删除）
rg -n "shouldCompress" packages/ohbaby-agent/src/core/context/context-manager.ts
# 期望：无匹配（闸门逻辑改由 decideCompactionRung 接管）
```

- `ContextUsage` 不再有 `shouldCompress` 字段。
- `ContextManager` 接口不再有 `shouldCompress` 方法。
- `events.ts` Zod schema 不再有 `shouldCompress`。
- 所有原消费方改用 `decideCompactionRung` 基于 `usageRatio` 对 `thresholds.summary` 判断。
- 测试中 mock `ContextUsage` 不再包含 `shouldCompress` 字段。

---

## AC-8 `sentHeuristic` 随 PreparedTurn 带出（F1）

**目标**：`PreparedTurn` 携带 `sentHeuristic`，lifecycle 不重新派生。

**判定**：

- `PreparedTurn` 接口包含 `sentHeuristic: number`。
- `prepareTurn` 末尾在产出 `messages` 后计算 `sentHeuristic = estimateWireHeuristic(messages)`。
- lifecycle 调 `updateCalibrationFactor(sessionId, realPromptTokens, prepared.sentHeuristic)`——直接用 prepared 带出的值。
- **F1**：lifecycle 不调 `serializeForLlm` / `serializeHistory` / 任何重新序列化——不重新派生。

```bash
rg -n "sentHeuristic" packages/ohbaby-agent/src/core/context/types.ts
# 期望：PreparedTurn 含 sentHeuristic 字段
rg -n "updateCalibrationFactor" packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts
# 期望：调用处用 prepared.sentHeuristic，不重新序列化
```

---

## AC-9 `removeTokenUsageMetadata` 处理

**目标**：标定式估算不再依赖 `tokenUsage` 元数据。

**判定**：

```bash
# 确认 tokenUsage 元数据的消费方
rg -n "tokenUsage" packages/ohbaby-agent/src --glob '!**/*.test.*'
```

- 若无其他消费方：`removeTokenUsageMetadata` 已删除，`markCompactedParts` 不再调它。
- 若有其他消费方：元数据保留，但 `token-estimation.ts` 不再读 `tokenUsage`（`findLatestUsageAnchor` / `readTokenUsage` 已删）。

```bash
rg -n "findLatestUsageAnchor|readTokenUsage" packages/ohbaby-agent/src/core/context
# 期望：无匹配（已删除）
```

---

## AC-10 估算器解耦

**目标**：估算器只认"wire 载荷"这一个值，不再扫 summary 边界、不参与 prune 清元数据。

**判定**：

```bash
rg -n "findLatestSummaryIndex|isSummaryMessage" packages/ohbaby-agent/src/core/context/token-estimation.ts
# 期望：无匹配（估算器不再扫 summary 边界）
```

- `token-estimation.ts` 不 import `summary.ts`。
- `token-estimation.ts` 不 import `filters.ts`（不再依赖 `isActivePart`）。

---

## AC-11 架构边界

```bash
rg -n "from .*runtime|from .*adapters|from .*agents" packages/ohbaby-agent/src/core/context
rg -n "TODO|NotImplemented|throw new Error\(\"not implemented" packages/ohbaby-agent/src/core/context
```

- `core/context` 不新增跨层依赖；factor 内存态不写库。

---

## AC-12 heuristic 数整条消息（F8）

**目标**：`estimateWireHeuristic` 把**整条消息**算进去，不只是正文——模型调用工具那一坨（`tool_calls`）也要计入。

**问题点**：工具调用轮的 token 大头在 `tool_calls`（工具名 + 参数），而正文 `content` 常为空。只数正文会让工具轮严重低估；又因每轮工具调用密度不同，导致 factor 忽高忽低。

**判定**：

- 构造一条**只有工具调用、`content` 为 null** 的 assistant 消息。
- `estimateWireHeuristic([该消息])` 的结果应**显著大于 0**（数进了 `tool_calls` 的字数），不是约等于 0。
- 反例对照："只数 content"的旧写法对这条消息约等于 0——用来确认新写法确实把工具调用算进去了。

**建议测试**：
```ts
const toolCallMsg = {
  role: "assistant",
  content: null,
  tool_calls: [{ id: "x", type: "function",
    function: { name: "read_file", arguments: '{"path":"/a/very/long/path/with/many/chars.ts"}' } }],
};
const tokens = estimateWireHeuristic([toolCallMsg], tokenCounter);
expect(tokens).toBeGreaterThan(20);  // tool_calls 被计入，不是 ~0
```

---

## AC-13 近上限安全垫（F7）

**目标**：撤掉硬性 reserve（16384）后，近上限仍有防"估算误差冲过上限"的保护。

**问题点**：`shouldCompress` 退休带走了"剩余不足 16384 就强制压"的硬地板；改成纯比例（0.95）后，大窗口在触发点只剩约 9500 token 余量，和 ±10% 估算误差同量级——某轮估少了就可能冲过上限。

**判定（F7-A，见 02 §二）**：

- 构造"比例没到 0.95、但剩余输入预算 < 4096"的会话 → 仍触发压缩。断言：此时控制决策返回压缩档，不是 none。
- overflow force 仍保留终极兜底，但不是常规近上限体验的唯一保护。
- **小窗口回归**：4k/8k 模型在新逻辑下不会压得过晚——构造接近上限的小窗口会话，验证仍能触发压缩。

---

## AC-14 单一测量入口（F9）

**目标**：占用率测量收口成**一个**函数 `measureUsage`，校正系数只在一处乘。

**问题点**：`getContextUsage` 改成直接收 `currentTokens` 后，每个调用点都要自己先算"字数 × factor"。`context-manager.ts` 里有八九处，只要一处漏乘 factor，同一轮的占用率就自相矛盾。

**判定**：

- 存在唯一入口 `measureUsage`（序列化 → `estimateWireHeuristic` → ×factor → `getContextUsage`），返回 `{ usage, sentHeuristic }`——`sentHeuristic` 供 prepareTurn 带进 `PreparedTurn`（F1），不必别处重新数。
- `context-manager.ts` 里所有占用率测量都走 `measureUsage`，没有任何地方单独手算 `heuristic × factor` 再调 `getContextUsage`。

```bash
rg -n "getContextUsage\(" packages/ohbaby-agent/src/core/context/context-manager.ts
# 期望：仅 measureUsage 内部调用 getContextUsage；其他地方都调 measureUsage
rg -n "getCalibrationFactor" packages/ohbaby-agent/src/core/context/context-manager.ts
# 期望：factor 只在 measureUsage 内出现一次
```

---

## AC-15 回归测试矩阵

```bash
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/core/context/context-window-usage.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts --testTimeout=300000
pnpm test
```

真实 provider 下需额外人工验证：多轮会话中 factor 收敛后，估算值与 API 真实 `promptTokens` 偏差 < 10%（按 `ohbaby-e2e-test.md` 本地配置，不提交密钥）。
