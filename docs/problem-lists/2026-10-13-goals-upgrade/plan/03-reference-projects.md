# 3. 参考项目与取舍

> 本文记录本地参考代码的事实及本项目的适用边界。最终产品选择见 [00](./00-discussion.md)，工程约束见 [02](./02-optimization-plan-and-change-scope.md)。
> 核查时间：2026-10-14 至 2026-10-15。路径相对下表项目根；行号只用于定位，优先按符号查找。未找到某能力不代表所有版本都没有该能力。

## 3.1 来源

本地项目根均位于 `/Users/hansun025/Projects/code-cli/`。

| 简称 | 目录 | 主要来源 |
| --- | --- | --- |
| DSH | `deepseek-harness/` | `packages/goal/`、`packages/util/timeout/`、`packages/llm/` |
| Codex | `codex/` | `codex-rs/ext/goal/`、`core/src/`、`state/src/`、`tui/src/` |
| Kimi | `kimi-code/` | `packages/agent-core-v2/src/features/goal/`、prompt channel、TUI footer |
| Claude Code Best | `claude-code/` | `src/services/goal/`、`src/hooks/useGoalContinuation.ts`、GoalTool、goal 命令 |
| ZCode | `ZCode/` | `apps/zcode-cli/packages/` 的 target、verifier、model adapter；conversation 协议文档 |

本次核查使用本地工作区快照，版本如下；各批 03 共用这张来源表，行号以对应快照为准，不代表上游当前版本。

| 本地目录 | HEAD | 来源边界 |
| --- | --- | --- |
| `ZCode/` | `aac47556` | 本地源码 |
| `kimi-code/` | `cbd754049` | 本地源码 |
| `deepseek-harness/` | `d743267388` | 本地源码，简称 DSH |
| `claude-code/` | `77a7934e` | README 标识为 Claude Code Best（CCB），复原并扩展的实现；remote 为 `claude-code-best/claude-code`，不作为 Anthropic 官方源码证据 |
| `codex/` | `12cca49c81` | 本地源码 |

参考用于理解问题和边界，不按“几家都这么做”投票。以下逐项覆盖全部决议，明确哪些是移植、哪些只是对照、哪些是本项目自己的选择。

## 3.2 逐项对应

