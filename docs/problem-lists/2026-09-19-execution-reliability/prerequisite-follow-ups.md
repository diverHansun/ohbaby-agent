# 独立前置修复待办

> 记录日期：2026-09-20。来源：本议题讨论。用户已要求记录，具体方案、参数和实施时间后续再定。A/B 保留为待办；C 已补齐独立前置的职责、规则和验收要求。全部仍是规划，不表示已经修复。

A、B 两项独立于 improve-1～4，原计划在整项可靠性改造实施前处理；2026-09-21 新增 C，后续讨论确认扩为“并发与资源保护”完整前置任务，先于 improve-2 实施。各项不得因为登记了待办就被视为已验收；第三轮实施前也应核实它所依赖的实际完成情况。

2026-09-21 补充：页面快照与事件续传一致性另登记为 [improve-1.1](improve-1.1/README.md)，安排在 improve-1 验收后、improve-2 实施前，具体方案后续讨论。它不是本文 A、B 的整项前置工作，不阻塞 improve-1 的审批独立恢复。

## A. 最终结果提取

### 已核实的现状

- 普通主会话在 `packages/ohbaby-agent/src/agents/service.ts` 使用 `waitMode: stream`；对用户保持流式输出。
- `core/lifecycle/lifecycle.ts` 分别处理正文和 `reasoningTextDelta`；普通流式正文没有在这里拼接 reasoning。
- `core/agents/output.ts::extractFinalOutput` 会拼接 assistant 消息中的 text/reasoning。`core/agents/runner.ts` 的 waitForCompletion 路径读取会话或 context scope 历史后调用它，没有在提取处限定本次 run。是否触发拼接，取决于消息中是否存在 reasoning part，不能写成每次普通对话都受影响。
- Web `apps/ohbaby-web/src/ui/App.tsx` 有 Thought 区域和 reasoning part 渲染分支；个别文本辅助函数也合并两种类型。用户观察到页面未显示 reasoning，尚不能据此断言前端不支持它，或认定其具体原因。

### 后续方案应解决

1. 最终交付只取本次执行、正确 session/context scope 的正式正文；没有正文时明确无结果，不取上次答复。
2. 成功正文、失败原因、取消事实与不完整输出区分；不把失败前片段包装为成功报告。
3. 分别验证普通主会话 stream、内部 waitForCompletion、子代理前台/后台结果及旧消息兼容。
4. reasoning 与正文保持类型边界。是否展示、保存或回放 reasoning 不在这条待办中擅自改变，尤其不能破坏 provider 的原生 model-state 回放。

不将该缺陷直接归因为先前主代理卡住的根因；目前证据支持的是结果正确性风险。

## B. 独立文件工具增强

### 已核实的现状

`tools/utils/text-files.ts` 的 `MAX_TEXT_FILE_BYTES = 1_000_000` 限制**整文件**，不是单页或内部读取块。先 stat 检查，再整文件 readFile，然后 read 工具才按行切片。输出另经截断，分页元数据可能与实际可见内容不一致。

| 工具 | 现状 | 待讨论目标 |
|---|---|---|
| read | 原文件超限拒绝；行切片后可能再截断 | 大文件按需读取；超长单行可续读；分页不漏内容 |
| grep | 跳过超限文件，元数据记录 skippedLargeFiles | 大文本可搜索；扫描、输出预算分开；区分无匹配/部分结果/失败 |
| edit | 全文读入、匹配、生成 diff、写回 | 独立资源预算；完整内容校验；保留可靠写回和并发保护 |
| write | 覆盖旧文件先全文读取，创建新文件没有同样大小门槛 | 区分写入和差异预览预算；新建/覆盖行为一致且可解释 |

建议按 Read/Grep → Edit/Write 分批讨论和验收。范围可以覆盖四个工具，但不等于统一取消一个大小常量。具体容量、分页协议、搜索实现、编码策略、并发与写入失败处理均**待定**。

### 参考调查记录

所有结论为本地源码观察，未运行参考项目的大文件测试；路径相对于 `/Users/hansun025/Projects/code-cli/`。

