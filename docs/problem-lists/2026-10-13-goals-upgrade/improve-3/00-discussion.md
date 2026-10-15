# 第 3 批（improve-3）：讨论结论与继承边界

> 更新：2026-10-15。基线 main / `018a5c96`；本批与第 1、2 批均未实施。本文件冻结本批继承的总体结论与批次分工，不复述整体方案。
> 整体决策见 [plan/00](../plan/00-discussion.md)，工程约束见 [plan/02](../plan/02-optimization-plan-and-change-scope.md)，批次地图与验收归属见 [议题 README](../README.md)，验收基线见 [plan/04](../plan/04-test-and-acceptance.md)。
> 本批文档是实施契约草案；`05-implementation-acceptance.md` 在实施完成后单独撰写。文中的接口形状是工程细化，不新增产品决议。

## 1. 本批在整体中的位置

第 3 批补齐 goals 的**停止与恢复契约**：blocked 常驻状态、模型三轮同因审计、双维原子 resume、活跃时间截止，以及 SDK / CLI / Web 的 blocked 可见与可恢复。README 把 plan/04 的 B1、B3–B12、D1–D7 和 U7 的恢复入口划给本批。

- **前置**：第 2 批的共享准入、执行身份、准入计轮、完成与尾部结算、删除 token 硬限制。本批按这些**预期契约**编写，不把它们当当前代码事实。
- **并行回归**：与第 1 批（llm-client 空闲看门狗）验证「截止中断 × 请求超时」竞争，plan/04 的 W4 goal 部分由本批承接。
- **后置**：第 4 批（自动 steer 与消息恢复）复用本批的状态与恢复入口；第 5 批只消费本批建立的 blocked 投影语义与恢复规则。

## 2. 继承的总体决议（plan/00 决议 3、6、9、13，决议 5 的恢复入口部分）

| 决议 | 本批继承的结论 |
| --- | --- |
| 3 两轴预算 | 轮次与活跃时长两轴，默认不设置；时间到顶当轮中断，不等轮末；1000 轮安全阀独立且不可抬高；token 只统计不进预算 |
| 6 模型自报完成 | 不加 verifier；UpdateGoal 的 reason 只对 blocked 有效，complete 不记录理由；completionCriterion 只用于注入与显示 |
| 9 blocked 与三轮门禁 | 四态 active / paused / blocked / complete；模型只能 complete / blocked；三轮同因按已准入 goal run 计；删除历史 `blocked → paused` 归一化与 `GoalStoredStatus` |
| 13 带额度恢复 | resume 支持无参、单维、双维，两维可交换顺序；新值是**总额度**，不清零已用量；失败预算与状态都不改；SetGoalBudget 不自动恢复 |
| 5 展示 | blocked 经 adapter、SDK、CLI、Web 正确呈现，从现有恢复入口操作；不加新色相、进度条或组件框架 |

## 3. 本批已确认的范围（做什么）

| 项 | 结论 |
| --- | --- |
| blocked 常驻 | `GoalStatus` 增加 blocked；来源是两轴预算、安全阀、模型合格报告三种；预算 / 安全阀的翻换点同时覆盖 driver 出口与第 2 批准入路径里的到顶检查；恢复走同一个 `/goal resume` |
| 模型门禁 | UpdateGoal 只接受 complete / blocked；blocked 要求非空 reason；模型不能自我恢复为 active |
| 三轮同因审计 | 按已准入 goal run 计数，每轮最多贡献一次；同因按 `trim().toLowerCase()` 比较；第三个合格轮落盘 blocked 与本次原因 |
| resume 语义 | 无参、单维、双维，两维可交换顺序；未给维度保留；重复维度、非法数字、缺值、尾部垃圾、超 1000 轮或 24 小时明确拒绝；合并后检查两轴与安全阀，一条 update 同时写预算与 active、清停因，失败零修改 |
| 时间截止 | 显式时间上限是当轮截止：到点在状态变更边界核对后转 blocked，并中断该 goal 的执行；创建、恢复、objective 实改、预算变更后按最新 active 用量重排，旧定时器不能打断新轮或替代目标；等待用户工作时到点仍转 blocked，但不中断用户 run |
| 中断身份 | 截止中断携带预期执行身份（goalId + runId，复核由第 2 批 helper 承担）；新用户 run 不被打断 |
| 审计重置 | 只有从 paused / blocked 的**真正恢复**、objective 实改、新目标、进程重启重置审计链；同文 no-op 不重置；active 幂等 resume 和仅调额度不重置 |
| 客户端纵切 | SDK `UiGoalStatus` 增加 blocked；CLI 常驻行、Web chip 与面板展示 blocked 并可恢复；Web 恢复入口给最少可选的两维输入 |