| 决议 | 参考事实与锚点 | 本项目取舍 |
| --- | --- | --- |
| 1 正文与展示 | Claude Code Best `src/hooks/useGoalContinuation.ts` 生成 isMeta user 消息；`src/screens/REPL.tsx` 另生成 transcript-only 的 `Goal auto-continue`；`src/utils/messages.ts:shouldShowUserMessage` 处理隐藏。Codex `codex-rs/ext/goal/src/steering.rs` 与 `core/src/event_mapping.rs` 将内部 goal 上下文与用户消息事件区分 | 借鉴模型文本和展示分离。复用 ohbaby 的 displayUserText，不照搬双消息、source 标签或 origin 体系；仍 user role，并非完全等价的隐藏 |
| 2 请求看门狗 | DSH `packages/util/timeout/src/index.ts:idleWatchdog`，`packages/llm/llm-deepseek/src/adapter.ts`；ZCode `apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts:readNextWithStreamIdleTimeout` | 放在 llm-client，保护每次等待；不照抄默认秒数或新增 goal 专用超时 |
| 3 两轴预算 | Kimi `packages/agent-core-v2/src/features/goal/goalService.ts:wallClockDeadlineDelay/handleWallClockDeadline` 提供活跃时间截止；DSH goal 使用 roundsStarted/maxGoalRounds。Codex `codex-rs/ext/goal/src/accounting.rs` 按缓存优惠处理 token 预算 | 借鉴时间截止和轮次准入。token 计价分歧只作对照，本项目选择删除 token 闸门，保留统计；不搬 Codex 子代理归集 |
| 4 全文目标与稳定前缀 | Codex `codex-rs/ext/goal/templates/goals/continuation.md` 全文插入 objective；DSH `packages/goal/goal-round-driver/src/prompt.ts` 每轮生成 goal_round；Kimi `goalInjection.ts` 每轮从状态构造；ZCode 从 session target 重渲染 | 保留独立权威状态与每轮全文。删除 inactive 自动前缀，不改压缩算法；静态 system 规则稳定是本仓库缓存设计约束 |
| 5 轮次/时长 UI | Kimi `apps/kimi-code/src/tui/components/chrome/footer.ts` 显示 active、时长、turns；Codex `codex-rs/tui/src/bottom_pane/footer.rs` 显示预算计数与恢复指引 | 主要借 Kimi 的简短数字。token 不进入常驻 UI；不借 Codex 新色相或恢复确认弹窗。ZCode 工具迭代号不能当作 goal 轮次依据 |
| 6 模型自报完成 | Codex continuation 模板有 Completion audit；Claude Code Best `src/services/goal/prompts.ts` 和 GoalTool prompt 有自审；ZCode `core/src/runtime/methods/target-completion-verification.ts` 使用独立 verifier，模型侧 `tool/handlers/target.ts` 主要只读 | 保留自报与 prompt audit，不加 verifier。ZCode 是另一套完成权威，不是可零成本插入的补丁 |
| 7 + 12 准入与旧轮失效 | DSH `packages/goal/goal-round-driver/src/index.ts:RoundAttempt/readyToDrive/validReservation` 绑定 goalId/revision/round，`packages/goal/goal/src/fold.ts` 在 admit 后计轮；Kimi `goalService.ts:handleBeforeStep` 用 countedGoalTurns 幂等计数 | 借鉴身份校验和“获准执行才计数”。不抄持久 revision/activation；本项目同进程用最小执行身份和准入快照，并补共享执行权 |
| 8 插话与队列 | Codex `codex-rs/core/src/session/turn_input.rs` 支持普通输入 steer，Review/Compact 为不可 steer 类型；DSH `goal-round-driver/src/index.ts:readyToDrive` 检查 competingQueued；ZCode `docs/conversation-protocol-declaration.md:guideFallbackPreservesIntent` 保留回退输入身份 | 借 Codex 的 steer、DSH 的用户工作优先、ZCode 的回退不丢 intent。不能把 ZCode 的整个 queue gate 搬来，它有 incomplete goal 阻止 drain 的相反规则 |
| 9 状态与同因计数 | Kimi goal `types.ts` 是四值，`goalService.ts:settleAbnormalTurn/resumeGoal` 区分失败暂停与 blocked 恢复；Claude Code Best `src/services/goal/goalState.ts:recordBlockedAttempt` 比较 trim/lowercase 理由；Codex accounting 有进程内失败计数 | 四值与恢复参考 Kimi；同因字符串参考 Claude Code Best。连续三个已准入 goal 轮是 ohbaby 的明确约束，不声称参考项目已有同样硬门禁 |
| 10 不做 fork | Codex `codex-rs/state/src/runtime/goals.rs` 使用 continuation deferral；DSH goal types 将 durable phase 与 activation 分开，driver README 说明恢复/fork 动机 | 当前 ohbaby 无 fork，已有 active→paused 重启归一化，不引入额外激活维度 |
| 11 不做多目标队列 | Kimi 的 goal 命令/变更记录有 `/goal next`；DSH 的 competingQueued 指普通输入，不是多个目标 | 保持当前一个 session 一个目标；不把用户队列优先误扩成目标队列功能 |
| 13 带额度恢复 | DSH `packages/goal/goal/src/index.ts` 的 resume 检查 roundsStarted/maxGoalRounds，提示先增加上限；Kimi `goalService.ts:setBudgetLimits` 不自动启动；Claude Code Best `src/commands/goal/goal.tsx` 的 `/goal continue` 给出下一步 | 将改上限与恢复合成一次显式用户操作；不清零计数，不照搬 continue 重置语义。双维原子恢复是本项目对两轴预算的必要补齐 |
| 14 criterion 长度 | Kimi `goalService.ts` 定义 objective/criterion 同值 4000，但 criterion 使用 slice；Codex `codex-rs/protocol/src/protocol.rs` 创建目标超 4000 码点拒绝；`core/src/context/user_goal.rs` 说明截断可能改变约束 | 借同值上限形状，沿用 ohbaby 的 6000 UTF-16 length，拒绝静默截断；不增加联合上限 |

## 3.3 几处不能混为一谈的机制

### 请求空闲与任务停滞

DSH 看门狗只在 next 等待期间计时，可以通过自有 SSE 活动回调 pulse；finally 中不等待可能永不返回的 iterator.return。ZCode 用 Promise.race 让超时本身能结束等待。这些形状与“只发 abort 然后继续等”不同。