| 项目 | 可借鉴事实 | 不能直接照搬 |
|---|---|---|
| OpenCode | `packages/opencode/src/tool/read.ts`：流式路径、默认 2000 行/50 KiB 输出；grep 使用 rg | 单行截尾不能通过下一行 offset 恢复；edit/write 仍可能全文读取 |
| Claude Code 本地重建版 | `packages/builtin-tools/src/tools/FileReadTool/FileReadTool.ts`：显式 limit 时不应用默认 256 KiB 整文件门槛；仍有输出 token 校验 | 不是官方实现保证；范围读取也可能为总行数扫描全文；原子写存在降级路径 |
| Kimi | `packages/agent-core/src/tools/builtin/file/read.ts`：最多 1000 行/100 KiB 输出；本地分块扫描；grep 使用 rg | 超长行截断并非完整续读；每次范围请求可能仍扫描全文 |
| Pi | `packages/coding-agent/src/core/tools/read.ts`：2000 行/50 KiB 返回预算、明确续读提示；edit/write 共用修改队列 | Read 先整文件读入；超长首行会建议 shell 替代，没有工具内完整续读 |
| Codex | `codex-rs/core/src/tools/handlers/shell_spec.rs`：命令输出预算；`codex-rs/apply-patch/src/lib.rs`：修改块验证 | shell/rg＋apply_patch 不是与四工具一一对应的接口；apply_patch 仍读取完整文本 |
| DeepSeek Harness | `packages/fs/tool-fs/src/read.ts`：大文件切流式；`read-render.ts`：输出/单行预算；`fs-local/src/fsio.ts`：写入 diff 单独限额 | 单行截尾仍不能完整续读；编辑依然涉及完整内容 |

后续验收至少涵盖：大文件小范围读取、超长单行、中文 UTF-8 边界、CRLF/BOM、末尾无换行、文件变化、取消、搜索部分结果、写入失败及新建后可读。具体命令随独立方案确定。

## 与 improve-3 的边界

- improve-3 使用可靠的正文提取和范围读取，实施前检查接口及验收证据；若前置未完成，结果交付阶段不得假装可读任意长报告。
- `.output` 生成、归属登记、内部只读授权、通知和随会话清理，全部在 improve-3。
- 系统用内部存储 API 导出报告，不要求子代理调用 write；Edit/Write 全面增强不是导出报告的技术前提。
- 不在本记录中创建新 improve 编号，也不据此立即修改产品代码。

返回：[总体路线](README.md) · [第三轮](improve-3/README.md)。

## C. 并发与资源保护（improve-2 前置）

> 2026-09-21 已确认职责、顺序和残留 Bash 策略。以下为前置 C 的规划要求和验收入口，未实施；A/B 仍是各自待细化的工作。C 不另立 improve 编号，C1–C3 是同一前置任务的实施阶段。字段/内部接口名称可按仓库惯例调整，行为边界不能削弱。

### C.1 目标、共享范围和非职责

让没有资源冲突的文件操作并行，同时保证真实操作未结束时不提前放行冲突操作。批次顺序、执行容量、文件资源保护分别负责自己的约束。

现有 `ui-inprocess/runtime-controller.ts:106–109,158` 的一个 runtimePromise 服务多个 session；`ui-runtime/composition.ts:266,552` 建立并共享 scheduler。serve 的 `runtime/daemon/main.ts:486–504`、`server.ts:166–179` 按 workspace 创建或复用 backend。因此同 backend 中两个主会话及各自子代理都可能被旧全局互斥拖住，不能只测试父子代理。以上 agent 路径相对 `packages/ohbaby-agent/src/`，server 路径相对 `packages/ohbaby-server/src/`。

不同 workspace backend 通常各有 scheduler；现有文件锁却是同进程模块级 Map。同一真实目标的合作文件工具应共享保护，不能按 sessionId 或 backend 身份绕过。独立 TUI/serve 进程不共享内存锁，共享 SQLite 不构成跨进程文件保护。

C 不负责审批入口、结果存储、Web/TUI 组件、模型请求计时、完整子代理面板、全树 Stop 或冷恢复。也不新增通用 Shell 文件访问追踪、OS 沙箱、跨进程锁或工作区冻结平台。

### C.2 三阶段实施及最小交付

| Stage | 负责的工作 | 交付给 improve-2 的能力 |
|---|---|---|
| C1 文件锁正确性 | 修复 timeout 包装结束就提前 release；真实写入结束才解除保护 | 可信的资源释放语义及独立回归测试 |
| C2 访问与并发准入 | 受信工具声明资源范围；批次内保留冲突顺序；同进程共享文件读写保护；容量与资源等待分开 | 准入、等待原因、实际开始、归属、取消等待者和资源释放的内部接口 |
| C3 Bash 与清理 | Bash 批次内保守调度；TERM→KILL、停止确认、输出收尾；来源主会话限制；清理 owner 延续 | 逻辑结果与清理事实分离、限制建立/解除及可观察的真实清理状态 |

