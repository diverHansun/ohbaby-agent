# improve-4 实施与验收

> 2026-09-28。实施与验收完成。最终整仓、类型检查、lint、子代理及两轮 Pi 审查通过；真实模型、编译版 Web/PTY、响应丢失与最终远程页脚复验通过。本地保留，未 merge、未 push。

## 版本、范围与依赖

基于 `603b1f57db6c256f022746257148d4b59cbd720d`（开发分支 `codex/improve-3.1`）在原 checkout 建立 `codex/improve-4`。未合并、未推送。环境为 macOS、Node 26.3.1、pnpm workspace，同批 SDK/agent/server/Web/CLI。

实现与测试提交：`b436843315accee92e943462d9b8f95944dae2ae`（`feat(runtime): implement durable stop and retained prompt recovery`）。本文件及脱敏证据随后独立提交，不改变已验收源码。

依赖验收见 [A/B/C 前置](../pre/05-implementation-acceptance.md)、[C3](../pre/c3-implementation-acceptance.md)、[improve-1](../improve-1/05-implementation-acceptance.md)、[1.1](../improve-1.1/05-implementation-acceptance.md)、[2](../improve-2/05-implementation-acceptance.md)、[2.1](../improve-2.1/05-implementation-acceptance.md)、[3](../improve-3/05-implementation-acceptance.md)、[3.1](../improve-3.1/implementation-notes.md)。这些是依赖背景，本轮仍重新执行受影响测试。

用户追加约束已落实：生产 system-prompt 拼接、context/prompt cache 构造规则没有改动。retained 位于调度、存储、协议和展示；已有 cache accounting 测试仅把用户停止期望由 cancelled 调整为 interrupted。

## 实现边界

- 本次 rootRunId/executionId 贯穿子委托、工具和后台 job。Stop 先同步封口并发取消，再保存输入、子资格、工具历史、Run 和 prompt 终态；B 等这些关键登记成功，不等物理清理。
- 保存失败保留原结果、原结束时刻，阻塞该会话。显式进入、重连、下次执行及关闭收口合并恢复，不重跑模型/工具。普通查询只读。一次关键保存共用默认五秒数据库活跃等待额度（FIFO、锁退避、事务与提交）；无数据库写入的主逻辑等待不扣额度，子写入不能延长，并发写入按共享活跃时间计一次。关闭另外受同一个绝对十秒宿主截止期约束。
- shell/sandbox 未确认清理继续持有原资源保护。serve stop 在十二秒外部预算内核对原 PID/token、实际退出和独立清理报告；发出信号不是退出成功。
- queued 从接受时就有 owner；只由同 owner 领取。冷恢复将死 owner 旧队列转 retained。原 owner 保存恢复成功则继续普通队列；新环境不会自动执行 retained。
- 单条 retained 发送保留 promptId/userMessageId，通过 operation receipt 幂等、租约和容量事务更新 acceptedAt/admissionOrder。同毫秒依持久准入序号排序；普通编辑不重排。
- Web/TUI 复用输入框和队列图标，正文可选择；queued 保存、retained 发送；Esc 恢复草稿。TUI Alt+↑进入选择，↑/↓选择、Enter编辑、队列Ctrl+D删除。Stop 确切未发送 Steer 的英文提示只属于最新用户 Stop。

## 升级与回退

022 在已停止旧写入者的离线前提下先 `VACUUM main INTO` 创建 `*.before-retained-<uuid>.backup`，包含 WAL 已提交内容。随后同一事务重建 CHECK/字段/索引、初始化 acceptedAt/admissionOrder、旧 queued→retained、旧活动 Run/prompt 补中断、旧 child current/pending 退队保留 execution 审计。已完成结果原样保留。已知活 writer 拒绝升级；SQL失败全部回滚，修复原因后重新启动重试。

