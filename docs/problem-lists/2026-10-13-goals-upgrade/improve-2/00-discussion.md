# 00 讨论记录：第 2 批（执行准入与统计基础）

> 本文件记录本批已确认的范围与结论。业务决策来源是 `plan/00`–`plan/04` 的总体决议；批次划分与承重范围由主代理在用户授权后提出、经独立代理复核，不是用户原话，也未经用户逐条批准。
> 规划基线：main / `018a5c96`，此前各批尚未实施。总体规划见 [../plan/00-discussion.md](../plan/00-discussion.md)，行为约束见 [../plan/02](../plan/02-optimization-plan-and-change-scope.md)，验收基线见 [../plan/04](../plan/04-test-and-acceptance.md)。
> 文中出现的接口、字段名是**预期实现**示意，用来固定行为与所有权，不是用户已批准的最终签名；实施会话可在满足同一契约的前提下调整命名。

## 1. 批次定位

总体分 5 批实施：1 通用请求 watchdog；**2（本批）执行准入与统计基础**；3 blocked、三轮同因审计、多维 resume、硬时间截止与 SDK/CLI/Web 状态恢复；4 自动 steer 与 FIFO、未消费输入恢复 UI；5 displayText 展示、删除 inactive 注入、criterion 6000、数字 UI。

本批解决两件事。第一，一个 session 里"谁有权执行"目前有三个各说各话的入口（用户 claim、goal 续跑、手动 compact），检查和占位之间还夹着 await，导致普通输入打断 goal、排队项提前占容量、旧执行污染新目标。第二，完成与统计在轮末结算、token 闸门和用量通道上都有已知缺口。这两块是后续 steer（4）、blocked 与截止（3）、UI 数字（5）的地基，先做。

## 2. 已确认结论（本批）

### 决议 A：统一 session 执行权占位，用户队列优先

- 本 session 的执行权收敛为一个占位（下称"门禁"），三类持有者：普通用户 run、goal 轮、手动 compact。同一时刻最多一个持有者。
- 用户 claim、goal 准入和 manual compact 登记，都在同一个串行边界里完成“复查条件、持久化、登记占位”，不再出现"先查空闲、await 之后再 set"的窗口。
- 用户队列优先：goal 只有在本 session 没有 queued / starting / running 的普通用户工作、也没有 compact 占位时才准入门禁。当前 goal 轮结束后，已排队用户消息先跑；用户队列清空后 goal 才进下一轮。不设 goal 插队配额。
- goal 正忙时，已排队的用户消息保持 queued：不提前 claim，不占 `maxActiveSessions` 名额，也不打断 goal。

### 决议 B：过渡态——普通输入只排队，不打断

- 删除"普通输入打断 goal"分支（pause + interrupt + 等待）及其专用 helper；删完后用户撞 goal 必须落到"等待排队"，不能落进通用 throw。
- 显式 `/goal pause`、stop、runtime error 仍可停止 goal，不受影响。
- 本批不实现"接受后自动 steer"（归第 4 批）；现有的显式手动 steer（`steerQueuedPrompt` 入口）保持现状不动。
- 说明：只排队意味着用户输入要等当前 goal 轮跑完才被执行，这是第 4 批自动 steer 落地前的过渡行为，不是最终设计。

### 决议 C：准入计轮与同一快照

- `GoalTurnRunner` 不再接收 driver 提前渲染的 prompt 文本。
- 取得执行权后：核对 goalId / active / 预算与安全阀 → 持久化本次计轮 → 用这份准入快照同时生成模型正文与简短展示文本。轮号、正文、展示值不来自两次读取。
- 用户工作或 compact 仍忙时，在准入循环内等待唤醒，不计轮、不构造过期消息；目标或生命周期失效才返回 `not_admitted`。订阅早于检查，唤醒后重新判断，事件驱动而不忙转。
- 计轮持久化失败：内存不虚增，占位释放干净；启动失败发生在计轮成功之后，这一轮保留。

### 决议 D：进程内身份，旧结果不污染新生命周期

- 身份用最小的进程内代号（executionEpoch）+ 已有 runId，不引入持久 revision，不把字段版本化。
- succeeded / failed / cancelled / 外层 catch / 截止中断 / finally 清理都携带本次执行身份：目标或生命周期已不是自己这一代，就不能改状态、不能暂停新目标、不能删掉后继执行者的记录。
- 同目标迟到 usage 仍可结算（写进 paused / blocked / complete 的统计），状态回写必须 executionEpoch 匹配。两者分开判定。
- pause 与 resume 重叠、driver 退出与重新驱动重叠时：最后恰有一个有效 driver。driver finally 只清理自己的条目；仅为已提交后继 goalId/epoch 或尚未消费的显式驱动请求补一次 ensureDriving；同代致命失败不自动重启，待结算 recovery 仍阻止准入。

