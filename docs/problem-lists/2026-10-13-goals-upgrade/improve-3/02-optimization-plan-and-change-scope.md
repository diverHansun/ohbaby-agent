# 第 3 批方案与改动面（blocked、三轮审计、双维 resume、时间截止、客户端恢复）

> 本文是实施契约：后续开发会话按此改代码、按 [04](./04-test-and-acceptance.md) 自测。基线 main / `018a5c96`；各批均未实施。接口约定见第 2 批定稿；实施前须结合该批 05 与当时源码核对（对齐结论见 [00](./00-discussion.md) §5）。
> 范围见 [00](./00-discussion.md)，现状依据见 [01](./01-problem-analysis-and-current-state.md)。行号是规划快照，定位以符号为准。

## 2.1 方案总览

保留 GoalStore → GoalService / driver → adapter 分层，本批只补三件事：blocked 成为第四态，停止原因对用户可见；「改上限 + 恢复」合成一次带检查的串行操作；显式时间上限变成当轮截止，到点就中断该 goal 的执行，不等轮末。三条路径的要点：**截止**＝按最新 active 用量排 timer，到点在串行区内复核身份与预算，仍到顶才 block 并中断该 goal 的执行；**审计**＝模型 blocked 报告带准入票据（runId + 轮号）进入进程内审计链，第三个相邻合格轮落盘 blocked；**恢复**＝解析 → 合并 → 检查两轴与安全阀 → 一条 update 同时写预算与 active。

| 状态 | 进入方式 | 怎么离开 |
| --- | --- | --- |
| active | 创建、用户显式恢复；准入后自动续跑 | 显式 stop / run 失败 → paused；两轴预算、1000 轮安全阀、三轮同因报告 → blocked；模型 complete → complete |
| paused | 显式暂停、当前 run 失败、重启归一化 | `/goal resume`（检查两轴与安全阀后）→ active；cancel 清除 |
| blocked | 轮次 / 时间预算到顶（准入检查或当轮截止）、安全阀、模型连续三轮同因报告 | 同一个 `/goal resume`；安全阀到顶只能 cancel 后新建 |
| complete | 模型自报完成（第 2 批持久化 → 尾部结算 → clear） | 不可恢复 |

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 |
| --- | --- | --- | --- |
| blocked 的地位 | 第四态，与 paused 共用 `/goal resume` | 语义独立、客户端可表达；恢复仍只有一条路 | paused 的子类或新 cause 枚举 |
| 停止原因字段 | 继续用 `pauseReason` 承载 paused / blocked 原因 | 决议 9 明确 | 新增 `PauseCause` / `blockedReason` |
| 审计计数单位 | 按已准入 goal run，每轮最多一次 | 防同一轮三次工具调用凑数；与普通用户 run 隔离 | 按工具调用次数（见 [03](./03-reference-projects.md)） |
| 审计状态位置 | 进程内小状态、每 session 一份；只有最终 blocked 与原因落盘 | 决议 9；不为审计建库 | 审计链持久化、独立审计表 |
| 轮次 vs 时间预算 | 轮次是准入上限（最后一个允许轮跑完）；时间是当轮真截止 | 轮次可精确计数，时间必须能中断长请求 | 两轴都只在轮边界检查，或都做当轮硬切 |
| resume 写入 | 合并 + 检查 + 单条 update，整体在第 2 批串行区内；失败零修改 | 防并发 SetGoalBudget 用旧快照覆盖 | 先改状态再异步检查、失败回滚 |
| 单位校验位置 | 新增纯模块 `goals/budget-input.ts`，命令与工具共用 | 命令层不能反向依赖 `tools.ts` | 校验留在工具层、命令层复制一份 |
| 截止中断 | 传入捕获到的执行票据，复核由第 2 批 helper 承担 | 不误伤新轮或新用户 run | 中断「此刻任意 runId」 |
| 客户端改动 | 只加状态与恢复入口；Web 两维输入用现有面板控件；形状区分沿用单色 | 决议 5；数字与正文展示归第 5 批 | 新仪表盘、进度条、新色相 |

## 2.3 分阶段实施（同一批内，不是新轮次）

### Stage 1：blocked 状态贯通

