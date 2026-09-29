# improve-2 实施验收

## 5.1 范围与结论

| 项目 | 记录 |
| --- | --- |
| 日期 / 环境 | 2026-09-27；macOS arm64，Node 26.3.1，pnpm 9.15.0 |
| 开发分支 | `codex/improve-2-execution-progress` |
| 实施基线 | `553fc65e67be2d32ece5c775b975677af95a090b`，含前置 A/B/C、improve-1、improve-1.1 |
| 依据 | 本轮 [02](02-optimization-plan-and-change-scope.md)、[04](04-test-and-acceptance.md)，不回写规划为进度记录 |
| 检查对象 | 基线到当前工作树，包含新增文件；用户要求先测试、独立审查及 Pi 复核，再分批提交 |
| 当前结论 | **通过（本次约定的 macOS 范围）**。完整测试、编译客户端、真实模型、子代理及 Pi 复核完成；下述基线限制与延后事项保留，不包含 New session 的关闭结论 |

New session 的重复创建及 Web/TUI 文件组织由用户明确要求在本轮验收后处理，不属于本表的通过结论。保留用户同期修改。早先局部 New session 回归通过不足以证明用户完整流程已修复。

S0 已核对前置 C 和第一轮实际代码、验收资料。历史报告中的串行补跑/去重汇总不冒充一次完整绿灯；本轮另跑当前完整测试集。Windows/Linux 实机终止验证按此前约定留待后续，本次不宣称跨平台实测通过。

## 5.2 实施与规划对照

| 范围 | 实际结果 | 关键接点 |
| --- | --- | --- |
| S1 单项可靠交付 | 每个工具独立准备、开始、结束、保存和发布；B 不等待无冲突 A 的审批；模型仍等待整批逻辑结果且按原调用顺序接收 | scheduler、CallDelivery、Lifecycle、ToolBatchEventQueue |
| S2 持久事实与计时 | 工具阶段及模型 attempt 事实进入既有 JSON、源投影和 SDK；事实时间来自实际操作边界 | execution、modelRequests、RequestAttemptObserver、source-session-projection |
| SQLite 取消响应 | 同连接 FIFO、事务前异步有限重试、单次 BEGIN 忙等待 25ms；事务体与 COMMIT 不重放 | runWriteTransaction 及全部运行期写入口 |
| S3 异常/清理组合 | 关键保存失败中断原 turn，不变成普通工具错误或模型重试；晚到清理只更新原 owner 的事实 | ToolDeliveryError、两残留 owner 集成测试、真实 Bash 进程 |
| S4 Web/TUI | 原卡片展示执行计时，执行名称动画；模型正文前等待；每轮一次总耗时；Stop 等可靠终态 | ToolCard、App、WorkingSpinner、transcript、useStopRequest |
| 最终组合 | 实际编译 Web、默认 in-process TUI PTY、故障注入 HTTP、真实 Sonnet 子代理、回滚 reader | 本文 5.4 |

## 5.3 实际调整与边界

| 维度 | 调整 / 保持 | 原因与影响 |
| --- | --- | --- |
| 数据结构 | 增加内部 `executionOutcome`，Bash 主动提供 timed-out/cancelled 等事实 | 工具函数正常返回不等于 shell 执行成功；修正计时观察，不改变既有结果正文/状态协议。后台派遣和 task_output 查询不套用被查询 job 的执行结果 |
| 数据流 | `MessageManager.getPart` 定点读取；串行投影队列在已完成操作之间按 8ms 预算让出事件循环 | 1026 工具实验发现长串同步克隆/序列化会挤占计时器。保留原提交与版本边界，失败仍立即传回；无事务中间让步 |
| 命令完成 | compact 等待源 `context.window.updated` 提交后返回，再发布一次兼容事件 | 完整测试发现原先 fire-and-forget 在队列让步后暴露 ready 事件未交付；已定向复现并修复 |
| 启动迁移 | 同步初始化保留 5000ms 忙等待，完成后恢复运行期 25ms；同路径初始化失败也通过 finally 恢复 | Pi 发现本轮缩短等待误伤未走 FIFO 的迁移。真实独立进程持锁先复现约 25ms 失败，再验证等待约 466–470ms 成功；未重试迁移主体或 COMMIT |
| 协议 / 存储 | 扩展可选字段，复用现有同源投影、续传、历史分页；不新增表或迁移 | 旧 reader 实际读取新 JSON 并普通编辑通过；不另建消息/快照协议 |
| 文件结构 | 生命周期批次队列保持在 lifecycle，交付状态在 scheduler，时间格式在 SDK | 各自拥有业务顺序和错误语义，不抽成泛用异步队列。Web/TUI 辅助文件归属另按用户意见讨论 |
| 依赖 | 未引入运行时第三方依赖 | 测试使用现有 Vitest、真实 HTTP/SQLite、编译产物与 PTY |

