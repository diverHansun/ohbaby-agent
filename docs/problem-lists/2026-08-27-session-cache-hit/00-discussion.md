# 讨论记录与已确认要点

> 2026-08-27 与用户讨论定稿。正式方案见 01–04。本文只保留已确认结论。
> 显示口径继承 2026-08-26 improve-6 冻结设计，所有权从 `docs/core/context/improve-6/` 挪出。

---

## 1. 背景与动机

improve-5 已经把 provider cache 归一化到 `uncached / cacheRead / cacheWrite + observed`，Lifecycle 也按 run 聚合。improve-6 把占用七类接到了 Web。用户仍然看不到命中率：事实停在 run 结果里，没有主代理 session 桶，`/status` 也没有独立一行。

占用和 cache 是两套账。文档和实施都不能再挂在 context 占用批次下。

---

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 落点 | `docs/problem-lists/2026-08-27-session-cache-hit/`；不与 `context/improve-6` 共用，不放进 `docs/core/context/` 或 `docs/core/llm-client/` |
| 代码所有权 | 累加器不进 Context、不进 llm-client、不进 Lifecycle core。Tracker 由 `ui-inprocess` 外层持有，跨 runtime 重建存活；RunManager 只提供不认识 cache 的窄完成回调；`/status` 只读 |
| 显示口径 | **session aggregate 唯一**：`Cache-Read Share = ΣcacheRead / Σ(uncached + cacheRead + cacheWrite)`。分母必须含 `cacheWrite` |
| 两个字段的区别 | `cacheReadTokens` 是可信主代理请求中“从 cache 读取”的 token **累计数量**；`cacheReadShare` 是该累计数量占累计可记账输入 `accountedInputTokens` 的比例。Share 不是“新命中的另一批 token”，也不是命中请求数 / 总请求数 |
| 累计边界 | 累计域是同一主代理 session 内历次 model request；不是单个 step / turn / run，也不是当前窗口尚存内容的快照。run aggregate 只是 session 累加原料，前端不显示 run 级百分比 |
| 谁进桶 | **只计主代理**（`isSubagent !== true` 的 agent-step run）。子代理内部 usage 可以存在，**不**进入用户看到的 session 命中率 |
| 何时不清 | **换模型不清**；**手动 compact、自动 compact 都不清**。整段任务加权，不假装进入新 epoch |
| 不完整轮 | 尽力而为：`usageComplete=false`，或无 `inputBreakdown`，或 `observed.cacheRead !== true` → **整轮跳过**；已有累计继续显示。本批不为未消费的诊断预存计数。多 step 工具循环中任一步缺 breakdown 时，现有 `aggregateTokenUsage` 会让整 run 无 breakdown，本批接受“宁缺毋滥”，不得只挑有字段的 step 入桶 |
| 辅助请求 | title / summary 不进桶（Lifecycle 的 agent-step 聚合已隔离；累加器不得再把辅助 usage 折进来） |
| 最终可见文案 | Web 与 TUI 都只出现一次 `Cache hit 61%` / `Cache hit —` / `Cache hit 0%`。Web 使用 label `cache` + value `hit …`；TUI 使用 label `Cache` + value `hit …`，不得出现 `cache Cache hit …` |
| 取整 | `cacheReadShare`（0–1）×100 后四舍五入到整数 |
| UI 位置 | 只在 `/status`：Web 卡片独立行；TUI 面板 Context 与 Tools 之间。不进占用彩条、顶栏环、hover/click 详情、TUI 底栏 |
| 物理语义 | cache 只改变计费与延迟，**绝不**从窗口占用扣除 |
| 生命周期 | 内存级；进程重启归零。session 删除、UI 归档清目标桶，backend dispose 清全部桶（卫生）；这不等于 compact 或换模型清桶 |
| `/status` 字段名 | **确认 `promptCacheUsage`**，避免和请求策略配置 `apiConfig.promptCache` 撞车 |
| DTO | **确认** `sessionId / accountedInputTokens / cacheReadTokens / cacheReadShare`；不含 `estimatedAt`，因为厂商 usage 是 observation，不是估算，且 UI 不消费时间 |
| UI adapter | Web 增加 `statusPromptCacheUsage(data)`，TUI 增加同层 `toPromptCacheUsage(value)`；两者对 unknown payload 做结构与范围校验：sessionId 非空、两个 token 数为非负整数且 read≤accounted；accounted=0 时 read=0/share=null，accounted>0 时 share∈[0,1]。不在 UI 重算 share，也不新增跨包 validator 抽象 |
| 关键改动清单 | 本批 02 **不写** |

