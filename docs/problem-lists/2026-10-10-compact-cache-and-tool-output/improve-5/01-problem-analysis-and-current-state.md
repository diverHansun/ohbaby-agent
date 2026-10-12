# 第 5 批：现状、问题与证据

> 时间口径：**基线事实**指调查版本 `c5cfda26` 的代码；**前四批成果**是本批实施的前置条件，需要复核，不表示当前已经交付；**本批改动**指入口贯通、mask 清理和跨入口回归。
> 代码路径相对仓库根。行号为调查快照，定位以符号名为准。
> 需求见[00](./00-discussion.md)，方案见[02](./02-optimization-plan-and-change-scope.md)，验收见[04](./04-test-and-acceptance.md)。

## 1.1 问题陈述

本批要解决四个具体问题，都是「切换收尾」性质：

1. **入口没完全合一。** 手动 `/compact` 现在走两条不同的上层路径（CLI 走命令、Web 走专用 RPC），自动和溢出又各走各的触发；手动经 `compact()`，自动和溢出经运行内 prepare 路径，最终共用 `runCompaction`；触发、准入与信号回传需按入口核对。
2. **失败语义需要跨入口验收。** 按计划，第 4 批应完成自动失败终止与 force 一次基本保护；当前不能宣称这些行为已验证。第 5 批扩展手动、自动、force 和不同 scope 的集成回归，确认同一失败不会重新获得摘要额度。
3. **mask 旧机制整套还在。** 遮罩投影、`MASK_*` 常量、`context.masked` 事件、`maskEnabled` 选项和一批旧测试都还在，属于「失去引用」的残留。
4. **清扫本身的边界风险。** 清扫不能顺手删掉旧数据读取兼容，也不能顺手引入新框架、永久锁或版本服务。

## 1.2 已确认边界（引用 00）

手动仅空闲执行、忙由后端判、不暗停工具、不入等待队列；失败终止在第 4 批完成、本批只回归；mask 本批整体删；删 mask 后输入预算口径不再用于触发；不新增框架／永久锁／版本服务，不删旧数据读取兼容。见 [00 §已确认](./00-discussion.md)。

## 1.3 现状：三条入口与信号流

**手动入口有两条上层路径，汇到同一处。**

- CLI：`commands/builtin.ts:530 handleSessionCompact` → `commands/types.ts:119 CommandCompactProvider.compactSession` → `POST /v1/commands`（`packages/ohbaby-server/src/app/create-app.ts:1660`）。
- Web：`apps/ohbaby-web/src/api/daemon/http.ts:505` → `POST /v1/sessions/:id/compact`（`create-app.ts:2041`）→ 同一个 `compactSession`。
- 两者都经 `adapters/ui-runtime/composition.ts:1211 compactSession()` 调 `core/context/context-manager.ts:1679 compact()` → `compactUnlocked`（`:1517`）→ `runCompaction`（`:1483`）。

**自动入口**：`context-manager.ts:1592 prepareTurnUnlocked` 以 `countTurnCompaction: true` 调 `runCompaction`；触发判据 `needsSummaryCompaction`（`compaction-policy.ts:108`）当前取完整窗口占用 `currentTokens / contextLimit`，阈值 `COMPRESSION_THRESHOLD = 0.95`（`constants.ts:1`）。`lifecycle.ts:1688 prepareTurnWithProgress` 用 `onCompactionStarted` 竞速产出 `context:compacting`。

**溢出入口**：`lifecycle.ts:658` 捕获 `isContextOverflowError`（`core/llm-client/errors.ts:33-52`）→ `:662-685` 以 `force: true` 重新 prepare（`:675`）→ 二次溢出 `:738-759` 以 `terminalReason: "context_overflow"` 结束；`runtime/run-manager/error-detail.ts:221-227` 把它映射为 `retryable: false`。`run-manager/worker.ts` 只转发流，不做 force。

