# 第 3 批测试与验收标准

> 对照 [02](./02-optimization-plan-and-change-scope.md) 的 Stage 与 plan/04 的 B / D / U 场景；本批未实施，测试尚未运行。遵循既有测试分类：unit 只测局部逻辑、依赖替换；**integration 必须让真实 store / service / adapter 协作，不接受「一个 fake 配一个模块」充数**。竞态用可控 deferred 与 fake timers，LLM 用 fake provider；`*.e2e.test.ts` 默认被 vitest 配置排除。

## 4.1 测试范围与命令（已核实）

**文件范围**：局部逻辑继续放既有 unit 文件（`goals/{store,service,driver,budget,tools}.unit.test.ts`、`commands/goal.unit.test.ts`），并新增 `goals/blocked-audit.unit.test.ts`、`goals/budget-input.unit.test.ts`；真实协作场景新增 `goals/goal-lifecycle.integration.test.ts`（状态 / 审计 / resume，真实 store + service + 假 runner）与 `goals/goal-deadline.integration.test.ts`（截止，真实 service / store + fake timers + 可控中断端口），必要时扩 `persistence.integration.test.ts`；契约面看 `adapters/ui-inprocess.contract.test.ts`、CLI `tui/app.contract.test.tsx`、Web `ui/App.unit.test.tsx`。

```bash
pnpm exec vitest list packages/ohbaby-agent/src/goals/store.unit.test.ts   # 只收集用例、不执行，用于确认文件与用例名
pnpm exec vitest run packages/ohbaby-agent/src/goals/goal-lifecycle.integration.test.ts
pnpm test:unit
pnpm test:contract
pnpm test:integration   # 各命令调用 node scripts/run-vitest-by-type.mjs <type>
pnpm --filter ohbaby-agent prompt:check   # base.md 与 templates.generated.ts 同步
pnpm typecheck
```

真实模型测试（`goals/goal-completion.real.e2e.test.ts`）按既有环境开关单独运行，不作为本批验收证据。

## 4.2 blocked 状态与审计

| ID | 场景 | 类型 | 落点与通过条件 |
| --- | --- | --- | --- |
| 3-B1 | 轮次 / 时间 / 安全阀触发；显式 stop 与 run 失败 | unit + integration | 局部判定在 `driver.unit.test.ts`（原「预算到顶 pause」两例改写为 blocked）；「经 service+store 转 blocked 并停 driver」在 `goal-lifecycle.integration.test.ts`；stop / failure 仍 paused、cancel 清除 |
| 3-B9 | 同一 run 三次 blocked；三个相邻 goal run 同因；落盘失败重试 | unit + integration | 计数规则在 `blocked-audit.unit.test.ts`；三个真实准入轮在 `goal-lifecycle.integration.test.ts`，经真实工具上下文逐轮调用，依次断言 active 1/3、active 2/3、blocked，并测中间不报告则断链；`store.block` 写失败时保持 2/3，同一 run 用同一理由重试成功，第三次登记不被锁死 |
| 3-B10 | 换原因、空原因、无报告轮、普通用户 run、steer、not_admitted | unit | 全部在 `blocked-audit.unit.test.ts` + `tools.unit.test.ts`；空原因拒绝；换因从 1 计；无报告轮断链；无票据不计数；steer 共享原 run 票据、不新增轮、不拒绝其后正常工具调用 |
| 3-B11 | 停止后 resume、active 幂等、replace、新目标、重启；跨 session 隔离 | integration | `goal-lifecycle.integration.test.ts`（含重建回放）；真正恢复 / objective 实改 / 新目标 / 重启重置审计链；同文 no-op 不重置；当前轮中途改 objective 后，该旧正文轮不贡献新链，下一准入轮才开始；active 幂等或仅调额度不重置；两个 session 互不影响；已落盘 blocked 保留 |
| 3-B12 | 模型传 active / paused；旧 run 调工具 | unit + integration | enum 与理由校验在 `tools.unit.test.ts`；生命周期 transition 后旧票据失效、旧 run 迟到报告 not_eligible 且不改目标，在 `goal-lifecycle.integration.test.ts` |
| 3-E1 | 历史 blocked 记录回放 | unit | `store.unit.test.ts`：原样保留 blocked（原「归一为 paused」用例改写） |
| 3-E2 | 模型可见文案与生成物 | unit | `injection.unit.test.ts` + `pnpm --filter ohbaby-agent prompt:check`：`UpdateGoal` 只列 complete / blocked；静态规则、续跑规则、工具描述均要求每个真正受阻轮报告一次，1/3、2/3 仍 active；无「先等三轮再调用」或「paused 表示阻塞」旧说法 |

