# 第 5 批：现状、前序预期与问题

> 时间口径：**基线事实**指 main / `018a5c96` 的代码；**前序预期**（improve-1 至 improve-4）是本批实施的前提，还未交付；**本批改动**指展示接线、删除 inactive 注入、criterion 校验与轮次/时长 UI。
> 源码路径相对仓库根，行号是核查快照，定位以符号为准。需求见 [00](./00-discussion.md)，方案见 [02](./02-optimization-plan-and-change-scope.md)，验收见 [04](./04-test-and-acceptance.md)。

## 1.1 问题陈述

本批解决四个问题，都是收尾性质：

1. **goal 续跑正文直接出现在用户气泡里。** 模型要读的完整提醒和用户该看到的提示现在是同一段文本，实时回显和历史回放都显示全文。
2. **inactive 轻提示还在。** paused 时每条普通输入都会拼一份"目标存在但不自动推进"的全文，另有一个专用开关和一个只做透传的 helper，属于决议 4 要删的对象。
3. **criterion 没有任何格式规范。** trim、空白、长度都不校验，超长文本直接入库，`replace: true` 也没有前置校验。
4. **轮次与活跃时长只藏在查询里。** 常驻 UI 投影只有 3 个字段，CLI 只显示一行状态；数字刷新通道（静默刷新）要等第 2 批建立后才能接。

## 1.2 基线事实

### 消息路径：正文与展示共用一段文本

- 提交契约：`GoalTurnRunner.runTurn(sessionId, promptText, goalId)`（`packages/ohbaby-agent/src/goals/types.ts:94-100`）；`driver.ts:36-42` 先 `incrementTurn`，再用 `renderGoalTurnPrompt`（`goals/injection.ts:61-81`，`isFirstTurn = turnsUsed === 1`）渲染正文并提交。
- adapter 接线：`adapters/ui-inprocess.ts:1004-1019` 的 goal runner 闭包把正文交给 `submitPromptInternal`（`owner: "goal"`，`suppressGoalContextNote: true`）。
- 消息装配（`ui-inprocess.ts:3092-3150`）：`promptTextForModel` 得到 `modelPromptText`；`createTextMessage({ text })`（定义在 `:433-448`）做实时回显；`runtime.startSession` 只在 `modelPromptText !== text` 时带 `displayUserText: text`。
- 落库与回放：`core/agents/runner.ts:93-95` 把 `displayUserText` 写进 part 的 `metadata.displayText`；`adapters/ui-state/persistent-store.ts:164-165` 回放优先读它，否则显示 `part.text`。
- 结果：goal 正文当前等于实时气泡也等于历史气泡（两条路径共用 `text`），`displayText` 机制已存在但只有普通用户输入在用。
- 标题：`scheduleSessionTitleGeneration`（`:2691-2719`）在 `:3197-3203` 以 `firstUserMessage: text` 触发；goal 首轮的 `text` 就是正文，所以标题天然取正文。改造后这个来源不能换成短提示。

### inactive 自动注入：轻提示与专用开关

- `renderGoalContextNote`（`goals/injection.ts:83-106`）只为 `paused` 生成轻提示；导出在 `goals/index.ts:11`。
- `promptTextForModel`（`ui-inprocess.ts:3418-3441`）在 `owner === "user"` 且未 suppress 时拼 `${note}\n\nCurrent user request:\n${text}`，并顺带 `publishGoalUpdated`（`:3432`）刷新投影。
- 专用开关 `suppressGoalContextNote` 出现在提交选项（`:257`）、goal runner 调用（`:1012`）和 `promptTextForModel` 调用（`:3092-3098`）。
- 轻提示会随普通输入持久化，多次普通输入会重复目标全文（plan/01 P8 已记录）。
- 两条普通输入路径要分开看：queued 普通 run 走上面这条提交流程（改造后一律无 goal 前缀）；成功 steer 的输入进入当前 goal run 的 protected input（runtimeInput），根本不经过 `promptTextForModel`。blocked 与 paused 一样按"非活跃不注入"处理，第 3 批交付 blocked 后不能再长出一条注入分支。

### criterion：只有 objective 有校验

- `GoalStore.create`（`goals/store.ts:109-157`）先 trim objective、拒绝空值、拒绝超过 `MAX_GOAL_OBJECTIVE_LENGTH`（6000，`goals/constants.ts:6`），随后把 `input.completionCriterion` 原样透传进记录与内存（`:136-137`、`:151-152`），没有 trim、空白或长度处理。
- 入口：`CreateGoal` 工具（`goals/tools.ts:138-172`，支持 `replace`）经 `GoalService.createGoal`（`goals/service.ts:129-136`）到 store；CLI `/goal <objective>` 不传 criterion（`commands/goal.ts:72`）。
- `replace: true` 时不检查 `goal_exists`，直接 append 新的 create 记录并替换内存状态；失败要保证旧目标完全不动。

