# 4. 测试与验收标准

项目无独立 `test-blueprint`。沿用现有 vitest 布局：`*.unit.test.ts` / `*.contract.test.ts` / 相关 integration。

本批只验任务 A（实时 Lifecycle 计量）和任务 B（自动压缩过程态）。三类占用 UI **无验收项**（不做就不测）；但要用边界测试防止任务 A 顺手改变 `getContextUsage` / 手动 compact 的 messages-only 行为。

---

## 4.1 测试范围

| 层 | 覆盖 |
|----|------|
| 单测 | `estimateWireHeuristic` 含 tools；所有重测路径保留 tools；`onCompactionStarted` 仅在实际自动 compact 档位确定后、prune 前调用；纯 prune/summary 调用，`none/mask` 不调用 |
| 单测（回归） | `getContextUsage` / 手动 compact 不触发工具解析且仍为 messages-only；`noticeFromCompactResult` 成功静默；校准 EMA 仍用 `sentHeuristic`；总量格式 `38K / 1M (4%)` 仍能渲染 |
| 集成 | Lifecycle：resolveTools 在 prepareTurn 之前；final step tools 为空时 sentHeuristic 不含 schema；自动压缩时 `context:compacting` 出现在 `context:prepared` 之前（含普通路径与 overflow `force` 路径） |
| 合同 | `run.context.compacting` 映射存在；`UiContextWindowUsage` **仍无** breakdown 字段 |
| 手工 | TUI/Web 总量条仍在、数字在有 tools 的会话里应合理上升；自动压缩时 spinner 变成 `Compacting...`，对话区不新增摘要消息；占用条布局不变 |

本批不新增 provider cache 测试；cache usage、启用和统计由独立 improve-5 定义验收标准。

---

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 |
|----|------|------|--------|---------|
| TC-1 | 同一 messages，有 tools vs 无 tools | 单测 | 有 tools 时 heuristic 与 `currentTokens` 更大；tools 变化而 messages 不变则占用变 | 任务 A / P1 |
| TC-8 | 最后一步 maxSteps | 集成 | 发送 tools=[] 与测量 tools=[] 一致，避免末步 factor 被空 schema 污染 | 任务 A / P1 |
| TC-4 | 成功 prune/compact | 单测+回归 | **不**发 compact warning/info notice；占用 tracker 更新为压缩后**总量** | 任务 B / P2 |
| TC-5 | 失败/inflated compact | 单测 | 仍发 warning；文案不含误导性 token 箭头（保持现契约） | 任务 B / P2 |
| TC-9 | Bus 仍发布、UI 不订阅 | 单测 | manager 测试仍能收到 ContextEvent；生产 adapter 不 import subscribe ContextEvent | 任务 B / P2 |
| TC-10 | compact 过程态 | 单测+集成+UI 合同 | 手动 `/compact` 仍显示 `Compacting...`；自动压缩：实际档位确定后、首次 prune mutation 前 Lifecycle 已 `yield context:compacting`；纯 prune 与 summary 各只开始一次，`none/mask` 不误报，overflow force 同样触发；worker 发出 `run.context.compacting`；`context:prepared` 清回普通 running，run 终态兜底；UI 只改运行状态标题；**transcript 不新增**摘要模型消息；**不**发成功 notice | 任务 B / P2 |
| TC-11 | 静态查询/手动 compact 的本批边界 | 单测+合同 | `composition.getContextUsage`、`compactSession` 不调用 `resolveTools`，公开参数不增加 agent/step/tools；其 usage 保持 messages-only。文档明确这只是粗估，并登记为占用监测/UI 的实施前置 | 任务 A / P1 |

未编号、**本批不做**：原 TC-6/TC-7（breakdown 字段与三类展示）。后续占用 UI 批次再立。

---

## 4.3 集成边界