资源保护仍由前置 C 持有。单次保存成功不代表物理操作已退出；逻辑结果结束不自动释放未知残留的文件保护。SQLite 的 5 秒入队预算并非任意排队位置的硬响应期限；队列头之前的工作仍须完成。

## 5.4 测试和实际验收

### 命令与结果

| 检查 | 结果 |
| --- | --- |
| `pnpm exec vitest run` | 最终 **425 文件、4646 测试通过，17 跳过**；431 个文件共 4663 项，187.27s。首次 4639 通过/2 失败均为 compact 完成顺序，修复后 4641 通过；加入 P3 和启动回归用例后再次完整重跑绿灯 |
| P3 旧记录缺阶段说明 | 在原展开区补说明，不伪造时间；tool-card **20/20**，独立 Spec 复核关闭 |
| Pi 启动回归修复 | 新增 startup-contention **4/4**；数据库目录 **60/60**；真实服务锁竞争 **4/4**，Stop 发出到取消约 2–3ms，运行期短等待没有退回 5 秒 |
| `pnpm run lint` / `pnpm run typecheck` / `pnpm build` | 均退出 0；包含最新 P3 修复的构建通过 |
| 改动文件 Prettier / `git diff --check` | 初查发现 5 个格式项，纯格式整理后全部改动文件复查通过；不批量格式化无关文件 |
| `pnpm exec vitest run --config tests/integration/core/projection-fairness.vitest.config.ts --reporter=dot` | **4/4**，真实 memory/SQLite 投影与每次 JSON 序列化 |
| `pnpm exec vitest run --config tests/integration/core/rollback-reader.vitest.config.ts --reporter=dot` | **1/1**，基线 17 个实际模块读取新 JSON，并保留普通更新语义 |
| `CI=1 OHBABY_EXECUTION_UI_HARNESS=1 OHBABY_EXECUTION_UI_AUTORUN=1 pnpm exec vitest run --config tests/smoke/execution-progress-harness.vitest.config.ts` | **3/3**，独立控制结果落库、RPC 和物理执行三个闸门；修正测试服务 workspace bootstrap 后再跑 |
| 真实模型 | `OHBABY_RUN_REAL_EXECUTION_PROGRESS=1 OHBABY_EXECUTION_REAL_PROFILE=zenmux-claude-sonnet5-anthropic pnpm exec vitest run --config tests/smoke/execution-progress-real.vitest.config.ts`；**1/1**，见下方记录 |

真实模型共 5 次尝试：前 4 次 Luna 失败保留，依次包含错误的 session 身份断言、额外 skill 权限请求，以及缺失进程 end 的不合格并发场景；不把部分完成改记为通过。最终 `anthropic/claude-sonnet-5` / `anthropic` 完整通过，29.32 秒、8 次实际请求（含独立后台标题请求）、2 次精确命令审批。两个父 subagent_run 在同一消息发出，子 scope 不同且与数据库父关系匹配；真实 Bash 区间分别为 `[1790471508503,1790471511806]` 与 `[1790471511778,1790471511800]`，重叠 **22ms**。真实读文件、两个实际输出及最终回复均校验。只证明这次真实接线，不保证任意模型总会遵循并发指令；未放宽命令白名单或结果断言。

### T01–T28 对账