## 4. 本批不做（边界与归属）

| 项 | 归属或结论 |
| --- | --- |
| 通用请求空闲看门狗本体、超时错误分类 | 第 1 批 |
| 共享执行准入、执行身份基建、准入计轮、旧结果保护、complete 持久化与尾部结算、静默 usage 刷新、token 闸门删除 | 第 2 批 |
| accept 后自动 steer、稳定 FIFO、未消费输入提示与重发 | 第 4 批 |
| 常驻条轮次 / 时长数字、正文与短展示分离、criterion 长度校验 | 第 5 批 |
| token 的再次处理 | 第 2 批已删除；本批只处理剩余两轴，不恢复 token 语义 |
| 多目标队列、fork、独立 verifier、语义停滞检测、`/goal budget` 命令、安全阀抬高、用 replace 重置计数 | 明确不做（plan/00 决议 10、11；plan/02 §2.3） |

## 5. 依赖的跨批契约（规划已对齐；实施前核对第 2 批实际验收与源码）

| 来源 | 本批依赖 | 用途 |
| --- | --- | --- |
| improve-2 | 准入票据绑定表：runId → { goalId, executionEpoch, turnNumber }；票据从 token 占位起存在，runId 随后附加，settle / complete 处理完才清除，不落盘；`executionEpoch` 由 GoalService 持有，生命周期转换（pause / cancel / complete 清除 / replace 新建 / objective 实改 / 真正 resume）时**立即递增**，不等新 driver 启动；driver 循环启动时捕获一次、整段固定，不每轮重捕获；普通用户主 run 经实际 owner 验证，无 goal 准入票据；缺票据本身不等于用户身份，steer 与 goal run 共享 runId 与绑定 | 三轮审计用 (runId, goalId, 有效 executionEpoch) 判资格、用 runId 去重「同轮一次」；steer 不新增审计轮 |
| improve-2 | `withSessionMutation`（= session 投影的 promise tail / owner.runControl 窄端口，经依赖注入拿到，见 improve-2/02 §2.2）作为每 session 唯一串行区 | resume 的读→合并→检查→一条 update 整段在一个排队条目内；区内只做裸 store 操作，不调用会再入队的公共方法；`ensureDriving`、定时器重排、中断 await 都在区外；不自建第二把锁 |
| improve-2 | `GoalExecutionInterruptInput.expectedRunId`（或等价票据），中断 helper 在异步等待后复核身份（见 improve-2/02 §2.4） | 截止中断只终止预期的 goal run，新用户 run 不被打断 |
| improve-2 | store 单条 update 写「预算 + 状态 + 清停因」的入口由本批新增（第 2 批不提供） | 维护 store 唯一写入入口与失败零修改 |
| improve-2 | 准入路径内的预算 / 安全阀到顶检查；driver 现有 pause 出口 | 本批把两处出口从 paused 改成 blocked，门禁与准入顺序不动 |
| improve-1 | 请求空闲超时的独立错误分类，与用户取消、外部 abort 区分 | 截止中断与 watchdog 超时竞争时，迟到失败不得改写 blocked 状态 |

若前序实际落地与上表不同，按 [议题 README](../README.md) 的规则先调整本批 02 的衔接，不照搬预先写好的符号名。

## 6. 确认记录

- 五批分工的来源：用户授权规划并指定由子代理撰写、主代理审核；五批地图由主代理提出并经代理复核（见 [议题 README](../README.md) 的五批实施地图）。本批不是用户对每个批次逐项拍板的结果。
- 同期澄清：只有真正从 paused / blocked 恢复才重置审计链；active 幂等或仅调整额度不重置。
- 本文是批次结论的转述，不是用户原话；plan/00 §4 保存总体原话。评审建议与工程细化不等于用户对每个函数签名的批准。

## 本次代码审查后的修订（2026-10-15）

继承第 2 批的 objective 实改失效和 goal root 中断；同文不清审计链。模型每个真正受阻轮报告一次，由后端计到三轮，不再叠加“先等三轮再报告”。Web 带参 resume 直接传完整命令到后端，无参仍走面板；覆盖 composer 与面板两条恢复入口。这是对已有决策的工程补齐，授权原文见 [plan/00](../plan/00-discussion.md)；尚未实施。