模型 complete 无三轮门禁，3-B9 不得误测成「调用三次即 blocked」。

## 4.3 resume 解析与原子恢复

| ID | 场景 | 类型 | 落点与通过条件 |
| --- | --- | --- | --- |
| 3-B3 | 无参、只给轮次、只给时间、同时两维 | unit（命令层）+ integration | 解析与错误文案在 `commands/goal.unit.test.ts` + `budget-input.unit.test.ts`；未给维度保留（含未设置）、两维可交换、总额度不清零用量在 `goal-lifecycle.integration.test.ts` |
| 3-B4 | 两维同时到顶，只抬一维后又给两维 | integration | `goal-lifecycle.integration.test.ts`：单维失败零修改并列出另一维；两维通过后一次 update 同时生效并恢复 |
| 3-B5 | 重复维度、未知单位、缺值、非有限数、负数 / 零、非整数轮次、尾部垃圾、超 1000 / 24h | unit | `budget-input.unit.test.ts` + `commands/goal.unit.test.ts`：全部 `invalid_budget` 明确拒绝，状态与记录不变 |
| 3-B6 | resume 与 SetGoalBudget 并发改不同维度 | integration | `goal-lifecycle.integration.test.ts`：同一 `withSessionMutation` 区内合并，无丢更新（deferred 卡住串行区再放行） |
| 3-B7 | 上限等于已用量；安全阀到顶 | unit | `budget.unit.test.ts` 的 `planResume`（含「新总额低于原上限但高于已用量可通过」）+ 命令错误文案；安全阀提示 cancel 后新建 |
| 3-B8 | SetGoalBudget 调高 paused / blocked 预算 | integration | `goal-lifecycle.integration.test.ts`：预算更新、状态不激活；显式 resume 后才驱动 |
| 3-E3 | 单维解析纯函数 | unit | `budget-input.unit.test.ts`：turns 正整数且 ≤ 1000、时间 1s–24h、单位白名单 |

## 4.4 时间截止

| ID | 场景 | 类型 | 落点与通过条件 |
| --- | --- | --- | --- |
| 3-D1 | 一轮长请求超过活跃时长预算 | integration | `goal-deadline.integration.test.ts`：当轮内 blocked 并中断该 goal run，不等轮末 |
| 3-D2 | active 时首次设预算、抬高、调低（不新增清除语法） | unit | `service.unit.test.ts`（fake timers）：按最新用量重排、旧截止失效、未定义的清除写法被拒 |
| 3-D3 | 定时器将触发时 pause / resume / 新建目标 / objective 实改与同文 | integration | `goal-deadline.integration.test.ts`：旧回调不影响后继；正文实改重排但不延后原累计截止，仍能 block 并定点中断同 goalId 正在收尾的旧 epoch run 及其子代理；同文 no-op 保持原 timer；到点复核最新预算 |
| 3-D4 | goal 等待用户工作时到点 | integration | `goal-deadline.integration.test.ts`：goal blocked，用户 run 与其活动子代理都不中断；无 goal root 不走 session 级兜底 |
| 3-D5 | 中断 helper 的 await 前后执行者切换 | integration | `goal-deadline.integration.test.ts`：只按捕获 goal root 中断主 run 与子代理；后继用户 root 和子代理无影响；includePrimary=false 的 blocked 只清该 goal 子树，主 run 可收尾，包含 runtime 已启动但 UI runReady 尚未发布的窗口 |
| 3-D6 | 早到回调、pause / cancel / complete / dispose | unit | `service.unit.test.ts`：早到重算后重排；旧回调按 token 自识别、不清新 timer；停止后无遗留任务与重复通知 |
| 3-D7 | 用户队列持续有工作 | integration | `goal-deadline.integration.test.ts`：goal 不插队；active 等待时长继续增长；paused / blocked 停止增长 |
| 3-D8 | 目标已 admitted 但 run 尚未就绪时到点 | integration | `goal-deadline.integration.test.ts`：分别卡在绑定前、startSession 前、runReady 握手期间；block 后立即取消 preparation，复用第 2 批交接检查，保留准入计轮；不遗留可执行旧 run，不写成「仅诊断跳过」 |

## 4.5 客户端与契约