- 目标：`GoalStatus` 加 blocked；store 提供 `block()`；两处到顶出口（driver 的预算 / 安全阀出口，与第 2 批准入路径内的到顶检查）都改调 block，不再调 pause；回放保留 blocked。
- 改动点：`goals/types.ts`、`store.ts`、`driver.ts`、`errors.ts`；准入路径沿用第 2 批的位置与门禁顺序，只换调用出口。
- DoD：04 的 3-B1、3-E1；`store.unit.test.ts` 原「legacy blocked 归一为 paused」用例改为「原样回放」。

### Stage 2：模型门禁与三轮同因审计

- 目标：UpdateGoal 只接受 complete / blocked；blocked 要求非空 reason；按已准入 goal run 连续三轮同因才落盘 blocked。
- 改动点：新增 `goals/blocked-audit.ts`（每 session 一份）；`tools.ts`（enum 与描述）、`service.ts`（`updateGoalFromModel`）、`constants.ts` 与 `primary/base.md` 文案，重生成 `prompts/templates.generated.ts`。
- DoD：04 的 3-B9、3-B10、3-B11、3-B12、3-E2。

### Stage 3：双维 resume 与原子恢复

- 目标：无参 / 单维 / 双维；合并检查后一条 update 生效；失败零修改；SetGoalBudget 不恢复。
- 改动点：新增 `goals/budget-input.ts`（纯解析与校验）；`goals/budget.ts` 的 `planResume`；`commands/goal.ts`、`types.ts`、`catalog.ts`；`store.ts` 的 `resumeWithBudget`；`service.ts` 在 `withSessionMutation` 区内编排；`tools.ts` 的 SetGoalBudget 改用共用 helper。
- DoD：04 的 3-B3、3-B4、3-B5、3-B6、3-B7、3-B8、3-E3。

### Stage 4：时间截止与中断衔接

- 目标：显式时间上限成为当轮截止；创建 / 恢复 / objective 实改 / 预算变更后重排；到点复核后 block，并中断预期的 goal run。等待用户工作时到点不中断用户 run。
- 改动点：`service.ts`（token 化的 timer 与到点处理）、`budget.ts`（剩余时长纯计算）、`types.ts`（`expectedRunId`）；中断身份复核由第 2 批的 `executeGoalExecutionInterrupt` 提供，本批**只传参、不重复实现**；adapter 在到点路径提供当前 goal run 票据（含还在准备中的准入）。
- DoD：04 的 3-D1…3-D8 与跨批的 3-X1（watchdog × deadline，依赖第 1 批）。

### Stage 5：客户端纵切、规则与文档同步

- 目标：blocked 经 SDK / CLI / Web 可见、可恢复。
- 改动点：`ohbaby-sdk/src/snapshot.ts`（`UiGoalStatus`）；adapter 投影放行 blocked、命令后端透传 limits；CLI 核对 blocked 显示与颜色（沿用 warning，不加色相）；Web chip 形状与恢复输入（见 §2.5）；`docs/goals/` 同步与两份 2026-07-03 历史文档的 superseded 注明。
- DoD：04 的 3-U7、3-E4、3-E5。

## 2.4 按包 / 目录的改动面

| 包 / 目录 | 新增 | 修改 |
| --- | --- | --- |
| `packages/ohbaby-agent/src/goals/` | `blocked-audit.ts`、`budget-input.ts` | `types.ts`、`store.ts`、`service.ts`、`driver.ts`、`budget.ts`、`tools.ts`、`errors.ts`、`constants.ts`、`index.ts` |
| `packages/ohbaby-agent/src/commands/` | 无 | `goal.ts`、`types.ts`、`catalog.ts`（resume 参数与 argsHint） |
| `packages/ohbaby-agent/src/adapters/` | 无 | `ui-inprocess.ts`（投影放行 blocked、中断票据、命令透传 limits） |
| `packages/ohbaby-agent/src/core/system-prompt/prompts/` | 无 | `primary/base.md` + 生成物（`pnpm --filter ohbaby-agent prompt:generate`，检查 `prompt:check`） |
| `packages/ohbaby-sdk/src/` | 无 | `snapshot.ts`（协议扩展，同批更新消费者） |
| `packages/ohbaby-cli/src/tui/` | 无 | `components/prompt/index.tsx`（核对 blocked 显示；数字归第 5 批） |
| `apps/ohbaby-web/src/` | 无 | `ui/commands/GoalControl.tsx`、`ui/session/SessionScreen.tsx`、`ui/session/status.css` |
| `docs/goals/` | 无 | architecture / data-model / dfd-interface / non-functional / ui / test 与两份 2026-07-03 文档（只补 superseded 指向，不删原文） |
| 测试 | `goals/blocked-audit.unit.test.ts`、`goals/budget-input.unit.test.ts`、`goals/goal-lifecycle.integration.test.ts`、`goals/goal-deadline.integration.test.ts` | 见 04 §4.1 清单 |