**忙与重复保护**：手动经 `ui-inprocess.ts:2806-2817 acquireRuntime(getActiveRunId(...))` 取准入，遇到 `RuntimeSwitchPendingError` 会**重试等待**（不是直接报 busy）；`ui-inprocess.ts:2557-2572 assertCanUseAsPrimarySession("compact")` 拒绝子代理会话；`runtime/run-ledger/errors.ts:25-35 SessionRunBusyError` 用于新 run 声明，`ui-inprocess.ts:178,1127 isBusyError` 识别它；`context-manager.ts:1690`（compact）与 `:1738`（prepareTurn）都在同一个 `mutationLane` 下，按 session／scope 串行。

**信号回传有两条路。** `context/events.ts:78-92 CompactionStarted／CompactionFinished` 与 `:125-139 CompactSkipped` 是领域事件，但 `bus/event-catalog.ts:226-248` 标 `uiVisible: "no"`；UI 实际吃的是 run 流：`lifecycle.ts:594 turn:start.compaction` → `worker.ts:402-413 run.context.compacting` → `stream-bridge-run-event-source.ts:314,329-345` → `run-stream-adapter.ts:547-559 handleContextCompaction`、分发在 `:819-827`；失败／inflated 由 `prompt-context.ts:50-79 noticeFromCompactResult` 转成 `notice.emitted`。CLI 在 `packages/ohbaby-cli/src/tui/store/events.ts:280-281` 收 `notice.emitted`，`:1157-1172` 格式化 `session.compact`；Web 在 `eventReducer.ts:469` 收 `notice.emitted`，`CompactOverlay.tsx:80-139` 渲染结果。

## 1.4 现状：mask 机制（本批删除对象）

- 常量：`constants.ts:4-14` 六个 `MASK_*`；`:24-27 CompactionThresholds.mask`；`:30 DEFAULT_COMPACTION_THRESHOLDS.mask`。再导出在 `index.ts:7-12`。
- 实现：`core/context/projection.ts:15-306`——`MaskConfig`、`ContextMaskedEventPayload`、`createMaskConfig`、`reduceForModel`、`collectMaskCandidates`、`maskToolPart`、`isMaskedContent` 等；再导出 `index.ts:48-54`。
- 接线：`context-manager.ts:282 maskCutoffs`、`:285-289 maskConfig`、`:555-595 reduceContextForModel`（`:563` 传 maskConfig、`:586-592` publish `Masked`）；`types.ts:278-286 maskEnabled／maskConfig`。
- 档位耦合：`compaction-policy.ts:76 CompactionRung` 含 `"mask"`，`:98,:103` 会返回 `"mask"`；`context-manager.ts:1197,:1279` 两次 `decideCompactionRung`。
- 事件：`events.ts:50-54 MaskSkippedReasonSchema`、`:140-150 ContextEvent.Masked`；登记行 `bus/event-catalog.ts:315-333`（含 `maskedPartIds`、`maskedTokens`）。
- **生产消费方为零**：全仓扫描确认 SDK／server／CLI／Web 都没有 `masked*`、`MaskConfig`、`reduceForModel` 的读取方，唯一读取者是测试 `manager.unit.test.ts:287`。`docs/bus/event-catalog.md:29` 有对应文档行。
- 测试：`projection.unit.test.ts:185-658`（mask 主套件，11 个 `it`）；`manager.unit.test.ts:1934-2268`（mask 用例，含 `:287` 订阅）与 `:2513-2690`（档位梯级）；`native-context.unit.test.ts:197-219`；`core/agents/instance.integration.test.ts:488-493`；`context-window-policy.integration.test.ts:4,54-55`；`runtime-inputs.integration.test.ts:75`；`context-state-machine.unit.test.ts:137`。

## 1.5 现状：跨批遗留（假定已由前批处理，本批只复核）

