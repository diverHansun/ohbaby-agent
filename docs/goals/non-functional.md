# goals 模块 non-functional.md

本文档显式声明 goals 模块在功能正确之外必须站住的工程约束。只写这个模块**特有**的约束，不写通用最佳实践。前置 [goals-duty.md](./goals-duty.md) / [architecture.md](./architecture.md) / [dfd-interface.md](./dfd-interface.md)。

> 这个模块最独特的非功能语境：**它会长时间自主续跑（无人值守）、把用户 objective 当输入、并跨越进程崩溃与 `--resume`**。这三点决定了下面的优先级——安全与可靠性远压过性能。

---

## 一、Quality Priorities（质量优先级，有序）

1. **安全（无人值守下的权限安全 + 防注入）— 最高。** goal 循环可连续自主跑多轮；在宽松权限模式下这意味着**无人值守地执行工具/命令**。同时 objective / completion criterion 是**不可信数据**。这两点是本模块相对"普通单轮"最独特、最危险的属性，必须最优先守住。
2. **可靠性（崩溃可恢复 + 恢复安全）— 次高。** 长任务天然跨进程退出/崩溃/`--resume`。goal 必须能从记录重建；且恢复的默认姿态是**停**（active→paused），绝不在无人知情时"自己又跑起来"。
3. **可预测的终止与成本可控。** 防跑飞靠四条：模型自审（主）+ 用户随时中断 + opt-in 预算（turn/token/active-time，到顶 pause、可恢复）+ 不可配置的 1000-turn 系统绝对安全阀。未声明预算时不创建产品级限制，agent 按任务完成度规划；安全阀只处理异常循环，不作为默认预算或规划目标。
4. **可观测性（进度可见、可审计）。** 无人值守的工作必须能被看见与回溯，否则用户无法信任它自主跑。
5. **实现简单 > 性能。** 明确把降复杂度排在性能之上：本模块不是延迟热点（模型调用延迟主导），driver 编排与每轮提醒渲染的开销可忽略。刻意不为性能牺牲清晰度。

（性能/吞吐不进优先级前列——见运行约束的说明。）

---

## 二、Operational Constraints（运行约束）

- **串行、不并发**：goal 续跑 Run 串行（CLI adapter 的 owner-aware interruption 下同一时刻至多一个活跃续跑 Run）；goals 不追求并发推进。用户插话会先暂停 goal，再执行用户 Run。
- **提醒开销可忽略**：GoalInjector 每轮重算纯字符串，相对一次模型调用可忽略；不做缓存优化（YAGNI）。提醒作为 user 消息 append 到 history，每轮约 200-500 tokens，旧的可被 compact 压缩。
- **不稳定外部依赖的方向性约束**：
  - 模型/provider/网络：瞬时超时/provider 错由**继承的 llm-client 重试策略**处理（与正常对话完全一致，`DEFAULT_PROVIDER_RETRY_POLICY` / `maxRetriesPerStep`，尊重 retry-after）；仅当重试**耗尽**或错误**不可重试**才 → pause(`runtime-error`)，不自动恢复，交用户 `/goal resume`。
  - run-manager：续跑 Run failed → pause；cancelled → pause。goals **不加自己的重试层**——重试是 llm-client/step 级的继承能力，不是 goals 的 Run 级重试。
  - services/database：记录落盘失败必须显性（不得让 goal 看似在跑却无法重建）。
- **权限模式约束**：goal 循环在**既定权限模式**下运行，不放宽也不收紧。无人值守场景应由用户选择"与仓库风险和可执行命令相匹配"的权限模式；在 manual 模式下，goal 工作可能因工具审批而暂停等待——这是**可接受**的预期行为，不是缺陷。
- **成本约束**：opt-in 预算按 turn/token/active-time 三维控制；main 只翻译用户、system 或 developer 明确给出的自然语言限制，禁止自行发明。time 只累计 active pursuit，在 continuation 边界判定。系统安全阀始终是写死的 1000 goal turns。长任务的 token 成本由用户对目标、预算与权限模式的选择承担；goals 保证不会无限循环。
- **停止一致性**：goal 从 active 进入 pause/cancel 后，当前 daemon 内 goal-owned primary 与 active subagents 必须停止；subagent record/context/queue 保留。状态迁移先关闭续跑入口，adapter 中断必须被 await，失败不得静默。
- **complete 收敛**：main 仅在全部 subagents 结束，目标、验证与最终结论完成后调用 complete；工具返回后输出最终回答并结束。runtime 对仍 active 的 straggler 做 interrupt-only 兜底，不 close。

