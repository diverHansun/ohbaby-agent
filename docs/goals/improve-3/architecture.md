# goals 第 3 批架构：停止与恢复

> 2026-10-15；基于 [improve-2](../improve-2/architecture.md)。本目录描述本批实施后的阶段状态，原始 goals 文档保留。契约见 [improve-3/02](../../problem-lists/2026-10-13-goals-upgrade/improve-3/02-optimization-plan-and-change-scope.md)，实测与限制见 [05](../../problem-lists/2026-10-13-goals-upgrade/improve-3/05-implementation-acceptance.md)。自动 steer、常驻数字与 inactive 注入清理由后续批次交付。

GoalStore 仍是持久化唯一写入入口，GoalService 持有每 session 的状态、执行身份与 driver，adapter 负责执行和投影。新加两个局部模块：`blocked-audit.ts` 保存进程内的最近一次合格报告；`budget-input.ts` 统一命令与工具的额度解析。没有新增锁、调度器、数据库或依赖。

## 停止语义

| 状态 | 来源 | 恢复 |
| --- | --- | --- |
| active | 创建或显式恢复 | 自动续跑，服从共享准入与用户优先 |
| paused | 用户 stop/pause、执行失败、重启时 active 降级 | 检查额度后 `/goal resume` |
| blocked | 两轴预算、1000 轮安全阀、模型合格的连续三轮同因报告 | 同一 resume 入口；安全阀耗尽只能 cancel 后新建 |
| complete | 模型自报完成 | 不可恢复；结算尾部后 clear |

预算的轮数是准入上限，最后一个允许轮可以完成。时间上限是 active 状态的截止，包含等待用户工作与工具执行的时间。paused/blocked 不累计。运行失败不会覆盖已经提交的 blocked，截止也不能覆盖已经提交的 paused。

## 状态变更边界

复用 `withSessionMutation` 的 session owner 队列：区外初始化；区内读最新快照、检查资格、append、提交内存、失效 epoch/取消准备；区外重排 timer、请求 driver 或等待中断。区内不能调用会再次进入该队列的公共入口。预算恢复的读、合并、检查、单条 update 全在一个队列条目内，失败不改预算或状态。

`resumeWithBudget` 同时保存两轴与 active、清除 pauseReason。active 上无变化恢复是幂等操作，不写记录、不重置审计；active 调整额度保留时间锚点，不因等待 append 而赠送活跃时间。真正从停止状态恢复才换 epoch 并清审计链。

## 时间截止

每个 active 且设时间预算的 session 一个 unref timer。创建、恢复、objective 实改和预算变化后，用最新累计 active 用量重排。每个回调捕获独立 token；进入 session 串行区后再次核对 token、goalId、状态和预算。旧回调不清新 timer；早到回调按剩余时间重新安排。

到顶时先捕获实际 goal 票据，再保存 blocked、失效 epoch，最后在区外中断票据对应的主 run 与子树。捕获执行范围不使用 mutation 资格筛选：正文刚编辑后，旧 epoch 的同 goal run 仍需在原累计截止被停止。还没有 runId 的准备阶段依靠票据 controller 取消，继承 improve-2 启动与 runReady 交接保护。无 goal 票据时只更新目标状态，不触碰正在执行的用户 run。

pause/block/complete/cancel 清 timer，`closeAdmission` 调用 GoalService.dispose 清理全部 timer，随后继续既有 driver 尾结算和 scheduler 恢复。dispose 不把尚未落盘的统计当作已结算。

## 三轮审计

模型只能 complete 或 blocked；blocked 要求非空理由。只有当前 goal-owned run 的有效票据可贡献一次，普通用户 run 无审计资格。比较 `trim().toLowerCase()` 的原因，票据轮号必须相邻；中间无报告轮或理由改变从 1 开始。同 run 的多次调用及 steer 内的工具不增加轮数。

第三次先写 blocked，成功才提交内存计数；失败仍停在 2/3，可在同 run 重试。真正恢复、objective 实改、新目标和重启清链；同文 no-op、active 幂等恢复、仅调额度不清。最终 blocked 与原因落盘，审计链不落盘。模型 blocked 与 complete 均允许当前主 run 收尾，只取消所属子树的冗余执行。

截止 append 失败不能伪造 blocked 成功，也不能放任已捕获执行继续。失败路径取消准备、保留 stopIntent 并在区外中断原 root，报告原始存储错误；不递增 epoch，以免 active 状态触发后继 driver。普通取消结果仍由既有 driver/finalization 处理；若此时还能写 paused，保留截止原因并记 runtime 来源。若磁盘持续拒绝写入，内存可能仍显示 active，但原执行已经停止且 timer 已清除；只在后续显式操作或准入重新检查，不自动重试。无 goal 票据时不执行任何 session 范围的中断。

历史 [状态简化决定](../2026-07-03-state-contract-simplification.md)中“blocked 非常驻”的对应结论由本批取代；[普通输入中断记录](../2026-07-03-interrupt-current-light-note.md)的变更已由 improve-2 接续。两份原始记录保留，不倒改历史。
