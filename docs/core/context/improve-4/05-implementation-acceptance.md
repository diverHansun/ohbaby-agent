# 5. 实施验收文档

> 撰写时机：实施完成后，按 `plan-code-improvement` 验收模式独立检查后撰写

## 5.1 元信息

| 项 | 值 |
|----|----|
| 议题 / 批次 | context improve-4：实时 Lifecycle tool schema 计量 + 自动压缩过程态 |
| 规划文档版本（commit / 日期） | `b408e57` / 2026-08-21 |
| 实施范围（commit 范围 / 时间段） | 基线 `e59107b`，代码实现 `45f6b1f`、`6e5cd82`、评审修正 `a6a283f` |
| 验收日期 | 2026-08-21 |
| 结论 | **通过**：任务 A/B、边界回归和完整自动化测试矩阵均通过；真实 provider/UI 手工观察留给最终审查，不阻断本次代码验收。 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据（文件 / commit / 测试） |
|---------|------|--------------|------------------------------|
| Phase 1 / 任务 A：实时请求计量含 tools | 完成 | Lifecycle 在每一步先解析 tools；同一份 tools 交给 `prepareTurn`、所有压缩后重测、overflow retry 和 provider send。final step 统一为 `[]`。 | `45f6b1f`；`context-manager.ts`、`token-estimation.ts`、`lifecycle.ts`；TC-1、TC-8 |
| Phase 1 边界：静态查询/手动 compact 保持粗估 | 完成 | 未给 `getContextUsage`、`compactSession` 或公开 API 增加 agent/step/tools 参数，也未为这两条路径物化 provider tool schemas。 | `composition.unit.test.ts`；TC-11；SDK/API diff |
| Phase 2 / 任务 B：自动压缩开始信号 | 完成 | `runCompaction` 在非 `none/mask` 档位确定后、任何 prune/summary 之前调用回调；纯 prune、普通 summary 和 overflow force 均覆盖。 | `6e5cd82`；`context-manager.ts`、`lifecycle.ts`；TC-10 |
| Phase 2：Lifecycle → worker → UI 状态 | 完成 | Lifecycle 用局部 Promise signal 在 generator 内先发 `context:compacting`；worker/stream source 映射为 `run.context.compacting`；adapter 投影到现有 `UiRunStatus.title`；Web 读取 title，TUI 复用既有能力。 | `6e5cd82`；worker/source/adapter/Web 测试 |
| Phase 2：结束、失败与并发隔离 | 完成（评审后加固） | `context:prepared` 清除标题；失败由 run 终态兜底。状态写入和清理仅作用于当前前台 session、同一 run，并且不会清掉同 run 的更新标题。 | `a6a283f`；adapter 单测与 in-process 合同测试 |
| Out-of-scope 防线 | 完成 | 未增加 cache accounting、breakdown、memory hooks、Bus UI 订阅、DB migration、精确 tokenizer 或新依赖。cache 仅在 improve-5 文档中独立登记。 | diff/rg 审查；`pnpm-lock.yaml`、SDK、TUI usage、tokenCounting 均无实现改动 |

## 5.3 规划 vs 实际差异（基础指标对账）

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
|------|----------|----------|----------|----------|
| 数据结构 | `PrepareTurnInput.tools`、`onCompactionStarted`；Lifecycle/stream 增加过程事件 | 与规划一致；未给 `ContextUsage` / SDK 增加 breakdown/cache 字段 | 无 | 向后兼容，改动集中在已有数据流 |
| 数据流 | step-local tools 同时用于测量与发送；回调用 signal 唤醒 generator | 与规划一致；并增加 active session + runId + title 三重 UI 清理守卫 | 独立代码审查发现后台 session 可能污染全局状态、旧 clear 可能覆盖新标题 | 只加局部保护条件，没有引入全局状态机；降低并发串扰风险 |
| 协议/接口 | 新增内部 `context:compacting` / `run.context.compacting`；公开 usage 结构不变 | 与规划一致 | 无 | 内部事件向后兼容；无 SDK schema 迁移 |
| 文件/包结构 | 修改 context、lifecycle、run worker、UI adapter、Web；TUI 无需产品代码 | 与规划一致；测试覆盖扩展到 composition 和完整 in-process 失败路径 | 评审要求把边界与终态清理变成可执行契约 | 无新增模块、依赖或抽象层 |
| 错误处理/边界行为 | `none/mask` 不发；成功 prepared 清理，失败由终态兜底 | 与规划一致；明确后台 session 不改前台状态，也不清除更新后的运行标题 | 多 session 并发下需要所有权隔离 | 行为更严格，未改变压缩结果语义 |
| 依赖变更 | 无 | 无 | 无 | 无供应链与构建风险 |

