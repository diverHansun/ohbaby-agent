# 04 测试与验收：第 2 批（执行准入与统计基础）

> 总体验收基线见 [../plan/04-test-and-acceptance.md](../plan/04-test-and-acceptance.md)，本文只覆盖本批场景，并标明哪些场景留给第 3/4/5 批。默认在仓库根执行；测试分类遵循 `docs-test/classification.md`。

## 4.1 命令

```bash
# 单文件快跑（改哪测哪）
pnpm exec vitest run packages/ohbaby-agent/src/goals/driver.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/goals/store.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/goals/service.unit.test.ts
# 按类型跑本批相关面（脚本自动收集，见 scripts/run-vitest-by-type.mjs）
pnpm test:unit          # goals/*.unit.test.ts 等
pnpm test:contract      # SDK / adapter 契约（含 ui-inprocess.contract.test.ts）
pnpm test:integration   # goals 持久化、goal-compact、adapter/scheduler 协作
# 收尾
pnpm run typecheck
pnpm --filter ohbaby-agent prompt:check    # 若改了 base.md / 常量文案，先 prompt:generate
```

竞态验收沿用既有模式：可控 deferred/barrier + fake clock，显式卡住关键 await 再触发另一操作；不用 sleep 碰运气，不用真实模型请求（`goal-completion.real.e2e.test.ts` 只在显式开关下单独跑，不作本批证据）。

集成测试落点：拟新增 `packages/ohbaby-agent/src/adapters/goal-execution.integration.test.ts`，让真实 scheduler、执行门禁、GoalService 与 GoalStore 协作，仅替换 provider、时钟和外部 I/O；覆盖下表准入、handoff、中断与结算竞争。回放场景扩展既有 `goals/persistence.integration.test.ts`，compact 场景扩展既有 `goals/goal-compact.integration.test.ts`。局部纯逻辑留在对应 unit 文件，协议投影留在 contract 文件，不能用全 mock 单元测试充当这里的集成证据。

## 4.2 门禁与队列（对应 plan/04 A1、A5、S6、S7 及新增）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| G1 | goal 轮运行中，用户 prompt 已被 accept、drain 到达 | integration | 不 claim、不打断 goal、不占 `maxActiveSessions`；goal 轮结束后用户先跑（S6/S7） |
| G2 | 同一 barrier 上 goal 准入与用户 claim 同时发生 | integration | 恰一方取得执行权，另一侧延后；无第二个 run 启动（A1） |
| G3 | goal 忙导致 drain 跳过；goal 释放执行权 | integration | gate notify 触发 drain，queued 用户项被 claim；双方不互相等待（死等回归） |
| G4 | claim 成功后 scheduler 进入 closed 分支（requeue → break） | integration | 走外层 finally 释放 lease：无悬空占位，后续 drain 能再 claim；lease 不被释放两次 |
| G5 | compact 持有占位时请求 goal 下一轮 | integration | 准入循环内等待，不计轮、不 pause、不空转；压缩结束被唤醒、重查预算后准入；等待中目标失效才返回 `not_admitted`（A5） |
| G6 | goal 等待准入期间被 pause / cancel / replace | integration | 不计数、不发消息、占位释放正确（A2） |
| G7 | pause 与计轮同时排队（barrier 卡住 append） | integration | 两种顺序各跑一遍：pause 先 → 不计轮；admit 先 → 计一轮、准备阶段按 cancelled 上报，绝不返回"未准入" |
| G8 | 计轮落盘失败 / 启动失败 | integration | 写失败：内存不虚增、lease 不残留；准入落盘后启动失败保留一轮。计轮/运行异常后 pause append 也持续失败：退出一次、错误可见、无同代自动重试；修复存储后显式 resume 恰启动一次（A4/A8） |

## 4.3 身份、complete 与统计（对应 plan/04 A3、A6-A10、C1-C8、B2、U6、U9）

