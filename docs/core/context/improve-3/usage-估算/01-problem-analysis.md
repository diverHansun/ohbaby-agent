# usage 估算重构 · 现有问题分析

> 分析日期：2026-06-25
> 对象：`token-estimation.ts`（`estimateContextTokens`）+ `context-manager.ts`（`estimateAssembledTokens` / `markCompactedParts` / `removeTokenUsageMetadata`）+ `serialization.ts`（`serializeHistory` / `serializeMessage`）
> 框架：learn-swe-before-implement 审阅模式
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G12

---

## 零、核心判断

ohbaby 的 token 估算当前用**锚点机制**——找最近一条带 `tokenUsage` 元数据的消息当锚点，`estimate = anchor.tokens（快照）+ heuristic（锚点之后尾部）`。这在"历史不可变"的假设下工作良好，但 improve-3 的 mask/prune/summary 就是在改历史。

锚点机制有三个结构性问题，它们恰好卡在"token 估算 ↔ context 管理"的耦合点上。

---

## 一、问题 1：锚点看不见 mask（G12 核心）

### 1.1 锚点机制的工作原理

`token-estimation.ts:17-36`：

```
1. findLatestSummaryIndex(history)     ← 找最近的 summary 消息
2. findLatestUsageAnchor(history, latestSummaryIndex)
   ← 从后往前找第一条带 tokenUsage 元数据的消息（通常是上一次 assistant 轮）
3. 若有锚点：
     estimate = anchor.tokens（写死的数，API 返回的 promptTokens）
              + heuristic(锚点之后的消息)
   若无锚点：
     estimate = heuristic(全部历史)
```

锚点是一个**快照数字**——它记录的是"那次 API 调用时，发送集总共多少 token"。锚点之前的所有消息，不管内容是什么、有没有被改过，只贡献这一个数。

### 1.2 为什么 mask 看不见

mask 削的是"保护窗口外的旧工具输出"——这些几乎必然在锚点之前（锚点是最近的 assistant 轮，很新）。

```
时间线：  [old] ──────────────── [anchor] ── [tail] ── [new]
mask 削：  ↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑↑     ← 全在锚点之前
锚点贡献： anchor.tokens（快照，不变）
尾部贡献： heuristic(tail)（不变）

→ mask 把旧工具输出换成占位符 → maskedHistory 变小
→ 但 estimateContextTokens(maskedHistory) 走锚点分支
→ 锚点之前的消息只贡献 anchor.tokens
→ mask 的削减完全不可见 → usage 数字不下降
```

### 1.3 打穿 improve-3 的后果

- **G1 失效**："usage = mask 后实际发送量"——锚点在，不成立。
- **G7 失效**：验收测试"mask 开启 → usage 降到阈值以下 → 不触发 prune-summary"——用当前估算器跑，会失败。
- **G9 放大**：0.95 阈值顶部余量更薄，"看不见 mask"在 0.95 线附近后果更严重。

---

## 二、问题 2：system + memory 双计

### 2.1 机制

`context-manager.ts:315-326`：

```ts
function estimateAssembledTokens(systemPrompt, memory, history) {
  return tokenCount(systemPrompt + memory.merged)    // ← 量一次 system+memory
    + estimateContextTokens(history).tokens;          // ← 锚点的 totalTokens 已含 system+memory
}
```

锚点的 `totalTokens` = API 返回的 `promptTokens`——API 发送时包含了 system + memory + history。所以：

```
estimateAssembledTokens = tokenCount(systemPrompt + memory)
                        + anchor.tokens（已含 system+memory）
                        + heuristic(tail)
= system+memory 被算了两次 + history 尾部
```

### 2.2 影响

system + memory 通常占几千到一两万 token。双计会让 usage 系统性偏高，导致压缩过早触发（在 0.95 阈值下尤其敏感）。

---

## 三、问题 3：估算器反向耦合 context 管理

### 3.1 机制

`context-manager.ts:264-301` 的 `markCompactedParts` 在 prune 时调 `removeTokenUsageMetadata`：

```ts
function markCompactedParts(history, compactedPartIds, compactedAt) {
  return history.map((message) => ({
    info: message.info,
    parts: message.parts.map((part) => {
      if (compactedPartIds.has(part.id)) {
        return { ...part, time: { ...part.time, compacted: compactedAt } };
      }
      const metadata = removeTokenUsageMetadata(part.metadata);  // ← 清元数据
      return metadata === undefined ? part : { ...part, metadata };
    }),
  }));
}
```

