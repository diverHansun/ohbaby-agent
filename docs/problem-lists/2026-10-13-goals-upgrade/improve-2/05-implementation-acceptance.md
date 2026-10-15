# 05 实施与验收：第 2 批（执行准入与统计基础）

日期：2026-10-15。开发分支：`codex/goals-upgrade-improve-2`，基于 improve-1 的 `8bac21ea`。本批保留独立分支，等待 improve-5 总体验收后再决定合并。

原始方案：[02 优化方案](./02-optimization-plan-and-change-scope.md)；标准：[04 测试与验收](./04-test-and-acceptance.md)。实施后模块文档：[架构](../../../goals/improve-2/architecture.md)、[数据模型](../../../goals/improve-2/data-model.md)、[接口与时序](../../../goals/improve-2/dfd-interface.md)、[测试说明](../../../goals/improve-2/test.md)。按用户补充约定，`docs/goals/` 原始文件不改；子目录只描述本批阶段状态，不能当作五批全部落地后的最终设计。

实现提交：`a3f2c243`（Lifecycle 部分用量保留）、`6cbd37c7`（goals 准入、身份、结算与测试）。

## 实施结果

- 用户 prompt、goal 和手动 compact 共用 adapter 的小型执行占用组件。检查、计轮与占用仍在现有 session owner 队列内串行完成，没有新增调度器或锁。goal 忙时用户仅排队，不打断，不占用户执行容量；释放后用户队列优先。
- goal 准入成功才计轮，并从同一快照生成正文、轮号和展示值。票据绑定真实 runId，executionEpoch 隔离暂停恢复、目标替换和 objective 实改。旧 run 可以收尾，但不能修改新生命周期；同 goalId 的已知尾部用量仍可结算。
- complete 先持久化并隐藏 UI 当前目标，通知一次，再结算末轮 usage、静默 clear。runtime finalization、usage、clear 使用 scheduler 的单个恢复槽，成功阶段不重复，不新增历史账本。
- token 只作统计，移除 token 预算和自动提醒中的 token 文案；查询保留 total、cache 和不完整标记。缓存量包含在 total 中，不重复相加。
- 预算到顶仍暂停；blocked、硬时间截止、自动 steer、displayText 的 live/replay 与数字 UI 不在本批。只读 steer 资格挂点已就位，尚未接入自动输入分流。

新增的生产文件只有 `adapters/session-execution.ts`，独立表达三条执行路径共用的占用与唤醒。其余生产修改沿现有模块完成。测试新文件分别验证 service 准入、adapter 协作、gate/scheduler 协作与 HTTP 服务链路；没有引入通用测试框架。

## 测试暴露的问题与修复

1. **失败或取消丢失已知缓存小计**：Lifecycle 原先只在完整 breakdown 中保留缓存量。补可选 `cachedInputTokens` 下界字段，完整 breakdown 的原有语义保持不变；受控 provider 失败标记统计不完整。最终补测还发现首事件前普通错误直接 throw 会丢失前序步骤累计量；普通失败及强制压缩重试后的失败均改为携带原始 failureCause 和已知 usage 返回，保持 runtime 错误分类。兼容 Chat/Responses 的既有明细测试。
2. **执行恢复阻断目标命令**：旧 runtime 收尾失败时，命令入口先重试恢复，导致 cancel/new 都无法提交。目标命令改为初始化状态视图；真正执行仍受 recovery gate 阻断。
3. **旧目标 clear 回放影响新目标**：update 与 clear 都按 goalId 过滤，真实 SQLite 与内存回放均验证。
4. **关闭后的准入空转**：adapter 已承担有效等待，`not_admitted` 直接结束当前 driver，关闭唤醒后不重试同代。
5. **内部准备 await 漏取消**：独立 `preparationSignal` 穿过 AgentService、runner 和 RunManager，覆盖配置、消息、pending/running ledger、sandbox 等准备等待。running 落盘后同步解除监听；已启动 worker 不因 complete/objective 换代误停。pending 取消仍补终态与输入关闭。
6. **关闭过早确认**：关闭等待所有 goal driver 尾结算，再处理随后登记的 recovery。usage 挂起与首次失败后重试都有真实 client 回归；沿用现有 deadline，不新增退出协议。
7. **准备取消监听器异常外泄**：权限撤销抛错时仍投递 abort，错误由现有 finalization 重试处理，AbortSignal 监听器不向 Node 抛出未捕获异常。
8. **缺失总量落成 0**：Lifecycle 的空小计为 0 且 incomplete，adapter 不再把它写成已知 total；模型明确返回 0 且总量完整时仍保留。真实失败、无 usage 的 complete、显式零用量三种路径均有回归。

