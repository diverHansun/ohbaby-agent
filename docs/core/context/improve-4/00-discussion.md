# 讨论记录与已确认要点

> 2026-08-20 至 2026-08-21 与用户讨论定稿（含范围收口：本批不含占用三类 UI；任务 A 只修实时 Lifecycle 请求计量；任务 B 的“开始”覆盖完整实际自动 compact）。正式方案见 01–04。

---

## 1. 背景与动机

ohbaby 的 context 压缩（mask → prune → LLM 摘要）已经能跑，improve-3 的标定估算也已落地。讨论后确认：当前请求占用测量遗漏 tool schema；自动压缩过程中前端也听不到「正在压缩」。

Prompt cache、长期记忆（LLM 主动搜 / hooks）和占用三类监测/展示排在本批之后。improve-4 实施拆成任务 A（tool schema 计量）和任务 B（自动压缩过程态）。Prompt cache 另立 `docs/core/context/improve-5/`，不与本批共享实施契约。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 大方向 | improve-4：tool schema 计量 + compaction 过程态；后续：prompt cache、占用监测+UI、长期记忆 |
| 本批落点 | `docs/core/context/improve-4/` |
| 本批 in-scope | tool schema 进入请求占用测量 + 自动压缩后端→前端过程事件 |
| 实施拆分 | 任务 A = Phase 1 tool schema 计量；任务 B = Phase 2 过程态。按 A → B 实施，分别验收/回滚，不再保留依赖待确认项 |
| Token 算法来源 | 继续用 `services/llm-model/tokenCounting.ts` 的启发式；不引入第二套占用算法 |
| 占用测量入口 | 继续 improve-3 F9：`measureUsage` / `measureContext` 为占用数字的单一入口 |
| 工具 schema | 必须进入占用**测量**（让现有总量条和压缩阈值可信），否则校准因子会把这块系统性误差吞掉 |
| 任务 A 的计量边界 | **只修实时 Lifecycle 每一步请求**：测量与发送复用同一份已解析 tools，包括 final step 的 `[]` 与 overflow force retry |
| `getContextUsage` | 本批保持 messages-only 粗估；不为静态查询解析动态 tools，不扩展其公开参数 |
| 手动 compact 估算 | 本批保持 messages-only 粗估；`compactSession` / `ContextManager.compact` 不为工具上下文扩参 |
| 后续前置条件 | 上述两条粗估必须在「context 占用监测与 UI」实施前优化；该事项属于后续占用批次，**不属于 improve-5/cache** |
| 占用三类 UI | **本批不做**。现有总量条保留。后续若做：KISS 三类 + `~`（学 dsh），不在本批加字段 |
| Compaction hooks | **不学 pi**。不新增 `session_before_compact` 一类扩展点 |
| 压缩可观测通道 | 不给 Bus `ContextEvent` 再接一条 UI 订阅。生产通道保持 Lifecycle `context:prepared` → `run.context.prepared` → adapter |
| 成功 compact notice | **不发**。成功只体现为占用数字重算后变化 |
| compact 过程态 | 用 UI spinner（已有 `Compacting...` / `Compacting session`）。开始语义是“已经选择并开始整个实际自动 compact”，不是“摘要模型调用开始”；纯 prune 也必须显示。**不把摘要 LLM 写成一条对话 message** |
| 校准因子写库 | **否**。内存 Map；进程重启后从 1.0 起，随后续 API usage **重新生成**（不是从磁盘同步） |
| Prompt cache | **本批不做**。不新增字段、不启用、不统计命中率/成本、不预测；独立 improve-5 再设计 |
| 存储 | 继续 SQLite，不换 JSONL |
| 精确 tokenizer | 本批不做 |
| Mask | 保持默认关闭；本批不为打开 mask 做产品化 |

