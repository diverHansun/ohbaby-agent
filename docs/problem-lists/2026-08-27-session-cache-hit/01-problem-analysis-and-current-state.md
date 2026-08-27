# 1. 问题基线与当前实施状态

> 时间口径：2026-08-27，`main` `5774fe4`。improve-5 usage 归一化与 improve-6 占用 UI 已在代码中。本文只诊断，不写目标方案。

## 1.1 问题陈述

1. **命中事实有了，产品数字没有。** Provider 能给出 `inputBreakdown`，Lifecycle 能按 run 合成 `LifecycleTokenUsage`，但没有任何 session 级 Cache-Read Share，仓库内零命中 `cacheReadShare` / `Cache hit`。
2. **`/status` 只有占用。** `handleStatus` 只拉 `contextWindow`。Web 还用单测锁死卡片不含 `Cache`。用户要看命中率，现在没有出口。
3. **两套账如果挂错模块会再缠一次。** 占用 tracker 住在 Context；cache 是模型返回后的记账。Context Non-Duties 已禁止解析 vendor cache。llm-client 是单次流式层，禁止管 session 统计。灰色地带就是「没人拥有 session 桶」。
4. **子代理 usage 会污染主会话观感。** 子代理走同一条 Lifecycle/usage 链，只是 `isSubagent` / 独立 `sessionId` 不同。若按 session 一把梭或在 llm-client 里见 usage 就加，会把另一套前缀混进用户看到的百分比。
5. **缺字段若当 0%，会撒谎。** improve-5 用 `observed` 区分「报了 0」和「没报」。UI 若不存在，这条不变量还没有产品层消费者。
6. **累计 token 与累计比例需要分名。** `cacheReadTokens` 是历史可信 cache-read token 数量；`cacheReadShare` 是先跨 run 累加 token、再除以累计可记账输入得到的 session 比例。若命名成 `totalInputTokens` 或按 run 百分比求平均，会误导为全量输入或单轮 hit rate。

## 1.2 已确认分界（引用 00）

```text
adapter normalizeTokenUsage
  → TokenUsage.inputBreakdown + observed
  → Lifecycle.aggregateTokenUsage（仅 purpose=agent-step 的 run）
        ↘ 主代理 run 完成 → session 桶（本批缺口）
        ↘ 子代理 run 完成 → 不进用户 /status
  → /status.promptCacheUsage → Cache hit {n}% | —
占用通道（已有，本批不动）：
  ContextUsage + composition → UiContextWindowUsage → 环 / 七类
```

同一进程内，compact、换模型之后累计继续；进程重启归零。累计的是该 session 历次主代理请求的 provider usage，不是当前上下文窗口尚存 token 的库存。

---

## 1.3 providers / llm-client 现状

### 1.3.1 goals-duty

`docs/core/llm-client/goals-duty.md`：向上提供流式入口，**仅透传精确 usage**；不做 token 估算或预算决策；不管 session。`prompt-cache.ts` 的职责是**请求策略**（key / `cache_control`），不是命中率。

代码与文档一致。Gap 不在 llm-client 内部，而在「透传之后谁记账」。

### 1.3.2 architecture

llm-client 位于 config → providers → lifecycle。它不知道 `isSubagent` 作为产品过滤条件（请求里虽有 `contextScopeId`，那是 cache **identity**，不是 `/status` 过滤）。把 session Map 放进 `streamChatCompletion` 会让执行层变成产品统计库，依赖方向反了。

可逆：本批不改 llm-client 公开 API。不可逆风险：若把 session 桶塞进 client，以后 occupancy/cache/计费都会继续往这里堆。

### 1.3.3 data-model

| 类型 | 位置 | 现状 |
|------|------|------|
| `InputTokenBreakdown` | `services/interface-providers/types.ts` L40–48 | `uncached/cacheRead/cacheWrite` + `observed.cacheRead/cacheWrite` |
| `InterfaceProviderTokenUsage` | 同文件 L50–55 | inclusive `inputTokens` + optional breakdown |
| `LLMRequestPurpose` | 同文件 L8–11 | `agent-step \| context-summary \| session-title` |
| 归一化 | `token-usage.ts` `breakdown()` L60+ | 冲突时报 diagnostic；**无** Cache-Read Share helper |

`promptCache` 在请求侧是策略对象；配置里是 `auto \| enabled \| disabled`。`/status` 已确认使用 `promptCacheUsage`，避免同名不同义。

### 1.3.4 dfd-interface / test

数据流：原生 usage → `normalizeTokenUsage` → stream 事件 → llm-client 累积 → Lifecycle。improve-5 单测锁住 observed 语义。**没有**「缺 observed → 命中率 null」的产品 helper 测试，因为 helper 不存在。

use-case / non-functional：对本层不适用到「session `/status`」；llm-client 没有会话寿命。

---

## 1.4 lifecycle / run-manager 现状

