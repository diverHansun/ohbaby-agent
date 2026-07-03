# goals 模块 use-case.md

本文档说明 goals 模块围绕职责完成的关键业务动作——"职责如何被执行"，不是实现。概念沿用 [data-model.md](./data-model.md)，数据流沿用 [dfd-interface.md](./dfd-interface.md)，职责追溯 [goals-duty.md](./goals-duty.md)。

---

## 一、Use Case Overview（用例概览）

goals 的关键业务动作收敛为四个（每个都可追溯到 Duty）：

| Use Case | 一句话 | 追溯职责 |
|---|---|---|
| **UC-1 推进目标至终态** | 从 objective 起，跨多轮续跑到模型自判 complete/blocked 或预算/安全阀触发 | Duty 1/2/3/4 |
| **UC-2 让路插话后显式恢复** | 用户插话时停 goal、办用户短期目标、办完用户自行 resume | Duty 1/2 |
| **UC-3 跨重启重建目标** | 进程重启/`--resume` 后重建 goal 并安全降级 | Duty 1/6 |
| **UC-4 命令式生命周期控制** | 以 `/goal` 命令查询/暂停/恢复/取消/替换/设预算 | Duty 1/5 |

其余具体场景（模型 prose 创建、Esc、运行时错、预算到顶、安全阀触发、模糊目标）作为下述用例的**分支或失败点**，不单列。

---

## 二、Main Flow Description（主流程描述）

### UC-1 推进目标至终态

1. **接收创建**：命令 `/goal <objective>`（直写 store）或模型 `CreateGoal`（prose 自主请求）传入 objective（可选 criterion、可选预算参数）。空 objective 拒绝。
2. **建记录并起驱动**：GoalStore create → `active`；若有预算参数则 `setBudgetLimits`；追加 `goal.create` 记录；GoalService 启动 GoalDriver。
3. **续跑循环**（GoalDriver，每轮）：
   a. 预算/安全阀判定：任一已设预算到顶 **或** 未设 turn 预算且续跑轮数达安全阀上限 → markBlocked → 停。
   b. incrementTurn。
   c. 渲染续跑提醒文本（流 D）并作为 user 消息起一轮续跑 Run（首轮输入=objective，后续=GOAL_CONTINUATION_CORE + 进度 + 预算报告）；Run 内模型可调 goal 工具。
   d. 读 `RunCompletion` → 翻译为迁移（见责任边界与失败点）。
4. **自判终止**：模型在某轮调 `UpdateGoal('complete')`（成功，宣告即清，**完成总结就在这一轮里，不额外加轮**）或 `UpdateGoal('blocked', reason)`（判不可能/需输入）。
5. **预算/安全阀终止**：任一已设预算到顶或安全阀触发 → markBlocked（可恢复）。
6. **输出**：每次迁移追加记录 + 发布快照；complete 额外发完成消息后清记录。

> 分支——**模糊目标**：不做强制澄清轮；objective 直接建 goal，模型在首轮自审后若判"已答/不可能/矛盾"即 `complete`/`blocked`，不空跑。
> 分支——**预算收敛**：当任一预算用量达 75% 时，续跑提醒中标记"approaching budget limit, start converging"，模型据此主动收尾。

### UC-2 让路插话后显式恢复

1. **插话中断**：goal `active` 续跑期间用户发来普通消息。CLI in-process adapter 以 owner-aware interruption 让用户 Run 优先：先取消当前 goal Run，再起用户 Run。对用户可见语义是 interrupt-current；具体实现不要求 run-manager 对普通 user/user prompt 启用全局 `interrupt-current`。
2. **停 goal（不删）**：GoalDriver 捕获 cancelled → pause（`terminalReason: "interrupted"`）。goal 完整保留。
3. **办用户短期目标**：模型处理用户消息；与 goal 的工作在**同一 session、同一 message history** 中，模型能看到 goal 的进展 + 用户的插话。若用户连发多条，队列逐条办完。
4. **用户显式恢复**：用户完成小任务后，自行 `/goal resume` → goal 回 active → GoalDriver 重入续跑循环（回到 UC-1）。

> **不自动恢复。** 用户始终知道自己打断了 goal，知道自己要恢复。简单、可预测。
> **不做 context 隔离。** goal 的 turn 与普通任务的 turn 共享同一 session，模型在 resume 时能看到插话期间的增量，无需重复。
> 分支——**Esc**：pause（`terminalReason: "interrupted"`），同样不自动恢复，用户 `/goal resume` 才续。
> 分支——**运行时错/超时**：瞬时超时/provider 错由**继承的 llm-client 重试**兜（与正常对话一致，`maxRetriesPerStep`）；重试**耗尽**或不可重试才 Run failed → pause(`runtime-error`)，**不自动恢复**；用户排查后 `/goal resume` 恢复。

### UC-3 跨重启重建目标