### 决议 E：complete 持久终态与结算

- complete 先持久化为终态（不再"宣告即清除"）：停止后续准入，UI 立即投影为空，完成通知只发一次。
- 同目标最后一批已准入 run 的 usage 结算到该目标，然后清除；complete 时没有该目标待结算的 run，就直接清除，不等待不存在的回调。
- complete 残留期间：resume、replace objective、预算编辑都被拒绝；新建目标不受残留阻挡。
- 崩溃发生在"complete 已落盘、clear 未写"之间：回放直接清理 complete，不降为 paused，不恢复驱动。
- 不新建按 goalId 的历史结算 map，不建历史账本；目标被替换或取消后的旧结算直接跳过。

### 决议 F：删除 token 预算闸门，补齐 usage 通道

- 删除 goal 的 token 预算：配置字段、计算、工具单位、提醒文案、converging 判定一并去掉。totalTokens 与缓存命中只作统计，不再可能触发停止。
- usage 通道补齐：succeeded / failed / cancelled 都回传已知 usage，不因终态丢弃；总用量、缓存读取量、完整性（是否部分统计）沿同一通道到 store 与查询输出，未知不伪装成零。
- store 持久化读兼容：旧记录里的 token 预算字段被忽略，缺新字段时按未知处理，不回写旧格式。
- 计轮与 usage 的刷新走数据刷新通道（`goal.updated`），不追加生命周期 notice；运行时提醒（续跑正文）不含 token，查询（`/goal status`、GetGoal）保留统计明细并标出部分统计。
- 75% converging 提醒只看轮次与活跃时长两个维度；子代理与压缩摘要用量不归集。

### 决议 G：预算过渡态（明确不是最终设计）

- 本批到顶（轮次或时长）仍按现状转 paused；blocked、当轮内硬时间截止、带上限 resume 都是第 3 批。
- 本批只保证：token 维度不再存在、用量不丢、身份正确。不要在第 3 批之前把 blocked 写进状态机或文案。

### 决议 H：落地边界

- 复用现有 commit 队列（`SourceSessionProjection.owner` 每 session 串行区）和运行 gate，不自造第二套调度器。
- 不新建 settlement map、独立事件总线、activation 层、持久 revision、verifier。
- 跨包影响只按本批 02 的实际接口范围：本批改的是 goals 内部类型（`GoalSnapshot` 等）与 adapter 行为；`UiGoal` 的数字字段（turnsUsed / wallClockMs / blocked）归第 5 批和第 3 批，本批不动 SDK 展示契约。

## 3. 本批不做，留给后续批次

| 事项 | 归批 | 本批只保证 |
| --- | --- | --- |
| blocked 状态、三轮同因、硬时间截止、带额度 resume | 3 | 预算到顶仍是 paused，动作边界清晰可替换 |
| 自动 steer（accept 后分流）、FIFO 细节、未消费输入恢复 UI | 4 | 排队不打断、顺序稳定、目标忙不提前 claim |
| displayText 落库与实时/回放一致、删除 inactive 注入、criterion 6000、CLI/Web 数字 | 5 | 准入时同时产出正文与展示值，后续不重复渲染 |
| 通用请求空闲 watchdog | 1 | 与本批无接口耦合 |

## 4. 待实施会话确认的工程细节

- 门禁的具体命名与文件落点（本批 02 给出示意）。
- `GoalChangeKind` 增加"数据刷新"类的最终命名。
- 计轮落盘等待期间收到 pause 的边界行为，按本批 02 §2.3 的契约实现（计轮已落盘即算一轮，但不启动 run）。
- 同一 run 内工具 replace 目标后的回写判定，按本批 02 §2.3 的契约实现。

## 本次代码审查后的修订（2026-10-15）

objective 实改递增既有 epoch，goalId/预算/累计统计保留；同文 no-op 不失效。工具内部真实 runId、准备取消、goal root 定点中断及票据 outcome 的显式恢复均在本批闭合；同代致命失败不在 finally 自动重试。详见 02 §2.3–2.5 与 04 G8/G21/G24/G26–G28。这是对已有决策的工程补齐，授权原文见 [plan/00](../plan/00-discussion.md)；尚未实施。
