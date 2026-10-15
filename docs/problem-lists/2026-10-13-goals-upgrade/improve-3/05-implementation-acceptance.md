# 第 3 批实施与验收：停止、恢复与时间截止

日期：2026-10-15。分支 `codex/goals-upgrade-improve-3`，基于 improve-2 收尾提交 `fed91056`。本批保留独立开发分支，不合并 `codex/goals-upgrade` 或 main，等待 improve-5 总体验收。

契约：[02](./02-optimization-plan-and-change-scope.md)、[04](./04-test-and-acceptance.md)；阶段模块文档：[架构](../../../goals/improve-3/architecture.md)、[数据模型](../../../goals/improve-3/data-model.md)、[接口与用例](../../../goals/improve-3/dfd-interface.md)、[测试入口](../../../goals/improve-3/test.md)。延续 improve-2 的文档约定，原始 `docs/goals/` 文件保留，本目录只描述第 3 批阶段状态。

## 实施结果

- blocked 成为常驻第四态，预算与安全阀到顶从 paused 改为 blocked。模型只能 complete/blocked；用户 stop、执行失败与重启降级仍 paused。
- 模型每个真正受阻轮报告一次。后端按有效准入票据确认相邻三个 goal run、同轮一次、同因归一化；第三次先保存再提交内存计数，保存失败可同轮重试。真正恢复、正文实改、新目标与新进程清链；同文编辑、active 幂等恢复与仅调额度不清链。
- `/goal resume` 支持无参、单维与双维两种顺序。额度是总量，不清零用量；完整解析拒绝尾部垃圾。合并检查与一条 update 同处既有 session 串行区，失败预算、状态和记录都不变。SetGoalBudget 不自动恢复。
- active 时间预算变成当轮截止。创建、恢复、实改 objective、调额度按累计用量重排；旧回调不清新 timer。捕获真正 goal 票据后停止对应执行及子树，准备阶段也能取消；等待用户工作时只阻塞目标，不打断用户。
- SDK、adapter、CLI、Web 保留 blocked，Web 面板支持空字段保留原额度、双维恢复与错误重试。composer 带参命令原文透传后端，无参保留面板交互。

## 与规划的衔接和调整

| 项目 | 实际处理及理由 |
| --- | --- |
| 基线与旧符号 | 规划以 main 快照描述“前序预期”，实际继承 improve-2 已落地的票据、epoch、preparationSignal 和 runControl；不重复实现身份系统 |
| 纯逻辑与状态位置 | 新增 budget-input 与 BlockedAudit 两个局部模块，仍由 service 持有每 session audit/timer；无新锁、调度器、表或依赖 |
| 中断端口 | 复用 improve-2 的 expectedRunId/ticket 与 helper，无需另扩 adapter 票据 API；closeAdmission 清理 service timer |
| 文档落点 | 保留历史设计原文，阶段文档写入 docs/goals/improve-3；本批四态取代历史“blocked 非常驻”的结论，不改写原始决策记录 |
| 原有 light note | paused 的 light note 暂留至 improve-5；历史 blocked 不再降 paused，也不新增 blocked note |
| UI 补充授权 | 用户实施中明确要求去除嵌套卡片、减少玩具感，授权 Pi 直接打磨 Goal UI；不增加下一批常驻数字或新框架 |
| 旧 safety-cap 测试 | 原 fixture 在 safetyCap=0 时没有任何已准入票据，却假设按 session 扫描中断任意子任务。改为 blocked 且无 root 不扫其他任务，符合本批定点中断契约；保留并加强真实 goal/user 两棵树的实际中断测试 |

## 测试和审查发现的修复

1. **active 调额度丢失保存等待时间**：resume 的 active→active update 如果在 append 完成后重新起表，会赠送保存期间的活跃时间。保留更新前时间锚点，400ms→600ms 的 deferred append 用例先红后绿。
2. **截止落盘失败后执行继续**：独立审查复现 timer 已移除、blocked append 拒绝，目标仍 active 且执行未停。失败路径现在停止已捕获 root/preparation，保留原状态/记录并报原始错误，不递增 epoch、不自动重试；普通取消结果继续走原有 paused/finalization。无票据时不触碰用户执行。准备中、已运行及中断自身报错均有故障注入回归。
3. **截止取消原因被覆盖**：Pi 只读建议经主代理故障注入复现（准备与运行两个用例先红）。driver 取消分支优先保留 ticket.stopIntent.reason 并记 runtime，普通用户取消仍为 interrupted/user。持久化持续失败时可能保留 active 表示但执行已停，timer 不自动重试，后续操作重新检查。
4. **测试异步边界**：watchdog 竞争用例在并行回归中读到了尚未完成结算的 active。将同步点改为 provider 消费部分输出后的下一次读取，以及真实 goal.updated 停止事件；不增加固定等待时间。受影响测试及该文件连续三次复跑通过。
5. **协议与界面接线**：blocked 不能继续走旧 paused 归一化；adapter 的事件、重连快照和 session view 同步。Web 参数不能被 overlay intent 吞掉，带参仅在 goal/resume 分支开启 allowOverlay，非法尾部交后端拒绝。