1. **触发重建**：进程重启 / `--resume` 打开旧 session。
2. **回放重建**：`GoalStore.rebuild()` 通过 GoalPersistence 读取记录并回放成内存态（含预算、用量）。
3. **安全降级**：`GoalStore.normalizeAfterReplay()` 把任何 `active` 降级为 `paused`（驱动循环已不在跑，绝不能"自己又跑起来"），清理游离的 `complete`。
4. **等恢复**：用户 `/goal resume` 确定性恢复。

### UC-4 命令式生命周期控制

1. **接收命令**：`/goal status`（读快照）/ `pause` / `resume` / `cancel` / `replace <objective>` / 设预算参数。
2. **转发迁移**：命令层只解析转发；`/goal replace` 路由到 GoalStore 的 `replaceObjective`，GoalStore 执行对应迁移并校验合法性（如 `resume` 仅对 paused/blocked 有意义）。
3. **输出**：迁移结果 + 快照；`resume` 额外触发 ensure-driving 重入续跑；`cancel` 丢弃记录。

> 恢复路径统一：**只有 `/goal resume` 一条路。** 不自动恢复、不模型据意图恢复。任何 paused/blocked 的 goal，用户敲 `/goal resume` 即可确定性恢复。

---

## 三、Responsibility Boundaries（责任边界）

| 步骤 | 归属 | 说明 |
|---|---|---|
| 状态迁移合法性（谁能停、能否恢复） | **goals（GoalStore）** | 唯一入口，校验 actor 与迁移 |
| 续跑循环编排、预算/安全阀判定 | **goals（GoalDriver）** | 读 RunCompletion 翻译为迁移 |
| 续跑提醒 / light note 文本产出 | **goals（GoalInjector）** | active 续跑提醒写入 history；paused/blocked light note 作为普通用户 prompt 前缀 |
| 预算计算与报告 | **goals（budget）** | opt-in，三维独立判定 |
| 起 Run / 并发 / sandbox / 取消 | run-manager | goals 只 create + waitForCompletion |
| 上下文组装、compact | core/context | goals 供 user 消息，位置/压缩归 context |
| 权限模式 / 工具审批 | permission/policy | goal 循环在既定权限下跑 |
| 完成/阻塞判定、预算设置 | **模型**（经工具落到 goals） | goals 只记录模型声明的迁移，不替模型判断内容 |
| 记录落盘 / 字节存储 | services/database | services 只存取记录；GoalStore 定义回放与归一化逻辑 |
| CLI/Web 渲染 | UI 层 | goals 只发快照 |

一句话防胖：goals 负责**编排与状态**，不负责**执行、审批、组装、存储、渲染、内容判断**。

---

## 四、Failure & Decision Points（失败点与决策点）

- **预算到顶（防跑飞）**：任一已设预算维度到顶 → markBlocked(budget_exhausted)。**可恢复**——用户 `/goal resume` 再给一批。opt-in，不设则无此维度约束。
- **安全阀触发（防跑飞兜底）**：未设 turn 预算时，`turnsUsed` 达写死上限 → markBlocked(safety_cap_reached)。**可恢复**。这是唯一的自动"天花板"（仅未设 turn 预算时），零配置、零传参。单轮内 step-runaway 由运行时既有 `DEFAULT_MAX_STEPS` 兜住。
- **续跑 Run 失败（runtime-error）**：瞬时超时/provider 错已由继承的 llm-client 重试策略兜过（同正常对话）；仅当重试**耗尽**或错误**不可重试**时 Run failed → pause(`runtime-error`)，**不自动恢复**，交用户 `/goal resume`。goals 不加自己的重试层。
- **插话 Run 未干净完成**：用户 Run 失败/取消 → goal 保持 paused，等用户 `/goal resume`。不自动恢复。
- **恢复的统一性**：所有 paused/blocked 的恢复都是 `/goal resume`，不因缘由区分。简单、可预测。
- **模型误判 complete**：goals 不二次校验语义（Non-Duty），但完成是"宣告即清"——若用户不认可，可 `/goal <objective>` 重开或 `/goal replace <objective>`。
- **幂等性**：ensure-driving 幂等（重复触发不叠加多个 driver）；create 对空 objective 拒绝；cancel 后再 cancel 无副作用。
- **并发一致性**：续跑 Run 串行（adapter owner-aware interruption 下同一时刻至多一个活跃续跑 Run）；goal 迁移全部过 GoalStore 单入口，杜绝并发改状态。

---

## 五、文档自检

- 每个 UC 都追溯到 Duty（见概览表）。
- 明确了 goals 真正负责的步骤（编排/状态/提醒产出/预算）与外部步骤（执行/组装/存储/渲染/内容判断），未把外部行为误写成自身职责。
- 流程停在编排级，未展开实现伪代码。
- 至少覆盖多类失败/决策点：预算到顶、安全阀、运行时错、插话未净、恢复统一性、误判 complete、幂等、并发。
- 恢复路径统一为 `/goal resume`，不做 auto-resume、不区分 PauseCause。
