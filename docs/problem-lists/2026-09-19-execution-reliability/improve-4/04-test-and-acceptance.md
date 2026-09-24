# 4. 测试与验收标准

> 后续实施的验收契约，不是本次测试结果。本次只完成文档调查与审查。必须在improve-1、1.1、前置C、improve-2/3实际验收并核对A/B依赖后运行本轮测试；不得用旧诊断的通过记录替代。

## 4.1 分层与观察点

沿现有 Vitest unit/contract/integration、compiled Web 和真实模型测试入口；仓库未发现独立 `docs/test-blueprint.md`，不在本轮新增一套测试规范。

| 层 | 验证内容 | 必要观察点 |
|---|---|---|
| unit | 状态转换、资格检查、去重、时钟和截止期 | 可控 Promise/时钟、调用次数、状态不倒退 |
| contract | SDK、in-process、REST/JSON-RPC、投影一致 | 真实身份、错误码、retained 与 receipt、同版协议一致、未知状态拒绝 |
| SQLite integration | 同库多 owner、事务/重试、修复/迁移 | 提交前后记录、唯一键、终态/消息关系，不只 mock store |
| 真实进程 integration | Shell 取消、daemon 退出确认、强杀和重启 | PID/进程身份、独立退出观察、marker 文件、DB和诊断 |
| compiled Web / PTY | 用户实际入口、刷新、双页、编辑/删除/发送 | UI + 后端事件 + DB + provider请求计数四者一致 |
| 真实模型 E2E | 多子代理长任务、停止后新任务、历史继续 | 协议/模型/revision、交付身份、不串任务，不依赖网页答案正确性 |

故障点以闸门控制：派遣登记前后、execute 前开始事实提交、工具结果提交、根中断登记、prompt claim、清理确认、恢复事务提交。不能仅 sleep 一段时间推测竞态。真实进程测试可用有界轮询，必须有最终超时和独立回收，避免测试自身泄漏。

## 4.2 场景矩阵

