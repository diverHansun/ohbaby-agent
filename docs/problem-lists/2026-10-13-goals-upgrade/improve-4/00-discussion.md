# 4. 讨论记录与已确认要点

> 批次：improve-4（自动 steer + FIFO 顺序 + 未消费恢复）。文档基线 main / `018a5c96`，与 plan 相同。
> 本文区分两类结论：**继承的用户决定**（来自 [plan/00](../plan/00-discussion.md) 决议 8 与 [plan/02](../plan/02-optimization-plan-and-change-scope.md) §2.5，用户已确认）和**本批工程提案**（为落地这些决定新定的工程形状，由主代理审核，供用户审阅；不表示用户逐条批准）。
> 所有前序批次（improve-1/2/3）尚未实施。本文一律把它们的产出写成"预期契约"，不当作现状。

## 1. 本批范围

一句话：把"普通输入优先 steer"从人工动作改成 accept 路径上的自动分流，并把未消费输入的提示与重发做成跨 run、重启后仍可用的可操作事实。

包括：

- 自动 steer 挂点：普通输入持久接受后、claim 前，尝试 steer 进正在执行的 goal run。
- 同 session 稳定 FIFO：A 已排队时，后到的 B 不得 steer 越过 A。
- steer 结果的类型化：预期竞争（保留排队）与真错（如实报错）分开。
- 未消费 / 处理未确认的跨 run 投影、显式重发、CLI/Web 可见操作。

## 2. 继承的用户决定（plan 已确认，不重新讨论）

| 决定 | 来源 |
| --- | --- |
| 普通输入先接受并持久化，claim 前尝试 steer 到正在执行的 goal run；成功 steer 不中断、不暂停、不建新 run、不加轮 | plan/00 决议 8.1–8.2 |
| 目标已封口、已关闭等预期竞争保留同一队列项；存储失败、身份冲突、内部异常如实报错，不伪装成功 | plan/00 决议 8.3、plan/02 §2.5 |
| 有更早 queued 项时后来者不得 steer 越过；顺序是 session 接受顺序，不靠同毫秒随机 UUID | plan/00 决议 8、plan/02 §2.5 |
| 放宽未消费提示：不限 user-stop、不限最近 run；原文可辨认、可显式重发；重发是新请求，不静默重放 | plan/00 决议 8.8、plan/02 §2.5 |
| 接受不等于模型已处理；本地 attempt 不等于 provider 收到 | plan/00 决议 8 末段 |
| 成功 steer 共享当前 run 的 Todo scope / reasoning / 剩余 step，UI 不承诺每条消息独立回答 | plan/02 §2.5 |
| 大 protected input 超限：显示失败与未处理状态，不丢输入、不无限扩上下文 | plan/02 §2.5 末段 |

## 3. 本批工程约束（依用户授权修订）

| ID | 提案 | 一句话理由 |
| --- | --- | --- |
| E1 | 自动 steer 插在 `WorkspacePromptScheduler.accept` 已进入的 owner 提交回调内（持久接受后、释放前），复用批 2 的同一 session 顺序，一次进入、不新建锁 | 公共 accept 返回后再分流不具原子性；在区内调公共 steer 会重入同一串行区而死锁 |
| E2 | 批 2 挂点在 accept 的同一串行区核对 active、当前 goalId、有效 executionEpoch 与未封口 run；steer 事务再复核 run 接收状态 | complete / blocked 或替换后仍在收尾的旧 run 不再接收自动 steer；失配保留原项 queued |
| E3 | FIFO 判定复用 `prompt_submission` 现成的 `accepted_at` + `admission_order`（两个 store 都按 scope 单调），不新增序列字段、不建通用队列 | 现表已有稳定顺序依据 |
| E4 | 结果分为 `steered` / `not-steered`（保留 queued 与原因）/ `existing`（复用旧记录真实状态）/ `error`（真错） | 同 id 重试可能已在运行或结束，不能一概伪报 queued |
| E5 | 自动 steer 的幂等键用接受请求自身的 `clientRequestId`；同一 id 只复用旧 receipt 与旧分流决定，不做第二次尝试 | 重试不改投、不二次 steer |
| E6 | 未消费事实由**会话级列表**承载：`UiSession.unconsumedSteers`（inputId、promptId、messageId、text、state）；转录里的标记由 messageId 关联派生；删除 `UiRun.unsentSteer` 与 SDK 的 `hasUnsentSteerAfterLatestStop` | 不能从"当前已加载消息"推断全量（分页 / 压缩 / 重连会吞老记录）；一个事实一个载体 |
| E7 | 显式重发 = 走同一 accept 路径创建**新 prompt**（新 promptId、新 userMessageId）；`clientRequestId` 由 `operationId` 派生保证幂等；子记录存最小外键 `resendOfPromptId`（下一可用迁移，非唯一）。允许用户显式多次重发，每次一个新 operationId；同 operationId 重试返回同一 receipt | 复用 accept 现成的幂等；不重放旧身份；不做未批准的"每输入只能重发一次"限制 |
| E8 | 提示规则：条目被本地标记确认处理（`processedRequestId` 是本地请求成功标记，**不代表模型已理解**）或存在"仍在执行路径 / 已处理"的重发子项时不再计数；子项 cancelled / failed 且未被消费时，原项提示恢复；历史原文保留 | 现状"后继 Stop 覆盖提示"会丢事实；不做"已读"账本 |

