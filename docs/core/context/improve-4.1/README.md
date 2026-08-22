# context improve-4.1 · 静态/手动路径的 tools 计量与占用口径统一

> 状态：规划文档已齐（00–04）。红队审查结论 **READY WITH FIXES**，blocker/major 已回写本文档；实施以 **02 + 04** 为准。
> 开工前请确认 U1/U2/U3（02 已给推荐答）。本规划会话不写实现代码。
> 日期：2026-08-22
> 基线：`main`（improve-4 任务 A/B 已合入，含 `45f6b1f` / `6e5cd82` / `a6a283f` / `d56ee99`）
> 落点：`docs/core/context/improve-4.1/`
>
> 主题：偿还 [improve-4](../improve-4/README.md) 明确登记的遗留项——`getContextUsage` 与手动 compact 的 **messages-only 粗估**。同时统一「当前占用」的 UI 口径，并让**任何 agent（含子代理）的上下文都能被同一套逻辑正确测量**。

---

## 1. 为什么是 4.1 而不是 5

两个原因，缺一不可。

**第一，这是 improve-4 自己制造的回归，不是新功能。** improve-4 把实时 Lifecycle 的计量修准之后，EMA 校准因子不再需要吸收 tool schema 缺口而相应回落。静态路径与实时路径**共用同一个 factor**，静态数字失去了原先「歪打正着」的补偿。01 已用公式说明这是口径不一致而非两档精度；量级由实施单测钉住，规划期不实测 factor 数值。详见 [00 §1](./00-discussion.md#1-背景与动机) 与 [01 §1.3.3](./01-problem-analysis-and-current-state.md)。

**第二，它是后续两批的前置。** improve-4 的 00/02 已把「`getContextUsage` / 手动 compact 的 tools-aware 估算」登记为 **context 占用监测/UI 实施前必须偿还**，并明确写了「不属于 improve-5/cache」。本目录就是兑现这条登记。

编号用 `4.1` 而非 `5`，是因为 `improve-5` 已被登记为 prompt cache 批次，improve-4 目录下 8 份文档共 **29 处**引用指向它。新开 4.1 可零改既有链接。

---

## 2. 四批顺序（已确认）

| 顺序 | 批次 | 落点 | 状态 |
|------|------|------|------|
| 1 | **tools 计量与占用口径统一** | `improve-4.1/`（本目录） | 规划中 |
| 2 | prompt cache 观测与计费 | [`improve-5/`](../improve-5/README.md) | 已登记范围，未进入现状分析 |
| 3 | context 压缩/管理整体检查 | 待定 | 未开始 |
| 4 | 上下文窗口占用实时监测 + UI | 待定 | 未开始 |

第 3 批排在 cache 之后，是因为 cache 会改动 provider usage 语义，进而影响压缩决策的输入；让整体检查看到最终形态更划算。

---

## 3. 范围

### In-scope

1. **请求载荷层（路子三）**：引入 `RequestPayload = { messages, tools }`（messages 已含 system）。占用计量对它做。`AssembledContext` **保持不变**。详见 [03](./03-reference-projects.md) 与 [01 §1.3.2](./01-problem-analysis-and-current-state.md)。
2. **工具解析上浮**：由上层解析一次工具，同时喂给 system prompt 与计量。依赖方向从「prompt 模块拉取工具注册表」改为「上层注入」。
3. **静态与手动路径含 tool schema**：`composition.getContextUsage`、`composition.compactSession`、`ContextManager.compact` 的占用不再是 messages-only。
4. **正确传参**：从 `Session` 读取 `isSubagent` / `agentName` 传到 `assemble`。静态查询**默认不传** `contextScopeId`（session 上没有该字段）。**不加守卫排除子代理。**
5. **UI 口径统一**：`ContextWindowUsageTracker` 作为「当前占用」的唯一权威；`/status` 也先读它，不再单独现算一份。

### Out-of-scope

- **Prompt cache**：不新增 cache usage 字段、不启用 cache policy、不统计命中率/成本。独立 [improve-5](../improve-5/README.md)。
- **占用三类 breakdown 与新 UI**：不加 `system / tools / messages` 分类字段，不改占用条展示形态。第 4 批。
- **子代理占用的 UI 展示**：本批只保证「测量正确」，不新增任何展示入口。
- **压缩机制本身的重新设计**：阈值、档位、prune/summary 策略一律不动。第 3 批。
- 长期记忆工具 / hooks（`docs/core/memory/`）
- 精确 tokenizer / tiktoken；`services/llm-model/tokenCounting.ts` 算法不动
- 校准因子写库（维持 improve-3 D3）
- 打开 `maskEnabled`
- 换存储引擎

---

## 4. 与既有文档关系

| 文档 | 关系 |
|------|------|
| [improve-4](../improve-4/README.md) | **直接前序**。本批偿还其 00/02/05 明确登记的遗留项；不回退其任何已实施决策 |
| [improve-4/05](../improve-4/05-implementation-acceptance.md) | §5.7 后续事项第 2 条即本批 |
| [improve-3/usage-估算](../improve-3/usage-估算/README.md) | D11「占用率测量收口成单一入口」仍是权威；本批扩大 `measureUsage` 的输入，不新建第二个入口 |
| [improve-5](../improve-5/README.md) | 后序且独立。本批不碰 cache 字段；improve-5 不回退 `RequestPayload` / 全路径 tools 计量 |
| [goals-duty.md](../goals-duty.md) | 走路子三后 D1 组装源**无需修改**（tools 不进 `AssembledContext`）。G2 的 85% 与代码 0.95 的既有 gap 本批仍不修，只在 01 记录 |
| [architecture.md](../architecture.md) | Phase 1 补一句：计量对象是请求信封；不新画组件 |

---

## 5. 文档地图

| 文档 | 状态 | 作用 |
|------|------|------|
| [00-discussion.md](./00-discussion.md) | **已产出** | 已确认决策、边界与未决项 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | **已产出** | 现状诊断、代码锚点、U4/U7 关闭 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | **已产出** | 分三阶段方案、改动面、迁移与回滚 |
| [03-reference-projects.md](./03-reference-projects.md) | **已产出** | kimi-code / opencode / pi 对照与取舍 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | **已产出** | 风险导向验收（含翻转 improve-4 TC-11） |
| `05-implementation-acceptance.md` | 实施后 | 由验收模式写入 |

阅读顺序：README → 00 → 01 → 02 → 03 → 04。实施以 **02 + 04** 为准。

> 本批 03 提前于 01/02 产出，因参考项目调研已在讨论阶段完成，其结论直接影响了架构路线（路子三）的选定。这是有意的顺序调整，不是跳步。

---

## 6. 已知主要风险

**U7 已关闭**（[01 §1.3.3](./01-problem-analysis-and-current-state.md)）：ohbaby 用启发式 × factor，不是把 tools 叠在真实 usage 上。纳入 tools 后分子分母同量纲。实施时用 [04 TC-2](./04-test-and-acceptance.md) 钉住「禁止再加一遍 tools」。

观感风险：静态数字修正后占用条可能一次性跳高——这是少算被纠正，不是回归。

---

## 7. 实施入口

用户审查通过后，**新会话**按 [02](./02-optimization-plan-and-change-scope.md) + [04](./04-test-and-acceptance.md) 实施。本规划会话不写代码。