第 4–6 项由独立子代理审查复现后修复。按 KISS 删除了未被读取的 started/outcome、重复 recovery 标记、gate 的 kind 字段，以及仅为测试暴露的 getPendingTicket。

## G1–G28 证据索引

路径均相对 `packages/ohbaby-agent/src/`。GE = `adapters/goal-execution.integration.test.ts`，SE = `adapters/session-execution.integration.test.ts`，UI = `adapters/ui-inprocess.contract.test.ts`。contract 文件中的真实组合测试按原文件分类报告，不改称 integration；其下实际 owner、runtime、service、store 未被替换。

| 标准 | 自动化证据与边界 |
| --- | --- |
| G1、G3 | GE 用户不打断、跨 session 并行、队列优先；SE `maxActiveSessions=1`，gate 释放触发 drain |
| G2、G23 | GE owner barrier 两种顺序；SE stale prefilter 后 owner 区内复查，无第二个 worker |
| G4 | SE closed/requeue 释放恰一次，后继 scheduler 可再次 claim；旧 token 不清新占用 |
| G5、G6 | GE 实际 compact 持有期间等待/暂停，用户占用期间 pause/cancel/replace，未准入零计轮 |
| G7、G8 | GE append barrier 两种顺序、准备取消保留计数；计轮及自动暂停落盘失败不自动重试，修复后显式 resume |
| G9、G26 | GE 最新 objective、同 goalId/累计数保留、旧三种工具拒绝；admission unit 同文 no-op 与计轮后正文/展示值一致 |
| G10、G11 | GE pause/resume 后旧结算迟到、恢复期间 cancel/new；UI 同 run CreateGoal 替换，旧用量不计入新目标；service 固定 epoch 与 promise 身份清理 |
| G12、G15 | persistence integration 的 SQLite/内存回放：计数保留、active→paused、complete→clear，迟到 update/clear 过滤；GE 从 client 初始化无 provider 重跑 |
| G13、G25 | UI 同 run 替换期间旧尾部继续、旧统计/Todo 不写新目标、steer 查询无资格；G24 四种交接状态也验证查询资格 |
| G14、G18 | GE complete 立即投影空、通知一次、尾 usage→clear；UI shutdown 等待 usage 及晚到 recovery；admission unit 验证重复结算与 clear 重试 |
| G16 | SQLite/内存 store integration：complete 残留拒绝 resume/replace/budget 且零新记录，允许 create（两种 replace 值） |
| G17 | GE failed/cancelled 保留已知 total/cache；SQLite/内存 integration 验证只写已知字段，不把缺失值写成 0；Lifecycle 单元及协议集成验证部分统计 |
| G19、G20 | 历史 token 限额读兼容；tools unit 拒绝 tokens；status/GetGoal 共用渲染保留统计；injection unit 证明自动提醒无 token |
| G21 | GE runtime→usage→clear 实际 initializeSession 恢复、并发重试、取消/新目标后恢复旧 runtime；UI shutdown 晚到 recovery；成功阶段恰一次 |
| G22 | GE 真实 foreground child 与另一 session 手动摘要产生用量，goal 只计 admitted 主 run；独立 auxiliary usage integration 回归 |
| G24 | GE 配置准备、claim/running ledger barrier 与准备取消；UI 实际 worker 已启动但 runReady 未发布时 complete/replace 保留尾部、pause/cancel 中断 |
| G27 | GE 真实 user 主 run 四工具成功；三种写工具 × 缺失/未知/真实 child runId 拒绝且持久化不变，GetGoal 仍可读；三种过期写工具拒绝；schema 不包含 runId |
| G28 | goal-execution-control contract 用真实 SessionSubagentHost/实例与执行 store，观察两棵树的实际 child signal/status；主 run 的真实启动中断由 UI G24 覆盖 |