## 验收证据索引

下列路径相对仓库根。unit 只称单元测试，真实协作仍按其文件类型报告；端到端独立列出，不把 opt-in 跳过计入通过。

| 验收项 | 证据与覆盖 |
| --- | --- |
| 3-B1 / 3-E1 | goals store/driver unit、goal-compact integration、persistence integration：预算/安全阀 blocked，显式停止与失败 paused，blocked 回放保留 |
| 3-B9 / 3-B10 / 3-B12 | blocked-audit unit、goal-lifecycle integration、tools unit；daemon goal E2E 通过 production tool：同 run 三次只算一次，三个已准入 run 才 blocked，空理由/非法状态拒绝，旧票据失效，第三次 append 失败可重试 |
| 3-B11 | lifecycle integration：同文/active resume/setBudget 保留；真实恢复、正文实改、新目标清链；重建 service 清部分链，已落盘 blocked 保留，跨 session 隔离 |
| 3-B3–3-B8 / 3-E3 | budget-input/commands/budget unit；lifecycle integration：两轴同时耗尽，任一单维恢复失败零修改、双维单 update，deferred 并发合并、append 失败，blocked 调额不驱动直到显式 resume；安全阀不可抬高 |
| 3-D1 / 3-D2 / 3-D3 / 3-D6 | goal-deadline integration：长轮、首次设额/调高/调低、早到重排、旧 token、暂停恢复/取消/完成/替换/关闭清理；保存期间活跃用量不回退 |
| 3-D4 / 3-D7 | adapters/goal-stopping integration：用户持有执行时 deadline 不抢占，goal 未准入不计轮，blocked 时长不继续增长；child-stopping integration 同时验证用户子树 |
| 3-D5 / 3-D8 | goal-stopping：绑定前、启动前、worker 已启动但 UI runReady 未发布；goal-child-stopping：当前 goal、正文实改旧 epoch、模型第三次 blocked、等待用户四类真实子树，includePrimary:false 不等待未发布的 runReady；原 G28 contract 保留 await 后执行者切换 |
| 3-X1 | goal-stopping integration 使用 production idle watchdog：deadline 先 blocked 和 watchdog 先 paused 两个方向均保持先提交状态 |
| 3-U7 | Web goal-resume.integration：真实渲染 App→Web runtime→HTTP daemon→后端，覆盖双维正反序、单维、非法尾部、无参面板、空字段、失败保留与 session 校验；浏览器桌面/手机补充 |
| 3-E2 / 3-E4 / 3-E5 | prompt:check、injection/tools unit；CLI blocked 文本与 warning ANSI；adapter blocked contract 的 event/snapshot/session view 一致 |
| HTTP 端到端 | daemon goal-execution.e2e：真实 HTTP/SSE、SQLite、工具与 runtime；三轮阻塞、主任务收尾、双维恢复审计清零、complete 结算清理 |

这组证据覆盖关键竞争窗口，并不声称穷举所有时序组合。主任务完整 runtime 的 runReady 窗口、子树真实 signal/store、第三轮审计分别有组合测试；用户切换到新 root 的 await 竞争沿用真实 child host 契约测试，不把分层证据虚报成每种交叉排列都做过浏览器 E2E。

## 执行记录

| 最终执行 | 结果 |
| --- | --- |
| `pnpm test:unit` | 339 文件，4,209 通过，2 个既有跳过 |
| `pnpm test:contract` | 37 文件，540 通过 |
| `pnpm test:integration` | 162 文件，1,500 通过；随后对截止原因、watchdog 同步点与 UI 最终改动复跑受影响集合 |
| 最终受影响集合 | App、样式、真实 Web resume、deadline、adapter stopping、child stopping，共 6 文件 / 226 项通过；stopping 文件另连续三次、每次 6 项通过 |
| 确定性 daemon E2E | goal-execution + model-idle：3 通过；4 个真实 provider opt-in 跳过，不计作通过 |
| 真实 API E2E | 本轮另开启 DeepSeek goal 实测，与两项确定性 goal 及 watchdog 合计 4 通过、3 个其他 provider opt-in 跳过；详情见下 |
| 静态与构建 | `pnpm typecheck`、`prompt:check`、修改源码 Prettier、`git diff --check`、`pnpm build` 通过 |
| Lint | `pnpm lint` 退出 0：0 errors / 122 warnings（包含测试返回类型提示）；未扩大范围清理历史警告 |

构建仍提示 Web 主包约 521KB 超过 Vite 500KB 提示阈值；这是体积提示，不是编译失败，本批未额外拆包。测试未以 skip 或异常包装退出码冒充通过。