### UI 投影：三个字段，四处消费

- SDK 类型 `UiGoal`（`packages/ohbaby-sdk/src/snapshot.ts:75-82`）只有 `status`、`objective`、`pauseReason`；`UiGoalStatus` 仅 `active | paused`（blocked 扩展属 improve-3）。
- 投影函数 `goalSnapshotToUiGoal`（`ui-inprocess.ts:1408-1419`）；写入 `uiGoalsBySession`（`:538-541` hydration、`setGoalProjection` `:1424-1439`），供初始快照（`snapshotGoalsFor` `:1454-1462`）、session 视图（`:730-740`、`:846-853`）和 `goal.updated`（`publishGoalUpdated` `:1441-1453`）消费。事件出口为 `UiGoalUpdatedEvent`（`ohbaby-sdk/src/events.ts:129-134`），消费方是 CLI `store/events.ts:245-252` 与 Web `api/daemon/eventReducer.ts:421-431`。
- CLI：`selectActiveGoal`（`packages/ohbaby-cli/src/tui/store/selectors.ts:49-59`）提供整个 `UiGoal`，但 `app.tsx:1169` 只传 `goalStatus`；`components/prompt/index.tsx:72、908-909、971-973` 渲染单行 `goal {status}`（两色：active 用 `theme.status.accent`，其余 `warning`）。
- Web：`GoalStatusChip`（`apps/ohbaby-web/src/ui/commands/GoalControl.tsx:23-46`）渲染 `goal {status}`，`title` 放 objective；面板摘要行在 `:110-135`（`OverlayResult` 的 `rows`，形状见 `overlay-controls.tsx:48-52`）；`selectors.ts:211-218` 选 active goal；`SessionStatus.tsx:36、92` 挂 chip。
- notice：`GoalService` 的 `onChange`（`ui-inprocess.ts:802-816`）对每次变更既 `publishGoalUpdated` 又发一条 `Goal ...` notice；计轮与 usage 目前不发任何事件（plan/01 §1.6），静默刷新属 improve-2。
- 文档口径：`docs/goals/ui/goal-ui-design.md` 明确"不暴露 turn/token usage、不做 turn/token 详情"，与决议 5 冲突，实施后要同步（见 [02](./02-optimization-plan-and-change-scope.md) §2.7）。

## 1.3 前序预期交付（实施前提，不是当前事实）

| 批次 | 预期交付 | 本批如何消费 |
| --- | --- | --- |
| improve-2 | 共享准入；同一准入快照生成正文/轮号/展示值并写入提交契约；执行身份；准入计轮与 usage 静默刷新；普通输入排队优先、删除打断分支及其专用 helper；完成与尾部结算；token 预算与自动提醒 token 删除、partial/cache 统计通道 | 只接展示值与静默刷新；不重算正文、不补记账、不重做 token 删除与打断分支删除 |
| improve-3 | blocked 全链状态（SDK/CLI/Web）、双维 resume、时间截止与恢复入口 | 只回归：数字与恢复界面共存，blocked 时长显示停止值 |
| improve-4 | accept 后自动 steer、稳定 FIFO、未消费输入与显式重发 | 只回归组合一致性 |
| improve-1 | llm-client 请求空闲看门狗 | 整体回归（[04](./04-test-and-acceptance.md) §4.5） |

如果前序实际接口与本表不同，按 README 的规定先调整本批衔接，不把预期函数名当成既成事实。

## 1.4 为什么这些不能留给下一批

- 展示是用户唯一直接感知的出口；正文与短提示不分离，U1/U4 无法验收，标题被短提示污染的窗口也要在这里封死。
- 删除轻提示和短提示接线挤在同一条提交路径（`submitPromptInternal` 与 `promptTextForModel`），拆开会让两条消息路径长时间并存。
- criterion 校验必须与 `replace: true` 的修改顺序一起确认，否则一次超限替换可能破坏原目标。
- 轮次/时长是 SDK 契约字段，CLI、Web、SDK 测试要在一个批次里一起更新，避免半投影期。
- 本批是收尾批：组合回归在 04 列清，不建纯测试批。

## 1.5 SWE 判断

- 复用既有 `displayText` 机制与 `goal.updated` 通道，不新建 kind 或事件；失用的轻提示代码按引用链删除，而不是留开关。
- 校验放在 `GoalStore`（唯一状态写入入口）；UI 只消费投影，不复制计算。
- 本批唯一的对外协议变化是 `UiGoal` 增加三个展示字段（与 improve-3 的 blocked 联合一起构成最终形状），消费方可枚举、可同批更新。

## 补充代码核查（2026-10-15，同一基线）

前序规划经源码复查后新增了正文实改的 epoch 失效、结算显式恢复、自动 steer 成功通知，以及 Web 带参 resume 的 composer 接线。本批仍只负责上下文与展示；组合验收必须消费这些前序契约，不把尚未实施的行为描述成现状。