- **prune（第 3 批负责）**：`packages/ohbaby-sdk/src/compact.ts:3,24-29,45`（`"pruned"` 与 `prune` 字段）、`core/context/types.ts:133`（`CompactStatus` 含 `"pruned"`）、`events.ts:110-116 Pruned`、CLI `store/events.ts:1162`、Web `CompactOverlay.tsx:120-123` 与 `wire.ts:257`、`prompt-context.ts:54-58`。**清理时不能误删的共用能力**（`time.compacted`、`commitCompaction` 事务、工具配对）必须保留——第 3 批已按 plan/02 §9.2 处理，本批只在 04 里作复核项，不重新列为首次任务。
- **次数上限与抖动锁（第 4 批负责）**：`MAX_COMPACTION_PER_TURN`（`constants.ts:21`）、`THRASH_*`（`:18-20`）、`decideCompactionRung` 的 `thrashLocked／maxPerTurn／compactionCount` 参数、`context-manager.ts:1185-1196 isThrashLocked／perTurnCapped` 与 `:1206-1216 CompactSkipped` 的 `"thrash-locked"／"per-turn-cap"` 原因。第 4 批同批删除；若删完仍留下无人使用的原因字面或参数壳，本批按「失去引用」清扫（见 02 §2.3）。
- **无进展地板**：第 4 批计划用压后占用地板替代抖动锁。本批只回归「没涨不重复压、涨过地板才再压、手动与溢出不受限」。

## 1.6 跨模块一致性与文档漂移

- 模块权威文档仍写的旧设计：`docs/core/context/goals-duty.md:93,95,97-104,136`、`dfd-interface.md:74-75,224`、`test.md:8,37,54,57` 仍描述 `mask／prune／thrash`、`0.95`、`0.3` 保留比例、`ratio>=0.50 → mask`。实施后需同步（见 02 §2.4）。
- **编号提醒**：`docs/core/context/improve-1..7`、`improve-4-to-5-regression` 是 **Context 模块记录编号**，与议题实施批次**不是一对一**；本议题的模块记录入口是 `docs/core/context/improve-7/README.md`。不要把模块目录的 `improve-5`（LLM 请求契约，2026-08-24 历史批次）与本批混淆。

## 1.7 改动影响面（现状视角）

涉及 `packages/ohbaby-agent/src/core/context/`（mask 全部）、`core/context/index.ts`、`bus/event-catalog.ts`、`packages/ohbaby-sdk/src/compact.ts`（复核 prune 字段是否已清）、`packages/ohbaby-cli/src/tui/store/events.ts`、`apps/ohbaby-web/src/ui/commands/CompactOverlay.tsx`（复核 prune 行），以及测试文件与 `docs/bus/event-catalog.md`、`docs/core/context/*.md`。

## 1.8 SWE 原则审视摘要

- **复杂度来源**：一个触发动作有多个口径（rung 四值、mask 阈值、完整窗口占用），一条失败有多个重试所有者（lifecycle 的 force 与 context 的层内重试），UI 信号绕开领域事件走 run 流。收尾方向是**减少分叉**，不是再加一层。
- **清扫纪律**：删除依据是「失去引用」，需顺真实引用链走（类型 → 导出 → 消费 → 测试 → 文档），不以文本搜索无命中宣布完成。
- **不引入**：清扫不得顺手建新框架、永久失败锁或版本服务；不得删旧摘要／原文读取、`time.compacted`、`commitCompaction` 共用事务。
- **可逆性**：删 mask 是可逆的（曾被默认关闭，删的是死路），风险主要在误删共用件，靠 04 的引用核对与旧库重开兜底。

## 1.9 与既有文档关系

`plan/02 §9.1` 的常量归属表是本批 mask 删除的权威依据（`MASK_*`、`CompactionThresholds.mask` 归第 5 批）；`plan/02 §9.2` 的 prune 清理归第 3 批，本批不复做。第 4 批的次数上限／抖动锁删除见 `plan/02 §9.1` 与 `discussion-notes §17.13`。本批不改 plan。