新程序必须先停下才能回退：保留升级后的数据库，再把升级前备份恢复到原路径；备份之后新增历史不会自动回流。已实测关闭新连接、覆盖原路径、独立 SQLite 打开并核对旧 schema/原 queued/原 child JSON、integrity 与外键。未测试旧二进制混用新库，也不支持这种用法。

可解析但缺 owner 的旧记录由离线步骤处理。缺少 execution/root/currentRun 关联身份或损坏 JSON 不能猜测；原记录与备份保留，按可证明影响范围阻断。在线遇到新格式活动 prompt 缺 owner，同样显示局部恢复错误；retained 缺历史 owner 本身不阻断新会话。

## 已执行的专项证据

- 根保存故障：A 的 Run 终态写失败时 B 不执行，显式进入或关闭可补保存，A 不重跑；重试和关闭共用 singleflight。
- 真实双进程 SQLite：A 持有 active/queued，B 接受并只列出自己队列；B 不能 claim A，live恢复不改A；SIGKILL A 后只有A变 interrupted/retained，B原记录不变。
- 崩溃证据：独立进程在实际调用前、已产生副作用但开始事实未保存、开始已保存、完整结果已保存、明确执行前拒绝处到闸门后 SIGKILL；前两者相同持久证据均恢复 unknown，不伪造开始时间，不增加副作用 marker。另在真实恢复完成 Run/首个工具保存后再次 SIGKILL，重开补完第二工具，原终态与原修复时刻不变。
- 历史 CAS：另一 SQLite 连接在读取后先提交真实结果，恢复条件写入不覆盖成功结果/native metadata。恢复 model request 也保留原身份与已完成记录。
- 预算：独立 writer 依次持锁，多个关键写入共享总预算；FIFO过期不越过前驱，显式新尝试可恢复。真实HTTP Stop 在SQLite锁竞争下先取消，RPC完成可以等待关键登记。
- 交接采样（同一后端 fixture，不设额外毫秒门槛）：正常 12.76ms、慢清理 Stop 10.96ms、200条历史 14.39ms。慢清理闸门到 B 完成后才释放（11.65ms），硬断言 B 首请求时旧清理未结束。数字用于本机诊断，不是生产性能承诺或跨版本 benchmark。
- 真实模型 `zenmux / openai/gpt-5.6-luna / openai-responses`：root Bash Stop→B→C 首次5请求；两个后台子代理各启动独立长Bash→根Stop→B→C 首次8请求。均验证真实PID/执行marker、唯一B、新Run身份、旧child/迟到输出不串、C完整tool配对HTTP200；权限和清理错误为空。预算分别18/24，没有靠无限重跑获得通过。

已入库脱敏证据：[root Stop](evidence/2026-09-28/real-root-stop.json)、[双 child Stop](evidence/2026-09-28/real-child-stop.json)、[崩溃闸门](evidence/2026-09-28/crash-barriers.txt)、[真实双 owner](evidence/2026-09-28/dual-owner-process.txt)、[交接采样](evidence/2026-09-28/handoff-samples.txt)。Pi 修复后最终版分别 14.899 秒 / 31.985 秒，仍是 5/8 次真实请求，无权限与清理错误；证据文件已替换为最终版复验。双 child 场景被 Stop 的 A 请求有一条响应捕获记录为 response_stream（HTTP headers 为 200，但观察器未获得完整响应体），原样保留，没有通过重跑消除它；B/C 协议与执行身份断言均通过。实时模型入口：

```sh
OHBABY_RUN_REAL_EXECUTION_RELIABILITY_STOP=1 pnpm exec vitest run --config tests/smoke/execution-reliability-stop-real.vitest.config.ts
OHBABY_RUN_REAL_EXECUTION_RELIABILITY_CHILD_STOP=1 pnpm exec vitest run --config tests/smoke/execution-reliability-stop-real.vitest.config.ts
```

## 审查与修正

分阶段子代理审查及独立复审已经修正：恢复分页漏旧child、microtask空转、补保存覆盖原结束时刻、旧实例覆盖新owner、历史非原子修复覆盖真实结果、关闭期间获取新runtime、关闭重复恢复/诊断丢失、每次SQLite写重新获得完整预算，以及普通成功误终止后台Bash。