## 2.5 接口、规则与例子

### 状态与端口

```ts
export type GoalStatus = "active" | "paused" | "blocked" | "complete";
// 删除 GoalStoredStatus 与 blocked → paused 归一；blocked 正常回放

export interface GoalExecutionInterruptInput {
  readonly sessionId: string;
  readonly reason: string;
  readonly includePrimary: boolean;
  /** 第 2 批契约字段：只中断这一条 run；本批在截止路径传入捕获到的票据。 */
  readonly expectedRunId?: string;
}

export interface UpdateGoalFromModelInput {
  readonly sessionId: string;
  readonly status: "complete" | "blocked"; // 其余状态直接拒绝
  readonly reason?: string;                // blocked 必填且 trim 非空；complete 忽略
  readonly runId?: string;                 // 第 2 批绑定表身份；所有 mutation 的可信身份；blocked 另检查审计资格
}
```

本批**不新增工具级身份门禁**：CreateGoal、SetGoalBudget 与 UpdateGoal(complete) 的旧身份保护继承第 2 批的整条 mutation 路径，普通 run 的 complete 按其绑定目标照常可用；只有 blocked 报告要求 goal-owned run；GetGoal 保持只读快照查询。

### 三轮同因审计（`blocked-audit.ts`，每 session 一份小状态）

- 资格：报告来自 goal-owned run（第 2 批绑定表命中）、`goalId` 等于当前 active goal、票据捕获的 `executionEpoch` 仍等于当前值。`executionEpoch` 由 GoalService 持有，生命周期或正文 transition（暂停、取消、新建替换、objective 实际改变、真正恢复）时立即递增，旧 run 的迟到工具调用因此不达标；driver 循环启动时捕获一次并整段固定，driver 的 `driving` 项按 promise / loop 身份清除，执行票据在结算与完成清理后按自身身份释放，不用 epoch 当删除条件。
- 轮号取票据的 `turnNumber`，不现读 `turnsUsed`。相邻轮继续累计（`turnNumber === 上一轮 + 1`）；中间有没报告的轮 → 断链，从 1 计。
- 同轮一次：同一 runId 第二次报告不计数，也不允许换理由重写本轮贡献。
- steer 与 goal run 共享 runId 与票据，**不新增审计轮**；它触发的工具调用就是原 run 的工具调用，照常受「同轮最多一次」约束，不因来自 steer 而拒绝后续正常工具调用。
- 普通用户 run、not_admitted：没有票据 → 不计数，返回清楚说明。
- 同因判定 `reason.trim().toLowerCase()`；换说法从 1 计。
- 第三个合格轮：先 `store.block(reason, "model")` 落盘，**成功后才把内存链提交为终态**；落盘失败保持 2/3，同一 run 可用同一理由重试，不能把第三次登记锁死。
- 重置：真正从 paused / blocked 恢复、新目标、进程重启（天然）；active 幂等 resume 与仅调额度不重置；`/goal replace` 仅在归一化后 objective 实际改变时随第 2 批 epoch 失效重置，旧 run 不再具有 mutation 资格，新准入从 1 计；同文 no-op 不清链。不新增 cutoff 状态。审计链按 session 隔离，互不影响。
- 预算与安全阀不经过这个计数器。blocked 落盘后只需中断冗余子代理（`includePrimary: false`，与 complete 同口径，当前 run 可做收尾发言），且仅限票据捕获的 goal root，不能按 session 扫描用户子代理。
- 提示契约：`primary/base.md`、`GOAL_CONTINUATION_CORE` 和 UpdateGoal 描述同步要求模型在每个真正受阻轮报告一次；1/3、2/3 仍 active，继续可做的独立工作；后端负责第三轮转 blocked。禁止“先等三轮再调用”的双重计数文案。

### resume 解析与原子恢复