| ID | 结果与证据范围 |
| --- | --- |
| T01 | 通过：原权限核心测试及真实 SQLite A 审批/B 先保存；编译 Web 和 PTY 实际单次批准 |
| T02 | 通过：同资源 read→write→read 顺序，批准后末次读取 CHANGED；拒绝、准备和资源规则集成测试 |
| T03 | 通过：容量/前台子代理调度合同、独立子批次真实 Bash 重叠及 Sonnet 接线 |
| T04 | 通过：B 的持久结果、源事件、刷新恢复先于 A；模型收到原序且只在整批逻辑结果后继续 |
| T05 | 通过：scheduler 实际开始/唯一终态、各工具类别；Bash typed outcome 修复后的真实进程断言 |
| T06 | 通过：准备/开始/结束保存故障、原 turn fatal、无重试；编译 Web 故障场景 B 保留且出现一次 failed Total |
| T07 | 通过：批次队列按 call 合并、有界通知、逐项接收拒绝、无悬空关键 Promise |
| T08 | 通过：真实独立 SQLite 持锁与服务取消入口、有限重试耗尽、源投影失败恢复；断线行为另见 T28 的证据边界 |
| T09 | 通过：真实 adapter attempt 起止、首段非空正文、lazy iterator/abort 关闭；正文后不重现等待 |
| T10 | 通过：失败 attempt、重试/退避、强制 compact 的集成和投影测试；后台 purpose 排除。退避的全部组合未逐个在真实浏览器演示 |
| T11 | 通过：live/SQLite/source refresh 同源，版本与恢复合同；编译 Web 实际刷新 |
| T12 | 通过：root/child scope 投影及失败隔离，真实子代理数据库关系；不以共享 sessionId 当作唯一子身份 |
| T13 | 通过：prompt 可靠终态与结束时间，注入落库闸门，终态先到/后到都不取 RPC 时间作结论 |
| T14 | 通过：历史分页关联 prompt/run/message，Web/TUI 一次性总时长及旧 reader 兼容 |
| T15 | 通过：服务端时间样本加单调时间推进、格式边界/异常时钟合同；刷新从原事实继续 |
| T16 | 通过：实际执行才起超时，连续输出不重置；沿用 C 的工具自持 deadline |
| T17 | 通过：真实 Bash 300ms 超时、原结果、timed-out 事实及 confirmed cleanup。旧版弱判据的浏览器记录不计最终通过 |
| T18 | 通过：残留资源保护/阻塞解释及未执行事实，正常清理无新增通知 |
| T19 | 通过：两 SQLite owner 逆序晚到清理只更新各自原调用，不重放结果或模型 |
| T20 | 通过：真实后台进程在派遣结束后继续，查询成功不冒充被查询 job 的 outcome |
| T21 | 通过：普通容量归还与未知物理资源保留，独立文件仍可继续，阻塞调用不执行 |
| T22 | 通过：原卡片展开和键盘、仅 executing 名称动画、刷新计时、reduced-motion 的 computed animation 为 none |
| T23 | 通过：编译 Web reasoning→正文→结束及刷新，PTY 同样正文后隐藏；启动/工具/审批/压缩/子 scope 排除由合同测试覆盖 |
| T24 | 通过：编译 Web 成功/失败/取消只一次 Total，原 run 关联；TUI 两轮回复与 Total 按顺序稳定追加 |
| T25 | 通过：默认编译 serve 的审批、冲突、执行/计时刷新、Stop、真实超时；故障使用真实持久 backend + 编译 Web 的明确注入组合，非默认 CLI 故障来源 |
| T26 | 通过：真实默认 in-process CLI PTY，无 remote daemon。正常动画审批/慢 Bash；禁用动画下计时与双 Esc 取消。Ctrl+C 基线问题明确保留 |
| T27 | 通过：上述 Sonnet 真实 HTTP 接线；五次尝试如实记录，不以 scripted 代替 |
| T28 | 通过：原位禁用/10秒提示/可编辑草稿/reduced-motion、RPC-first 和 terminal-first 均实际浏览器+DB验证。错误、自然完成、旧 run 迟到/换会话由单元与接口合同覆盖，不宣称全部竞态都人工演示 |

浏览器 offline 仿真补充：阻断新网络请求期间没有假报停止或生成 Total，草稿保留；恢复并取得终态后显示一次取消总时长，服务端只收到一次 Stop。该工具的 offline 设置没有证明既有 SSE 连接被断开，故不拿它证明全部断线重连路径；该路径依据已有传输恢复集成测试和 Stop 断线合同测试。

实际 PTY 明确设置 60×120。正常动画的 Bash spinner 随真实 executing 转动、资源等待的 read 静止，结束时间固定。`OHBABY_TUI_NO_ANIM=1` 保留静态 spinner 与每秒计时；模型正文出现后等待消失。双 Esc 显示 Interrupted 和 cancelled Total。Ink 的全屏重绘会重发 Static 历史，原始 ANSI 输出重复不等于界面重复追加。

### 产物与复现

受控 CLI runner：`node scripts/run-execution-progress-e2e.mjs`，TUI 加 `--tui`，禁用动画再加 `--no-animation`；按 runner 输出的 attach 命令在 PTY 中启动编译 CLI。注入 Web 的交互模式省略 autorun，用 `scripts/control-execution-progress-harness.mjs` 分别释放三个闸门。所有启动实例使用隔离目录、fixture 凭据和自有进程；结束只清理本次实例。

本机未提交证据位于 `.ohbaby/test-evidence/improve-2/`：`real-model.json`、各 attempt 诊断、`compiled-web-final.json`、`tui-animation-final.json`、`tui-no-animation-final.json`、`task5-injected-*.log`、实际 Web 截图。最终完整测试日志为 `/tmp/ohbaby-improve2-release-suite.log`，构建为 `/tmp/ohbaby-improve2-release-build.log`，性能为 `/tmp/ohbaby-improve2-final-perf.log`；这些本机产物不含 API key，不应当作仓库中长期保证存在的文件。

## 5.5 SWE 审查与剩余限制