| ID | 场景和必须断言 | 层 / Stage | 问题 |
|---|---|---|---|
| T01 | 普通 B 创建新 runId、同 session；Steer 保持 A；step/request attempt 不冒充新 Run；复用 runtime。S0 用第三轮实际接口构造 accepted/queued/running 子委托及工具/job，验证无 childRunId 时也有 executionId/rootRunId、同实例A/B归属可区分；缺项阻断依赖它的整树Stop接线，回上游补齐，不用parentSessionId代替 | upstream contract / S0 | P1 |
| T02 | A 活动且 B/C 正常 queued，根 Stop 后 A 主逻辑退出并登记，再 B 恰好启动一次，C 顺序不变 | integration / S1 | P1/P2 |
| T03 | A 含当前允许的一层模型派遣、foreground/background、未领容量子委托；另构造已有内部/历史多层归属记录验证整树收尾，不开放模型嵌套；Stop后全部本次委托失去资格，已完成结果不变 | host+DB / S1 | P1/P3 |
| T04 | Stop 与接受派遣/创建完成在每个边界竞争；未登记的不启动，已接受的可追溯且被中断，不产生游离子执行 | controlled race / S1 | P1 |
| T05 | 子实例有 current A1、pending A2；Stop 后两者留记录退队，新主给 B1，只 B1 执行；明确续旧工作也使用新 execution | host+DB / S1 | P3 |
| T06 | A 的旧 Stop/finally/结果/进度在 B 活动后到达，不停止B、不清B索引、不重置B时间、不注入A交付 | contract+integration / S1 | P1/P2 |
| T07 | Stop 与审批回答/always 竞争，未决审批撤销、等待者结束；迟到回答无策略副作用、不启动工具 | improve-1联测 / S1 | P1 |
| T08 | Stop 前成功提交结果与 Stop 后迟到返回分开：前者保持成功，后者不能把 interrupted 改success；通知不触发新模型 | DB+lifecycle / S1 | P1/P7 |
| T09 | 分别使Run/prompt终态、子委托退队、未完成工具历史保存失败：Stop受理不冒充关键登记成功，取消与清理继续，任一关键项未成功前B不启动；有限重试耗尽显示具体错误并保留事实；DB恢复后原owner补登记并重读，B读取到完整tool-call/result配对后只启动一次；主逻辑未退出不得ready，崩溃后另走冷恢复 | fault integration / S1 | P2/P7 |
| T10 | A raw工具/cleanup闸门不释放，Stop后B模型可开始且正常清理静默；正常观察期B冲突工具不执行，A确认后可放行；异常变体转unconfirmed后新调用返回一次普通资源错误、原保护仍在、迟到确认不重放 | scheduler+sandbox / S1 | P2 |
| T11 | cleanup Promise拒绝或unconfirmed，文件保护/lease/registry仍追踪；按前置C先建保护再归还普通调用名额一次，无冲突工作不因旧调用占槽停住；迟到回调不重复还槽、只释放对应owner的资源；不合作进程内写不会因超时获得冲突并行写入 | integration / S2 | P2 |
| T12 | background Bash已经返回jobId后根Stop，仍按归属收到终止；另一Run/另一独立scope的job不被误杀 | real process / S2 | P1/P2 |
| T13 | 清理未结束时配置热重建被阻止/等待，旧保护未丢；普通换Run不重建整runtime | integration / S2 | P2 |
| T14 | 显式关闭、SIGINT/SIGTERM、支持平台SIGHUP均停止接活；关闭与enqueue/claim/懒加载竞争不启动新任务；幂等重复关闭 | daemon+PTY / S2 | P4 |
| T15 | serve stop 发信号后目标仍活时不得报已退出；进程实际结束才确认；端口先关闭/状态文件先写不误报；外部超时非零 | real daemon / S2 | P4 |
| T16 | token不匹配、新服务换代、PID复用模拟、存活检查权限错误，不对新进程发信号、不盲报成功；新token报告不被旧命令采用 | contract / S2 | P4 |
| T17 | 多清理项一个失败/一个超时，其余仍尝试；独立进程持SQLite真实写锁，busy_timeout/退避/清理/最后保存共用一个退出截止时间，剩余不足不再发起完整重试；锁覆盖预算时不伪报已保存，锁在预算内释放时可完成保存。以外部时钟观察宿主与serve stop：同步等待受限；仍未确认进程退出时命令在外部预算内非零返回，不由进程内timer假报成功；底层dispose不杀宿主 | SQLite+real process / S2 | P4 |
| T18 | A运行、B/C queued后正常退出或SIGKILL，再启动：A中断，B/C retained，无provider/工具自动请求；重复打开/刷新仍不执行 | real daemon+DB / S3 | P5/P6 |
| T19 | 同版本同库TUI与serve各自accept即保存owner，listQueued/启动范围/claim仅处理本owner，不因别人的队首阻塞自己；claim不能改写归属，requeueBusy保留owner。重启其中一个只修失效归属，另一方queued/running/审批不变；同PID多owner只dispose自身；不同owner不能冒充同一环境 | multi owner DB+process / S3 | P6 |
| T20 | 在线恢复遇到归属不明、PID探测权限错误或旧scope-only入口，不按全scope中断、不自动认领；错误影响范围明确。与T43离线旧库迁移区分：已满足离线前提后旧记录缺owner本身不导致永久无法迁移 | owner recovery / S3 | P6 |
| T21 | 工具在开始保存前、保存后执行前、产生副作用后结果保存前崩溃：分别not-started/unknown/unknown；不重跑；完整结果不被合成覆盖 | crash barriers / S3 | P7 |
| T22 | 修复各store之间再次崩溃，重启后终态、tool配对、交付、retained一致且无重复；ready前用户输入不执行 | DB transaction / S3 | P6/P7 |
| T23 | 单根会话malformed/格式不支持/定点保存失败，原记录保留、该树blocked、另一健康树可用；父已终态但子仍running也被核对 | fault integration / S3 | P6/P7 |
| T24 | 共享DB不可写/迁移失败不冒充单会话故障，依赖它的新执行被阻止；错误不是永久Thinking | integration+UI / S3 | P7 |
| T25 | 有失主子结果/未交付通知/未ready产物/删除意图，恢复保留归属、可幂等核对派生文件、不唤醒新Run、不重放子任务、不越权读 | improve-3联测 / S3 | P1/P7 |
| T26 | retained B/C时用户发送新D，只D可执行；单条重发B原子更新owner与acceptedAt，仅B重新准入，C归属/状态不变；消息id不复制，B不越过已接受D；另冻结底层时钟在同一毫秒接受D再重发B，仍按准入顺序，不按随机ID插队；普通queued编辑不换owner、不更新acceptedAt，失败重发保留原状态和归属 | scheduler+DB / S3 | P5/P8 |
| T27 | 单条重新提交与双页重试、响应丢失、edit/delete/claim/Steer竞争，唯一receipt/唯一Run；retained不能Steer，已claim删除返回冲突；队列满/关闭/未ready保留retained及编辑内容，与新提交抢最后容量只允许一个成功 | contract+DB / S3 | P5/P8 |
| T28 | 新空库初始化与旧格式fixture升级到同一目标约束；status CHECK支持retained，已有字段/索引/唯一键/外键完整，acceptedAt初值来自createdAt；同版SDK/Web/TUI正确识别，未知状态不降级queued；升级后不要求旧二进制可用，回退只验停新程序后恢复备份，不做多版本兼容矩阵 | schema+contract / S0基线/S3验收 | P5/P6 |
| T29 | retained隔日重发保留createdAt、用新acceptedAt计时；恢复封口时间不冒充实际执行结束；原真实endedAt不覆盖 | clock+projection / S3 | P7/P8 |
| T30 | 正文不触发编辑，铅笔编辑/垃圾箱删除；普通queued“保存”、retained“发送”；删除不经过输入框清空，无继续队列按钮 | compiled Web / S4 | P8 |
| T31 | 原草稿/恢复编辑文字不丢、多条不合并；取消/失败/删除当前项/租约过期/双页乱序均不覆盖或复活已删内容 | UI+backend / S4 | P8 |
| T32 | Web刷新/重连/复用活serve不是冷启动：普通队列继续、审批恢复；打开历史不自动执行retained | compiled Web / S4 | P5/P6 |
| T33 | 默认TUI不启动/attach serve；任务Ctrl+C是Stop并推进正常队列；明确退出仅清理自己；重开旧会话保留待发送 | compiled PTY / S4 | P4/P5 |
| T34 | 两种链路的端到端闭环：Stop自动B、整服务退出后重开不自动B；真实多子代理任务旧结果不串新任务 | scripted+real E2E / S4 | 全链路 |
| T35 | 三种交接耗时采样：正常结束、慢清理Stop、长会话；旧清理独立计时，记录相同fixture前后差异用于诊断，不自行设交接毫秒阈值。硬断言：A关键保存成功、旧清理闸门仍未释放时B请求已出现，不等待无冲突清理 | controlled perf / S4 | P2 |
| T36 | Stop原按钮反馈复用第二轮T28，可靠终态后结束且不等残留清理，旧run回执不影响B；正常清理无专门通知；异常实际挡住B时仅受影响且未execute调用收到一次普通工具错误，原保护仍在；普通锁竞争不误报、独立工作继续；清理确认/取消/启动竞争不重复结果、不重放 | C14/C15+improve-2联测 / S1/S4 | P2/P7 |
| T37 | 真实工具执行计时与Thinking独立；等待不启动running计时，Stop后原工具计时固定；刷新不重置，异常未执行调用无伪造时长，后台派遣计时不冒充job时长 | Web+PTY+SDK / S4 | P2/P8 |
| T38 | 注入瞬时busy、持续不可写、损坏/不支持错误：真实 serve 锁竞争下从本地客户端发 Stop 到受理并发取消须在 1 秒内（衔接第二轮 T08），不把 handler 入场前的堵塞漏掉；验证关键登记统一有限次数/总等待预算，SQLite等待与退避不叠套；失败后无自我drain/无限轮询；普通日志错误不阻断关键登记已成功的交接；普通查询不写入 | fault+clock+SQLite / S1 | P2/P7 |
| T39 | 重连、进入会话和下一次执行入口分别触发同一原owner恢复；前两者用显式恢复调用，普通GET snapshot/history/control保持纯读；多页面/SDK并发合并，提交成功但响应丢失后重读不重复终态/结果；关键保存成功才条件claim，使用单次答复scripted provider验证B请求/Run数均为1，旧A与工具执行数不增加；独立审批健康故障不被ready清除，旧请求不恢复 | contract+DB+Web/PTY / S1/S4 | P2/P7 |
| T40 | 恢复期间删除/编辑B、提交D触发检查、关闭服务或结束原owner：已删B不复活，有效项按既有队列顺序，编辑/claim沿租约规则；检查失败不接受D、不返回成功receipt且保留输入，恢复成功才正常接受D且不插队；shutdown不重新开放，同PID换owner不冒充原环境；冷恢复retained保持手动发送 | controlled race+DB / S1/S3/S4 | P2/P5/P6 |
| T41 | 接受/组装/发送/Stop竞争接第三轮T56：仅确切未送入且用户Stop产生灰色英文原文，位于queued卡片上方（空队列沿同区域）；多条合并一行，刷新/双页/切会话不串；B照常自动推进，原Steer不重排/回填/成为B新输入，无Queue paused/Continue；已尝试失败及未知证据不误标 | input+DB+Web/PTY / S1/S4 | P3/P5/P8 |
| T42 | serve stop覆盖02§2.5退出码矩阵：已退出+清理完成0，已退出+清理失败/未知1，确无服务0，身份不明/仍活/观察超时1；报告缺失不推翻进程退出事实，缺pid文件但身份冲突不冒充未运行 | real process+CLI / S2 | P4 |
| T43 | 旧入队未写owner库：已知旧TUI/serve活着时拒绝危险升级且不drain；停止旧写入者后一致备份包含WAL已提交数据；retained约束、acceptedAt初始化、旧queued全部转retained及迁移版本同事务，不伪造owner。缺owner的可解析旧活动记录补中断，子pending留历史退队。SQL中途失败则该版本及队列转换一起回滚且不启调度；重试及重复启动无丢失/重复。schema提交后、会话恢复前退出，再启动无可领取的旧queued且仍补完恢复检查；没有旧queued时不制造消息。不要求扫描器证明全机退出，也不要求旧版读写新库 | migration+real process / S0基线/S3验收 | P5/P6/P7 |
| T44 | 真实PTY准备三条queued/retained及现有草稿：Alt+↑进入选择，↑/↓选择中间项，Enter编辑，queued Save/retained Send只作用该项；Esc恢复草稿，队列Ctrl+D删除；编辑中Ctrl+D不走旧删队列分支；双页删除/claim不误操作相邻项，导航不触发模型或Stop | compiled PTY+DB / S4 | P5/P8 |

