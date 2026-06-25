# 投影层 · 实施和优化方案

> 实施边界：把投影逻辑收成一条命名链，新增"工具结果可逆遮罩"阶段；保留并复用现有白名单投影；不改 `compact`/`prepareTurn` 对外签名。
> 前置：建议在编排层去三重（improve-3/编排层/）落地后推进。决策见 [README.md](./README.md) D1–D9。
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G1/G2/G3/G5/G6/G7/G11。

---

## 一、投影层拆为"削减"与"渲染"两半

关键约束：mask 要"摘要前先削以降低摘要频率"，就必须影响"是否触发压缩"的 usage 测量。因此投影链不是简单地在压缩之后，而是拆成两段，夹住编排层。

> **缺口评审修正（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）**：prune 读 mask 前历史（"档案里可回收多少"），usage 读 mask 后历史（"实际发给模型多少"）。mask 跑两次幂等——第一次在 runCompaction 前（影响 usage），第二次在 runCompaction 后（对 prune/summary 后的 history 重新应用同一 cutoff，cutoff 单调不推进）。

```
assemble → active history (S1 选择 + S2 排序，已有)
   │
   ├── 【削减段·第 1 次】reduceForModel(history, cutoffState, maskConfig) → maskedHistory
   │      └─ maskOldToolOutputs（新增, 路线图 2.2, 可逆, 不写库）
   │
   ├── usageBefore = getContextUsage(maskedHistory)           【基于 mask 后】
   ├── runCompaction(assembled, usageBefore, ...)              【prune 扫描 assembled.history = mask 前】
   │      └─ projectedHistory（prune/summary 后的工作集）
   │
   ├── 【削减段·第 2 次】reduceForModel(projectedHistory, cutoffState, maskConfig) → finalHistory
   │      └─ 幂等：cutoff 不推进，只对 projectedHistory 重新应用同一 cutoff
   │
   └── 【渲染段】renderForModel(finalHistory, opts) → ChatCompletionMessage[]
          ├─ 历史 reasoning 不回传 / 活跃 reasoning 注入（已有, 显式化）
          ├─ summary → <context_summary>（已有）
          ├─ assistant → tool_calls 拆分（已有）
          └─ 工具结果 + 白名单投影（已有, 复用 tool-metadata-projection.ts）
```

- **削减段**操作 domain 类型 `MessageWithParts[]`，是 mask 的家；它在压缩门限**之前**，使 usage 基于遮罩后的工作集。
- **渲染段**是终端适配，落到 wire 格式 `ChatCompletionMessage[]`，在压缩**之后**。
- 两段都是纯函数（除 cutoff 游标读写），可独立单测。
- mask 跑两次但幂等：cutoff 单调，第二次不推进，开销是纯函数遍历，可忽略。

> 接缝：削减段输入是 `AssembledContext.history`；编排层 `runCompaction` 的 `projectedHistory` 进第二次削减段。三者同为 `MessageWithParts[]`，天然咬合。

---

## 二、mask 阶段设计（maskOldToolOutputs）

### 2.1 kill switch + dark ship（[G2](../gaps-and-decisions.md#g2mask-缺-kill-switch)）

```
maskEnabled: boolean  // 默认 false
```

- `maskEnabled=false`（dark ship）：mask 逻辑仍然跑——算 cutoff、算可遮罩量、产出 `maskedPartIds` 统计 + 发 `context.masked` 事件，但**不替换占位符**，history 原样返回。
- `maskEnabled=true`：执行占位符替换。
- 翻开关条件：dark ship 数据显示"mask 本会延迟 ≥1 次 prune-summary"且无异常。

### 2.2 算法（混合"保护窗口 + 全局聚合 + 批量触发 + 单调 cutoff"）

参照 gemini `ToolOutputMaskingService` 的反向扫描、kimi `MicroCompaction` 的单调 cutoff、oh-my-pi 的小结果不遮 + 占位符带原大小：