### 1.4.1 goals-duty

Lifecycle D4 维护执行中的 Token 统计；N6 **不负责 Session 生命周期**。run 级 `LifecycleTokenUsage` 属于执行结果，session 级产品桶不是循环引擎的既有职责，但 **RunManager 完成点是唯一同时看见 `usage` + `isSubagent` 且能保证恰好一次的稳定切口**。它应只调用窄完成回调，不直接依赖 cache tracker。

### 1.4.2 architecture / data-model

| 符号 | 位置 | 现状 |
|------|------|------|
| `aggregateTokenUsage` | `core/lifecycle/token-usage.ts` L41–67 | 同 run 多 step 相加；任一步缺 breakdown 则整 run 丢掉 breakdown；`next===undefined` → `usageComplete=false` |
| `usage = aggregateTokenUsage(...)` | `lifecycle.ts` L608 | 只聚合本 run 的 model step |
| `purpose: "agent-step"` | `lifecycle.ts` L915–919 | compact summary / title **不**走这条 `streamChatCompletion` |
| `LifecycleTokenUsage` | `lifecycle/types.ts` L248–254 | 含 optional `inputBreakdown`、`usageComplete` |
| `RunCompletion.usage` | `runtime/run-manager/types.ts` L62–68 | 从 `LifecycleResult.usage` 透传 |
| `completionFromResult` | `run-manager/manager.ts` L62–79 | 成功/失败都带上 usage，**没有 session 折入** |
| abort 覆盖 | `run-manager/manager.ts` L248–253 | worker 已返回后若 signal aborted，会重建 cancelled outcome 并丢掉原 `result.usage`；若产品要求“已报告的可信 usage 仍累计”，本批必须窄修 |
| `isSubagent` | `CreateRunOptions` L37；`worker.ts` L263–265 | 已传到 `lifecycle.run`，累加器尚未读 |

`token-usage.unit.test.ts` 覆盖 step 聚合与 observed AND，不覆盖跨 run、主/子过滤、Share 公式，也没有锁住“取消发生在完整 usage 返回之后仍保留 usage”。

### 1.4.3 use-case

辅助请求隔离已有集成证据：`adapters/ui-runtime/auxiliary-token-usage-isolation.integration.test.ts` L214–225，title/summary 的 usage 不进入 `result.usage`。本批若在 llm-client 见请求就加，会把这条已经修好的边界打穿。

compact 发生在 `prepareTurn` 内，不经过 run 的 agent-step 聚合，因此 **compact 本身不会改 `LifecycleTokenUsage`**。产品要求「compact 后累计仍在」——当前连累计都没有，这是缺口而不是错误清桶。换模型同样没有 cache 桶可清。

### 1.4.4 non-functional / test

run 聚合是同步纯函数，无 IO。真实 provider cache 仍是 improve-5 opt-in smoke，与本批产品投影无关。Gap：没有「主代理两 run 相加」「子代理 run 不加」测试，因为没有被测对象。

---

## 1.5 commands / SDK / UI adapter 现状

### 1.5.1 commands

`handleStatus`（`commands/builtin.ts` L237–266）并行拉取 models/tools/mcp/`getContextWindowUsage`，payload **没有** cache 字段。`CommandServiceOptions`（`commands/types.ts` L205–207）只有 `getContextWindowUsage`。`/status` 不依赖用户是否开过占用环——占用走 tracker；cache 连 tracker 都没有，开不开面板都得不到命中率。

### 1.5.2 occupancy tracker（对照，不是 cache）

`createContextWindowUsageTracker`（`core/context/context-window-usage.ts` L48–83）按 `sessionId` 存占用。`getContextWindowUsageInternal`（`ui-inprocess.ts` L1778–1807）对 `coreSession.isSubagent === true` 返回 `null`。tracker 在 `ui-inprocess.ts` L412–413 创建。Cache 应对齐「子代理不展示」，但 **不应** 复用该对象或塞进 `UiContextWindowUsage`（improve-6 已禁止）。

`connectModelInternal`（`ui-inprocess.ts` L2262–2263）会 `resetRuntime()` 并清 occupancy tracker；`resetRuntime()`（`adapters/ui-inprocess/runtime-controller.ts` L93–104）销毁当前 `UiRuntimeComposition`。因此 cache tracker 若在 runtime composition 内创建，会违反「换模型不清」：它必须由 `createInProcessUiBackendClient` 外层持有，再把同一个窄回调注入每次新建的 RunManager。

现有 `SessionEvent.Removed` 清理订阅位于 `adapters/ui-runtime/composition.ts` L646–683，会随 composition 销毁；而 `archiveSessionInternal`（`ui-inprocess.ts` L1494–1518）直接归档并移除 UI session，不发布该事件。外层 cache tracker 因此需要自己订阅同一个 bus，并在 archive 成功路径直接清目标桶；不能假设 composition 的旧订阅会替它清理。