实施语义没有偏移：**自动 compact 的“开始”是整个实际自动压缩操作已经开始**。具体开始点是非 `none/mask` 档位确定后、首次 prune mutation 前；不是摘要模型调用开始。

## 5.4 实施理由与注意事项

- Lifecycle 已经拥有 agent、step、final-step 与工具解析上下文，因此由它一次解析 tools，再向 ContextManager 和 provider 下传，符合 SRP；没有为一个字段引入完整 `StepContext` 或 canonical envelope。
- ContextManager 只消费 provider-ready tools，不依赖 tool registry/MCP/skill 系统；tools 只进入现有 wire heuristic，不复制 `tokenCounting.ts` 算法。
- Promise signal 是 generator 与内部 Promise 之间最小的时序桥。状态仍以现有 run stream 为权威，不增加 Bus → UI 第二通道，也不增加全局 compact 状态机。
- UI 过程态复用 `UiRunStatus.title`。自动压缩摘要仍是内部上下文产物，不写 transcript；成功仍不发持久 notice。
- `getContextUsage` 与手动 compact 本批仍是 messages-only 粗估。更精确地说：这两个入口不物化/传入 provider tool schemas；现有 system prompt 组装仍可能把工具**名称文本**写入 messages，这不等于 schema 计量。必须在后续 context 占用监测/UI 实施前完成它们的输入契约优化，且不要混入 improve-5 cache accounting。
- Prompt cache 字段、启用策略、命中率、价格与成本估算仍完全属于 [improve-5](../improve-5/README.md)。本批没有提前钉死 `prompt_tokens` 的 cache 语义。
- 校准 factor 仍跨 step 使用；工具集突变后会有一次 EMA 滞后，现有 overflow force 是安全兜底。本批不调整 EMA 或持久化策略。
- system prompt 的工具名称与 Lifecycle 的 provider schema 由现有不同入口获得；若运行中 registry 极短暂变化，名称文本和 schema 快照理论上可能不同。实时测量与 provider send 仍严格共用同一 schema，故不阻断本批；若未来建立统一 request context，可一并消除该残余。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

| 验收 ID | 结果 | 证据 |
|---------|------|------|
| TC-1：同 messages，有/无 tools | 通过 | `includes tool schemas in the wire heuristic and ignores empty tools`；`includes tool schemas in prepared heuristic and current usage`；压缩后重测直接对账 `sentHeuristic` |
| TC-8：final maxSteps | 通过 | `uses the final maxSteps model step for text-only finalization`、`fails when the final maxSteps finalization step still requests a tool`：测量与请求都得到 `tools: []` |
| TC-4：成功 prune/compact | 通过 | `does not emit notices for successful compact results`；`does not emit persistent notices for successful context compaction`；prepared usage 继续更新总量 tracker |
| TC-5：失败/inflated compact | 通过 | `emits compact warnings without token deltas for failed and inflated results` |
| TC-9：Bus 非 UI 通道 | 通过 | ContextManager 既有事件测试仍通过；生产 adapter 未订阅 `ContextEvent`；过程态走 run stream |
| TC-10：完整 compact 过程态 | 通过 | 覆盖纯 prune、普通 summary、`none/mask`、同 tick、overflow force、worker/source 映射、Web title、前台 session/run 隔离、新标题保护与 prepare 失败终态清理；无 transcript summary / 成功 notice |
| TC-11：静态/手动边界 | 通过 | `keeps provider tool schemas out of static usage and manual compaction`；公开 API/SDK diff 无 agent/step/tools/breakdown 增量 |

完整验证结果：

| 命令 | 结果 |
|------|------|
| `pnpm run test:unit` | 213 files passed；1903 passed，2 skipped |
| `pnpm run test:integration` | 42 files passed；287 passed |
| `pnpm run test:contract` | 12 files passed；226 passed |
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 通过 |
| 定向 context/UI 合同测试 | 4 files；200 passed |

回归/边界检查：

- `tokenCounting.ts` 算法、TUI 总量格式、SDK `UiContextWindowUsage`、memory 模块、DB schema 与 lockfile 均未改。
- Web 只让 live/running 的既有 title 进入状态 pill；没有增加 context breakdown UI。
- cache 相关生产实现无 diff；improve-5 只承接后续讨论文档。
- 真实 provider 下的 token 数字变化和 TUI/Web 视觉过程态尚未做人工观察；自动化已经覆盖数据流、状态投影和完整 in-process 失败路径，最终审查时可作为非阻断 smoke 再确认。