- **Lifecycle ↔ ContextManager**：`prepareTurn` 的 tools 必须与随后 `streamChatCompletion` 的 tools 同一引用/同一序列化结果。
- **Composition ↔ ContextManager（静态/手动）**：`getContextUsage` 与手动 `compactSession` 本批不获得动态 tools；不得用任务 A 的实时契约推断它们也已精确。
- **Lifecycle ↔ UI（过程事件）**：`context:compacting` 必须在整个实际自动 compact 尚未完成时到达前端，包括纯 prune。实现必须在 generator **函数体**里 yield（`Promise.race` 或拆步）；不得在 `onCompactionStarted` 回调里 `yield`。
- **Provider ↔ 校准**：保持 improve-3 的现有 usage 契约；本批只确保 heuristic 分母包含实际发送的 tools。
- **SDK ↔ TUI/Web**：占用对象仍是总量；展示层不依赖不存在的 `breakdown`。

---

## 4.4 回归清单

- improve-3：mask 默认仍不替换占位符。
- 压缩阈值仍 0.95 / remaining<4096 / overflow force。
- `sentHeuristic` 仍随 `PreparedTurn` 带出，Lifecycle **不**对 messages 重新 heuristic。
- 成功 compact 默认不 notice（`prompt-context.unit.test.ts`）。
- 手动 `/compact` 的 `Compacting...` spinner 仍在。
- `getContextUsage` / 手动 compact 仍不解析 tools、不扩 agent/step/tools 参数；其粗估限制有文档说明。
- 占用条仍是总量格式，无三类行。
- Memory 仍只读注入；subagent 仍不 load memory；无 memory hooks。
- SQLite schema 无强制 migration。

---

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 计量含 tools | 有 schema 的一步，占用总量 > 仅 messages | TC-1 + 一次真实会话看 TUI 总量是否合理上升 |
| 计量边界未膨胀 | 只修实时 Lifecycle；静态查询/手动 compact 保持 messages-only，且后续前置事项已记录 | TC-11 + API diff |
| 无双通道 UI | adapter 不订阅 `ContextEvent` | rg + TC-9 |
| 成功无 notice | 成功 compact 不出现 `context:compact:` warning/info | TC-4 |
| 过程 spinner | 手动保持 `Compacting...`；自动压缩从 prune 前开始切到同一标题，正常/终态均清理，transcript 无摘要消息 | TC-10 |
| 占用条未扩成三类 | SDK/`usage.ts` 无 breakdown；TUI 仍一行总量 | rg + 手工 |
| 算法未分叉 | `estimateTokens` 仍指向 `estimateTokensForText` | 读 composition 注入 |
| 记忆未膨胀 | 无 `memory_*` 工具、无 compact/memory hooks | rg |

发布门命令（实施时以仓库脚本为准）：相关包 `vitest` 以及现有 `context` / `lifecycle` / `interface-providers` / TUI spinner 测试全绿。**不要求**新增 sdk breakdown contract。

任务 A 与 B 分别验收、可独立回滚；本次按 A → B 实施。任务 A 要求 TC-1、TC-8、TC-11 绿；任务 B 要求 TC-4、TC-5、TC-9、TC-10 绿。

---

## 4.6 对抗性审查要点

1. **末步清空 tools 却用了上步 factor。** 防御：测量与发送同一 `tools`（TC-8）。残余：factor 仍跨 step 共享，工具集剧变时有一阶滞后——可接受，overflow force 兜底。
2. **顺手加入 cache 字段或更改 provider usage。** 禁止。已移到 improve-5，避免未确认语义进入本批。
3. **本批顺手加三类 breakdown「反正量都量了」。** 禁止。00/02 已收口；没有 UI 契约就不要加死字段。
4. **给 Bus 再接 UI「更实时」。** 禁止。会与 `context:prepared` 双写。
5. **把 compact 摘要 LLM 写成对话消息。** 禁止。污染历史且可能再被压缩。过程态只走 spinner。
6. **以为 `onCompactionStarted` 回调里可以直接 yield。** 禁止。测的是「`context:compacting` 先于 `context:prepared` 出现」，不是回调签名本身；同 tick 完成也不能丢事件。
9. **把开始点放到 `generateSummary` 前。** 禁止。那会漏掉纯 prune；开始点必须在实际档位确定后、prune 前，`none/mask` 不发。
7. **把记忆 hooks 塞进 compact 前后。** 禁止。方向 4 另批。
8. **为了“全局一致”让静态查询或手动 compact 临时 resolveTools。** 禁止。它们缺少真实 step 上下文，可能产生副作用或测到错误工具集；先保留明确粗估，在占用监测/UI 批次建立完整输入契约。