真实UI联测抓到 retained 获取编辑租约后从增量投影消失、TUI租约更新导致列表移位、回复终态重绘清空已恢复草稿；分别补 retained 可见规则、两端统一准入排序，并将历史重置限制在 transcript 子树。独立最终复审抓到用户Stop误显示error、活动prompt缺owner却显示ready、retained重发与A保存失败竞争仍返回成功，均有针对性回归。补查非法 PID 后统一在 owner 探测前按 unknown 处理；终态 Run 与延迟清理的索引竞争改由当前 Run 事实决定 control，避免已完成还显示 Stop。

Pi `opencode/claude-opus-5-5` 完成两轮只读审查，同一会话 `89106387-518f-41e3-93e6-50b65f83c9d0` 的两次原始正文均已完整呈现给用户。第一轮六项意见逐项核实、修正后，第二轮认为六项均已解决或属于可接受的保守边界，没有发现新的可操作阻塞缺陷。Pi 没有执行测试；动态验收由下列独立运行证明。

| Pi 项 | 核实与处理 |
|---|---|
| 1 历史重复恢复 | 真实 SQLite 6000 条历史复现旧预算超时。最终 cold 250.93ms / warm 47.09ms；cold 核对 6000 个 Run，warm 不重复 history 核对，两次写事务均为零。仅有候选才写恢复事务，已闭 inputs/terminal execution 不重复写；逐 Run history 核对成功后缓存其终态快照，失败重试可以继续前进。每次仍检查当前 owner/child/instance。旧 closed 字段不证明完整，所以冷启动保留一次只读核对及未完成事实修复，未新增 schema。 |
| 2 预算起点过早 | 真实 5.1 秒主逻辑等待复现无锁保存错误。Stop 仍立即持久化输入封口；改为累计数据库事务活跃等待额度，主逻辑空档暂停，嵌套和并发共享额度。关闭绝对截止不暂停。 |
| 3 goal 保存失败漏门控 | 实际 goal Run 保存失败却 ready 的回归先红后绿；goal 也登记同一会话 pending finalization，显式进入/关闭补原 Run。另保护已 claim、尚等 goal 的 B：保留 queued，不继承 A 的结果、不反复轮询。 |
| 4 PID 锁释放顺序 | 将释放延至诊断关闭之后，缩短换代窗口。最终报告仍放在释放之后以包含释放失败；没有采纳提前写 confirmed 报告。最后报告 I/O 期间若 token 换代且原 PID 仍活，按既有身份契约保守返回 unconfirmed/1，不能去操作新进程。 |
| 5 CLI 诊断过早关闭 | host 先完成或用完预算，再以相同剩余绝对截止尝试关闭 diagnostics，合并两者错误。 |
| 6 retained 成功但响应丢失 | Web/TUI 与真实 prompt store 联合回归：先 queued/terminal 再丢响应。首尝试固定 operationId/正文，只有已尝试项能在状态/lease 改变后显式重放；真实回执才确认成功。保留草稿，Web 刷新可恢复尝试，不根据他人状态变更冒成功，不自动循环重试。 |

第二轮另提出超时后尝试 diagnostics flush 的低优先级建议。核对实际 logger 后保留现状：每次 emit 已启动后台 drain，关闭仍遵守共享绝对十秒预算，不另加等待额度，也不启动不受关闭预算观察的异步 dispose。预算耗尽时，最后一部分缓冲日志可能没有落盘，结果报告 unconfirmed；不承诺超时后日志完整。逐 Run 的 history 核对缓存随当前进程增长，6000 条实测通过；没有为这一规模引入新缓存框架。

最终全量暴露的两处测试/生命周期问题也有先红后绿回归：SSE 断流测试改为按事件内容和 EOF 观察，不假设网络 chunk 边界；persistent backend 的派生 startup promise 立即注册被动拒绝处理器，晚到的 API/dispose 仍报告原错误，测试夹具同时补齐 initialize/dispose，避免关闭 SQLite 后后台启动继续运行。

