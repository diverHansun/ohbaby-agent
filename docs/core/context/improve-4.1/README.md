# context improve-4.1 · tools-aware 计量与主代理静态/手动闭环

> 状态：实施与自动化验收完成；详见 **05**。
> 日期：2026-08-22
> 规划基线：`main@6436c15`
> 实施分支：`codex/context-improve-4-1`
> 落点：`docs/core/context/improve-4.1/`
>
> 主题：偿还 [improve-4](../improve-4/README.md) 遗留的静态查询与手动 compact 的 **messages-only** 计量缺口；统一主代理当前占用口径。子代理继续依赖带 `contextScopeId` 的实时 `prepareTurn` 计量驱动自动压缩，不在本批提供静态查询或 UI 展示。

---

## 1. 为什么是 improve-4.1

improve-4 已让实时 Lifecycle 把 tool schema 纳入 `sentHeuristic`，但以下入口仍漏 tools：

- 主代理冷启动/无 tracker 时的静态 `getContextUsage`
- 主代理手动 `/compact` 的 `usageBefore` 与 compact 内部重测

这些入口与实时路径共用同一个 EMA calibration factor。实时分母修为 `messages + tools` 后，静态/手动路径若继续只算 messages，就不再是“精度较粗”，而是输入口径不同。

本批只关闭 improve-4 已登记的问题，不把 prompt cache、压缩策略复盘、占用 breakdown 或 memory 提前塞进来。

---

## 2. 后续路线（已确认）

| 顺序 | 批次 | 核心目标 | 与本批关系 |
|------|------|----------|------------|
| 1 | **improve-4.1** | tools-aware 计量；主代理静态/手动/status 闭环 | 本目录 |
| 2 | **第一次 context 压缩闭环审查** | 从数据结构、数据流出发，检查手动压缩、自动压缩、context 剪裁与 prune；对照 pi/opencode/kimi-code | 4.1 完成后单独规划，不在本批实施 |
| 3 | **improve-5** | prompt cache 命中、cache usage 与计费语义 | 独立待分析；当前不做 |
| 4 | **第二次 context 压缩闭环复核** | cache 落地后重新检查 usage 语义对压缩决策的影响 | improve-5 完成后进行 |
| 5 | **context 占用监测与 UI** | 只展示主代理窗口总量及各项占比 | 子代理不进入用户 UI |
| 6 | **memory / 长期记忆** | LLM 主动工具搜索或 hooks 注入 context | 长期项 |

子代理的占用需求属于**内部运行保障**：必须按 `sessionId + contextScopeId` 计量并驱动自动压缩。它不等于用户可查询的静态占用，也不要求进入 UI。第一次和第二次压缩审查都必须覆盖这条内部链路。

---

## 3. 本批范围

### In-scope

1. **计量边界显式化**：引入窄语义 `ContextMeasurementPayload = { messages, tools }`。它只表达计量所需的 wire 部分，不冒充完整 provider 请求；`AssembledContext` 保持不变。
2. **工具依赖上浮**：调用方解析工具定义，工具名 push 给 system prompt，schema 给计量与实际请求；生产 `SystemPromptProvider` 不再主动拉工具 registry。
3. **主代理静态路径含 schema**：冷启动静态占用按“非最终 step”携带完整 tools。
4. **主代理手动 compact 含 schema**：`usageBefore`、prune 后投影与 summary 后重测使用同一份 tools。
5. **`/status` 单源**：删除内部 status payload 的旧 `context` 字段及独立 `getContextUsage` 查询，只保留 `contextWindow`。
6. **手动 compact 后刷新占用**：以 `usageAfter` 更新 tracker 并发布已有 `context.window.updated` 事件，避免 `/status` 和占用条继续显示压缩前旧值。
7. **子代理实时回归护栏**：确认 `prepareTurn` 继续携带 `contextScopeId`、`agentName`、tools，并按 scope 使用 calibration/自动压缩；不新增子代理静态入口。

### Out-of-scope

- prompt cache 字段、policy、命中率、cache read/write 与成本；归 [improve-5](../improve-5/README.md)
- 手动/自动压缩、context 剪裁、prune、summary 的策略与阈值复盘；归紧随本批的第一次压缩审查
- `system / tools / messages` breakdown、新占用 UI、主代理展示形态
- 子代理占用 UI、公共静态查询、按 scope 的 UI tracker
- 长期记忆工具与 hooks
- 精确 tokenizer、calibration 持久化、`maskEnabled`、存储迁移
- `goals-duty.md` 85% 与实现 0.95 的既有阈值 gap

---

## 4. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [improve-4](../improve-4/README.md) | 直接前序；本批只偿还其明确登记的 tools-aware 静态/手动计量债务 |
| [improve-4/05](../improve-4/05-implementation-acceptance.md) | §5.7 后续事项第 2 条是本批来源 |
| [improve-3/usage-估算](../improve-3/usage-估算/README.md) | D11 单一计量入口继续有效；本批补完整入口输入，不新建第二套算法 |
| [improve-5](../improve-5/README.md) | 独立后序议题；不再被写成第一次压缩审查的前置 |
| [goals-duty.md](../goals-duty.md) | tools 不进入 `AssembledContext`，D1 组装源保持不变 |
| [architecture.md](../architecture.md) | 实施时补充“计量对象是 request-shaped measurement payload”及 primary/static 与 scoped/runtime 分界 |

---

## 5. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策、范围与路线 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状、证据链与风险 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 分阶段实施契约与改动面 |
| [03-reference-projects.md](./03-reference-projects.md) | pi / opencode / kimi-code 的 adopt/adapt/reject |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、集成测试、回归与审查门 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施结果、测试矩阵与独立审查结论 |

阅读顺序：README → 00 → 01 → 02 → 03 → 04 → 05。

---

## 6. 实施入口

已在临时分支 `codex/context-improve-4-1` 上按 [02](./02-optimization-plan-and-change-scope.md) 分批实施、按 [04](./04-test-and-acceptance.md) 验证。当前未合并到 `main`，也未推送远程仓库。