顺序：C1 独立验收 → C2/C3 组合实施验收 → improve-2。进入 improve-2 还需 improve-1 和 improve-1.1 实际通过；不强行规定 C 与第一轮完全串行，接线依赖第一轮身份的部分必须等实际接口核对。A/B 原安排不变。

主要改动面：agent `core/tool-scheduler/{types,concurrency,scheduler}.ts`、`tools/utils/file-locks.ts`、文件工具访问描述/准入接线、`tools/{bash,shell-job-registry}.ts`、`shell/process.ts`；composition/scope lease 仅补真实 owner 与清理交接。不由 scheduler 直接访问会话数据库或前端。

### C.3 C1：超时结果不等于写入结束

现状：`tools/utils/file-locks.ts:24–44,63–67` 使用 Promise.race；包装超时后 finally 立即 release，operationPromise 可能仍在运行。`file-locks.unit.test.ts:12` 把提前释放写成了预期，必须同步修正。write/edit 已使用该锁，问题不以放开外层并发为前提。

借鉴 Pi `packages/coding-agent/src/core/tools/file-mutation-queue.ts:52–59`、`tools/write.ts:203` 和 `test/file-mutation-queue.test.ts:176,221`：真实操作成功或失败结束后才释放；取消/超时可先通知调用方，但持有者继续观察底层 Promise，接收迟到异常。取消一个等待者不能释放别人的锁。保护释放一次；不合作操作仍可能继续阻塞同文件，不自动跳过或强杀 serve。

Pi 的普通 read 和 Bash 不参与这把写队列；ohbaby 的完整读写保护由 C2 补齐，不把 Pi 的写写保护说成读写锁。

### C.4 C2：按资源保护，按批次保留必要顺序

- 文件访问描述由受信工具实现产生，不接受模型自报“无副作用”。至少表达读、写、文件/目录范围及未知范围；范围无法证明独立时不得当作独立路径放行。首版 Bash 统一按未知范围在当前批次内保守处理，不新增命令只读分类器。
- 已知文件 read/read 可并行，read/write 和 write/write 互斥。write/edit 的读取、校验和写回属于同一个保护区。不同资源可并行，但不跨越已经明确的前序依赖。
- 同批冲突调用按原调用顺序等待；无冲突调用不因为前面有另一个文件的待批/写操作就全停。保持冲突资源上的公平性，不能用新读取持续插队饿死已有写等待者；公平性不应挡住其他文件。
- 路径标识使用可信规范化结果，覆盖相对路径和已有符号链接；缺失目标依赖规范化父路径。目录搜索、移动或多文件工具必须声明完整范围或保守归入未知；不只提取一个参数中的文件名。多资源取得应避免持有一部分再无限等待另一部分。不能声称仅 realpath 就解决所有硬链接或外部进程竞争。
- 前置计划不提前执行依赖前序文件状态的检查；到达相应顺序位置后再做路径/权限预检查。获批后若实际目标或访问范围发生变化，重新校验必要权限，不持有文件保护等待用户批准。
- 审批、资源等待、残留 Bash 限制等待均不占实际执行名额，不消耗执行期限。取得所需准入后、真正调用 execute 前才记录执行开始；文件锁等待不能继续藏在 execute 的计时内部。
- 同一次执行只有一个资源持有者。调度器取得保护后，write/edit 内部复用这次受信 lease，不再次获取非重入锁而自己等自己；绕过 scheduler 的直接工具入口仍取得同一保护。lease 只由内部接线传递，不能由模型或外部工具参数伪造；不保留互不知情的两套锁。
- 容量限制独立存在，保留既有合理上限，不把“没有全局写锁”实现成无限 spawn。资源释放不能用逻辑结果替代；具体容量归还按实际占用定义，不把整个 backend 的容量槽冒充文件锁。
- memory/subagent 派遣保留不被兄弟 Bash 审批整体挡住的能力；子代理实际工具仍受它自己的批次顺序、共享文件保护和来源限制。控制入口不能跟普通文件工具一起被封住。

现有 `splitIntoWaves` 按类别将写操作全串行，需要随访问准入调整；仅移除 ConcurrencyController 的全局标记不足以实现不同文件并行。不要另造通用工作流依赖图。