远程响应丢失验收另发现 TUI `installSessionView` 跳过最新 idle Run、重新选中旧恢复 error。修正后按实际开始时间选择 Run，活跃/审批优先，再采用最新终态；CLI 内部记录错误的 Run 来源，只有明确来自 Run 的旧错误才允许被新成功替换。来源未知或独立 runtime/snapshot 错误保守保留，即使文案与旧 Run 相同也不冒认。两轮增量子代理审查和先红后绿回归覆盖这些区别，最终 store/App 206 项通过；没有改变 SDK 或隐藏恢复/审批错误。

## T01–T44 对账

下表按风险组合分层证明，不声称每个故障都重复穿过所有 UI/平台。测试文件均指本仓库同名文件；最终运行统计在下一节。真实 Web/remote PTY 使用同一编译 daemon、HTTP/event transport 与 SQLite，provider 为 scripted；真实 LLM 单列，不混为同一场景。

| 项 | 实施证据与实际范围 |
|---|---|
| T01 | execution-store、subagent-host、composition、current-run-inputs：未生成 childRunId 也具备 execution/root；新普通输入换 Run，Steer 留在原 Run。 |
| T02 | scheduler FIFO、ui-inprocess durable Stop；真实 root Bash→B→C 验证 B 唯一。Stop 前已有 B/C 的顺序由确定性调度测试证明。 |
| T03 | host 构造 foreground/background/排队及历史多层记录，整树取消；真实两个 background child 的各自长 Bash 同时停止。未开放模型嵌套。 |
| T04 | host accept/bind/start 与 shell registry spawn 各闸门竞争，已经接受的保留审计、未获得资格的不得开始。 |
| T05 | host current/pending 退队与新 execution；SQLite/memory instance CAS 保留后来 owner 的 current/pending。 |
| T06 | 旧 root/job/finally 索引隔离；真实模型 A 停止后 B/C 成功，旧 child 请求、marker 不增长。 |
| T07 | permission-run-lifecycle：根 Stop 撤销 child 审批，迟到 always 不写规则；Web 审批与刷新另由既有集成测试回归。 |
| T08 | execution terminal 不可逆、lateResult 审计；history 的真实第二 SQLite 连接提交结果不被修复覆盖。 |
| T09 | RunManager 各 finalization 阶段失败/重试、scheduler prompt 保存失败、backend Stop 保存失败阻断 B；恢复只补登记，原结束时刻不变。 |
| T10 | cleanup 闸门硬断言 B 请求已开始而旧清理未结束；tool scheduler 正常等待、unconfirmed 单次资源错误和迟到确认。 |
| T11 | Bash/MCP/sandbox/source-cleanup 和 delivery：保护、lease、名额归还只作用原 owner；不合作操作不提前释放冲突保护。 |
| T12 | 两个真实 background Bash 返回 jobId、独立 PID/root/scope；只取消 A，B 继续并一次完成。 |
| T13 | RunManager hasActiveWork/waitForCleanup 追踪脱离主流程的 release；配置重建与 runtime-controller 回归，普通换 Run 不重建。 |
| T14 | admission/InstanceStore/lazy runtime 的关闭竞争；真实 Supervisor SIGINT/SIGTERM/SIGHUP 与重复关闭。真实默认 PTY 显式 /exit、idle Ctrl+C 均退出 0。 |
| T15 | 独立宿主与 stop 观察进程：端口/信号回执不当退出，等真实 PID 结束或有界失败。 |
| T16 | stop unit 注入 token 换代、PID 复用、EPERM、身份损坏；不接触用户无关进程。 |
| T17 | 独立 SQLite writer 锁覆盖/预算内释放、多个 cleanup 混合结果、CLI 外部退出观察；共同截止时间不能逐项重置。 |
| T18 | global-single-serve 正常关闭/SIGKILL 后同库重开，A interrupted、B/C retained，零自动请求；compiled Web/PTY 另核对重启 UI。 |
| T19 | dual-writer-process 真实双 PID 同库 active/queued 隔离，活 A 不动、强杀后只修 A；审批/requeue/同 PID dispose 用独立针对性测试。 |
| T20 | root/prompt/child PID 缺失或非法、探测权限错误、scope-only 保守处理；新增 50 个回归，未知不送入自定义探测器。 |
| T21 | 真实 SIGKILL 闸门 before/after invoke、start、complete、pre-invoke reject；相同持久事实均 unknown，不重跑或伪造开始。这里用受控操作与生产存储，不是真实模型全循环强杀。 |
| T22 | Run 终态与首个 tool 修复提交后再次强杀，重开补第二个并保持首项；delivery/retained/ready 由分层幂等和门控测试共同证明。 |
| T23 | session 格式/关联身份错误按树阻断；父终态子 active、分页 206 项和另一健康根回归。未通过猜测修复损坏数据。 |
| T24 | 持续 SQLite 写锁、migration SQL 回滚和 backend recovery 错误；UI 显示 blocked 并保留输入。未把全局 DB 错误降为正常 ready。 |
| T25 | persistent backend 重开无模型/新输入；SQLite artifacts 重开核对 preparing/删除意图/完整结果/待交付，重复幂等并拒绝越权。两个集成 fixture 组合证明。 |
| T26 | store 同毫秒 admissionOrder、owner/createdAt/acceptedAt、容量；daemon 与 compiled Web 新 D 不带动 retained F，手动 B 保留身份。 |
| T27 | receipt 跨重试/response 丢失/最后容量/lease/claim 冲突；HTTP 同 operation 并发与第三进程重试；A 保存失败期间 resubmit 再检查 gate。 |
| T28 | fresh/022 约束、索引/外键/未知状态 contract；一致备份实际复制回原路径、独立 SQLite 核对旧 schema/记录。没有旧二进制兼容承诺。 |
| T29 | clock/store/projection：createdAt 不变、acceptedAt 新值、真实 endedAt 不覆盖、recovery 来源不冒充实际耗时；UI 重开显示中断历史。 |
| T30 | compiled Chrome：正文不进入编辑、铅笔 Save/Send、垃圾箱删除独立条目，无继续队列按钮。 |
| T31 | Web 组件/后端租约和乱序测试；真实 Web/PTY 草稿恢复、两端删除所选项后不误删邻项；终态历史重绘不清空草稿。 |
| T32 | compiled Chrome cold restart/刷新保留 retained 与草稿，provider 数不增；活 serve 重连与审批由 daemon/API/UI 回归覆盖。 |
| T33 | 真实 compiled 默认 inprocess PTY：owner_pid 就是 TUI PID、无新子进程/监听端口，已有 daemon 的 state 不变；Ctrl+C Stop 后普通 B 自动推进；/exit 后重开 R retained 不自动发。 |
| T34 | 真实 root/双 child LLM Stop→B→C；真实 daemon 重启不自动执行旧队列；compiled Web/PTY 共用 SQLite 端到端。 |
| T35 | normal/slow cleanup/200-message 三类交接采样及闸门断言，旧清理独立计时。没有旧 revision 相同 fixture 的性能基线，不报告改善比例。 |
| T36 | C14/C15 scheduler、Bash、run adapter 与 Web Stop 回归；真实结果/旧 owner 隔离。新修用户 Stop 映射 idle、终态 control 不再滞留活动 Run。 |
| T37 | SDK duration、真实计时/Thinking 分离、projection/PTY display 回归；cold compiled UI 保留 recovery 来源，不因刷新重置为新活动计时。 |
| T38 | 真实 HTTP+SQLite 锁竞争的取消受理小于 1 秒；完整 RPC 可等待保存；共用预算、纯查询、不自旋由数据库和 scheduler 回归。 |
| T39 | 原 owner 显式进入/重连/提交恢复 singleflight；GET 纯读；旧错误不会清掉独立审批/恢复错误；恢复后唯一 B。 |
| T40 | scheduler 编辑/删除/accept/recover/shutdown 闸门；真实双客户端删当前 TUI 选择后 Ctrl+D 不误删邻项，关闭不重新开放。 |
| T41 | memory/SQLite current inputs 的 accepted/assembly/attempt/Stop；latest user-stop 提示 helper/Web/TUI contract，backend snapshot/source 与下一 B Stop 不串提示。普通 Steer accepted 提示不是“已被模型处理”的证明。 |
| T42 | 真宿主+独立 CLI clean/incomplete/unknown/alive/absent 退出码矩阵，身份冲突单项反例。 |
| T43 | 离线 022 WAL 备份、活 writer 拒绝、SQL 回滚、无 owner child 退队、schema commit 后重开与 first enter 零请求；未知关联保留阻断。 |
| T44 | 真 remote PTY 三条 queued/retained，Alt+↑/上下/Enter/Ctrl+D/Esc，实际 Chrome 删除所选条目后不误操作邻项；SQLite 身份和 provider 数对账。 |