---

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 / 后续做 |
|----|-------------------|
| `memory_add` / `query_history` / hooks 召回 | 方向 4，`docs/core/memory` 另开批次 |
| pi compaction hooks | 明确不做 |
| 存储引擎更换 | 不做 |
| Origin taxonomy / compress-as-tool | 仍按 improve-3 推迟 |
| 把 mask 默认打开 | 不做 |
| 校准因子写入 `app_state` / SQLite | 明确不做 |
| 成功 compact 的 info notice / token delta 粘底 notice | 明确不做（与 `docs/problem-lists/compact/05` 一致） |
| 把 compact 摘要模型输出插入 transcript | 明确不做（会污染对话、还可能再被压缩） |
| 占用三类监测 / breakdown 字段 / TUI·Web 分类展示 | **本批不做**（方向 3，后续 context 批次） |
| `getContextUsage` / 手动 compact 的 tools-aware 估算 | **本批不做**。暂留 messages-only；在方向 3 占用监测/UI 实施前先完成 |
| 长期记忆 hooks / 主动工具 | **本批不做**（方向 4，`docs/core/memory`） |
| cache usage 字段、cache policy、命中率/成本统计、命中预测 | **本批不做**（`docs/core/context/improve-5/`） |

---

## 4. 已确认：与关联议题的关系

- improve-3 usage 估算：方案 ③ 标定已实施。本批只补「量什么」中的 tool schemas，不再改 provider usage 语义。
- improve-3 D3「factor 不写库」：**维持**。重启行为见 §2 校准因子行。
- memory improve-1：只读 Loader 仍是当前契约。本批不恢复工具面、不加 hooks；也不为 memory 单列占用分类。
- goals-duty G2 写 85%、代码是 0.95：本批不改阈值，只在 01 记 gap。
- `docs/problem-lists/compact/05`：手动 `/compact` 的 running spinner、成功不粘 notice，本批沿用；自动压缩的 in-progress 信号仍缺，由 02 Phase 2 补。
- 后续占用监测/UI：不能直接把当前静态查询或手动 compact 的 messages-only 数字当成完整窗口占用；实施前必须先补齐它们所需的 agent/step/tools 上下文。此依赖不写入 improve-5，避免把 request occupancy 与 cache accounting 混为一批。

---

## 5. 参考项目

- **dsh**：cache pressure 与命中统计只作为 improve-5 的调研输入；本批不 adopt cache 数据模型。占用三类 breakdown + `~` **留给后续占用 UI 批次**。
- **pi**：压缩边界指针与存储/推理分离可对照理解；**拒绝**其 hooks 和 JSONL 作为本批方案。手动 compact 的 spinner 语义与 ohbaby 已有 `Compacting...` 同构，自动路径应对齐，而不是抄 pi 的 hook。

---

## 6. 校准因子在重启后会发生什么（已确认，不是同步）

不要理解成「重启后从某处 sync 一份旧 factor」。

```
进程启动 / daemon 重启
  → calibrationFactors Map 为空
  → getCalibrationFactor() = 1.0          // 启发式原值，未纠偏
  → 第一次 prepareTurn 按 1.0 估占用、做压缩决策
  → 该步 LLM 返回 usage
  → updateCalibrationFactor(prompt_tokens, sentHeuristic)
  → 之后每步 EMA 更新，直到下次进程退出
```

「生成」= 用本进程内真实 usage 重新标定。

「同步」= 没有。没有跨重启、跨会话写盘。这是有意的：factor 是「这个进程、这次会话风格」的纠偏，不是配置。

首轮 factor=1.0 时上下文通常还小，压缩决策不敏感。这是接受的代价。

---

## 7. 关于「没有生产消费者」（判断修正，已确认）

先前「Bus 无订阅 = 压缩完全没闭环」说得过满。拆开看：

| 通道 | 现状 | 要不要改 |
|------|------|----------|
| Bus `ContextEvent` | 只有单测订阅 | **不**给 UI 再订一份（避免双通道） |
| Lifecycle → 占用总量 | `context:prepared.usage` 已更新 tracker | 成功闭环靠现有总量条；任务 A 补上 tool schema。本批不加三类 UI |
| 失败 notice | `failed` / inflated 已 warning | 保持 |
| 手动 `/compact` 过程 | TUI `Compacting...`、Web `Compacting session` | 保持；成功不另弹 info |
| 自动压缩过程 | **会触发、会跑完**；只是关在 `prepareTurn()` 这一次 `await` 里，返回前 Lifecycle 不能 `yield` 给前端 | **要补后端→前端 in-progress 事件**（spinner），不是「让自动压缩开始能跑」 |