T21 的 not-started 必须有可靠证据（例如新版本 execute 前可靠写入协议且确认未提交开始）；旧历史没有字段一律 unknown。T19/T20 不能只 mock isAlive=true，至少有一次同版本真实双进程同库测试；旧版只用于 T43 的升级拒绝与离线 fixture，不扩成混版本运行矩阵。T16 的 PID 复用用注入身份观察模拟，禁止碰用户真实无关进程。

T01 在 S0 验上游归属数据，不提前要求尚未实现的整树 Stop；后者由 S1 的 T03～T06 完成。T28/T43 在 S0 确定真实旧格式、操作前提和 fixture，在 S3 执行迁移验收。以上仍为44项场景，按真实风险选取故障点，不新增字段排列组合测试。

## 4.3 真实 serve 与浏览器验收步骤

1. 先构建实际实施代码。使用独立 `OHBABY_HOME`、DB、项目目录、日志与 scripted provider；确认没有复用用户已有服务，再运行 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`。通过返回地址驱动浏览器。
2. A 在现有一层模型派遣范围内派三个子代理，包含一个 background Bash、一个待审批、一个已完成结果；同时排入普通 B/C。用闸门固定状态，记录 rootRun/execution/call/job/prompt 关联。多层关系另以内部构造记录测试，不要求模型调用被禁止的嵌套派遣。
3. 点根 Stop。断言完整任务树失去资格，原审批消失；旧主退出、关键停止事实及未完成工具历史保存成功后，B 的首个模型请求出现。旧工具清理仍在等待时，B 的冲突工具不得开始，正常清理不增加前端提示；随后释放闸门并观察准确清理。异常变体保持旧操作未结束、注入终止或探测失败，B被阻塞的新调用返回普通工具错误，无running计时和专门清理提示；迟到释放不重放该调用。C不提前执行。
4. 放出 A 的迟到回调，确认 B 不被重置，A 结果不作为 B 通知；复用旧子实例执行 B 的新指令，旧 pending 输入无工具调用。
5. 新建独立样例 A2+queued B2/C2，调用 `serve stop`，同时保留一项慢清理。断言命令在目标进程活着时仍等待，实际退出后再确认；记录清理是否 confirmed，不能只看 HTTP/端口。
6. 用相同测试 home/DB 重新启动。A2中断，B2/C2保留待发送，provider请求数不增加。刷新、切页、再运行复用serve均不发送它们。
7. 查看铅笔/垃圾箱与输入框：修改B2后“发送”，只B2运行；C2仍保留。新发送D不带动C2。另验证正常运行queued编辑后“保存”仍自动排队。
8. 单独运行崩溃变体：在开始事实/副作用/结果提交/恢复事务等闸门处 SIGKILL 测试宿主，重启检查 T21/T22。用唯一 marker 记录工具执行次数，禁止靠模型文字声称“没重跑”。
9. 注入单会话错误与共享DB错误，观察局部/整体阻断边界。另在同一活owner内让Stop关键登记持续失败：有限重试后B仍queued、无新增工具执行；解除故障，分别从重连、进入会话、下一次执行入口触发恢复，覆盖T38～T40；保存成功才启动有效队首。持续普通快照/历史查询不触发重试，多入口不重复启动。多进程变体核对独立TUI/serve互不修复对方活任务。
10. 用 `tests/models-4-tests.md` 当时可用的至少一个真实模型执行多校并行调研等长任务，覆盖等待中Stop、下一普通消息、重启后显式发送。凭据仅由环境注入，不写入文档/截图/日志。网站答案随时间变化，验收看执行与交付事实。
11. 用真实 PTY 按T44逐键验证选择/编辑/删除/保存/发送，按T41验证Steer提示；测试结束由**测试宿主**独立终止它自己创建的残留进程/进程组，并核对端口与临时凭据无残留。此测试回收能力不算产品已实现跨重启进程清理。

强杀/清理超时测试必须设置外部总超时，避免实现失效让测试永久等待。macOS Command+Q 仅补手工观察记录，不用它代替可重复 SIGTERM/SIGHUP/SIGKILL 测试，也不承诺所有终端实现一致。

## 4.4 测试入口与新增落点

以下文件在规划基线存在，可用作相关回归入口；新增场景放对应模块附近，必要时新增跨模块 integration 文件。未新增前不得宣称下列命令已覆盖全部 T 项：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts packages/ohbaby-agent/src/runtime/run-ledger/database.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts packages/ohbaby-agent/src/agents/subagents/database-store.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/runtime/prompt-scheduler/database-store.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/tools/shell-job-registry.unit.test.ts packages/ohbaby-agent/src/tools/shell-job-registry.integration.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/supervisor.unit.test.ts packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm run typecheck
pnpm run lint
pnpm run test:e2e:compiled-web
```