### C.5 C3：Bash 超时后的确定规则

**已确认：已知文件按资源保护；未知残留 Bash 限制来源主会话及其子代理，其他独立主会话继续。** 来源限制不是工作区隔离，不保证其他会话与未知 Shell 副作用绝无冲突。

| 情况 | 约束 |
|---|---|
| 普通 Bash 正常运行 | 当前模型批次内保守调度；不持有覆盖整个 backend 的 dangerous 大锁 |
| 明确资源的操作超时、真实操作未结束 | 所有参与同进程保护的调用继续遵守该资源锁；不同文件可工作 |
| 未知 Bash 超时/取消、仍在正常终止 | 后端登记来源主会话限制，暂缓该主会话及其子代理新的文件访问和 Shell 执行；包括后续批次和后续 run，正常清理静默 |
| 清理失败或有限观察后仍无法确认，实际阻塞新调用 | 保留原保护；被挡住且尚未执行的调用返回普通工具错误“未执行，资源暂不可用”，不无限等待、不新增专门清理提示 |
| 独立主会话 | 不受这条来源限制自动冻结或取消；若碰到已知资源锁，正常占用时等待，持有者清理异常时该新调用同样返回普通资源错误，不能绕过保护 |
| 观察/取消/清理、模型输出 | 不因来源限制而禁用；来源限制不是整轮 Stop，也不重放工具 |
| 确认受管理进程范围已停止、只剩输出管道收尾 | 解除该进程对应限制，输出有界收尾；不把管道拖延继续当作文件风险 |

具体约束：

1. 来源从后端真实关系解析为 `scopeKey + rootSessionId`，派遣时绑定，记录原 session/run/call/job 身份及 runtime generation 供精确关联；不能从当前页面或模型参数猜 root。限制按根会话保留，不仅绑定 rootRunId。子代理被其他任务重新使用时，按该次执行的真实归属判定，不永久给实例贴封禁标记。
2. 进入终止时登记该 owner 的清理及临时来源限制；确认停止即可解除。任何超时/未确认结果对外交付之前，必须已有相应保护。已排队、已批准但未 execute 的调用也必须在启动边界复查；已经执行的独立工具不自动回滚或全部取消。
3. 来源限制至少覆盖文件读取/搜索/写改、Bash，以及可能访问本地文件而未证明独立的扩展/MCP 工具。只有受信能力明确为不触及受限资源的操作才可继续；不能仅看 category=network 就放行。task_output、task_kill、状态查询和取消等明确控制能力保留可用。
4. 每个残留独立持有 owner/记录；两个残留必须分别确认，清掉一个不能解除另一个。批次、run 或逻辑会话结束不能抹掉仍存活记录；同一进程中的 runtime 热替换需保留或转交这些责任，不允许重建 scheduler 绕过限制。跨重启恢复仍归第四轮。
5. 正常后台 Bash 返回 jobId 仍只是派遣完成，不占整段任务的派遣槽，也不触发来源限制。它到期或被取消后若出现相同停止未确认，沿同一规则限制来源，task_output/task_kill 仍可用。成功派遣不冒充 job 成功完成；job 后续超时/取消更新自身 outcome/cleanup，不改写已返回的派遣调用结果。
6. 不添加“过一段时间自动当作旧操作未执行/自动解除保护”的机制。2026-09-22 用户确认修订异常等待：正常清理静默；清理失败或有限观察后仍无法确认，且实际挡住新调用时，将该尚未执行的调用结算为普通工具错误，而不是继续无限等待。它只证明新调用没有进入 execute，不能推断旧操作未执行或已经停止。批次仍按每项真实结果收齐后交给模型；已启动的其他调用不因此自动取消。
7. 同一准入边界处理保护解除、清理异常、新调用启动和取消的竞争；已经排队但尚未执行的受影响调用也要收到异常结果，不能只拒绝后来到达的调用。原保护和 cleanup owner 继续保留；确认释放后只恢复后续调用的准入，不自动重放已返回错误的调用，不重复发送结果。已有用户取消优先，不把取消伪装成资源错误。后台不增加自动工具重试；独立资源、独立主会话及控制/清理入口沿原范围工作。
8. 异常判断由清理负责人提供真实失败、探测失败或有限观察到期未确认的事实，不由前端“多久没输出”推断。正常锁竞争不套用此错误，`in-progress` 也不能在本轮停止观察已结束后永久冒充正常清理。各工具的有限观察预算、何时转 `unconfirmed` 和后续确认方式在 C3 实施前定稿并可注入测试；不是 B 统一先等 N 秒，也不是到期放锁。无法强停的进程内操作仍可继续占资源，但进入异常清理状态后不要求新调用无限挂起。