- 解析（`budget-input.ts`）：接受 0、1、2 个维度；每个维度是「正数 + 单位」；两维顺序可交换；未给的维度保留当前值（含「未设置」）。
- 拒绝（`invalid_budget`，状态与记录不变）：重复维度、未知单位、缺少数值、非有限数、负数 / 零、非整数轮次、尾部垃圾、超 1000 轮，以及不在 1 秒至 24 小时范围内的时间。
- 合并检查（`planResume`，在 `withSessionMutation` 区内用最新快照）：合并后任一上限 ≤ 已用量 → `budget_reached`，列出维度、已用量与下一步；`turnsUsed >= safetyCapTurns` → `safety_cap_reached`，提示 cancel 后新建。
- 新总额只需合法且大于已用量，**可以低于原上限**（SetGoalBudget 本来就能调低）；本批不新增「清除已设置上限」的语法。
- 通过后一条 update 写 `budgetLimits` + `status: "active"` + 清 `pauseReason`。整段只占一个排队条目、区内只调 store 窄函数；退出区后再重排 deadline、触发 `ensureDriving`，`init` / `enterSession` 等会再入队的方法从不放进区内。
- 失败时预算、状态、记录全不变。active 上无参 resume 检查后保持幂等，并用 `ensureDriving` 补缺失驱动；带参数时仍按同一原子路径更新给定额度。两者都不新开生命周期、不重置审计链。SetGoalBudget 仍只写预算、不激活停止目标。

### 截止与中断

- 每个 active goal 一个 timer：先清旧再排，回调捕获自己的 token（递增序号）。旧回调发现自己不是当前 token 就直接返回，**不能清掉新 timer**；清理只清自己的 entry。
- objective 实改提交后在区外按保留的累计活跃用量重排 timer；原累计时长/额度不清零、不重新赠送时长。同文 no-op 不换 epoch、无需重排，原 timer 继续有效。
- 到点在串行区内复核最新预算与用量、`goalId` 与生命周期；仍在限内（早到回调）→ 退出区后按新剩余重排；已到顶 → 区内先按当前 goalId 的实际执行占位捕获票据（runId + executionEpoch，可能是正文实改后仍运行的旧 epoch；停止范围不能拿 mutation 资格过滤）再 `store.block`（block 属生命周期转换，会使 executionEpoch 立即递增），退出区后按**捕获的票据** await 中断，供 helper 在 await 后匹配；不按递增后的新值查找，避免误拒自身。
- 目标已 admitted、run 还在准备中（拿不到 runId）时，block append 成功后立即对已捕获票据发准备取消信号，并使 epoch 失效，复用第 2 批的启动/交接复核取消其 preparation，不让它继续启动；确实没有可中断对象时才只保留状态迁移并记录诊断。
- 等待用户工作时到点：goal 转 blocked，但中断只针对 goal-owned run（`includePrimary: true` + 票据匹配），用户 run 及其子代理不受影响；无匹配 goal root 时不调用 session 级后备中断。
- pause / block / complete / cancel / session 释放（dispose）都要清 timer；timer `unref?.()`，不靠进程退出兜底。

### 命令与工具例子

```text
/goal resume                      保留当前预算，检查后恢复（active 上幂等，不重置审计链）
/goal resume 100 turns            轮次总上限改为 100，时间上限保留
/goal resume 3h                   时间总上限改为 3 小时，轮次上限保留
/goal resume 100 turns 3h         两维一次提交，等价于 /goal resume 3h 100 turns
/goal resume 100 turns 100 turns  → 拒绝：重复维度
/goal resume 1.5 turns            → 拒绝：轮次必须是正整数
/goal resume 1001 turns / 25h     → 拒绝：超 1000 轮安全阀 / 超 24 小时
/goal resume turns / 100 turns extra → 拒绝：缺少数值 / 尾部参数不忽略
```

两维到顶只给一维：`Cannot resume: turns used 20/20. Provide both dimensions, for example /goal resume 40 turns 2h.` 安全阀到顶：`Safety cap reached: 1000/1000 continuation turns. Run /goal cancel, then create a new goal.` 成功返回 `formatGoalStatusLines` 的状态行。

```text
UpdateGoal({ "status": "blocked", "reason": "waiting for the user to pick a database" })
  首次 / 第二次 → Blocker recorded (1/3 consecutive goal turns). The goal is still active.
  第三个合格轮 → Goal blocked: waiting for the user to pick a database. Use /goal resume to continue.
UpdateGoal({ "status": "complete" })                 → 完成；reason 不记录
UpdateGoal({ "status": "paused" })                   → 拒绝（enum 只有 complete / blocked）
UpdateGoal({ "status": "blocked", "reason": "   " }) → 拒绝：reason 必须非空
```

