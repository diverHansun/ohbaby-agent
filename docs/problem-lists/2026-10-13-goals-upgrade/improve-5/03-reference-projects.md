# 第 5 批参考项目与实际取舍

> 本批只关心三件事：**续跑消息怎么把正文与展示分开**、**criterion 上限怎么处理**、**轮次与时长怎么显示**。
> 参考根目录 `/Users/hansun025/Projects/code-cli/`，本批重核时间 2026-10-15；完整对照见 [plan/03](../plan/03-reference-projects.md) §3.2。本文件只记录本批用到的局部结论，不作为整套方案的正确性证明。

## 3.1 本批实际核对的来源

| 项目 | 重核位置 | 结论 |
| --- | --- | --- |
| Claude Code Best | `claude-code/src/hooks/useGoalContinuation.ts:137、177`（`isMeta: true`）；`src/screens/REPL.tsx:5142`（`Goal auto-continue (${turn}/1)`，transcript-only 消息）；`src/utils/messages.ts:5098` `shouldShowUserMessage` | 续跑消息双轨展示：模型读正文，界面读另一段短提示 |
| Kimi | `kimi-code/apps/kimi-code/src/tui/components/chrome/footer.ts:106-131`（badge `[goal ● active · 4m · 7 turns]`，设了轮次上限时显示 used/limit）；`:453、517-537、553-558`（`goalWallClockMs` + 定时器前端推算） | 数字投影形状可借鉴；逐秒前端推算不采用 |
| Kimi | `kimi-code/packages/agent-core-v2/src/features/goal/goalService.ts:86`（`MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH`）、`:1045-1050`（`normalizeCompletionCriterion` trim + 超限 `slice`） | objective/criterion 同值上限形状；criterion 静默截断 |
| Codex | `codex/codex-rs/core/src/context/user_goal.rs:1-14`（`MAX_OBJECTIVE_BYTES = 700`；注释：超长**整段省略**，截断可能把限制变成授权）；`codex-rs/protocol/src/protocol.rs` 创建目标超 4000 码点**拒绝**（plan/03 §3.2 决议 14） | "不截断"的理由来源；省略与拒绝是两种不同处理，本批只借后者 |

## 3.2 可借鉴点与本批取舍

| 做法 | 参考 | 本批采用方式 |
| --- | --- | --- |
| 续跑消息"模型正文 + 界面短提示"双轨 | Claude Code Best（已重核） | **采用**：分成正文与展示值两条消费路径；**不采用**它的 isMeta 双消息与 source/origin 体系，本项目复用既有 `displayUserText`、消息保持 user 角色 |
| 短提示带轮号，如 `(turn N)` | Claude Code Best `REPL.tsx:5142` | **采用**形状；文案基线继承第 2 批（首轮 `Goal started`，后轮 `Goal auto-continue (turn N)`），生成点仍在准入快照 |
| badge 显示 `状态 · 时长 · 轮次`，有上限才显示分母 | Kimi footer（已重核） | **采用**：CLI 常驻行与 Web 面板同形；**不采用**常驻 tokens 与 blocked 专用色相（blocked 属 improve-3 的单色形状） |
| active goal 前端逐秒推算时长 | Kimi `goalWallClockMs` + 定时器 | **不采用**：决议 5 规定只显示后端最近一次快照值，前端估算不能充当预算权威；本阶段不做逐秒走字 |
| objective/criterion 同值上限 | Kimi（已重核） | **采用**同值 6000 的形状；**不采用** `slice` 静默截断 |
| 创建门槛超限拒绝而不是改写 | Codex `codex-rs/protocol/src/protocol.rs`（4000 码点创建拒绝，plan/03 §3.2 决议 14） | **采用**"拒绝而不截断"的理由：criterion 超限明确报错。注意 `core/src/context/user_goal.rs` 的 700 字节段是**整段省略**（既不是截断，也不是拒绝），只作对照，不用作拒绝依据，也不套作本项目上限 |

## 3.3 明确不借鉴

- Claude Code Best 的 transcript-only 隐藏消息与 isMeta 双消息：本项目一条消息加 `metadata.displayText` 就够，改两次消息形状超出需要。
- Kimi 的通用 origin/injection 压缩分类与重注入机制（非 goal 专属特判，见 plan/03 §3.4）、Codex 的 `goal_files` 文件转存：本批不引入文件转存，长文本处理只靠既有转义与上限。
- 仪表盘、进度条、新配色：数字显示沿用 CLI 两色与 Web chip 现状。

## 3.4 对 02 方案的影响

参考只解释 [02](./02-optimization-plan-and-change-scope.md) §2.3（展示分离）、§2.4（criterion）与 §2.5（轮次/时长）的局部取舍；文案字面量、字段名与消费边界以 02 为准，不因参考项目形状而扩张范围。