| ID | 场景 | 类型 | 落点与通过条件 |
| --- | --- | --- | --- |
| 3-U7 | Web blocked 的普通恢复与调额恢复 | contract + 手工 | `ui/App.unit.test.tsx` + 手查：Resume 在 paused / blocked 可用；Optional limits 两字段可空、留空不改维度；错误不关面板、显示到顶维度；composer 提交 `100 turns 3h`、反序、各单维、非法尾部和无参：通过真实 Web runtime 到命令后端，验证受控 allowOverlay 接线和 session 校验，不能 mock executeSlashCommand 后直接断言调用；带参完整到后端且非法不吞，无参保持面板；数字/状态/记录断言同一后端语义 |
| 3-E4 | CLI 常驻行显示 blocked | contract | `tui/app.contract.test.tsx`：`goal blocked` 文本可见、颜色沿用现有 warning |
| 3-E5 | SDK / adapter 投影 | contract | `adapters/ui-inprocess.contract.test.ts`：`UiGoalStatus` 含 blocked；投影放行 blocked、complete 仍为空；`goal.updated` 与重连快照一致 |

## 4.6 跨批组合

**3-X1（本批唯一的跨批项）watchdog × deadline 的顺序**（plan/04 的 W4）：deadline 到点与该 goal run 内 provider 空闲超时竞争。终态由**串行先后**决定，不预设 deadline 永远胜出：

- 顺序 A：deadline 先提交 blocked → watchdog 的超时失败（或迟到错误）到达 → 状态保持 blocked，不被翻回 active，也不被覆盖成 paused / runtime error。
- 顺序 B：用户 stop 或 runtime failure 先提交 paused → 旧 deadline 回调复核发现非 active → 直接失效，不把 paused 改成 blocked。

写进 `goal-deadline.integration.test.ts`，用 fake provider + fake timers，标记「依赖第 1 批，落地后启用」。

**未来第 4 批（steer / 队列）的 4 项标记**（只登记、不在本批实现）：

1. steer 不新增审计轮：接通自动 steer 后回归 3-B10 的 steer 行（steer 共享原 run 票据）。
2. 用户队列竞争：用户队列持续有工作时 deadline 到点（3-D7 的跨批版），goal 不插队、用户 run 不受影响。
3. blocked 后的未消费输入：排队输入不得自动恢复目标，恢复入口仍是 `/goal resume`（对齐 plan/04 S8）。
4. paused / blocked / complete 或已被替换的目标，即使旧 run 尚未关闭，也不得接收新的自动 steer；原项 queued，释放执行权后按用户优先运行。

其余 S 系列由第 4 批全量承接，不复制到本批。

## 4.7 回归清单

- 一 session 一有效执行者；权限审批与 sandbox 政策不变；`/goal budget` 仍不可用，额度入口只在 resume。
- complete 由模型自报，不加 verifier、不加最小完成轮数；token 不因本批回到预算判断或常驻 UI；查询统计不受影响。
- 旧记录：active 重启降 paused、complete 残留清理、blocked 保留。
- 既有测试只有「预算到顶 pause」「legacy blocked 归一」两类用例属于预期改写，其余（`goal-compact.integration.test.ts`、`persistence.integration.test.ts`、admission 相关）必须保持通过，不得为通过而放宽断言。

## 4.8 验收门（Stage 映射）

| Stage | 通过条件 |
| --- | --- |
| Stage 1 blocked 贯通 | 3-B1、3-E1 通过 |
| Stage 2 门禁与审计 | 3-B9–3-B12、3-E2 通过 |
| Stage 3 resume | 3-B3–3-B8、3-E3 通过 |
| Stage 4 截止 | 3-D1–3-D8 通过；3-X1 在两条顺序下都通过（第 1 批落地后启用） |
| Stage 5 客户端 | 3-U7、3-E4、3-E5 通过 |

整批完成需：上述场景全绿 + 回归清单通过 + `pnpm typecheck` + `pnpm --filter ohbaby-agent prompt:check`；Web 手工检查按 3-U7 执行并记录；真实模型测试未跑时如实记录，不以单测代替。

## 4.9 对抗性审查要点

1. 审计能否被凑数：同轮多次调用、来自 steer 的工具调用、旧 run 迟到报告，都不能增加轮；落盘失败后仍能在同轮重试。
2. resume 失败是否真的零修改：记录数、内存快照与 driver 状态都不动。
3. 旧 timer / 旧回调是否可能清新 timer 或误伤 resume 后的新 run；run 未就绪时 preparation 是否被取消。
4. blocked 是否四端一致：后端、SDK、CLI、Web 都能看见，恢复入口都在，错误信息具体到到顶维度。
5. 截止与超时 / stop / run failure 的终态是否由串行先后唯一决定，迟到结果不得覆盖已提交状态。
6. 串行区纪律：区内只做「读快照 → 捕获旧票据 → 落状态 → 失效 epoch / 发准备取消」与 store 窄函数，`ensureDriving`、timer 重排、中断 await、`init` / `enterSession` 都在区外；resume 的读→合并→检查→update 只占一个条目，不发生区内外互等。