### 2.1 三分桶（只消费，不改 normalization）

互斥，加总 = 总输入：

- `cacheRead`：命中此前写入的缓存（跳过 Prefill）
- `cacheWrite`：本轮首次写入缓存的前缀
- `uncached`：既不命中也不构成新写入的普通输入

OpenAI 系 `uncached = prompt_tokens − cacheRead − cacheWrite`。DeepSeek 等不报 `cacheWrite` 时，分母里该项为 0，不把 `observed.cacheWrite=false` 当成整轮不可信。

可信轮的最低条件：`usageComplete === true` **且** 存在 `inputBreakdown` **且** `observed.cacheRead === true`。

### 2.2 累计量示例（避免把 token 与 share 混为一谈）

```text
run A：accounted input 1,000；cache read 200
run B：accounted input 3,000；cache read 2,200

session.cacheReadTokens      = 200 + 2,200 = 2,400
session.accountedInputTokens = 1,000 + 3,000 = 4,000
session.cacheReadShare       = 2,400 / 4,000 = 0.60
UI                           = Cache hit 60%
```

这里不计算 `(20% + 73.3%) / 2`，也不显示 run B 的 73.3%；必须先累加 token，再做一次 session 比例。compact 只改变后续请求的上下文内容，不回减已经发生并由厂商报告的历史输入。

---

## 3. 已确认：边界（不做的事）

| 项 | 本批不做 |
|----|----------|
| 占用彩条 / 顶栏 / click 面板画 cache | 明确不做 |
| 子代理占用或子代理命中率进主 `/status` | 明确不做 |
| compact 或换模型时重置累计 | 明确不做 |
| 改 cache 请求策略、前缀、key | 不做（improve-5） |
| 改压缩阈值、inclusive occupancy | 不做 |
| 精确 tokenizer、价格引擎、成本节省% | 不做 |
| last-step 命中率与 session 命中率并显 | 不做（run 聚合只当原料） |
| 跨进程持久化 / 从日志重放 | 不做 |
| 新增 SSE / snapshot 推送 cache | 不做；run 完成时写入内存桶，`/status` 拉取。不得依赖「用户开过面板」才记账 |
| TUI 七类占用 | 不做 |
| 把累加器放进 `core/context` 或 `core/llm-client` | 不做 |

---

## 4. 已确认：与关联议题的关系

- improve-5：normalization / `observed` / agent-step purpose **原样消费**，不改。
- improve-6：占用 UI 已落地；其 00 §2.4 口径本批继承；Phase C 与 04 §4.7 由本目录 supersede。
- `goals-duty.md`（context）：cache hit ≠ 释放 token；Context 不解析 vendor cache。
- `goals-duty.md`（llm-client）：只透传精确 usage，不做 session 统计。

---

## 5. 参考项目（摘要；细节见 03）

| 来源 | 采用 | 不采用 |
|------|------|--------|
| deepseek-harness token meter / StatsLine | 原始 token 累加后求整会话 share、与 context pressure 分家 | durable-log projection、复杂近 100% 格式 |
| kimi-code analysis / Timeline | 三输入桶公式、`null` 未知态 | Context TokenBar 把 cache 画成使用量分段 |
| claude-code-best cost tracker | 累计 cache read/write 原始 token | 与 context 可视化混排的 hit rate、阈值告警 |
| improve-6 Web/TUI 契约 | `/status` 独立行位置和文案 | 顶栏/占用详情扩展 |

---

## 6. 用户确认记录

- 2026-08-26（improve-6）：session aggregate 唯一显示；run 级前端不显示；不完整轮尽力而为；文案 `Cache hit {n}%`；cache 不进彩条。
- 2026-08-27：实施和文档不放 `context/`、不整包放 `llm-client/`；落点为本 problem-list。
- 2026-08-27：子代理不算进用户看到的 session 命中率。
- 2026-08-27：换模型后、手动 compact、自动 compact 都不要清之前累计。
- 2026-08-27：完成后做文档自检（内部，不入库）。
- 2026-08-27：正式字段名确认采用 `promptCacheUsage`；DTO 确认采用 `sessionId / accountedInputTokens / cacheReadTokens / cacheReadShare`，移除 `estimatedAt`。
- 2026-08-27：UI 四态确认：字段缺失或 `null` 不画行；主 session 无可信数据画 `Cache hit —`；可信 read=0 画 `Cache hit 0%`；有数据画整数百分比。
- 2026-08-27：再次确认命中率是主代理 **session 累计量**，不显示 step / turn / run 级命中率。