所以：自动压缩**不是没法触发**。阈值到了就会在下一步模型调用前完成 prune，并在仍有需要时继续跑摘要。缺的是「正在压」这一段前端听不到。要补的是 **Lifecycle 在确认进入实际自动 compact、任何 prune/summary 动作开始前 `yield` 一条过程事件**，让 UI 把 spinner 改成 `Compacting...`。成功仍只靠随后 `context:prepared` 里的占用数字。

「yield」在这里=生成器向外抛事件给 run/UI，不是「压缩函数 return」。也不能写在 `onCompactionStarted` 回调里——必须在 Lifecycle 的 generator 函数体里 yield（用信号 + `Promise.race`，或把准备过程拆成两步）。

---

## 7.1 后端必须通知前端（已确认）

spinner 在前端，压缩发生在后端进程。没有事件，前端无法自己猜到「现在在压」。

| 时机 | 后端 → 前端 | UI | 不是 |
|------|-------------|-----|------|
| 实际自动 compact 开始：已选非 `none/mask` 档位，prune 尚未执行 | 新事件 `context:compacting` → `run.context.compacting` | spinner 标题 `Compacting...`；纯 prune 也可见 | 不是“摘要 LLM 开始”，不是对话 message，不是 notice |
| 结束（成功） | 已有 `context:prepared` → `context.window.updated` | 占用数字变掉；spinner 回到普通 working / 结束 | 不是成功 toast |
| 结束（失败/膨胀） | 已有 warning notice | 保持 | — |

手动 `/compact` 已经用 `command.started` 通知过了；自动压缩要补的是同一类 **运行时状态事件**，走 Lifecycle/run 通道，不走 Bus、不走 transcript。

---

## 8. 仍属实施风险（不是产品待拍板）

| 项 | 默认 | 若卡住 |
|----|------|--------|
| 工具解析时机 | Lifecycle **先 resolveTools，再 prepareTurn({ tools })** | 若循环依赖，降级为「测量补算、压缩仍不含 tools」，记入 05 |
| 自动压缩过程事件怎么 yield | 默认：`onCompactionStarted` 信号 + Lifecycle `Promise.race` 后在 generator 体内 yield；信号在非 `none/mask` 档位确定后、prune 前发出 | 若难测，拆成「决定」和「执行」两步；**禁止**在回调里 yield |

---

## 9. 用户确认记录

- 「四个按顺序的大方向」：token-counting → compaction 过程态 → 占用 UI → 长期记忆。
- **本批只做方向 1–2**。占用三类监测/UI、长期记忆 hooks **不做**。
- 实施拆成任务 A（tool schema 计量）与任务 B（自动压缩过程态）；按 A → B 实施，分别验收与回滚。
- 2026-08-21 确认：Anthropic / OpenAI-compatible 指 client 请求接口形状；DeepSeek、Gemini 等缓存差异属于上游服务端机制。Prompt cache 不影响 improve-4，另立 improve-5，且不提前钉死字段/语义。
- 2026-08-21 确认：improve-4 只把实时 Lifecycle 请求计量做准；`getContextUsage` 与手动 compact 暂留 messages-only 粗估并明确文档化。二者须在后续 context 占用监测/UI 实施前优化，且不与 improve-5 混合。
- 2026-08-21 确认：自动 compact 的开始语义是“整个实际自动压缩操作已经开始”，不是“摘要模型调用开始”。回调/事件在实际档位确定后、prune 前触发；`none/mask` 不触发，纯 prune 与 summary 路径都触发。
- Breakdown 若后续做：「不要分类过于夸张，保持 kiss，参考 dsh」。本批不加字段。
- Compaction「先不学 pi 用 hooks」。
- 校准因子默认不写库；重启后重新生成，不是从库同步。
- `/compact` 成功不要 info notice；成功靠现有占用总量；过程用 spinner；后端必须发 in-progress 事件给前端，但不要做成对话消息。
- 「卡在 prepareTurn」澄清为：自动压缩会跑，只是一次 await 返回前不 yield，前端看不到过程。
- 文档对齐后在临时分支实施、测试并审查；不推送远端，等待用户最终审查。
