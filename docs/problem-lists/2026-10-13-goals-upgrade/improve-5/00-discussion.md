# 第 5 批已确认结论与来源

> 本批是五批中的收尾批：接展示、删旧注入、封 criterion 上限、补轮次/时长 UI，最后做组合回归。
> 本批没有新的用户讨论，结论来自 plan 已收口的决议与批次交接契约。产品实现尚未开始，前序批次成果都是实施前提，不是当前代码事实。

## 来源

- [plan/00](../plan/00-discussion.md) 决议 1（正文与展示分开）、决议 4（删除非活跃自动注入）、决议 5（轮次/时长）、决议 14（criterion 上限）
- [plan/02](../plan/02-optimization-plan-and-change-scope.md) §2.6（正文和展示、长度与规则、展示和事件）、§2.8（改动面）
- [plan/04](../plan/04-test-and-acceptance.md) §4.7 U1–U13、§4.9（完成条件）
- [README](../README.md)「五批实施地图」「批次之间的过渡契约」「总体验收归属」

## 继承确认（前序交付或已锁定决策，本批不重开）

1. **准入快照（improve-2 预期交付）**：正文、轮号与展示值来自同一次准入快照，提交契约也由第 2 批交付；本批只接 live/replay 展示，不从旧快照重算正文，也不在 adapter 另生成展示值。若第 2 批未交付该契约，先回修第 2 批。共享准入、执行身份、准入计轮不在本批。
2. **token 退出（improve-2 已确定）**：token 预算的配置、判断与工具单位，以及自动提醒里的 token 一并由第 2 批删除，旧记录做读兼容；本批只消费“提醒不含 token”的结果，不重做删除。
3. **blocked 与恢复（improve-3 预期交付）**：blocked 的 SDK/CLI/Web 状态、双维 resume 与恢复界面同批交付；本批只回归，不补恢复入口，不重画 blocked 形状。
4. **steer 与未消费输入（improve-4 预期交付）**：accept 后自动 steer、稳定 FIFO、未消费提示与显式重发由第 4 批交付；本批只做组合回归。
5. **静态前缀与历史**：base.md 的 Goal 规则不按状态切换、不改规则语义（预算与状态文案的更新由前序批次负责）；不删除历史目标文本；不禁用 GetGoal；不改压缩分类与缓存身份。
6. **展示口径**：常驻 UI 与自动提醒不含 token；`/goal status` 与 GetGoal 保留统计明细；时长显示后端最近一次快照值，不逐秒走字；不新增消息 kind、system role、组件框架或主题。

## 本批负责的结论（已确认）

1. 短提示只改变展示：消息仍是 user 角色普通 text part；实时回显与落库回放显示同一短提示；提示为英文短句，不建 i18n 体系。
2. 会话标题源用 objective/正文，不能用短提示。
3. 删除 paused 轻提示及其专用开关；普通输入不再出现任何 goal 前缀，含 paused/blocked 等非活跃状态；queued 普通 run 与成功 steer 是两条不同路径，都不带 goal 前缀，也不重复注入目标全文。
4. criterion：trim 后按 JavaScript UTF-16 `length` 校验，上限与 objective 相同（6000）；纯空白按未提供；超限拒绝不截断；校验先于 `replace: true` 的任何修改。
5. `UiGoal` 增加 `turnsUsed`、`wallClockMs` 与可选 `turnBudget`；CLI 常驻行与 Web 面板显示轮次和时长；不搬完整预算报告，不把 tokens 放上常驻 UI。
6. 组合验收在 04 列清；不新建第 6 批纯测试。

## 工程建议（本批内的技术形状，可按等价方式落实）

1. **文案基线（工程建议，不是用户原话）**：短提示首轮 `Goal started`，后轮 `Goal auto-continue (turn N)`，N 为本次准入轮号；生成点唯一，仍在准入快照（第 2 批），实施前与第 2 批文档对齐，不在 adapter 追加文案。
2. 展示值随第 2 批的提交契约传输；`submitPromptInternal` 用独立的 `displayText` 通道，不覆盖正文参数（标题仍取正文）。
3. criterion 校验放在 `GoalStore.create`，沿用既有 `invalid_objective` 的错误模式增加错误码（建议 `invalid_criterion`），信息写明上限与当前长度；`CreateGoal` 工具说明同步补充长度限制，不另建校验入口。
4. 时长格式复用 SDK 已有 `formatDurationSeconds`，CLI 与 Web 不各写一套。
5. 数字刷新复用既有 `goal.updated` 与第 2 批的静默刷新，不为数字新增 notice。
6. 删除后 `promptTextForModel` 若没有剩余职责，整体删除，普通提交直接透传原文。

## 边界（不做）

- 不新建组件框架/主题/消息 kind/事件系统；不加进度条、百分比、新色相或逐秒计时器。
- 不按状态切换 base.md 的 Goal 规则、不改其语义（前序批次的预算/状态文案更新不属本批）；不改历史消息、GetGoal 输出；不增加 criterion 编辑功能。
- 不补 blocked 与恢复、不重做 token 删除与统计通道、不重做 steer 与未消费输入。
- 不把前端估算时长当作预算权威；展示值不参与预算判定。

## 本次代码审查后的修订（2026-10-15）

本批回归前批修正：实改 objective 后新正文/轮号/数字一致，恢复不丢参数，自动 steer 的队列投影与等待者闭合，失败结算可经现有 recovery 补齐，中断不影响用户子树。对应修复仍归第 1–4 批，本批只验证组合。这是对已有决策的工程补齐，授权原文见 [plan/00](../plan/00-discussion.md)；尚未实施。