Compiled UI 可追溯证据：[后端/DB/provider 对账](evidence/2026-09-28/compiled-web-remote-pty.json)、[实际 PTY 输入及 ANSI 输出](evidence/2026-09-28/remote-pty-actions.json)、[queued](evidence/2026-09-28/web-queued.png)、[retained/草稿](evidence/2026-09-28/web-retained.png)、[TUI 同库记录](evidence/2026-09-28/web-tui-shared-db.png)。最终 scripted provider 六次请求：两次 HOLD、Web B/D、TUI C/E；F retained 未自动执行。交互中 Web C 曾被 Steer，不计作 retained 对照；通过正常输入新增 F 完成独立对照。

Pi 修复后的独立响应丢失验收使用 `node scripts/run-improve4-ui-e2e.mjs --response-loss`。真实 daemon 已将选中 prompt 保存为 succeeded 后，代理截断成功 HTTP body；Web 刷新后 Retry、TUI Enter 重试均深比较原 operation 请求和原 receipt，正文保持冻结，随后恢复原草稿。SQLite 只有两个 receipt，每个选中项只产生一个消息/Run，provider 恰好四次请求（两次种子 HOLD、两次手动发送），其余 retained 不执行。controller 与 TUI 退出 0，failures 为空，测试进程均清理。见 [报告](evidence/2026-09-28/response-loss-report.md)、[运行对账](evidence/2026-09-28/response-loss-compiled.json)、[持久回执](evidence/2026-09-28/response-loss-durable-receipts.json)、[实际 PTY 操作](evidence/2026-09-28/response-loss-pty-actions.json)。该次另发现远程旧错误页脚，已单独修复并用最终编译版本重开同一 SQLite 复验，原缺陷现场证据仍保留。

