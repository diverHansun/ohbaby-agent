# 第 5 批参考项目与实际取舍

> 本批只关心两件事：**溢出恢复怎么不双花**、**手动入口怎么处理忙**。参考根目录 `/Users/hansun025/Projects/code-cli/`。
> 本文件只记录**本批用到的局部结论**，不宣称存在统一最佳做法；完整十家对照见 [plan/03](../plan/03-reference-projects.md) §5.6。ohbaby 的规则以 [00](./00-discussion.md) 和 [02](./02-optimization-plan-and-change-scope.md) 为准，**不盲抄**。

## 3.1 本批实际核对的来源

| 项目 | 本批重核的位置 | 结论 |
| --- | --- | --- |
| ZCode | `ZCode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts:749`、`:662`；`turn-loop-state.ts:104` | 每 model step 一个 `reactiveCompactAttemptedInCurrentModelStep` 一次性标志：进入压缩前置位，新 step 才复位 |
| Pi | `pi/packages/coding-agent/src/core/agent-session.ts:405`、`:3019`、`:3042` | 每 run 一个 `_overflowRecoveryAttempted` 一次性标志，先判后置位、失败不回滚 |
| claude-code（本地重建版） | `claude-code/src/services/compact/autoCompact.ts:99` | 连续自动压缩失败熔断 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` |
| opencode / 其余 | 见 plan/03 §5.6 | 本次未逐一重核，按 plan 记录引用，不作为本批直接依据 |

ZCode 与 Pi 是本批「force 一次、标志调用前置位、失败不回滚」的主要参照；claude-code 的熔断只用来对照「不用成功计数控制失败」，**不采用**它的固定失败次数闩锁。

## 3.2 可借鉴点与 ohbaby 取舍

| 做法 | 参考 | ohbaby 采用方式 |
| --- | --- | --- |
| 溢出标为不可重试、只进 force 入口 | kimi／pi（plan/03 §5.6） | **adopt**：结构上错开「自动触发」与「溢出触发」，同一失败不各拿一次额度 |
| 一次性标志先置位、不回滚 | ZCode／Pi（已重核） | **adopt**：作用域是本次溢出恢复流程；输入快照变化重入同一步不重新获额，新 step／新 run 才复位 |
| 成功后重发不挂恢复钩子、二次溢出直接结束 | opencode 新路径（plan/03 §5.6） | **adopt**：对应 04 的 E4 |
| 连续失败固定熔断 | claude-code（已重核） | **reject**：已确认不增加永久失败锁，压不下即失败、保留原历史，下次该触发照常触发 |
| 自动／overflow 共享失败结果、不跨入口再取额度 | ohbaby 已确认规则，参考比较见 plan/03 §5.6 | 本批按自己的规则做跨入口回归，不将各项目不同的恢复策略概括成一致实现 |

## 3.3 明确不借鉴

- 用固定成功次数帽控制失败（参考项目里保留次数上限的多半因为没有失败终止机制；ohbaby 有，所以不需要）。
- 忙时静默 abort 当前任务或加入隐藏队列（Pi 手动入口会 abort；ohbaby 选择忙时提示、空闲执行）。
- 为「字段统一」更换请求形状、或在清扫中引入版本服务／永久锁。

## 3.4 对 02 方案的影响

[02](./02-optimization-plan-and-change-scope.md) 的 Stage 3 回归 force 标志与跨入口失败终止，Stage 1 保留手动忙时拒绝。这些规则已在 plan 确定；参考只解释局部取舍，不作为整套方案的正确性证明。