```
输入: history(active), cutoffState(session 内单调), config
1. 若上下文使用率 < MASK_MIN_USAGE_RATIO(默认 0.5) → 直接返回，发事件(skippedReason: below-threshold)
2. 反向扫描，跳过保护窗口:
     - 始终豁免：最近一轮(protectLatestTurn) + 尾部 MASK_PROTECTION_TOKENS(默认 ~40k)
3. 保护窗口外，聚合可遮罩的 ToolPart（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)：只动 ToolPart，其他 part 永不扫描）:
     - 豁免工具(黑名单): write/edit(不可逆变更) / task/skill(不可重建) / agent_*(前缀匹配)
     - 默认可遮罩: 未知工具(含 MCP) + bash/read/list/glob/grep/web_search/web_fetch 等
       ([G5](../gaps-and-decisions.md#g5mask-豁免清单语义)：黑名单语义，未知工具默认可遮罩)
     - 已遮罩的跳过
     - 小结果不遮: part token < MASK_MIN_PART_TOKENS(默认 50) → 跳过
       ([G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)：借鉴 oh-my-pi，占位符本身约 20 token，遮小结果反而变大)
4. 仅当可遮罩总量 ≥ MASK_MIN_PRUNABLE_TOKENS(默认 ~20k) 才触发(批量阈值)
     → 否则发事件(skippedReason: below-batch)
5. 计算 nextCutoff = max(cutoffState, 本次可遮罩消息的最大 `message.info.time.created`)，用 created-time boundary 表示"创建时间不晚于 cutoff 的候选可遮罩"，单调推进；因此 reset 为 0 时表示无历史进入遮罩范围。低于 usage/batch 门槛时只保留已有 cutoff 的遮罩效果，不继续推进边界。
6. 对 cutoff 之前、可遮罩的 ToolPart，用占位符替换其输出内容:
     '[Old tool result cleared (was ~N tokens)]'
     ([G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)：借鉴 oh-my-pi，带原大小让模型判断丢了多少信息)
   保留 tool_call / tool result 配对结构(协议安全)
   → 若 maskEnabled=false，不替换，只记录统计 + 发事件
7. 发 context.masked 事件（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)：mandatory，全列表）
```

阈值复用现有常量精神（`PRUNE_PROTECT_TOKENS=40k` / `PRUNE_MINIMUM_TOKENS=20k`），新增 mask 专属可配置项放 `constants.ts`。

> **不加"缓存冷才触发"条件**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）：claude-code/kimi 有"距上次 assistant > 60min 才触发"的条件（Anthropic prefix cache TTL 1h）。ohbaby 的 cutoff 单调推进已防抖动，不绑定特定 provider 的缓存策略，KISS。

### 2.3 cutoff 游标

- 类型：`Map<sessionId, number>` 或随 session 生命周期的内存状态，值为 created-time boundary，单调（只增）。
- **不写库**；跨进程恢复重置为 0，按 usage 重探测。
- 与编排层永久 prune 的 `time.compacted` **互不写对方状态**：mask 只读 active history、维护自己的 cutoff；prune 仍按原逻辑写 `time.compacted`。
- **prune-summary 提交后 cutoff 重置为 0**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)：借鉴 kimi `microCompaction.reset()`）——被摘要的历史已消失，旧 cutoff 指向的位置已无意义，归零重新开始。

### 2.4 mask 事件（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)：mandatory）

```ts
export interface ContextMaskedEvent {
  readonly type: "context.masked";
  readonly sessionId: string;
  readonly enabled: boolean;                     // false=dark ship, true=实际替换中
  readonly maskedPartIds: readonly string[];    // 全列表，诊断时需知道具体遮了哪个 part
  readonly maskedTokens: number;
  readonly cutoff: number;
  readonly usageRatio: number;
  readonly skippedReason?: "below-threshold" | "below-batch" | "all-exempt";
}
```

- 每次 `reduceForModel` 调用都发（即使 `enabled=false`、即使最终没遮任何 part——`skippedReason` 记录为什么没遮）。
- Zod schema 同步更新。

### 2.5 与永久 prune 的两道防线关系

| 防线 | 层 | 触发 | 写库 | 可逆 | 读口径 |
|------|----|------|------|------|--------|
| mask（新增） | 投影·削减段 | usage ≥ 0.5 且可遮罩 ≥ 阈值 | 否 | 是 | 读 mask 后历史量 usage |
| prune+summary（现有） | 编排 | usage ≥ 0.95 | 是 | 标记保留 | 扫描 mask 前历史（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)） |