## 最终运行

- 所有审查修复后的最终 `pnpm test`：退出 0；472 文件通过、6 文件跳过；5208 测试通过、17 跳过（总 5225），267.76 秒。包含实际 CLI 构建、真实命令/serve 输出与 shutdown、npm packed CLI 安装 smoke；没有未处理拒绝。真实 LLM 使用独立配置，未混入全量数字。
- `pnpm run typecheck`：在全量构建结束后顺序执行，退出 0。先前与全量的 dist 重建并行发生 TS6305 输出缺失，该次作废；没有用源码改动掩盖构建竞争。
- `pnpm run lint`：退出 0，0 errors、93 warnings；未把 warning 称为已清零。
- 最终 control/backend/Web 反馈回归：4 文件 197 通过。非法 owner 回归及相关 SQLite/child/persistent：13 文件 281 通过。真实信号和 stop 矩阵：9 通过，包含本机 SIGHUP。
- `pnpm exec prettier --check <本轮修改的 ts/tsx/mjs/css>` 与 `git diff --check`：通过，本轮 168 个代码/样式/helper 文件格式符合。
- compiled Web/remote PTY：`node scripts/run-improve4-ui-e2e.mjs`，最终 runner 退出 0，六次 provider 请求、SQLite 唯一 Run/消息关系与 UI 逐键动作对账，独立清理成功。
- 默认 compiled inprocess PTY：controller 退出 0、failures 空；Steer 接受期间原模型连接和 Run 保持，没有增加模型请求，该次随后主动 Stop，因此不把它作为 Steer 已被模型消费的证明；下一模型请求的输入消费另由 current-run-inputs 测试覆盖。Ctrl+C 后 B 唯一执行；/exit 退出 0，重开 retained 不自动发，单条 Send 后身份/草稿保留、旧 error footer 消失，idle Ctrl+C 正常退出 0。测试 PID 均已退出；现场既有 serve 未受影响。
- Pi 修复后 compiled 响应丢失复验：Web 刷新后 Retry、TUI Enter 均取回相同操作回执，单条仅执行一次，草稿恢复。共四次 scripted 请求，controller/PTY 退出 0，独立清理成功。
- 最终 compiled 远程页脚复验：重开响应丢失场景的原数据库，最新成功历史正常、旧错误页脚消失、C/E 仍 retained、零模型请求，DB 仍为两个 receipt/四个 Run。idle Ctrl+C 与 helper 均退出 0，daemon/provider/临时凭据清理确认。见 [最终画面](evidence/2026-09-28/remote-footer-final-frame.txt)、[实际 PTY](evidence/2026-09-28/remote-footer-final-pty.json)、[清理核对](evidence/2026-09-28/remote-footer-final-check.json)。