两路独立审查分别核对代码规范/正确性和 D1–D35、T01–T28。Standards 无确认的可操作发现；Spec 的一个 P3（旧记录缺历史说明）已修复并限定复核关闭。Pi 使用用户指定的 `opencode/claude-opus-5-5` 只读核对代码和实际日志，指出启动迁移不经运行期 FIFO，却继承 25ms busy_timeout，存在升级启动锁竞争回归。真实独立进程复现后修复，子代理及同一 Pi 会话限定复核均关闭该项；Pi 没有亲自跑测试，其两次完整原文已在会话提供。

本轮把执行、可靠交付、资源释放和界面等待拆成各自拥有的事实，保留必要耦合而没有增加第二套状态协议。幂等终态、原 owner 校验、保存失败 fatal、只在 BEGIN 前重试分别保护重复交付、跨请求污染和副作用重放。权限及工具副作用仍走现有准入；真实模型偏离指令时测试严格拒绝，未用更宽权限换绿灯。

剩余限制：

- **大消息开销**：最终 1026 工具 memory 最大计时器间隔 144.3ms/总 45.91s，SQLite 139.9ms/总 53.44s；各 6156 次发布、累计约 2.355GB 序列化。单次 clone/stringify 仍不可抢占，总工作仍为 O(N²)。这是本机样本，不能承诺任意 payload 的 Stop 延迟上限。
- **终端已有缺陷**：基线 Ink render 未禁用默认 Ctrl+C 退出，可能先于 App 的取消处理退出。本轮未更改该启动契约，不能报告 Ctrl+C 取消通过；双 Esc 路径已实测。
- **平台与后续轮次**：Windows/Linux 未实机；整树恢复、下一 queued 的故障接管、完整子代理树仍按第三/四轮范围处理。
- **初始化边界**：已有 WAL 库的迁移等待恢复原预算。SQLite 的 DELETE→WAL 切换仍可能立即因锁失败，这是基线已有行为；测试只证明失败时连接关闭且全局未污染，解锁后重新初始化成功。运行中人为要求同路径执行尚未应用的迁移时仍可能同步等待最多 5 秒，普通运行期写入不使用此路径。
- **用户反馈**：New session 未关闭，前端 helper 的归属未作最终决定。验收不能覆盖或冲销这些待办。
- **Pi 的非阻断观察**：排队计入写入预算可能在首次 BEGIN 前耗尽；跨进程 session CAS 冲突显式失败、不重放有副作用的事务；流耗尽但尚未完成消费/校验时的 Stop 仍可把 attempt 记为 aborted。前两项属于当前有界准入/防覆盖取舍，第三项保留取消竞态语义边界，不把结果解释为服务器仍在生成。真实模型闸门证明并发存在，不证明调度延迟小于 22ms 或 3.3s。

## 5.6 主要修改位置

| 文件 / 模块 | 作用 |
| --- | --- |
| [scheduler](../../../../packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts)、[delivery](../../../../packages/ohbaby-agent/src/core/tool-scheduler/delivery.ts) | 每调用交付、实际阶段、fatal 与清理 owner |
| [lifecycle](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts)、[tool-event-queue](../../../../packages/ohbaby-agent/src/core/lifecycle/tool-event-queue.ts) | 有界批次事实、可靠写入、整批模型屏障 |
| [request-observation](../../../../packages/ohbaby-agent/src/core/llm-client/request-observation.ts) | 实际 attempt 与迭代器边界 |
| [busy-retry](../../../../packages/ohbaby-agent/src/services/database/busy-retry.ts) 及各数据库 store | FIFO、短同步等待、有限异步 BEGIN 重试 |
| [session-view](../../../../packages/ohbaby-agent/src/adapters/ui-state/session-view.ts)、[ui-inprocess](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | 同源事实、历史恢复、队列公平性、compact 完成合同 |
| [SDK execution](../../../../packages/ohbaby-sdk/src/execution.ts)、[duration](../../../../packages/ohbaby-sdk/src/duration.ts) | 可选观测字段、统一时间与时钟样本 |
| [ToolCard](../../../../apps/ohbaby-web/src/ui/tool-card.tsx)、[useStopRequest](../../../../apps/ohbaby-web/src/ui/use-stop-request.ts) | 原界面执行展示及可靠 Stop 等待 |
| [TUI](../../../../packages/ohbaby-cli/src/tui/) | 默认 in-process 投影、执行动画、稳定 Total 位置 |
| [lifecycle 集成](../../../../tests/integration/core/lifecycle-tool-scheduler.integration.test.ts)、[真实模型](../../../../tests/smoke/execution-progress.real.e2e.test.ts)、[编译 runner](../../../../scripts/run-execution-progress-e2e.mjs) | 真实存储/进程/模型/编译客户端验收入口 |