### Web 恢复输入（最小实现）

- 现有 Goal 面板保留直接的 Resume 按钮，等价 `/goal resume`。
- 一个可展开的「Optional limits」区放两个可选字段：轮数（整数，例如 `100`）与活跃时长（例如 `3h`）；留空表示该维度不改。
- 至少填一个字段时，Resume 合成 `/goal resume [<n> turns] [<duration>]`，走同一个命令 / 服务语义；失败时面板保持打开、显示原始错误（含到顶维度），不改本地状态。
- Web composer 的带参 `/goal resume ...` 直接提交完整原命令到既有后端解析；`SessionScreen.tsx` 在打开结构化 overlay 前区分有无参数，此受控分支用现有 `runtime.executeSlashCommand({ text, sessionId, clientRequestId, allowOverlay: true })` 提交完整原命令，沿用 catalog 与 session/binding 校验；不能仅令 openOverlayForSlashText 返回 false，否则 `runtime.ts:187–191` 仍会因 overlay 命令拒绝。不得对所有命令默认开启 allowOverlay，不交给会丢弃 rest 的 `GoalControl` 无参 intent。无参命令维持面板交互，面板可选额度仍按上一条拼命令。不在前端再造一套预算 parser；非法尾部必须传到后端并显示错误。
- 不新增组件框架、不加 token 数字；展示例子不需要给 `UiGoal` 加预算字段。

## 2.6 迁移与兼容

- 旧记录：历史 `status: "blocked"` 原样回放为 blocked（不再降 paused），已有 `pauseReason` / `reason` 归一保留；旧 active 重启仍降 paused，旧 complete 残留仍补 clear。
- resume 行为变化：无参 resume 从「只改状态」变成「检查后才恢复」，到顶会拒绝并给下一步。属有意变化，写入 `docs/goals/use-case.md` / `test.md`。
- SDK 协议：`UiGoalStatus` 增加 blocked 属跨包改动，生产者（adapter）与消费者（CLI、Web）同批更新，不承诺新旧客户端混跑。
- token 已由第 2 批读兼容忽略，本批不写也不解析；审计计数、timer、`expectedRunId` 都只是进程内状态，崩溃后 blocked 自身保留、审计链归零。

## 2.7 风险与回滚

| 风险 | 防护 |
| --- | --- |
| 旧 timer 打断 resume 后的新轮 / 替代目标 | 到点先复核 goalId、生命周期与最新预算；重排前清旧 timer；旧回调按 token 自识别（3-D3、3-D6） |
| 中断误伤新用户 run | 按捕获票据传入 `expectedRunId`，主 run 与子代理都限定到该 root；准备取消与复核由第 2 批 helper 承担（3-D4、3-D5） |
| 审计被普通 run / 旧 run 污染 | 票据资格 + 轮号相邻 + 同轮去重；steer 不新增轮（3-B9、3-B10、3-B12） |
| resume 与 SetGoalBudget 并发覆盖 | 同一 `withSessionMutation` 区内单条 update（3-B6） |
| 串行区死锁 | 区内只做裸 store 操作，不调用会再入队的公共方法；`armDeadline` / `ensureDriving` 在区外 |
| blocked 被旧消费者当未知 | SDK / CLI / Web 同批交付 + 契约测试（3-U7） |

**回滚**：以「本批前后端一起退」为单位，并核对第 4、5 批的依赖，不能只拆掉某个 helper 局部停用。局部关闭 deadline（不再重排与中断）只是降级：轮次与时间回到只在边界检查，blocked 与 resume 语义仍在，不等于完全回滚。回退 `GoalStatus` 枚举放最后：已落盘 blocked 会被旧版本降为 paused，属语义降级而非不可逆变化，必须在 05 记录并提示。

## 2.8 边界对齐与不在本轮

与 [00](./00-discussion.md) §4 一致：不做 watchdog 本体、共享准入基建、steer 分流、常驻轮次 / 时长数字、常驻 UI 的 token、criterion 校验、多目标队列、fork、verifier、停滞检测、`/goal budget` 命令；安全阀不可抬高，`/goal replace` 仍只改 objective，模型不能借 replace 或 SetGoalBudget 绕过门禁。plan/04 的 B1、B3–B12、D1–D7 与 U7 的恢复入口由本批负责；S 系列与常驻数字分别归第 4、5 批。