Codex `ext/goal/src/accounting.rs` 则统计零活动、执行失败且无成功工具等连续轮行为；`extension.rs` 将不可重试错误阻塞以防重复续跑。它不是流超时机制，本项目不引入这一套活动度判断。Claude Code Best 的非流式 fallback 超时也不能当作流空闲阈值证据。

### 三轮 blocked 审计

| 项目 | 实际约束 |
| --- | --- |
| Claude Code Best | recordBlockedAttempt 按调用次数累计同因；计数随 GoalState 存储，类型见 `src/types/logs.ts` |
| DSH | blocked 工具检查累计 roundsStarted 是否达到门槛，不检查每轮同因 |
| Codex | 模型三轮要求在 continuation 提示中；内存 accounting 的硬计数针对无活动/执行失败 |
| ohbaby 目标 | 按 run 绑定相邻三个已准入 goal 轮，同轮最多一次，非报告轮断链；内存计数 |

因此不能把“内存计数参考 Codex”扩写成“Codex 已实现同因三轮硬门禁”。本项目还需要自己的 run 绑定和重置规则。模型应在每个真正受阻的 goal 轮调用一次工具，由后端返回 1/3、2/3 或 blocked；不能照搬“模型先等三轮才报告”的提示，否则会叠加两层等待。

### 完成时机与用量

Codex `ext/goal/src/tool.rs` 在状态更新前 flush 用量，`state/src/runtime/goals.rs` 的过滤可包含 complete；但晚于完成到达的 usage 仍有时序限制。Claude Code Best 的流式工具可能早于尾部 usage 完成，不能作为“不漏记”的证明。ZCode `core/src/runtime/methods/turn.ts` 在 TurnComplete 和状态变更前结算，但其独立 verifier 架构使时序与 ohbaby 不同。

本项目采用持久 complete → 同目标尾部结算 → clear。没有完全同构的参考；选择理由是复用已有 complete 回放清理，避免“完成已通知但崩溃后又 paused”。不另建完成历史账本，替换/取消后的旧 usage 不追记。这是本项目对自身约束的取舍。

### 显式预算恢复与系统安全阀

Kimi/DSH 的 blocked 可经 resume 恢复；Codex 的 BudgetLimited 是独立终态，不能笼统写“Codex 所有 blocked/budget 状态都可恢复”。Claude Code Best `/goal continue` 是显式重置 max_turns，不等于 SetGoalBudget 自动恢复。

本项目预算可通过新总上限恢复，1000 轮安全阀不可覆盖。`/goal replace` 在 ohbaby 只是修改 objective，不能用它代替 cancel 后创建新目标。

### 长度上限与文本载体

Codex 的 4000 码点是创建/更新门槛，TUI `codex-rs/tui/src/goal_files.rs` 可先把超长目标转成文件引用；700 字节阈值只用于 `User set the goal` 溯源文本，超出整段省略。自动 continuation 仍发送状态中完整 objective。

Kimi 是本次核查中有独立 completionCriterion 的直接对照。其他项目没有这个字段时，不能据此声称它们证明了“两个字段必须同值”。同值只是最小且易解释的选择，拒绝截断则来自保留验收限制的要求。

## 3.4 明确不搬入的设计

- DSH 的持久 revision 与独立 activation：本项目无 fork，driver/store 同进程，按准入重渲染及进程内执行身份够用。
- Kimi 的通用 injection 处理：`goalInjection.ts` 注册 reminder，`reminderService.ts:125–137` 将其标为 `origin.kind = injection`，`compactionHandoff.ts:186–205` 按通用 origin 分类丢弃 injection/system_trigger，由后续注入重建。这不是 goal 专属压缩分支；本项目继续保留普通正文，不引入这套通用 origin/injection 协议。
- ZCode 的独立 verifier、整套输入可见性描述体系：超出当前成本和结构需要。
- Codex 独立 goals 数据库、六态和子代理预算归集：没有本项目需求支撑，不为形式一致而引入。
- Claude Code Best 的计满后清零继续：不符合本项目累计硬预算与不可覆盖安全阀语义。
- “所有数据都推到 UI”：只提供轮次、时长和必要分母；查询才提供统计明细。

本规划的参考依据已覆盖全部决议。后续 improve 仍需核对当时源码，但不应重新把已放弃方案作为默认实施路径。