可重复的全量命令应顺序执行，避免测试中的 CLI build 清理 dist 时与 TypeScript 输出读取竞争：

```sh
pnpm test
pnpm run typecheck
pnpm run lint
node scripts/run-improve4-ui-e2e.mjs
node scripts/run-improve4-inprocess-pty-e2e.mjs
```

两个 UI helper 提供隔离服务/DB、可控 provider 与断言入口，实际 UI/PTY 动作由调用者驱动；单独启动 helper 不等于已经完成交互验收。

最终默认入口另见 [inprocess PTY 报告](evidence/2026-09-28/default-inprocess-pty-report.md)、[DB/进程/provider 对账](evidence/2026-09-28/default-inprocess-pty.json)、[键盘与输出](evidence/2026-09-28/default-inprocess-pty-actions.json)。全量摘要：[verification-summary.txt](evidence/2026-09-28/verification-summary.txt)。

## SWE 收口

保留既有 scheduler、ledger、execution store、projection 和 runtime owner 边界。新增两个有实际复用点的小模块：owner PID 校验、数据库单次写入预算；没有为了统一界面另建任务平台或通用恢复框架。一次 Run 结束的事实保存与仍在清理的资源各归原 owner 管理。测试以可控闸门、实际不同进程和幂等身份为主，不用模型文字或时间等待替代执行事实。

已知维护成本在 `ui-inprocess.ts`、composition 和 scheduler 的生命周期协调，后续变更仍需同步核对三者的准入/终态/关闭顺序；本轮不顺带重写整个大模块。Pi 意见经事实核实后再决定是否修正，不以架构整齐作为扩大范围的理由。

## 残余边界

不承诺崩溃后接管/杀死遗留外部进程、撤销文件修改或网络远端副作用。未合作的操作仍可能占用冲突资源；未知结束时间以 recovery 来源表示，不当作实际运行时长。迁移依赖操作者停止旧程序，不扫描证明全机无writer。测试宿主独立回收自己的残留进程不算产品跨重启清理能力。macOS Command+Q 没有替代真实信号测试，亦不承诺所有终端一致。关闭预算耗尽可能留下未落盘的最后一部分诊断日志，此时按 unconfirmed 报告，不为了 flush 重新获得关闭额度。