### C.6 固定期限、真实清理与所有权

普通工具默认 120000ms 并保留 byTool，Bash 默认 120000ms、最大 600000ms，子代理默认 7200000ms 及已有覆盖规则。只从实际执行计时，固定期限，持续输出不续期，无 idle timeout；父级已有期限仍可能取消子级等待。

| 工具 | 取消/超时能力 |
|---|---|
| 我们启动的本地进程 | TERM→有限宽限→KILL 所属进程组；沿既有200ms升级间隔及registry有限观察窗口起步，参数变化需说明并测试 |
| 网络/MCP | 贯通信号，支持时协议取消；不保证远端副作用撤销，不杀共享server取消单请求 |
| 进程内读写/扩展工具 | 合作式取消，真实操作未结束继续持有冲突保护；不能为停止它杀整个serve |
| 子代理 | 取消该次执行并沿既有信号传播；整树Stop完整覆盖归第四轮 |

registry 保持清理 owner，区分 in-progress/confirmed/unconfirmed。发出信号、kill helper 返回、直接子进程 exit、管道 close 都不能单独证明整个受管理进程范围已停止。POSIX 检查所属组，Windows 结合终止命令结果和可确认的所属进程退出证据；探测失败记 unconfirmed。不承诺主动脱组后代的追踪，不按名称扫描杀其他进程。

调用结果可以先结束，清理继续进行。保留已有 deferred release/registry 能力，必要时用最小内部清理登记接口串接；不预先强制特定 hook 名。清理失败/Promise拒绝只表示未确认，不允许复用“无论resolve/reject都release”的逻辑。注册清理和限制须先于返回结果；scope lease 延续到真实使用者结束。未知 Bash 的保留是来源限制和清理责任，不重新保留整个 backend 的危险工具大锁。

未确认清理的 job 不被普通历史上限淘汰；scope/session dispose 仍需接管已逻辑终态的未清理 job。清理启动和确认幂等，停止观察后不再对可能复用的 PID/进程组重发信号。迟到 close 只能更新原调用清理事实，不把超时改成功，不产生第二个工具结果。

### C.7 与第二轮的接口交接

C 输出后端事实：真实 owner、访问范围、准入原因、实际执行起止、逻辑 outcome、清理状态和对应限制，以及 C.5 的“新调用未执行、资源暂不可用”准入错误。内部枚举名称可以调整，语义至少区分容量不足、前序冲突、文件资源冲突、来源任务残留清理。阶段通知支持第二轮的可靠保存接线；取消先同步阻止新执行和发signal，不依赖数据库写入成功。普通准入错误不能与第二轮持久化失败的 fatal 错误混为一类。

第二轮负责将这些事实逐项保存/展示，并在持久化失败时通过 C 的取消入口停止新启动、取消在途；不实现第二套锁、不在前端猜资源冲突。已知阻塞来源允许内部精确关联，展示必须经过会话授权过滤；不可读的其他会话只显示通用原因，不泄露标题、命令或路径。

### C.8 前置独立验收

