# 1. 现状与问题分析

> 基线：main / `018a5c96`（与 plan 相同）。本文描述**改造前**实现，不含任何批次的实施结果；批 2 的门禁与执行身份属预期契约，见 §1.4。
> 路径相对仓库根，定位以符号为准。

## 1.1 问题清单

| ID | 现状与影响 | 代码依据 | 方案入口 |
| --- | --- | --- | --- |
| P1 | 普通输入撞上 goal run 会直接打断并暂停目标；已有 steer 机制只由人工命令触发，未接到 accept 自动分流 | `adapters/ui-inprocess.ts` `waitForPromptSlot`（user 撞 goal → `interruptGoalPromptInFlight` → `pauseGoal("interrupted")`）；`steerQueuedPromptForOwner` 是唯一 steer 入口 | 02 D1 |
| P2 | accept 与分流不原子：accept 内部会 `requestDrain()`，目标空闲时可立刻 claim 启动新 run；claim 与 store 写都在同一 session 提交串行区（`commitCoordinator.run`），区外无法把"分流"插回两写之间 | `runtime/prompt-scheduler/scheduler.ts` `accept`（末尾 `requestDrain`）、`drain`（`store.claim`）；`adapters/ui-inprocess.ts` `commitCoordinator` 接 `sourceProjection.owner.run` | 02 D1 |
| P3 | steer 不检查更早排队项：`steerQueued` 只校验目标 run 与 prompt 状态，后到的 B 可以越过更早 queued 的 A | `runtime/prompt-scheduler/current-run-inputs.ts` `steerQueued`；`listQueued` 的顺序语义未参与判定 | 02 D3 |
| P4 | steer 冲突不分型：目标关闭、末步封口、幂等冲突、scope 冲突统一抛 `CurrentRunInputConflictError`，调用方分不清"预期竞争（原项保留）"与"真错" | `current-run-inputs.ts` `conflict()`/`CurrentRunInputConflictError`；CLI `prompt/index.tsx` 的兜底文案、Web `Composer.tsx` 错误展示 | 02 D4 |
| P5 | 未发送提示双重 user-stop 过滤且只看最近一次 Stop：适配器只在 `inputsCloseReason === "user-stop"` 时算 `unsentSteer`；SDK 侧只取最近一个 user-stop run，后继 Stop 一发生提示消失，异常关闭完全不提示 | `ui-inprocess.ts` `projectRunRecord`；`packages/ohbaby-sdk/src/run-inputs.ts` `hasUnsentSteerAfterLatestStop`；CLI `app.tsx`、Web `SessionScreen.tsx` 各调一次 | 02 D6/D8 |
| P6 | 未消费语义只有布尔：无法区分"未消费（从未尝试）"与"处理未确认（本地 attempt 已记）"；`firstAttemptRequestId` 已存在但 UI 没有消费。注意 `processedRequestId` 只代表本地请求成功落盘，不代表模型已理解 | `current-run-inputs.ts` `hasUnsentSteer`（纯布尔）、`admitRequestAttempt`、`confirmRequestSuccess` | 02 D6/D8 |
| P7 | 没有重发入口，且不能复用 retained 路径：retained 重发复用同一 promptId / userMessageId，而 steered 消息已写入旧 run，复用同身份等于重放旧消息 | `scheduler.ts` `resubmitRetained`；`current-run-inputs.ts` `steerQueued` 用 `prompt.userMessageId` 造消息；CLI/Web 现在只有一行固定文案 | 02 D7 |
| P8 | 大 protected input 失败没有可展示状态：输入状态字段只有 attempt / processed / closed，请求准备失败时没有"未处理 / 失败"投影，用户看不到消息为何没进模型 | `agents/subagents/continuation-coordinator.ts` `beforeStep` → `core/lifecycle/lifecycle.ts` protectedInputs 注入；输入记录无失败事实字段 | 02 D10 |

## 1.2 三条链路现状

**队列与顺序（稳定依据已具备）**

- `prompt_submission` 两个 store 在接受时都保证 `accepted_at` 按 scope 严格单调（DB `Math.max(now, latestCreatedAt+1, latestAcceptedAt)`；内存 store 同式），并维护 `admission_order`。
- `listQueued` 按 `accepted_at, admission_order, prompt_id` 排序；`drain` 以 session lane head 为候选（`scheduler.ts` `laneHeads`）。
- 结论：FIFO 判定不需要新字段或通用队列，只需在分流前查同 session 的更早 queued 项。

