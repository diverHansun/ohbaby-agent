# 1. 后端现状：占用计量与 cache 通道

> 时间口径：2026-08-26，分析 `main` 上 improve-4～5 与联合回归之后的代码。本文只诊断，不写目标方案。

## 1.1 问题陈述

1. **总量准，组成不可见。** `measureUsage` 把 `messages + tools` 估成一个 `currentTokens`，UI 只能说「窗口用了多少」，不能说「被谁占了」。
2. **分桶所需的 source 在测量前被剥掉。** `LifecycleDeps.resolveTools` 当前直接返回 flattened OpenAI tools；`toOpenAiTools` 把 `ToolDefinition.source` 丢掉，最终 `PreparedModelRequest.tools` 无法区分 builtin / mcp / skill。
3. **cache 事实停在 provider/lifecycle。** `InputTokenBreakdown` 已规范化，没有产品级 hit-rate helper，也没有进 SDK / `/status`。
4. **两条知识混用会出错。** 占用是 prepare 时的启发式校准；命中率是模型返回后的 provider 记账。当前 UI 只接了前者。

## 1.2 已确认分界（引用 00）

```text
AssembledContext + ResolvedStepTools（definitions + requestTools）
        → 七类启发式 composition
        → 校准后总量（现有 ContextUsage）
        → PreparedTurn / context:prepared（composition 与 usage 分离）
        → UiContextWindowUsage（optional composition）
                ↘ Web 小环 / click / `/status` 详细占用（无 cache）
                ↘ TUI footer / `/status`（本轮 total-only）

LifecycleTokenUsage.inputBreakdown（下一轮）
        → 独立 cache 通道（session aggregate）
        → Web / TUI `/status` Cache 行（`Cache hit —` ≠ 0%）
```

主代理才进用户占用 UI。子代理 scope 继续内部计量。

## 1.3 Context / LLM / Commands 现状

### 1.3.1 goals-duty

文档说 Context 负责请求投影、计量、压缩，以及 primary UI occupancy；cached input 仍占窗口；不把 UI tracker 当 child 精确源（`docs/core/context/goals-duty.md` G2、D 非职责、L117）。这不排除统计已经写入父请求的 subagent call/result；排除的是 child 自身窗口与内部 transcript。

代码：`context-window-usage.ts` 只投影总量；没有 composition 职责实现。Cache 归一化在 `services/interface-providers/token-usage.ts`，Context **正确**不解析 vendor 字段。Gap：goals 要求「可解释占用」，实现只有总量。

### 1.3.2 architecture

`architecture.md` L68、L155–161 登记 `context-window-usage.ts` 为 primary UI projection，事件 best-effort。文件布局仍是单一 tracker，没有 composition 或 cache 投影单元。

依赖方向健康：Context 不依赖 Web/TUI；adapter 把 `ContextUsage` 映到 SDK。本批应保持该方向，不要让 Context 去解析 `prompt_cache_hit_tokens`。

可逆：给 SDK 加 optional 字段是双向门。把 cache 塞进占用总量语义则是单向门——00 已禁止。

### 1.3.3 data-model

| 类型 | 位置 | 现状 |
|------|------|------|
| `PreparedModelRequest` | `context/types.ts` L89–92 | `{ messages, tools }`，tools 无 source；这是实际发送快照 |
| `ContextUsage` | `types.ts` L94–103 | 校准后总量；无 buckets |
| `PreparedTurn` | `types.ts` L192–200 | 携带 request、usage、compaction；当前无解释性 composition |
| `UiContextWindowUsage` | `ohbaby-sdk/src/context-window.ts` L1–7 | `currentTokens / contextWindowTokens / contextWindowRatio` |
| `LifecycleDeps.resolveTools` | `lifecycle/types.ts` L28–33 | 只返回 OpenAI tools，没有 definitions/requestTools 的一致快照 |
| `ToolSource` | `tool-scheduler/types.ts` L22 | `"builtin" \| "module" \| "skill" \| "mcp"` |
| `ToolDefinition` | 同文件 L123–129 | 含 `source` |
| `ToolPart.tool` | `message/types.ts` L96–102 | 可识别 `subagent_*` / `skill` |
| `MessageOrigin` / model-context metadata | `message/origin.ts` L3–35 | 已能识别 summary 与 `model-context:runtime:v1`，但尚未用于占用分桶 |
| `InputTokenBreakdown` | `interface-providers/types.ts` L40–48 | uncached/cacheRead/cacheWrite + observed |
| `LifecycleTokenUsage` | `lifecycle/types.ts` L243–249 | run 聚合；可带 breakdown、`usageComplete` |

同名不同义风险：`usageRatio`（压缩，input budget 分母）vs `contextWindowRatio`（UI，完整 window 分母）。improve-3 已区分；本批不得把 composition 绑到压缩 ratio。

`module`：生产无登记，仅测试夹具。

### 1.3.4 dfd-interface

当前占用流：

```text
serializeForLlm (serializer.ts L50–74)
  → assembleModelRequest (context-manager.ts L429–451)
  → estimatePreparedRequestHeuristic (token-estimation.ts L3–13)  // 一个数
  → measureUsage 乘 calibration (context-manager.ts L453–477)
  → ContextUsage
  → contextUsageToContextWindowUsage (context-window-usage.ts L24–41)
  → publish context.window.updated
       主路径：run-stream-adapter.ts handleContextWindowUsage L506–525，在 run.context.prepared L583–586
       compact 路径：ui-inprocess.ts ~L1769
  → snapshot.contextWindowUsages / TUI store
```

Cache 流在另一条河：provider normalize → `TokenUsage` → lifecycle aggregate。**没有**汇入 tracker 或 `/status`。