这些测试覆盖本批可达的核心竞争边界，并不声称穷举所有状态、异常和时序的笛卡尔积。门禁串行执行使正常生产路径同时只有一个 admitted goal run；直接重复结算等防御语义用 unit 补充，不以 mock unit 替代实际恢复入口证据。运行中的 pause 由 RunManager 以 interrupted 结束，adapter 沿用 failed 映射；G10/G11 实际验证该路径及 provider throw 的旧结果，不能把它误报为准备阶段 cancelled 的全部交叉组合。

## 执行记录

| 验证 | 结果 |
| --- | --- |
| `pnpm test:unit` | 337 文件，4,140 通过、2 项既有跳过 |
| `pnpm test:contract` | 36 文件，538 通过 |
| `pnpm test:integration` | 串行执行，157 文件，1,448 通过，约 400 秒；包含 CLI 编译产物、真实 daemon 进程及 SQLite 故障恢复 |
| 最后 G17 修正后定向重跑 | goal execution integration 44 + ui-inprocess contract 168，共 212 通过；全量 integration 中该文件此前为 41 项，三项新增见上文 |
| 确定性 E2E | daemon goal、model-idle、subagent 三文件：10 通过，4 项真实 API opt-in 跳过 |
| `pnpm lint` | 0 errors、108 warnings；改动文件检查 0 errors、15 warnings，均为缺少显式返回类型提示 |
| 格式、链接与敏感信息 | 改动 TypeScript 的 Prettier 与 diff-check 通过；11 份批次/模块/入口文档相对链接无断链；改动文件无密钥格式命中，未改 `.env` |
| `pnpm build` / `pnpm typecheck` | 全工作区构建和 CLI 打包通过；构建内含 `prompt:check`，最终类型检查通过 |

全量 integration 期间发现并补测 G17 的空小计边界，之后对直接受影响的两个 adapter 文件完整重跑。其余已通过测试不重复包装成新增测试数量。

真实 API 为独立补充证据，不替代确定性竞态测试：DeepSeek `deepseek-flash` / `openai-compatible`，通过真实 daemon HTTP/SSE、SQLite、production tool/runtime。最终一次运行 3 次请求（goal 2、title 1），一轮，16,290 total / 15,488 cached，统计完整，完成通知一次，最终 marker 精确匹配。为加强 marker 断言共跑两轮，合计 6 次请求；没有输出密钥或请求正文。真实 API 测试保留显式 opt-in。本批未进行浏览器视觉验收；前端展示仍按第 5 批统一验收。

## 参考与审查

参考项目只借用适合当前边界的做法：DSH 的有效预约复查、Codex 的 turn 身份记账、Kimi 的边界计数和用量归属、ZCode 的准备/运行/收尾区分、Claude Code Best 的用户队列优先与事件驱动续跑。Claude Code Best 是本地重构项目，不作为 Anthropic 官方实现证据。原始代码定位见 [03](./03-reference-projects.md) 和[总规划参考](../plan/03-reference-projects.md)。

独立子代理审查已完成，三条实际问题及处理见上文。Pi 按用户指定的 Opus 5.5 / medium 调用；本机注册模型为 `opencode/claude-opus-5-5`。同一次只读审查因宿主中断续接一次，已完成并向用户展示原文。Pi 未发现阻断项，主要建议如下：

- 建议准备取消不标记 incomplete，甚至退回轮数。本批不采纳：G7 明确规定准入后取消仍计轮；没有 startedRuntimeRunId 也不足以证明 worker 尚未启动，不能据此把未知用量标成完整。仅已知安全的零调用边界可在未来单独优化。
- 建议删除 gate.kind；确认没有读点后删除。保留 compactingSessions，因为现有 assertSessionNotCompacting 用它区分 compact 与当前已获准的 user/goal，不能直接用通用 gate 判断替换。
- 建议删除 driver 预算快路径、recoveryPending 守卫和 stopIntent 回放。本批保留：分别承担规划规定的快速退出、G21 恢复移交防重、runReady 交接的捕获停止意图；删除需要新的正确性证据，收益不足。

最终原始 provider 错误修复再次由子代理只读复核，确认 failureCause 仍经既有 normalizeRunError 保留分类；相关两文件 48 项通过。审查意见是辅助证据，最终以代码和测试结果为准。
