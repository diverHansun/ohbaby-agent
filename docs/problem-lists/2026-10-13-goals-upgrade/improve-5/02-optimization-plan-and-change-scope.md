# 第 5 批：上下文与 UI 收尾

> 依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md)、[plan/02](../plan/02-optimization-plan-and-change-scope.md) §2.6 与 [plan/04](../plan/04-test-and-acceptance.md) §4.7。本文供后续实施，验收见 [04](./04-test-and-acceptance.md)；本次不改业务代码。
> 前序批次（1–4）成果是实施前提，不表示当前已交付。本批不重做前序职责，前序若偏离预期接口，先调整本批衔接。

## 2.1 方案总览

把 goal 轮次的模型正文与用户可见短提示分开：正文随准入快照生成、走模型与历史；短提示走实时回显与回放。同时删除 paused 轻提示及其专用开关，给 criterion 封上 6000 上限，并把轮次与活跃时长接到 SDK/CLI/Web。

```text
准入快照（improve-2 预期交付）→ 正文 + 轮号 + 展示值
        │
        └→ GoalTurnRunner 提交契约（第 2 批交付，本批只读核对，不改签名）
             │
   adapter（本批）├─ createTextMessage(text = 展示值)            → 实时回显（message.appended）
                  ├─ runtime.startSession(prompt = 正文,
                  │        displayUserText = 展示值)             → metadata.displayText → 回放同一值
                  └─ 标题生成仍取正文/objective，不取展示值

普通输入（本批）：原文直接进入正文；不再拼 paused 轻提示、不再顺带刷新投影

GoalStore.create（本批）：objective 校验（既有）+ criterion trim/6000 校验
                          → 全部通过才 append/替换；失败时旧目标与记录不动

GoalSnapshot → goalSnapshotToUiGoal（本批补 turnsUsed/wallClockMs/turnBudget）
             → 初始快照 / session 视图 / goal.updated（improve-2 的静默刷新）
             → CLI 常驻行、Web chip 与面板（只显示数字，不发 notice、不逐秒）
```

## 2.2 设计取舍

| 项目 | 做法 | 边界 |
| --- | --- | --- |
| 展示值 | 随准入快照生成、随提交契约传输；adapter 只消费 | 不在 adapter 按轮号重写文案；不新增消息 kind |
| 回放 | 复用 `metadata.displayText`（写、读都在既有代码里） | 不改 `getMessageOrigin`、压缩分类、缓存身份 |
| 标题 | 仍取正文/objective | 不用短提示；不新增第二套命名源 |
| inactive 注入 | 删除轻提示、专用开关与透传 helper | 不改 base.md 静态规则、历史消息、GetGoal |
| criterion | store 校验 trim + UTF-16 length ≤ 6000，拒绝不截断 | 不设联合上限；不新增编辑入口 |
| UI 字段 | `UiGoal` 加 `turnsUsed`、`wallClockMs`、可选 `turnBudget` | 不加 tokens、不搬预算报告；不逐秒；不 notice |
| 时长格式 | 复用 SDK `formatDurationSeconds` | 不新增格式化框架 |
| 数字刷新 | 复用 `goal.updated`（含 improve-2 静默刷新） | 不新增事件，不为数字发 notice |

## 2.3 Stage 1：消息路径（短显示接线 + 删除 inactive 注入）

### 展示契约（本批固定）

- 消息仍是 user 角色普通 text part；实时回显与落库回放显示同一短提示。这两处必须**成对改**：实时消息文案（`createTextMessage`）与持久化 `displayUserText`/`metadata.displayText` 同批落地，禁止只写持久层，否则实时与刷新后显示不同文字。
- 生成点唯一：短提示与正文来自同一次准入快照，提交契约由 improve-2 交付。本批不重新定义 `GoalTurnRunner` 的签名，也不在 adapter 生成或推断展示值。实施前先做前置验收：第 2 批的提交契约已携带正文、轮号与展示值；未交付就回修第 2 批，本批不重做。第 2 批只交付"同快照生成 + 契约传递"，不接 UI；接 UI 是本批的边界。
- 文案基线：首轮 `Goal started`；后续 `Goal auto-continue (turn N)`，N 为本次准入的轮号；英文，不建 i18n 体系。文案与第 2 批的生成处对齐；若两批不一致，先在第 2 批的生成处按基线校正，不在 adapter 追加第二个生成点。
- 标题源保持 objective/正文，绝不使用短提示。