| ID | 场景 | 类型 | 通过条件 |
| --- | --- | --- | --- |
| G9 | 等待准入期间只改 objective | integration | 旧 epoch 等待者退出且零计轮，新 epoch 恰驱动一次；正文、轮号、展示值来自最新同一快照（A3；展示值只查生成点，不接 UI） |
| G10 | 旧轮 succeeded/failed/cancelled/外层抛错，期间新目标已创建 | integration | 旧 usage 不写新目标、旧回写不暂停新目标、旧 finally 不删新 driver 条目（A6） |
| G11 | pause 后立即 resume，旧轮迟到取消/失败 | integration | 旧结果不再暂停；恰有一个有效 driver（A7/A8） |
| G12 | 准入已落盘后崩溃回放 | integration | 计数保留、active 降 paused、不自动重跑（A9）；回放按 goalId 过滤迟到 update |
| G13 | 同一 run 内 `CreateGoal({replace:true})` | integration | 当前 run 不被中断；旧票据回写被丢弃；新目标获得自己的驱动（同 run replace 契约） |
| G14 | complete：有尾部 usage | integration | 先持久 complete（UI 立即为空、notice 一次）→ 结算含末轮 usage → 同目标全部 pending 票据结算后 clear；覆盖旧生命周期 usage 迟到、usage / clear 写失败；无第二条通知（C1、C4） |
| G15 | complete：无待结算票据 / 崩溃回放残留 | integration | 直接 clear 不等待；回放清 complete 不降 paused（C2） |
| G16 | complete 残留期间 resume / replace / 预算编辑 / create | contract + integration | 前三者被拒且状态不变；create（含 replace）放行且不被残留阻挡（C3） |
| G17 | failed / cancelled 带已知 usage；usage 部分缺失 | integration | 已知部分照常结算；未知不写 0、快照标记部分统计；cached 与 total 不重复相加（C5/C6） |
| G18 | 计轮 / usage 刷新与生命周期通知 | contract | 刷新走 `goal.updated`，不发 notice；创建/暂停/完成等生命周期仍发一次 notice（U6） |
| G19 | 历史 token 预算记录 / SetGoalBudget tokens | unit + contract | 旧记录被忽略读兼容；`tokens` 单位被拒；token 不参与任何停止与 converging（B2） |
| G20 | `/goal status`、GetGoal 与续跑正文 | unit + contract | 查询保留 total/cached 与部分统计标注；自动提醒无 token、仍有轮次/时长（U9 的 token 部分） |
| G21 | 重复 outcome、usage/clear 写失败、runtime finalization 失败后的实际恢复 | integration | 经生产 recovery 入口证明恰一次结算、恢复槽不被覆盖、交接身份正确；详细断言见下文（C7） |
| G22 | 当前轮并行子代理和独立摘要也产生 usage | integration | goal 只结算该 admitted run 的既有 usage，子代理与独立摘要不额外归集；缓存数不重复加进 total（C8） |
| G23 | drain 预筛空闲后，goal 先在 owner 区内准入 | integration | 随后的 claim 回调再次检查占位，零 claim 写入、用户项仍 queued，不占并发容量 |
| G24 | goal 准备阶段等待 runReady / 消息或 ledger 写入时 pause | integration | 用 barrier 分别卡在 runId 绑定前、绑定后 startSession 前、启动握手 await 中；pause/cancel 区内先捕获票据、落盘后发准备取消并失效，区外等待中断。不得启动或遗留有效旧 run、首个工具不得无票据运行；owner 无互等，保留已准入计数，用户 run 不被误伤；另在 runtime 已启动但 UI runReady 未发布时 complete/模型 blocked（第 3 批补）/objective 实改，主 run 允许收尾，不因 epoch 失效误停 |
| G25 | complete 或 run 内 replace 后，旧 run 尚未关闭 | integration | `getActiveGoalRunForSteer` 返回 undefined；第 3 批再补 blocked，第 4 批验证实际 accept 分流 |
| G26 | 已启动 goal run 期间 `/goal replace` 实改 / 同文 no-op | integration | 实改保留 goalId/预算/累计统计；旧 complete、budget、create 被拒，旧 usage 仍结算；旧 run 可收尾、新代只启动一次且用新正文。no-op 保留执行资格（A10） |
| G27 | 实际 Tool.execute → GoalToolBackend → service 的 runId 传递 | contract + integration | CreateGoal、SetGoalBudget、UpdateGoal 都用真实上下文，不接受模型 runId；首个工具调用已有绑定；pause/resume/替换后的旧工具拒绝；未知 run 与子 run 不因无票据取得普通用户权限；正常用户主 run 的授权变更可用；GetGoal 仍可读（A10/B12） |
| G28 | goal root 与用户 root 各有活动子代理，中断期间执行者切换 | integration | 主 run 与 descendants 均仅作用于捕获 goal root；不匹配不退回 session 扫描；无 goal root 不误伤用户树；includePrimary=false 仅取消该 goal 子树，主 run 可收尾（D4/D5 的基础） |