| ID | 必须验证的行为 | Stage |
|---|---|---|
| C01 | 文件操作超时/取消但真实Promise未结束，同文件下一调用不启动；不同文件可用；迟到成功/失败后释放一次 | C1 |
| C02 | read/read并行、read/write与write/write互斥；两不同文件写入可重叠；write/edit的校验到写入不交错；真实scheduler→write/edit接线无重复取锁自阻塞 | C2 |
| C03 | 相对路径、符号链接指向同目标时不能绕锁；目录/多文件未知范围不得误判独立；多资源无相互持有死锁 | C2 |
| C04 | 同批冲突顺序及公平性保留；另一个独立文件可以越过资源等待；类别write不再自动把全批串行 | C2 |
| C05 | 主子代理及同backend两个主会话同时调用：不同文件并行，同文件仍互斥；不同backend同进程碰同目标也不绕锁；直接工具入口与调度入口共享保护 | C2 |
| C06 | 审批/资源/来源限制等待不占实际执行槽或期限；取消等待者不解别人的锁、不留下监听 | C2 |
| C07 | 同批Bash保守；独立主会话不因category=dangerous整体停住；未声明副作用工具不能冒充控制能力 | C2/C3 |
| C08 | 真实进程TERM可退出、忽略TERM升级KILL；leader先退同组child仍活；输出已关进程仍活、进程组已停管道未关分别判定 | C3 |
| C09 | kill/存活探测失败、缺PID无法确认时保留限制；cleanup拒绝不当作确认；不对其他owner发终止 | C3 |
| C10 | 超时结果发布前保护已建；已获批/排队未execute调用被拦；旧run结束后同root新run及已有/新子执行仍受限，独立root继续 | C3 |
| C11 | 两个残留乱序确认只解除各自记录；重复close/cancel幂等；历史超过保留上限、逻辑dispose、runtime热替换不丢owner | C3 |
| C12 | 正常后台job不触发限制，后台超时/取消未确认触发同来源限制；task_output/task_kill可用；确认后恢复准入，不重放已返回错误的调用 | C3 |
| C13 | fixture最终由测试主动释放；无进程/端口残留；不同进程不共享内存锁的能力边界明确，不伪造跨进程保证 | C1–C3 |
| C14 | 正常清理时新冲突调用等待；注入终止失败/探测失败/有限观察到期后，已有等待者和新调用均得到一次普通资源错误，execute计数为0且无执行开始时间；旧操作真实未停，保护仍在；不影响无冲突工作 | C2/C3 |
| C15 | 异常结算与资源确认/启动/取消竞争只有一个结果；已报错调用不因迟到确认自动重跑，新调用可在确认释放后执行；进程内不合作操作用受控Promise验证相同边界，普通锁竞争不误报清理异常 | C1–C3 |

扩展现有 `tools/utils/file-locks.unit.test.ts`、`tools/files.scheduler.integration.test.ts`、scheduler unit/integration、shell-job-registry unit/integration 和 shell tests；补真实 composition 多会话接线用例，不能只mock两个锁对象。使用可控Promise/fake clock控制竞态，真实子进程检验终止。Unix/Windows分别验证，缺少Windows运行证据就标该平台阻塞，不以mock代替。只终止测试自己创建的进程。

基础定向命令（新增用例必须被实际收集，不允许passWithNoTests）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/tools/utils/file-locks.unit.test.ts packages/ohbaby-agent/src/tools/files.scheduler.integration.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/tools/shell-job-registry.unit.test.ts packages/ohbaby-agent/src/tools/shell-job-registry.integration.test.ts packages/ohbaby-agent/src/shell/shell.unit.test.ts
pnpm run typecheck
pnpm run lint
```

实施验收记录具体revision、场景、命令和平台局限后，improve-2 S0才可认定C通过。纯文档自检不运行以上产品验收，也不生成实施通过报告。

### C.9 参考与保留限制

[六项目比较 §3.9–3.10](improve-2/03-reference-projects.md)区分批次调度、文件保护与后台清理。Pi用于真实settle后放锁，OpenCode用于共享目标写保护，Kimi用于访问范围及批次内冲突，DeepSeek用于后台持续拥有清理。Codex与本地CCB提供并发/终止的对照，不照搬其发kill即足够结算的边界。

来源主会话限制是ohbaby自己的已确认取舍；六项目已查路径没有提供该完整策略。它不保证独立主会话与未知Bash副作用互斥，不因不同cwd就宣称文件隔离。无法停止的操作仍可能长期占资源；新调用按 C.5 区分正常等待与异常准入错误。2026-09-22 的[六项目补查](improve-4/03-reference-projects.md#310-2026-09-22正常静默与异常阻塞的取舍)说明快速交接、真实结束后放锁和后台清理的采用边界，不将新错误策略归为竞品已有共识。跨进程协调、跨重启接管、完整视觉设计不在C中附带增加。

## 向第四轮交付的边界

C交付精确资源/工具/job归属、执行准入、清理状态、释放条件和可注入的观察预算；第二轮保存/展示这些事实，第四轮按本次任务树触发取消并验证跨Run保护。C14/C15与第二轮错误交付、第四轮T10/T36组合，不能在第四轮另造清理状态机。A/B按既定独立前置顺序推进；读取/正文提取未验收时，第三轮及第四轮不能声称长结果恢复已可靠。具体交付矩阵见[总路线](README.md#顺序实施与跨轮交付检查)。