### 接线落点（`packages/ohbaby-agent/`）

| 位置 | 本批动作 |
| --- | --- |
| `src/goals/types.ts:94-100` `GoalTurnRunner.runTurn`（基线形状） | 只读核对第 2 批已交付的提交契约是否携带正文、轮号与展示值；本批不改签名、不补参数，前置验收未过先回修第 2 批 |
| `src/adapters/ui-inprocess.ts:1004-1019` goal runner 闭包 | 把正文与展示值一起传进 `submitPromptInternal` |
| `src/adapters/ui-inprocess.ts:3092-3150` 消息装配 | `submitPromptInternal` 增加可选 `displayText`；`createTextMessage` 用 `displayText ?? text` 做实时回显；`runtime.startSession` 的 `prompt` 用正文，`displayUserText` 在存在独立展示值时带上（不再用"正文 ≠ 原文"判断） |
| `src/adapters/ui-inprocess.ts:3197-3203` 标题调度 | `firstUserMessage` 保持正文，不得改成展示值 |
| `src/adapters/ui-state/persistent-store.ts:164-165` 回放 | 不改代码，只补测试证明 live/replay 一致 |

### 删除对象（按引用链）

| 位置 | 动作 |
| --- | --- |
| `src/goals/injection.ts:83-106` `renderGoalContextNote` | 删除 |
| `src/goals/index.ts:11` | 删除导出 |
| `src/adapters/ui-inprocess.ts:3418-3441` `promptTextForModel` | 整体删除；普通提交直接以原文进入正文 |
| `src/adapters/ui-inprocess.ts:257、1012、3092-3098` `suppressGoalContextNote` | 删除选项与全部传参 |
| `src/adapters/ui-inprocess.ts:3432` 顺带 `publishGoalUpdated` | 删除后不再借普通提交刷新投影；刷新由 `goal.updated`（含第 2 批静默刷新）、查询路径（`goalCommandBackend.status` `:3611`）与重连快照承接，实施时核对无其他消费者依赖 |

保留不动：`renderGoalTurnPrompt` 正文结构（其 token 行由 improve-2 处理）、base.md 静态规则、历史消息（旧轻提示记录仍可读）、GetGoal 输出、runtime model-context 的位置与去重。

### 完成条件

- goal 轮次实时与回放显示同一短提示，模型请求正文完整，标题不取短提示。
- 普通输入都不再出现任何 goal 前缀：无 goal 或目标为 paused/blocked 时，排队的普通 run 走本提交流程且不带前缀；成功 steer 的输入走当前 goal run 的 protected input（不经过本流程，也不带前缀）。
- `renderGoalContextNote`、`suppressGoalContextNote`、`promptTextForModel` 引用链闭合，类型检查通过。

## 2.4 Stage 2：criterion 上限校验

落点：`packages/ohbaby-agent/src/goals/constants.ts`、`goals/store.ts`、`goals/errors.ts`（可按需）。同时在 `CreateGoal` 工具的 criterion 字段说明中写明 trim 后最多 6000 个 UTF-16 代码单元，超限拒绝；校验仍集中在 store，不复制到第二个业务入口。