**steer 写入与注入（机制已存在，只差接线）**

- 写入：`CurrentRunInputStore.steerQueued` 在同一事务里校验目标 run（running、未封口）、把 prompt 从 queued 原子转成 steered、写 receipt，并落一条 `user-steer` 输入与用户消息。
- 封口：run 的 input port 在末步 `sealSteer`（`continuation-coordinator.ts` `beforeStep(finalStep)`），DB 上体现为 `run_ledger.steer_closed_at`。
- 注入：`beforeStep` 返回 pending 输入，`beforeFinish` 有 pending 就继续；`admitRequestAttempt` 记 `firstAttemptRequestId`，`confirmRequestSuccess` 记 `processedRequestId`。
- 结论：steer 进 goal run 不需要新通道，缺的是"accept 时自动决策"与"结果分型"。

**未消费 / 处理未确认展示（现状最弱）**

- 事实源齐全：`current_run_input` 行（closedAt / firstAttempt / processed）+ `run_ledger` 关闭原因 + steered 消息本身（`UiMessage.runtimeInputKind === "user-steer"`，但消息是分页 / 压缩 / 重连后按需加载的，不能当全量索引）。
- 投影链路：`ui-inprocess.ts` `projectRunRecord` → `UiRun.unsentSteer` → CLI/Web 各调 `hasUnsentSteerAfterLatestStop`。
- 结论：缺的是"会话级可查询的未消费列表 + 显式重发"；不能只按当前可见消息聚合。

## 1.3 与批 2 契约的边界（预期，未实施）

批 2 提供共享门禁 `SessionExecutionGate`、固定锁顺序（提交 barrier → session owner 串行区 `runControl` → 内存占位表 → run 本体在锁外）、接受顺序稳定、goal 忙不提前 claim、用户队列优先。本批的自动 steer 只允许在**已进入的 owner accept 回调内**做短写（store 级 `steerQueued` + 唤醒），不二次进入 owner 串行区、不放长跑逻辑、不占 gate 租约。

批 2 已保证"后到不越过更早 queued 项"的入队顺序；本批在此之上保证**分流**不破坏它（B 不越过 A 去 steer）。

## 1.4 前置依赖与现状的区分

批 2 / 批 3 是本批的实施前置（批 2 的门禁与只读挂点 `getActiveGoalRunForSteer(sessionId) => { runId, goalId } | undefined`（同步内存读，不带 generation）在本文写作时**不存在**，一律按预期契约引用）。现行代码在无门禁时普通输入会继续打断并暂停 goal，因此本批不提供"先发布、未接线降级为只排队"的中间形态，也不承诺先于前置批次发布；接口细节已按批 2 修稿对齐。

## 1.5 SWE 审视摘要

- 复用而非新建：steer 通道、顺序字段、幂等 receipt、消息投影都可复用；本批最多加一个可空列和一组类型化结果。
- 复杂度预算：拒绝新锁、新账本、新事件系统；FIFO 靠已有单调字段，未消费靠已有状态字段。
- 单一事实源：删除 `UiRun.unsentSteer` 与 latest-stop helper，避免两个标志表达同一事实。
- 可逆性：迁移列可空且可留；UI 协议删除项要求 CLI/Web/server 同批更新（monorepo 同版本发布）。

## 1.6 与既有文档关系

- plan/01 §1.5 的 P4（插话打断 + steer 未接线）是本文 P1/P2 的粗粒度版本，本批是其实现视角细化。
- `docs/goals/dfd-interface.md`、`docs/tools/todo-list/use-case.md` 的插话 / scope 约定随实现更新；本批不改文档树本身，验收时同步。

## 补充代码核查（2026-10-15，同一基线）

现有 `scheduler.ts:357–365` 的手动 steer 在 store 返回后执行 `notify(onUpdated)`、`onSteered` 和 `resolveCompletion`；`current-run-inputs.ts:399–408` 的裸 store 只持久化并通知消息/唤醒 run。计划的自动路径若只接裸 store，会遗漏完成通知。`scheduler.ts:222–241` 的同 id 快速读取及 `waitForCompletion`（`:520–583`）还允许并发重试读到分流前 queued 并注册等待；02/04 必须覆盖其后续结算。这是待实施路径的接线要求，不是当前自动 steer 已发生的 bug。