建议新增：runtime 下的 task-tree-stop/recovery integration、daemon shutdown-confirmation process integration、prompt retained-resubmit contract，以及 compiled Web/PTY 对应场景。命名按实施模块实际确定，文档不伪造它们已经存在。真实模型使用既有测试清单与 runner 实际参数，不能加 `passWithNoTests` 获得空通过。

回归包括前三轮审批快照/波次屏障/真实清理/子结果交付/Steer，provider 原生消息与 model-state，显式 foreground，旧会话读取，子视图只读和根权限，独立前置结果提取/read 接口。只在变化影响范围内重跑对应前置验收，不替前置另写实现。

## 4.5 发布门与实施验收记录

| 门槛 | 通过条件 |
|---|---|
| 依赖门 | improve-1、1.1、C、2/3实际验收可追溯；T01上游归属实测通过，不以parentSessionId降级；A/B实际依赖确认；本轮schema/API与真实代码校准 |
| 停止门 | T02～T13、T38～T40通过；B可开始但不能绕过旧保护；停止登记失败不能正常交接 |
| 退出门 | T14～T17、T42真实进程证据；取消请求、进程退出、清理完成三者不混淆 |
| 恢复门 | T18～T29、T40冷恢复部分、T43通过；无自动重跑、误改活owner、重复修复、retained误发 |
| 交互门 | T30～T33、T39～T41客户端部分、T44真实Web/PTY；已有输入框和图标行为准确、草稿不丢 |
| 组合门 | T34～T37及前轮关键回归；具备一次真实模型证据，不用scripted冒充实网 |