- 常量：新增 `MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH`（= 6000），不引入第二个数字。
- `GoalStore.create`（`store.ts:109-157`）在 objective 校验旁处理 criterion：
  - 先 `trim()`；纯空白按未提供处理，等同于 `undefined`，不写字段。
  - trim 后按 JavaScript UTF-16 `length` 校验；超过 6000 抛错（建议新错误码 `invalid_criterion`，信息写明上限与当前长度），拒绝入库，不做截断。
  - 校验必须发生在 `goal_exists` 检查和 `appendRecord`/内存赋值之前，覆盖 `replace: true`：失败时旧目标、用量与持久记录全部不变，不产生新的 create 记录。
  - 记录与内存写入共用同一个 trim 后的值，避免两处重复 trim。
- 兼容：历史记录里的 criterion 原样回放，不追溯拒绝、不改写，无数据库迁移。
- 不在 `UpdateGoal`、`replaceObjective`、`SetGoalBudget` 增加 criterion 路径（本批没有编辑入口）。
- 注入与查询路径（`untrustedBlock`、`formatGoalStatusLines`）不变；criterion 每轮仍只出现一次。

## 2.5 Stage 3：轮次与时长 UI

### SDK 契约（`packages/ohbaby-sdk/src/snapshot.ts:75-82`）

```ts
export interface UiGoal {
  readonly status: UiGoalStatus;          // blocked 由 improve-3 扩展，本批不重复判定
  readonly objective: string;
  readonly pauseReason?: string;
  readonly turnsUsed: number;
  readonly wallClockMs: number;           // 后端最近一次快照值
  readonly turnBudget?: number;           // 仅设置过轮次上限时存在；不搬 budget report
}
```

### 生产与一致性

- 投影：`goalSnapshotToUiGoal`（`ui-inprocess.ts:1408-1419`）填充三个字段，`turnBudget` 取 `snapshot.budget.turnBudget` 且为 `null` 时省略；`complete` 仍投影 `null`（清理语义属 improve-2，本批只跟随）。
- 同一函数同时服务初始快照（`snapshotGoalsFor`）、session 视图与 `goal.updated`，三路径天然一致；用测试固定（[04](./04-test-and-acceptance.md) U5）。
- 刷新：数字变化随 improve-2 的静默刷新（`goal.updated`）到达；本批不新增事件、不为数字发 notice。`GoalService.onChange` 的 notice 逻辑（`:802-816`）保持既有语义。

### CLI（`packages/ohbaby-cli/`）

- `components/prompt/index.tsx:971-973` 的 goal 行从 `goal {status}` 扩为带数字，例如 `goal active · 3m 12s · 7/20 turns`；未设置轮次上限时显示 `7 turns`；paused/blocked 显示停止值。
- 时长复用 SDK `formatDurationSeconds(wallClockMs / 1000)`（`packages/ohbaby-sdk/src/duration.ts:1-17`，已从 `index.ts` 导出）。
- 颜色沿用现有两色映射（`index.tsx:908-909`），不加新色相；`app.tsx:1169` 从传 `goalStatus` 改为传完整 `UiGoal`（`selectActiveGoal` 已提供）。

### Web（`apps/ohbaby-web/src/`）

- `GoalStatusChip`（`ui/commands/GoalControl.tsx:23-46`）保持 `goal {status}` 短形，不加数字，避免窄屏拥挤。
- `GoalOverlayBody` 的摘要行（`:110-135`）在 objective 之外增加两行：轮次（带上限时 `7/20`）与 active time（`formatDurationSeconds`）；沿用 `OverlayResult` 既有 rows 形状，不建新组件。
- 面板的恢复/调额交互属 improve-3，本批不占位。

### 统一不做

不把 tokens 放进常驻 UI，不搬运整个预算报告，不加进度条/百分比/新色相，不做逐秒计时器（时长只在快照/事件到达时更新）；`/goal status` 与 GetGoal 继续保留统计明细（`formatGoalStatusLines` 不动）。

### 消费方清单（同批更新）

