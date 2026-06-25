# 投影层 · 验收和测试标准

> 验收基于真实代码与真实测试输出。遵循模块级测试规范 `docs/core/context/test.md`，沿用 `manager.unit.test.ts` / `serializer.integration.test.ts` 既有约定。
> 本轮含两部分：投影链显式化（行为保持型）+ mask 新增能力（新行为，默认 dark ship）。
> 缺口评审：详见 [gaps-and-decisions.md](../gaps-and-decisions.md) G1/G2/G3/G5/G6/G7/G11。

---

## AC-0 文档完整性

- `docs/core/context/improve-3/投影层/` 下 `README.md` 与三篇齐备。
- 文档明确：投影/分离实质已存在；本轮收成命名链并新增可逆 mask；mask 与永久 prune 互补不替换。
- 文档明确：mask 默认关闭 + dark ship（[G2](../gaps-and-decisions.md#g2mask-缺-kill-switch)）；豁免清单为黑名单语义（[G5](../gaps-and-decisions.md#g5mask-豁免清单语义)）；mask 只动 ToolPart（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)）。

---

## AC-1 投影链显式化（削减/渲染两半）

**目标**：投影逻辑收成命名链，"发什么给模型"可单文件/单函数理解与测试。

**判定**：

- 存在 `reduceForModel`（削减段，操作 `MessageWithParts[]`）与 `renderForModel`/`serializeForLlm`（渲染段，→ `ChatCompletionMessage[]`）两个可独立单测的入口。
- `prepareTurn` 中：`reduceForModel`（第 1 次）在 `runCompaction` 量 usage **之前**，`reduceForModel`（第 2 次，幂等）在压缩**之后**，渲染段最后（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）。
- 历史 reasoning 仍不回传、活跃 reasoning 仍注入，行为不变。

---

## AC-2 mask off 行为保持（no-op 回归）

**目标**：mask 关闭时（`maskEnabled=false`），投影输出与本轮重构前逐位一致。

**判定**（重构前先固化为 characterization 测试，mask off 时必须全绿）：

- 同一会话历史，mask off 时 `prepareTurn` 返回的 `messages` 与重构前完全一致。
- `usage.currentTokens` 在 mask off 时与重构前一致（usage 改基于削减后工作集，但 no-op 时数值不变）。
- summary→`<context_summary>`、assistant tool_calls 拆分、工具白名单投影输出不变。

**建议命令**：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/core/context/serializer.integration.test.ts packages/ohbaby-agent/src/core/context/manager.unit.test.ts --testTimeout=300000
```

---

## AC-3 mask 触发与豁免

**目标**：mask 按"保护窗口 + 工具类型黑名单豁免 + 批量阈值 + 单调 cutoff + 小结果不遮"正确遮罩。

**判定**：

- 上下文使用率 < `MASK_MIN_USAGE_RATIO`（默认 0.5）时不遮罩。
- 可遮罩总量 < `MASK_MIN_PRUNABLE_TOKENS`（默认 ~20k）时不遮罩（批量阈值）。
- 最近一轮 + 尾部 `MASK_PROTECTION_TOKENS`（默认 ~40k）内的工具结果**不被遮罩**。
- **黑名单豁免**（[G5](../gaps-and-decisions.md#g5mask-豁免清单语义)）：`write`/`edit`/`task`/`skill`/`agent_*` 的结果**即使在窗口外也不遮罩**。
- **默认可遮罩**：未知工具（含 MCP）+ `bash`/`read`/`list`/`glob`/`grep`/`web_search`/`web_fetch` 在窗口外被替换为占位符。
- **小结果不遮**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）：part token < `MASK_MIN_PART_TOKENS`（默认 50）的结果不遮罩。
- **占位符带原大小**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）：`[Old tool result cleared (was ~N tokens)]`。
- 已遮罩的结果不重复遮罩。

---

## AC-4 协议配对完整性

**目标**：mask 后不产生孤儿 tool_call / 缺失 tool result。

**判定**：

- 被遮罩的工具结果，其 `tool_call_id` 与对应 assistant `tool_calls[*].id` 仍一一配对。
- 遮罩后的 `messages` 序列满足 provider 协议（每个 assistant tool_call 有匹配 tool 消息）。
- 占位符消息 `content` 非空（避免空 tool result 触发协议错误）。

**建议测试**：构造"assistant tool_call + 老 tool result"序列，遮罩后断言 tool 消息存在且 content 为占位符。

---

## AC-5 缓存单调性 + cutoff 重置

**目标**：cutoff 单调推进，遮罩边界不回退，避免缓存抖动；prune-summary 后 cutoff 重置。

**判定**：

- 连续多次 `prepareTurn`（历史递增）中，cutoff 只增不减。
- 已遮罩的较早消息不会在后续构建中"恢复原文"（除非显式 reset）。
- **prune-summary 提交后 cutoff 重置为 0**（[G11](../gaps-and-decisions.md#g11借鉴四项目的-mask-设计)）：被摘要的历史已消失，旧 cutoff 指向的位置已无意义。
- cutoff 为内存状态、不写库：

```bash
rg -n "time\.compacted|updatePart" packages/ohbaby-agent/src/core/context/projection.ts
# 期望：mask 路径不写 time.compacted、不调 updatePart
```

---

## AC-6 mask 与 prune 互补（读口径分离）

**目标**：两道防线职责清晰、互不写对方状态、读口径正确分离。

**判定**（[G1](../gaps-and-decisions.md#g1mask-与-prune-的时序交互读口径)）：

- mask 路径只读 active history、维护自身 cutoff，不写 `time.compacted`。
- prune+summary 仍按原逻辑（usage≥0.95）触发并写库；prune 扫描读 **mask 前**历史（`assembled.history`），不被占位符干扰。
- usage 基于 **mask 后**工作集——两个口径对应两个不同问题。
- 同一会话先 mask 后仍超阈值时，能正常进入 prune+summary。
- mask 跑两次幂等：第二次不推进 cutoff，只对 prune/summary 后的 history 重新应用同一 cutoff。

---

## AC-7 mask 只动 ToolPart（[G6](../gaps-and-decisions.md#g6mask-只动-toolpart)）

**目标**：mask 只扫描 ToolPart，其他 part 类型永不扫描。

**判定**：

- `maskOldToolOutputs` 实现中 `if (part.type !== "tool") continue` 明确跳过非 ToolPart。
- `SubtaskPart` / `TextPart` / `ReasoningPart` 在任何情况下都不被遮罩。
- 构造含 SubtaskPart 的会话，验证 SubtaskPart 原样保留。

---

## AC-8 mask 事件 mandatory（[G3](../gaps-and-decisions.md#g3mask-事件-mandatory)）

**目标**：每次 `reduceForModel` 都发 `context.masked` 事件，dark ship 期也发。

**判定**：

- `maskEnabled=false`（dark ship）时仍发事件，`enabled: false`，`maskedPartIds` 填实际会被遮的 part id 全列表。
- `maskEnabled=true` 时发事件，`enabled: true`，`maskedPartIds` 填实际被遮的 part id 全列表。
- 未遮罩任何 part 时仍发事件，`maskedPartIds: []`，`skippedReason` 记录原因。
- 事件 Zod schema 与 `events.ts` 同步。
- `prepareTurn` 正常会在压缩前预算和最终发送前各调用一次投影，因此消费者不应把 `context.masked` 事件条数等同于 turn 数。

```bash
rg -n "context.masked" packages/ohbaby-agent/src/core/context/events.ts
# 期望：存在 ContextEvent.Masked 定义
```

---

## AC-9 kill switch / dark ship（[G2](../gaps-and-decisions.md#g2mask-缺-kill-switch)）

**目标**：`maskEnabled` 默认 false，dark ship 期跑逻辑但不替换占位符。

**判定**：

- `ContextManagerOptions.maskEnabled` 默认 false。
- `maskEnabled=false` 时 `reduceForModel` 返回的 history 与输入逐位一致（不替换占位符）。
- `maskEnabled=false` 时 cutoff 仍推进、统计仍计算、事件仍发出（带 `enabled: false`）。
- `maskEnabled=true` 时占位符替换生效。

---

## AC-10 性能验证（[G7](../gaps-and-decisions.md#g7性能验证缺位)）

**目标**：验证 mask 的经济前提——"便宜地延迟 prune-summary 触发"。

**判定**：

**a) 阈值边缘延迟验证**：
```
构造会话：usage 恰好在 prune-summary 阈值边缘（mask 关闭时会触发）
验证：
  - mask 关闭 → decideCompactionRung 返回 "prune-summary" → 触发
  - mask 开启 → mask 削减后 usage 降到阈值以下 → 返回 "mask" → 不触发
  - 断言：mask 开启时 prune-summary 调用次数 = 0
```

**b) 长会话压缩次数对比**：
```
构造会话：10 步 tool loop，每步产生大量工具输出
场景 1：mask 关闭，统计 prune-summary 触发次数 N₁
场景 2：mask 开启，统计 prune-summary 触发次数 N₂
断言：N₂ < N₁（mask 开启时压缩次数更少）
```

---

## AC-11 架构边界

```bash
rg -n "from .*runtime|from .*adapters|from .*agents" packages/ohbaby-agent/src/core/context
rg -n "TODO|NotImplemented|throw new Error\(\"not implemented" packages/ohbaby-agent/src/core/context
```

- 不引入 origin、压缩多策略框架、cutoff 持久化。
- 不改白名单投影（`tool-metadata-projection.ts`）。

---

## AC-12 回归测试矩阵

```bash
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages/ohbaby-agent/src/core/context/manager.unit.test.ts packages/ohbaby-agent/src/core/context/serializer.integration.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts --testTimeout=300000
pnpm test
```

真实 provider 下需额外人工验证：长 tool 链会话中，遮罩生效后 prefix cache 命中率不因 mask 抖动（按 `ohbaby-e2e-test.md` 本地配置，不提交密钥）。