### G21 的恢复子场景

扩展 `adapters/goal-execution.integration.test.ts`，沿真实 scheduler recovery 与客户端重试入口执行，不能直接重复调用 `recordUsage` 代替恢复接线。

1. usage append 首次失败：票据保留 outcome、未置 settled；重试后 total/cached 恰累计一次。
2. usage 已成功、clear 单独失败：重试只补 clear，完整记录顺序可查，数字不重复。
3. runtime 已产 usage、finalization 失败：显式 retry 取得最终 RunCompletion，再结算真实 usage；不能用合成的无 usage failed 提前 settled/clear。
4. 卡住首次 settle / recovery 登记：queued 用户不能 claim；登记后由既有 recovery 阻断接续执行。证明 goal 与用户两个方向均不会覆盖同 session 的单恢复槽。
5. 转交 recovery 后再送重复 outcome：driver 不再结算或回写生命周期；恢复不复活终态。pause 写失败留下 active 时，也须显式 resume 才补驱动。
6. 取消/新目标替代后重试：旧 runtime 的输入关闭与终态仍补齐，goal usage/clear 不写新目标、不建历史账本。

## 4.4 留给后续批次（本批只保证接口与语义不被堵死）

| 场景 | 归批 | 本批的保证 |
| --- | --- | --- |
| blocked 状态、三轮同因审计、硬时间截止、带额度 resume 与客户端恢复（plan/04 B1、B3-B12、D1-D7、U7） | 3 | 预算到顶暂为 paused；第 3 批同时替换 driver 快路径与准入区内的到顶出口。审计复用票据，中断支持捕获身份 |
| 自动 steer、FIFO 细节、未消费输入恢复（S1-S5、S8-S12） | 4 | 排队不打断、顺序稳定；挂点检查 active、goalId、executionEpoch 与 run 接收状态 |
| displayText 的 live/replay、inactive 注入删除、criterion 6000、数字 UI（U1-U5、U8、U10-U13） | 5 | 准入同快照产出正文/轮号/展示值（首轮 `Goal started`、续轮 `Goal auto-continue (turn N)`），live/replay 接线必须成对改 |
| 请求空闲 watchdog（W1-W7） | 1 | 无接口耦合 |

注意：`ui-inprocess.contract.test.ts` 中现有"普通输入撞 goal"的用例主体属于本批（改成排队不打断）；其中 paused 轻提示相关断言由第 5 批删除，两边不要互相改对方的断言。

## 4.5 完成条件

- §4.2、§4.3 的每个 ID 有可重复的自动化测试且通过；未跑项须记录原因，并标为未验收，不能据此宣称整批通过；真实模型测试不作为本批证据。
- `pnpm run typecheck` 与 `pnpm test:unit/contract/integration` 通过；改了 base.md 或生成物时 `prompt:check` 通过。
- `docs/goals/` 的 architecture / data-model / dfd-interface / test 与本批实现同步（含 complete 持久终态与准入时序），历史决策文档只补说明不改原文。
- 已知不做项与过渡语义写清楚：预算到顶仍 paused、输入只排队无自动 steer、展示值本批不接 UI。这些都是过渡，不描述成最终设计。