为什么要清？因为如果不清，prune 后旧锚点的 `tokenUsage` 还在，`findLatestUsageAnchor` 会找到它，但它记录的 token 数已不反映当前工作集（被 prune 了）。

### 3.2 这是"意外耦合"

估算器在**参与 context 管理的内部状态管理**——它不是纯测量，而是反向依赖 context 管理的突变。这是 references/02 "耦合"的反例：估算器应该只认"给我什么工作集"，不应该知道"context 管理做了什么操作"。

`findLatestSummaryIndex`（`token-estimation.ts:62-73`）同理——估算器在扫 summary 边界，这是 context 管理的概念。

---

## 四、三个方案对比

| 方案 | 做法 | mask 可见? | 精度 | 与 context 管理的耦合 | 评价 |
|------|------|-----------|------|---------------------|------|
| ① 锚点 + 削减 delta | 保留锚点，mask/prune/summary 各自上报削了多少，从锚点里减 | 可见（要记账） | 最高 | 更紧（估算要知道每个操作的 delta） | delta 不好算——mask 削的原输出在锚点模式下没被单独量过 |
| ② 纯启发式 | 丢掉锚点，直接 char 估当前工作集 | 天然可见 | 0.95 线偏险（CJK/代码差 10–20%） | 松 | 精度不够，0.95 阈值不可信 |
| **③ 启发式 + 标定因子** | `estimate = heuristic(工作集) × factor`，factor 用上轮真实数纠偏 | 天然可见 | 高（真实数纠偏） | 松（只认"工作集"一个值） | **推荐** |

### 方案 ③ 详解

```
factor = 上轮 API 真实 promptTokens / heuristic(上轮发送集)
本轮 estimate = heuristic(本轮工作集) × factor
```

**一招解四件事**：

1. **mask 天然可见**：每轮重量当前（mask 后）工作集，占位符是小 ASCII，heuristic 直接反映。
2. **保住精度**：factor 吸收 char 权重偏差、信封/JSON 开销、tokenizer 差异——0.95 线可信。
3. **双计消失**：只量一次真实工作集（含 system+memory），不再"锚点已含 + 又加一遍"。
4. **解耦**：估算器只认"工作集"这一个值，不再扫 summary 边界、不再参与 prune 清元数据。

**代价**：factor 是全局标量，假设"heuristic 的相对偏差在一次会话内稳定"。会话内容风格剧烈切换（纯散文 → 大段代码）时偏差有二阶波动。但比锚点的"前缀必须不可变"假设健壮得多，且 overflow force（G10）兜底。首轮无真实数时 factor=1.0，此时上下文小，无所谓。

---

## 五、两个需求共用一个估算机制

用户的两个需求本质是同一个 `currentTokens` 的两种投影：

| 需求 | 关心什么 | 分子 | 分母 | 偏置 |
|------|---------|------|------|------|
| 压缩控制 | "还剩多少输入预算？该不该压？" | currentTokens | inputBudgetTokens（扣除输出预留） | 允许略高估，偏保守 |
| UI 显示 | "窗口用了百分之多少？" | currentTokens | contextWindowTokens（整个窗口） | 如实反映 |

两者**分子相同**（同一个 `currentTokens`），**分母不同**。所以估算机制只有一个，消费方式两个——与 message store 的"模型投影 / UI 投影"两条兄弟投影是同一架构思想。

---

## 六、风险与边界

| 项 | 说明 |
|----|------|
| factor 二阶波动 | 会话内容风格剧烈切换时偏差有二阶波动；overflow force 兜底；首轮 factor=1.0 无所谓 |
| factor 首轮 | 无真实数时 factor=1.0，此时上下文小，heuristic 偏差不影响压缩决策 |
| `removeTokenUsageMetadata` 删除 | 需确认 tokenUsage 元数据是否还被别处（如 per-message UI）消费；若有消费方则保留元数据但估算器不再依赖它 |
| 不做 | 本轮不改 heuristic 算法本身（char-to-token 比率），只改"如何用 heuristic 的结果" |
| 与编排层关系 | 依赖编排层 `runCompaction` 产出的工作集；建议编排层去三重先落地 |