mask 是便宜的第一道（每构建可跑），prune+summary 是永久兜底（mask 削不动时）。两道防线瞄准同一批旧工具输出，但读不同口径——mask 后的（量 usage）、mask 前的（prune 扫描）——各取所需，不互相干扰。

---

## 三、影响的代码点 / 文件位置

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/core/context/projection.ts`（新增） | `reduceForModel`（含 `maskOldToolOutputs`）+ cutoff 游标管理 + `maskEnabled` 开关；导出纯函数便于单测 |
| `packages/ohbaby-agent/src/core/context/serializer.ts` | 归位为"渲染段"：保持 S3/S4 逻辑；显式接收"已削减历史"，不再隐式承担选择/排序 |
| `packages/ohbaby-agent/src/core/context/context-manager.ts` | `prepareTurn` 在 `runCompaction` 量 usage **之前**插入 `reduceForModel`（第 1 次）；usage 基于削减后工作集；`runCompaction` 后 `reduceForModel`（第 2 次，幂等）；末尾 `renderForModel` |
| `packages/ohbaby-agent/src/core/context/constants.ts` | 新增 mask 配置：`MASK_PROTECTION_TOKENS` / `MASK_MIN_PRUNABLE_TOKENS` / `MASK_MIN_USAGE_RATIO` / `MASK_MIN_PART_TOKENS` / `MASK_PLACEHOLDER` / `MASK_EXEMPT_TOOLS`（黑名单）|
| `packages/ohbaby-agent/src/core/context/types.ts` | `ContextManagerOptions` 新增 `maskEnabled?: boolean`（默认 false）+ `maskConfig?`；新增 `ContextMaskedEvent` 类型 |
| `packages/ohbaby-agent/src/core/context/events.ts` | **新增 `context.masked` 事件**（mandatory，非可选）；同步 Zod schema |
| `packages/ohbaby-agent/src/core/context/tool-metadata-projection.ts` | **不改**，复用白名单 |

**不改**：`filters.ts`、`summary.ts`、`token-estimation.ts`、`file-ops.ts`、`lifecycle.ts`、`composition.ts`。

复用零件：`isActivePart`、`getActiveHistory`、`partitionSummary`、`serializeForLlm`（拆分后归渲染段）、`projectToolMetadataForModel`、token 估算。

---

## 四、建议提交拆分

| 提交 | 内容 |
|------|------|
| 1 | 文档对齐：本目录 README + 三篇 + [gaps-and-decisions.md](../gaps-and-decisions.md) |
| 2 | characterization 测试：固化当前"无 mask"投影输出（messages/usage）作为安全网 |
| 3 | 抽出渲染段：把 serializer 显式化为 `renderForModel(已削减历史)`，行为不变 |
| 4 | 新增削减段骨架 `reduceForModel`（mask 关闭时为 no-op），接入 `prepareTurn`（第 1 次 + 第 2 次幂等），usage 改基于削减后工作集（mask off 时数值不变） |
| 5 | 实现 `maskOldToolOutputs` + 单调 cutoff + 黑名单豁免 + 批量阈值 + 小结果不遮 + 占位符带原大小；`maskEnabled` 默认 false（dark ship）|
| 6 | `context.masked` 事件（mandatory + 全列表 + dark ship 也发）+ Zod schema |
| 7 | 性能验证测试（[G7](../gaps-and-decisions.md#g7性能验证缺位)）：阈值边缘延迟验证 + 长会话压缩次数对比 |

---

## 五、开发护栏

- 先写失败测试再实现（TDD）；先固化无 mask 行为，再开 mask。
- mask 必须维持 tool_call/tool result 配对完整（协议安全）。
- cutoff 必须单调，禁止回退（缓存稳定性）；prune-summary 提交后重置为 0。
- mask 只动 ToolPart，其他 part 永不扫描（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)）。
- mask off（`maskEnabled=false`）时，投影输出与重构前逐位一致（no-op 验证）。
- `core/context` 不新增跨层依赖；cutoff 不写库。
- mask 与 prune 互不写对方状态，职责边界清晰；prune 读 mask 前历史（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。
- `context.masked` 事件 mandatory，每次 `reduceForModel` 都发（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)）。
- 修改返回结构/事件时同步核对 `events.ts` 的 Zod schema。