实施后在本轮唯一 `05-implementation-acceptance.md` 写明 revision、环境、实际命令、T项结果、证据位置及残余风险。真实模型/平台条件不可用标阻塞；不能以代码审查、截图或类型检查替代运行验证。任何剩余高风险项不得标整轮通过。

组合验收同时回归[第三轮 T46–T48](../improve-3/04-test-and-acceptance.md)：允许的父重试不中断子执行，确定终止才传播；历史实例/结果保留，迟到事件隔离。不得仅测用户 Stop 而遗漏失败和预算耗尽出口。

## 4.6 对抗性审查和残余边界

- 尝试在停止后从旧 approval、child completion、finally 或 pending 创建回调发起新工作；必须被同一根资格拒绝。
- 尝试让退出与B领取同时发生；shutdown优先关闭准入，已经领取的要明确纳入取消，不能漏成新孤儿。
- 尝试修复半途重新启动或双恢复者竞争；唯一键/版本检查和ready门槛必须防重复、串结果。
- 尝试把未知工具结果当失败后自动retry；副作用计数必须保持，不允许恢复器调用工具。
- 尝试用另一个同版本活TUI、伪造子scope、旧token或响应丢失绕过身份约束；不得操作无关任务。旧程序仅测试已知活写入者阻止升级，不承诺迁移后仍能混用。

明确残余：进程崩溃可能遗留外部程序；网络取消不证明远端撤销；不合作进程内操作可持续占用冲突资源；正常清理期新调用等待，清理异常后按普通资源错误返回而不提前放锁；阻塞事件循环会让本进程退出计时器失效；实际崩溃结束时间可能未知。本轮要如实表达这些事实，不承诺已经实现跨重启资源隔离或外部副作用恰好一次。