---

## 三、Reliability & Observability（可靠性与可观测性）

**不可接受的失败（必须杜绝）：**
- goal 记录丢失导致崩溃后无法重建。
- 恢复后把 active goal 自动续跑（必须先降级 paused）。
- 把 `<untrusted_objective>` 当指令执行，越过 system/developer/权限/宿主控制。
- **静默失败**：续跑 Run 失败却让 goal 停在 active、假装还在推进。

**可接受的降级：**
- stream-bridge 快照推送尽力而为——观察者缺失不得影响 GoalStore 的状态权威。

**必须的可观测性：**
- 每次迁移发布 `goal.updated{sessionId, goal}`，UI 契约只暴露 `active`/`paused` 驻留状态、objective 与 `pauseReason`。完成或取消发布 `goal: null`，UI 隐藏 goal 状态。
- 一次 goal 的执行路径可从追加式记录**回溯审计**（谁在何时因何迁移）。
- 失败必须显性对用户可见（如 runtime-error 的 reason），而非仅记日志。
- 预算状态可见：`/goal status` 展示各维度用量、剩余量、是否到顶。

---

## 四、Trade-offs & Deferred Requirements（权衡与暂缓项）

- **不追求 goal 与用户消息真正并发**——换取模型与上下文一致性；代价是插话必然先暂停 goal。
- **不做 auto-resume**——插话后 goal pause，用户自行 `/goal resume`。放弃"插话办完自动续"的便利，换取简单与可预测；省去队列追踪、cancelReason 区分、自动重入的复杂度（`/goal resume` 仍走幂等的 ensure-driving 启动 driver）。与 kimi/codex 一致。
- **不区分 PauseCause**——所有 `paused` 同等处理，恢复统一为 `/goal resume`。`pauseReason` 仅供展示，不驱动恢复逻辑分支。避免"五值枚举 × 三恢复路径"的测试矩阵爆炸。
- **预算是 opt-in，不是强制**——不设则无产品级预算，设了则按维度独立判定。用户不直接传结构化参数，也不提供 `/goal budget`。
- **安全阀数字写死、不做可调/自适应**——1000 是所有 goal 的系统绝对上限，零配置零传参；显式预算不能绕过。它不进入预算报告，也不触发预算式收敛提示。
- **不做 `/goal next` 排队、交互式管理面板、master/subagent 多智能体**——明确延后（见 goals-duty Non-Duties），当前不为它们预留除快照字段外的机制。
- **不做跨 daemon 远程 cancellation**——当前 CLI/Web 只管理当前路径的会话与窗口；待全局单 daemon 架构落地后统一处理。
- **不承诺精确 wall-clock deadline**——支持 active-time budget，但只在 continuation 边界判定；paused 时间不计。
- **不追求横向扩展 / 多 goal 并行**——单 session 单 goal，符合当前定位。
- **可观测性首版只到"快照事件 + status + 审计记录"**——不建完整指标/trace/告警体系，避免过早的运维复杂度。

---

## 五、文档自检

- 优先级有序且有取舍（安全 > 可靠 > 可预测终止 > 可观测 > 简单 > 性能），非全部并列。
- 至少一类运行约束：串行不并发、外部依赖失败方向、权限模式、成本/预算/安全阀。
- 失败处理与可观测性明确：列了不可接受失败、可接受降级、必须的可观测性。
- 至少一项暂缓：并发、auto-resume、PauseCause、排队面板、多智能体、横向扩展均标为刻意延后。
- 未写成通用最佳实践：每条都绑定"长时间自主 + 不可信输入 + 跨崩溃"的模块语境。