- SDK：`events.contract.test.ts:85-111`、`session-view.unit.test.ts` 的夹具与断言。
- CLI：`store/events.ts:245-252、507-515` 的克隆路径无需改代码（结构透传），但 `app.contract.test.tsx` 的 `goals` 字面量要补新字段。
- Web：`App.unit.test.tsx:3840+`、`session/selectors.unit.test.ts:392+` 的夹具；`eventReducer` 与 `store.ts` 只透传结构，不改代码。
- agent：`ui-inprocess.ts` 投影与 `ui-inprocess.contract.test.ts:4268+` 等夹具。

## 2.6 Stage 4：组合回归与收尾

按 [04](./04-test-and-acceptance.md) §4.5 执行跨批组合回归：准入轮号与显示轮号一致、旧轮迟到结果不改数字、blocked/恢复与数字共存、完成清理后无陈旧目标、steer 与原文字样不互相污染、watchdog/截止与展示无耦合。本批是最后一批，组合验收并入本批 04，不新建纯测试批。

## 2.7 接口、迁移与回滚

- 对外协议变化：`UiGoal` 增加三个展示字段（本批）并最终联合 blocked（improve-3）；消息展示复用既有 `metadata.displayText`，不改消息形状与 kind。
- 迁移：无数据库 schema 迁移；criterion 只约束新写入；旧记录原样回放。
- 回滚：短提示可回退为显示正文（噪音变多但不丢正文）；轻提示删除没有运行期开关，回滚需恢复代码版本，实施说明里要如实写明；criterion 校验回滚后超长文本重新可写；`UiGoal` 字段回滚必须两端一起改，不能只回退一个消费者。
- 文档同步（实施完成后）：`docs/goals/ui/goal-ui-design.md`（补轮次/时长显示，删除"不暴露 turn/token usage"的旧口径）、`docs/goals/dfd-interface.md` 流 D（轻提示路径移除、展示值路径）、`docs/goals/use-case.md:78`、`docs/goals/data-model.md:14、43` 的轻提示措辞、`docs/goals/test.md`；`docs/goals/2026-07-03-interrupt-current-light-note.md` 保留原文补 superseded 说明（其中"普通输入打断 goal"部分属第 2 批的排队改写，与第 2 批协同，避免重复加注）。本批只列清单，不改这些文档。

## 2.8 风险与验收重点

| 风险 | 验证方式 |
| --- | --- |
| 展示值被 adapter 二次推断，出现"显示第八轮、正文第七轮" | 单一生成点；U1 断言实时与回放一致且正文完整 |
| 标题取到短提示 | U4；保留 `firstUserMessage = 正文` 的核对项 |
| `replace: true` 校验顺序错，超限替换破坏原目标 | U11 断言无新 create 记录、原目标与记录不变 |
| 三路径投影漂移（快照/事件/重连） | U5 三路径同测 |
| 数字刷新发 notice 刷屏 | U6 断言只更新投影、不追加生命周期 notice |
| 删除轻提示遗漏引用或误删共用件 | 引用链核对 + 类型检查；保留清单见 §2.3 |
| 与 improve-2/3 同文件冲突（打断用例的轻提示断言、blocked 投影） | 实施顺序 1→2→3→4→5；打断用例主体随第 2 批改写、blocked 投影随第 3 批，冲突处按前批 05 对齐，本批只动自己的断言 |

## 2.9 范围与发布边界

本批负责展示接线、删除 inactive 注入、criterion 校验、轮次/时长 UI 与组合回归。前序批次的准入、blocked、steer、token 删除与统计都是前置交付，不能推迟到本批补齐。文档完成不代表已实施；发布门见 [04](./04-test-and-acceptance.md) §4.5。

### 前序修订的组合边界

正文实改后新 epoch 的正文/轮号/数字保持一致；同文不换代。面板与 composer 的带参恢复、steered 的最终投影和等待者结算、usage 失败后的显式恢复、goal root 定点中断均由前批交付，本批按 04 §4.5 回归，不推迟到本批补实现。