### 5.5.2 独立审查与修正

本批完成后进行了三路独立审查：代码/SWE、文档边界、测试与数据流。确认并修复的事项如下：

| 发现 | 处理 |
|------|------|
| 后台 session 的 compact 事件可能覆盖前台全局运行状态 | adapter 增加 active session + runId 所有权检查，并加回归测试 |
| `context:prepared` 可能清掉同一 run 后续阶段的新标题 | 只在当前标题仍为 `Compacting...` 时清理，并加回归测试 |
| 真实 ContextManager 的 tools 计量、压缩后重测、普通 summary 开始点证据不够直接 | 增加直接单测，固定 `sentHeuristic/currentTokens` 与回调时序 |
| prepare 失败后的 UI 清理只有成功终态替代用例 | 增加完整 in-process 失败合同测试 |
| TC-11 容易被误解为“完全不解析工具” | 文档与 composition 测试改为精确约束：不物化/传入 provider tool schemas；保留既有 system prompt 工具名称文本 |
| README 尚未进入验收完成态 | 本文档与 README 状态在最终文档提交中补齐 |

### 5.5.3 SWE 层面评估（聚焦改动面）

结论：改动保持了小而明确的数据流，没有引入不必要的模块、持久化、依赖或泛化协议；评审发现的状态所有权问题已在当前批次关闭。

| 发现 | 严重性 | SWE 依据 | 建议 / 状态 |
|------|--------|----------|-------------|
| Lifecycle 成为 step tools 的单一编排者 | 正向 | SRP、Information Expert；避免 ContextManager 反向依赖工具系统 | 保持现状 |
| compact signal 使用局部 Promise bridge | 正向 | KISS/YAGNI；满足 async generator 时序而不建全局状态机 | 保持同 tick 与失败测试 |
| UI 状态是 workspace 全局投影，必须验证所有权 | 已关闭（原 P2） | 并发隔离、状态机所有权；旧事件不得覆盖新状态 | 已加 session/run/title 守卫 |
| 静态/手动入口与实时入口有两档精度 | 已知后续项 | 契约必须反映调用方可获得的信息，避免伪造 step context | 占用监测/UI 前优化；不在 improve-4/improve-5 混做 |
| cache 与 prompt usage 语义未统一 | 已知后续项 | 不在缺少 provider 语义时提前固化字段 | improve-5 独立设计 |

架构框架 4 复查：本批是进程内数据流与内部流事件扩展，无网络重试、幂等写入、鉴权或 DB migration 新要求；取消/异常由现有 run 终态收敛，旧/后台事件通过所有权检查降级为 no-op。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 类型 |
|------|----------|------|
| [context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts) | tools 进入所有实时 usage 重测；实际 compact 档位开始回调 | 修改 |
| [token-estimation.ts](../../../../packages/ohbaby-agent/src/core/context/token-estimation.ts) | wire heuristic 纳入非空 tools JSON | 修改 |
| [context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts) | `PrepareTurnInput` 增加内部可选字段 | 修改 |
| [lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts) | step-local tools 快照、overflow 复用、compacting signal/yield | 修改 |
| [lifecycle/types.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts) | 增加内部 lifecycle 过程事件 | 修改 |
| [worker.ts](../../../../packages/ohbaby-agent/src/runtime/run-manager/worker.ts) | 映射 `run.context.compacting` | 修改 |
| [run-stream-adapter.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts) | UI 过程态投影、清理与 session/run 所有权守卫 | 修改 |
| [stream-bridge-run-event-source.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts) | 过程事件 round-trip | 修改 |
| [selectors.ts](../../../../apps/ohbaby-web/src/ui/selectors.ts) | live/running 时读取既有运行标题 | 修改 |
| [manager.unit.test.ts](../../../../packages/ohbaby-agent/src/core/context/manager.unit.test.ts) | tool 计量、重测和 compact 开始语义 | 修改 |
| [lifecycle.unit.test.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts) | 同一 tools、final step、overflow 与完整过程态 | 修改 |
| [run-stream-adapter.unit.test.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts) | 状态投影、并发隔离、成功静默 | 修改 |
| [ui-inprocess.contract.test.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts) | prepare 失败后的终态清理合同 | 修改 |