### 1.5.3 SDK

`ohbaby-sdk/src/context-window.ts` 只有占用 + optional composition。`index.ts` 不导出 cache usage 类型。snapshot / `UiContextWindowUpdatedEvent` 也不带 cache。本批若误加进占用事件，会把两套账推成一条 SSE。

### 1.5.4 Web

`statusRows`（`apps/ohbaby-web/src/ui/slashCommands.ts` L159–205）标签为 session / model / context / connection / …，无 cache。`StatusCommandResult`（`App.tsx` L1643–1668）仅在 context 行有 composition 时换成七类块。`App.unit.test.tsx` L1777：`expect(contextRow?.textContent).not.toContain("Cache")` —— 当前把「整张 status 里出现 Cache」当成占用块失败；仓库里没有独立 cache 行可测。

### 1.5.5 TUI

`renderStatusPanel`（`ohbaby-cli/src/tui/render/status-panel.ts` L16–47）在 Model 之后画 Context，然后 Tools。单测 L54–57 锁总量行、锁不出现七类英文名，**没有** Cache 行。底栏 `formatContextWindowUsage` 与本批无关。

---

## 1.6 跨模块一致性

| 边界 | 现状 | 风险 |
|------|------|------|
| Context ↔ cache | 文档禁止混用；代码 occupancy 已独立 | 若把 `promptCacheUsage` 塞进 `UiContextWindowUsage`，会违反 00 与 goals-duty |
| llm-client ↔ session | usage 透传正确 | 在 client 累加会混 title/summary，并无法稳妥过滤子代理 |
| Lifecycle run ↔ RunManager | usage 已出现在 `RunCompletion` | 折入点已在，缺调用 |
| 主占用 UI ↔ 子代理 | 占用 get 对 child 返回 null | cache 必须同等过滤，否则 `/status` 在子会话上会撒谎或显示 `—` 被当成「该子代理没命中」 |
| 配置 `promptCache` ↔ `/status.promptCacheUsage` | 命名已分开 | 实施时若退回 `promptCache` 会让读配置的人误以为 `/status` 在控制缓存 |
| runtime reset ↔ session 累计 | 换模型会销毁 composition | tracker 若创建在 composition 内会意外归零，必须外置到 `ui-inprocess` 生命周期 |

文档 vs 实现：

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| improve-6：下一轮 `/status` Cache 行 | 无字段、无文案 | 本批 |
| improve-5：缺 observed 不得显示 0% | 归一化正确，无 UI 消费者 | 本批 helper + UI |
| context architecture：命中率留给下一轮 | 占用已投影，cache 无通道 | 权威文档过时 |
| llm-client：不做 session 统计 | 遵守 | 保持 |

## 1.7 改动影响面（现状视角）

将会动到：`adapters/ui-inprocess`（helper + session tracker + 清理订阅）、`runtime/run-manager`（窄完成回调 + 取消时保留已有 usage）、`adapters/ui-runtime`（注入回调）、`commands`（`/status` 读取）、`ohbaby-sdk`（新类型，占用类型不动）、`ohbaby-web` `/status` 卡片、`ohbaby-cli` status panel、context/lifecycle 权威文档中「下一轮」字样。

不会动到：`prompt-cache.ts` 请求策略、`normalizeTokenUsage`、占用 composition、压缩。

无存储迁移。旧 `/status` 消费者看不到新字段应保持可解析。

## 1.8 SWE 原则审视摘要

- **关注点分离（02 受力）**：占用启发式与 cache 记账混在 context 文档树，是偶然复杂度。本批用独立 problem-list 把所有权拉开，是在删关系，不是加层。
- **依赖方向**：数字应从「run 完成的 LifecycleTokenUsage」流向 UI，而不是从 UI 或 llm-client 回流去猜。
- **YAGNI**：不持久化、不推 SSE、不展示 last-step、不按 model 拆桶。换模型不清桶是产品选择，不是预留插件点。
- **可逆**：optional 命令字段与新内存 Map 可整段撤回；把 cache 写进 occupancy 语义或 snapshot 才是一扇门——01 将其标为禁止。
- **信息隐藏**：DTO 暴露可解释的 `accountedInputTokens / cacheReadTokens / cacheReadShare`，面板只消费 share；不完整轮直接跳过，不为当前没有消费者的诊断预存状态。
- **最小抽象**：RunManager 只新增一次同步完成回调，不引入 cache event bus、异步队列或通用指标框架；tracker 留在 UI adapter 边界，不扩大 Lifecycle core 的职责。

## 1.9 与既有文档关系

权威目标态：本目录 00。improve-6 00 §2.4 仍是口径出处，但实施契约以本 02/04 为准。improve-6 02 Phase C、N1–N6、04 §4.7 视为 superseded。llm-client 与 context 的 goals-duty 保持不变，本批对齐它们的 Non-Duties，而不是改写模块使命。