两类现有 provenance 已经足够支持本轮拆分，不需要新增持久字段：`isSummaryMessage` 将 summary 包成 `<context_summary>`；`isModelContextPart` 标记 Ohbaby 生成的 runtime environment/MCP 菜单。后者物理上仍在 initiating user message，但归因不能等同于 `role: "user"`。

`/status`：`commands/builtin.ts` `handleStatus` L237–267 取 `contextWindow` 总量，`countTools` L135–164 只计 **工具个数** 不是 token。

### 1.3.5 use-case

| 用户要做的 | 现在 |
|------------|------|
| 看窗口被谁占满 | 不能；只有 used/window |
| 区分 MCP schema vs 内置 schema | 不能；source 已丢 |
| 区分普通对话 vs 压缩摘要 | 不能；虽然已有 summary 元数据，计量仍是一个总数 |
| 看到子代理父窗口交互占了多少 | 不能；`subagent_*` call/result 混在 messages 总启发式里 |
| 看 cache 命中 | 不能；`/status` 无此行 |
| 子代理自己的窗口 | 正确：不进 primary tracker |

### 1.3.6 non-functional

- 启发式仍是现有 `TokenCounter.estimateTokens`（字符密度），不是精确 tokenizer。分类之和不必等于总量。
- cache 命中若把「未 observed」显示成 0%，会误导计费/前缀稳定性判断（improve-5 已冻结，UI 尚未遵守因为 UI 不存在）。
- 分桶会增加纯内存启发式计算；应复用现有 `TokenCounter`，不新增 tokenizer 或远程计数依赖。

### 1.3.7 test

已有：`context-window-usage.unit.test.ts` 锁 UI 分母是 **context window** 不是 input budget；`context-window.contract.test.ts` 锁 SDK 只有总量字段；`token-usage.unit.test.ts` 内联 `cacheRead/inputTokens`（L43–45），**无导出 helper**。

缺口：无 composition 不变量（七类非负、summary/runtime/subagent 边界、skill 目录不进 conversation、module 并入 builtin）；无 `/status` cache `—` vs 0%（下一轮）；无「definitions 与实际 request tools 来自同一步快照」的回归。

## 1.4 跨模块一致性

| 边界 | 衔接 | gap |
|------|------|-----|
| Context ↔ Lifecycle | 同一 `PreparedModelRequest` 测量与发送 | resolver 只返回 flattened tools，测量时没有与之配对的 `ToolDefinition[]` |
| Context ↔ UI adapter | `ContextUsage` → tracker → event | 事件形状无 composition |
| Lifecycle ↔ `/status` | 无 | cache 不经过 commands |
| Context Non-Duty「不解析 MCP registry」 | 仍成立 | 分桶应消费调用方已带 source 的定义，不回头查 registry |

## 1.5 改动影响面（现状视角）

- `packages/ohbaby-agent/src/core/context/`：启发式分桶、tracker 映射
- `packages/ohbaby-agent/src/core/lifecycle/` / `adapters/ui-runtime/composition.ts`：建立 step-local definitions/requestTools 快照
- `packages/ohbaby-sdk/`：占用类型、（下一轮）cache 类型、snapshot/event
- `packages/ohbaby-agent/src/commands/builtin.ts`：`/status` payload
- adapter 推送路径（run-stream-adapter、ui-inprocess compact）
- 权威文档：`architecture.md`、`data-model.md`、`goals-duty.md`；过时的 `docs/ui/components/status-bar.md`

## 1.6 SWE 原则审视摘要

- **关注点分离**：占用组成 vs cache 记账必须两套结构（00 哲学：知识单一表示，不是字面 DRY）。
- **YAGNI**：不在 Context 内建 tokenizer；不把 module 做成第八类；不把 runtime prompt 拆成 typed contribution。
- **DIP**：Context 继续依赖 `TokenCounter` 与调用方提供的 definitions，不依赖 MCP SDK。
- **高内聚/低耦合**：`ContextUsage` 继续只表达控制语义；composition 作为 `PreparedTurn`/事件的兄弟字段，不反向污染压缩策略。
- **显式依赖**：一个窄 `ResolvedStepTools` 同时携带 definitions 与 wire schemas，比两条平行参数或事后 registry 反查更不易漂移；其生命期只到当前 step，不引入服务/缓存。
- **现状债**：`estimatePreparedRequestHeuristic` 把整份 request 捏成一个 string（偶然复杂度）；分桶是把同一启发式按已有 role/source/tool 名切开，不是新算法。

## 1.7 与既有文档关系

| 文档 | 文档说 | 代码做 | gap |
|------|--------|--------|-----|
| `goals-duty.md` | UI occupancy；cache hit ≠ 释放窗口 | 总量 tracker；composition 与 cache 都未投影 | 本批只补 occupancy composition；cache `/status` 投影下一轮 |
| `architecture.md` | primary 只消费 `UiContextWindowUsage` | 是 | 需补充 composition 字段，child 仍 unavailable |
| `data-model.md` ~L103–109 | occupancy 含 cache read；breakdown 在 provider | ContextUsage 无 buckets | 组成是新派生，不是改 inclusive 语义 |
| improve-4 00 | 后续 KISS 三类 + `~` | 未做 UI | 本批扩为七类英文 key，`~` 保留 |
| improve-5 | cache breakdown + observed | provider/lifecycle 已有，UI 无 | 下一轮补 `/status` cache 通道；本批不动 |
| `docs/ui/components/status-bar.md` | `UiContextUsage` / `useRuntime()` | 现码是 `UiContextWindowUsage` | **文档过时**，实施时同步 |