## 4. 明确不做（本批边界）

- 不做通用消息确认 / 回执平台：除 E7 的一个可空列外不新增表、不新增事件系统、不在 goals 模块建历史账本或结算 map。
- 不新建第二把锁、第二套执行门禁；批 2 的 `SessionExecutionGate` 与固定锁顺序不改，本批只在已进入的 accept 回调内做短操作。
- 不做多目标队列、fork、激活层；不改 run-manager 底层并发政策、sandbox 与权限决策。
- 不改 goal 正文与展示文本（displayText 属批 5）；不改 blocked 三轮审计（批 3）。
- 不把 steered 内容静默重放；无法证明 provider 收到时不写“已发送”，也不写“从未发送”。

## 5. 与前序批次的接口（预期，未实施）

| 依赖 | 提供方 | 本批用法 |
| --- | --- | --- |
| 共享门禁 `SessionExecutionGate`、锁顺序（提交 barrier → session owner 串行区 → 内存占位表 → run 在锁外）、用户队列优先、goal 忙不提前 claim | 批 2（improve-2/02 的预期交付） | 自动 steer 只是在既有 accept 回调里加一段短写；不占 gate 租约、不二次进入 owner 串行区 |
| 只读挂点 `getActiveGoalRunForSteer(sessionId) => { runId; goalId } \| undefined`；内部核对 executionEpoch，不向 scheduler 暴露 | 批 2 的预期交付 | accept 同一区内检查当前 goal 为 active、goalId 与有效票据一致、run 可接收且未封口；不合格返回 undefined。scheduler 只用 runId |
| 批 2 的 runId 执行身份绑定（内部含 goalId 与执行代数，修稿改用 executionEpoch，不对外暴露） | 批 2 | steer 共享原 goal runId 绑定；不新建绑定、不增轮 |
| blocked 三轮审计绑定 goal run | 批 3 | steer 不新增 run / 轮，审计计数不受影响 |
| displayText 与数字 UI | 批 5 | 本批不碰 |

批 2 / 批 3 是本批的**实施前置**，不是可选的降级开关：现行代码在没有批 2 门禁时，普通输入会继续打断并暂停 goal，不存在"只排队"的中间形态；本批不承诺先于前置批次发布。

## 6. 参考项目

定点三处：Codex `turn_input.rs`（start / steer / 拒绝的类型化单一决策点）、DSH `competingQueued`（用户工作优先）、ZCode `guideFallbackPreservesIntent`（预期回退保留同一 intent 与顺序）。取舍与不借鉴项见 [03](./03-reference-projects.md)。

## 本次代码审查后的修订（2026-10-15）

裸 store steer 成功后还须完成 scheduler 的 prompt.updated、onSteered 和 completion waiter；自动/手动共用不重入 owner 的后续处理。同 id 并发重试在分流前读到 queued，也必须在成功后收到结算。验收见 04 S4-20/S4-21。这是对已有决策的工程补齐，授权原文见 [plan/00](../plan/00-discussion.md)；尚未实施。