首次全量执行：unit 339 文件/4,208 通过/2 既有跳过，contract 37 文件/540 通过；integration 160 文件通过，1 文件因旧 safety-cap 状态/无票据扫子树预期失败，随后该文件 6 项定向通过。两条 unit/contract 命令包装脚本在测试结束后误写 zsh 只读 status 变量；测试日志均明确通过，最终检查使用修正后的包装，不把包装退出码称为测试通过。

真实 API：使用 tests/models-4-tests.md 的 DeepSeek deepseek-flash/openai-compatible，从 .env 读取 key、不输出凭据或请求正文。独立临时 HOME/SQLite，真实 daemon HTTP/SSE 与 production UpdateGoal。一轮、3 次请求（goal 2、title 1），16,606 total / 9,344 cached，统计完整，完成通知一次、最终 marker 精确匹配。临时服务和目录由测试 finally 关闭/清理。此样本验证真实模型完成链路；三轮阻塞/原子恢复/截止竞态主要由确定性 provider 和故障注入证明。

## UI 与人工验收

Pi 仅调用一次：`github-copilot/claude-opus-5.5` / medium；负责 Goal 面板局部打磨和后端只读意见。收到用户限制其工作量的要求时该轮已自然结束，未追加任务。主代理随后独立回归，不采用 Pi 的自测声明替代验收。

面板去掉嵌套摘要卡与重复 objective，以状态行、留白和细线组织内容。Objective 独立保存且只在内容变化时可用；paused/blocked 的主操作为 Resume，active 显示 Pause，无目标显示 Create goal；额度默认折叠。所有操作在 busy 时禁用，错误留在面板，反馈 aria-live；说明文本经最终复审加深为 #6b6d73。

主代理在真实本地 daemon + 已构建 Web + 隔离 fixture 中使用 CUA 控制浏览器并查看截图，检查桌面 1280×900、手机 390×844：

- blocked 目标同时耗尽轮次与时间，只抬轮次明确失败，面板与输入保留；补 3h 后通过键盘 Resume，状态变 active。
- 保存新 objective 后状态仍 active；Pause 后运行停止、状态变 paused；重新加载仍显示保存后的 objective 与 paused。
- composer 原文 `/goal resume 100 turns extra` 到达后端并返回参数错误，目标保持 paused。
- Tab 可依次到达额度输入、Delete 与 Resume；手机长错误可在面板内滚动到底部操作，无横向溢出（document.scrollWidth = innerWidth = 390）。
- 浏览器 error 日志为空。更新说明文字颜色后重新构建、加载并复看桌面/手机。测试服务与浏览器已关闭，临时视口已重置。

人工截图保留于本机临时目录 `/tmp/ohbaby-client-qa-evidence/`：`root-desktop-final.jpg`、`root-mobile-final.jpg` 及错误状态；这些是本次运行证据，不是跨机器持久资源。真实模型的调用证据与 UI fixture 分开记录；fixture 不消耗真实 API。

## 审查

预算/命令、生命周期、客户端均经独立子代理审查。生命周期审查复现并推动修复截止写失败后未停执行；修复后定点复审通过。Pi 提出的取消原因问题已验证并修复；UI 复审未发现阻塞问题，说明文字对比度建议已采用。整批最终独立审查（gpt-6-astra / high）覆盖 `fed91056..f450ec15` 的 42 个改动文件及阶段文档，未发现可复现的 Critical / Important 或需要本批追加的 Minor 问题，结论为本批可交付；详见 [06 最终审查](./06-final-review.md)。该审查只读，未重复执行全量测试。

## 分批提交

| 提交 | 范围 |
| --- | --- |
| `8a7cc5eb` | blocked 生命周期、审计、额度解析与原子恢复、当轮截止、SDK/adapter 投影、单元/集成/HTTP E2E |
| `f450ec15` | Web 参数入口、恢复面板与视觉打磨、真实 Web runtime 集成、CLI blocked 契约 |

文档与验收另作提交。两个代码提交均经过仓库 pre-commit 的全量 lint 与 typecheck。保持当前独立开发分支，不 merge/push。

## SWE 与后续边界

本批复杂度集中在必须处理的时间与执行身份，不增加第二套状态权威。解析与计划函数不依赖 adapter；服务使用既有串行区，store 先保存再改内存；测试把准备、运行、收尾与失败作为可控边界。独立审查发现的持久化异常有最小停止路径，不以无限重试掩盖失败。审计按字符串归一而非语义理解，换说法会重计，这是已接受的产品限制。

后续继续 improve-4 自动 steer、FIFO 与未消费输入恢复；improve-5 常驻数字、正文/展示分离、criterion 上限及整体压缩/重连回归。历史 blocked 回滚旧版本会降 paused；前后端及依赖批次应一起评估，不能称为无语义变化的回退。
