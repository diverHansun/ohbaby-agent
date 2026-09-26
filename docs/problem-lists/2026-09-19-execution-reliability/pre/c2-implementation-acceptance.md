# C2 访问与并发准入：实施与验收

## 范围与基线

2026-09-26 从 C1 分支 `codex/pre-c1-file-lock-lifetime` 的 `0bb2d5a9` 创建本地临时分支 `codex/pre-c2-resource-admission`。该历史包含开发基线 `68b11ba2`、前置 A/B、improve-1/1.1，以及 C1 的 `e20ca9e0`、`5d030c02`。已通过浏览器阅读并核对[约定方案](https://chatgpt.com/s/cx_6ab689e53a6c8191b8eb6a9917882585)。本次只实施 [C.4 的 C2](c-concurrency-and-resource-protection.md)，不使用 worktree，不合并、不推送；下一阶段 C3 从本分支继续，完整 C 组合门通过后再合回开发分支。

## 实现与接口

`core/tool-scheduler/resources.ts` 提供同进程共享的资源准入：规范化文件/目录树的读写范围、业务 scope 范围、多资源一次取得、冲突公平排队、等待取消、真实结束释放与未确认清理保护。`file-locks.ts` 使用同一层；直接调用和 scheduler 调用不会各自维护一套锁。scheduler 将内部真实 lease 传给工具，Write/Edit 复用 lease，完整读取、校验、写回仍在保护范围内。伪造、过期或范围不足的 lease 不能建立所有权。

`tool-admission.ts` 将能力绑定到受信工具对象，模型参数、工具名字或旧 category 不能自行取得豁免。文件工具先提供宽松的批次冲突计划，到其顺序位置再解析实际访问范围及必要权限；实际执行参数固定为获准的规范化目标。目录搜索使用完整目录树，Grep 在实际准入时区分单文件与目录。Write 输出保留用户传入的路径形式。

| 工具 | 资源/批次范围 | 容量 |
|---|---|---|
| Read | 单文件读 | 当前会话 ordinary |
| Write/Edit（含 dry_run） | 单文件写；校验和写回同区间 | 当前会话 ordinary |
| Glob/List | 指定目录树读 | 当前会话 ordinary |
| Grep | 文件读或指定目录树读；省略 path 为工作目录树 | 当前会话 ordinary |
| todo_read/todo_write | 实际 session/context/work scope；捕获 active goal 身份，等待中变化不会改写到另一列表 | 当前会话 ordinary |
| web、goal、select_tools | 已知不与文件范围冲突，可独立准备 | 当前会话 ordinary |
| subagent_run | 派遣入口可独立准备；子工具自行准入 | 直接派遣者会话 dispatch |
| task_output/task_kill、subagent_status/subagent_close | 受信控制入口；保留既有权限/归属检查 | control，不占 ordinary/dispatch |
| Bash、未知扩展/skill、无范围 MCP | 同批保守屏障，不建立全 backend 大锁 | 当前会话 ordinary |
| 可信且 readOnlyHint 为真的 MCP | 沿现有可信配置允许彼此并行；与已知文件写仍保守处理，不能假称无本地副作用 | 当前会话 ordinary |

`ConcurrencyController` 按 session 计数，普通默认 10、派遣默认 3，同会话跨 run/批次共享，父子会话独立。后台可通过 scheduler config 的 `concurrency.maxConcurrency`、`maxSubagentConcurrency` 调整；旧 `maxReadConcurrency` 作为兼容输入。没有新增 UI 或动态配额。只有资源可授予时同步预留容量，等待审批/前序/资源不占名额；普通结果逻辑结算归还名额，真实操作的资源与环境 lease 独立延续。后台派遣返回后也归还派遣调用名额，不承诺限制存活子代理/进程总数。

必要准备从注册调用和取消控制器开始。独立项不等待无关项的审批或异步 accessGuard；明确空访问范围也可越过尚未完成的兄弟 plan，scope 调用只需先等可能冲突的声明 plan 解析，再判断是否等其执行。权限快照在异步准备前捕获，目标改变时重新审批；等待期间发生撤销、deny、level/mode 变化则释放准入后重新校验。规则末尾仅追加 allow（包括本次“始终允许”）不会无故使既有批准失效。实际 invoke 前再次检查取消，紧邻调用记录 startedAt 并启动期限；开始事实保存不会先占用执行时间。

`ToolSchedulerOptions.resolveOwner` 由 composition 复用既有真实会话关系解析，提供 session/run/message/call/context、rootSessionId、workspaceKey、scopeKey 与 runtimeGeneration。Full Access、规则自动放行无需审批卡也能得到 owner；scheduler 不访问数据库、不从当前页面猜身份。sandbox retain 延续到原操作真正结束：逻辑 destroy 可以返回，但不能销毁仍被真实工具使用的环境；同时拒绝该 scope 新 acquire/retain。

`onExecutionFact` 提供按调用有序的 waiting/started/settled/cleanup 事实，包含原 owner、访问范围、逻辑结果和清理状态；`onExecutionFactError` 交给后续持久化接线处理失败。等待原因包括 capacity/predecessor/resource，并保留 C3 的 source-cleanup 语义。取消同步生效，不等待事实 hook。第二轮仍负责可靠保存、fatal、展示和 SQLite 争用验收。

进程内操作取消后默认观察 1000ms，可由 `cleanupObservationMs` 注入测试；原 Promise 未结束则标记 unconfirmed，已有和新冲突等待者收到英文普通资源错误，execute 次数为零、无 startedAt。原资源继续持有；真实迟到成功/失败只确认清理并释放一次，不更改原结果、不重放失败的新调用、不重复归还容量。无冲突资源继续可用。有限观察并不是解锁计时器。

## 验收覆盖

| 要求 | 本次证据 |
|---|---|
| C02/C03 | resources unit、resource-admission integration、files.scheduler integration：读读、读写、写写、不同文件、symlink、目录树、多资源原子取得、真实 Write/Edit 无二次取锁死锁。 |
| C04 | scheduler unit、admission/preparation integration：冲突顺序、公平性、无关文件越过等待、依赖前序创建文件、准备取消、目标变化重新审批。 |
| C05 | ui-runtime/admission integration 使用真实 composition/持久会话关系构造父/子及另一主会话；工具集成另覆盖同进程跨 scheduler/backend 与直接入口共享。 |
| C06 | concurrency unit、capacity integration：默认混合 10 槽、另一主/子会话、跨批计数、直接派遣者 3 槽、真实控制工厂入口在满额时可用、伪造角色无豁免、取消等待不误释放。 |
| C07 的 C2 部分 | 未知访问保守留在批次内；独立会话无 dangerous 全局大锁；受信能力按实现绑定。Bash 残留来源限制留给 C3。 |
| C10/C11/C14/C15 的进程内部分 | cleanup integration、真实 scheduler→Write/Edit 延迟 rename：超时还容量、同文件保护、独立文件前进、观察到期、等待者/新调用错误、迟到 resolve/reject、取消竞态、保存 hook 延迟、环境 retain 失败/延迟销毁。 |
| C13 | 可控 fixture 最后由测试释放，真实服务与临时目录由夹具清理；不把进程内锁描述为跨进程保护。 |

`todo-admission.integration.test.ts` 使用真实 todo registry/store，分别在执行开始和资源等待中切换 active goal，确认写入仍落在被保护的原 scope，另一 scope 的持有者没有被绕过。恢复集成中原本“provider 已输出就假设投影已持久化”的竞争夹具改成等待真实投影内容，未改变产品恢复行为。

## 验证记录

| 检查 | 结果 |
|---|---|
| 最终全量 `pnpm exec vitest run` | 406 文件通过、6 文件按既有条件跳过；4423 项通过、17 项跳过，退出码 0，约 224 秒。覆盖 unit/contract/integration、真实 CLI/daemon、打包后冷安装；跳过项不冒充通过。本次运行已包含 Pi 复审后的最后资源队列补丁。 |
| 资源队列补丁阶段的 scheduler＋文件/todo/真实 composition 定向回归 | 12 文件、143 项通过；另资源/C1锁最终19项通过。新增慢 canonicalization gate 先红后绿，空访问/独立scope可推进，文件与混合scope前序保守保留。 |
| `OHBABY_RUN_REAL_FILE_TOOLS=1 pnpm exec vitest run --config tests/smoke/file-tools-real.vitest.config.ts` | 最后补丁后 1/1 通过，2026-09-26 10:10 启动、约 53 秒；真实 HTTP listener＋persistent runtime＋Zenmux `openai/gpt-5.6-luna`，12 次真实请求，Read 续读、Grep、Edit、Write 及磁盘内容核验。密钥仅由既有夹具读取，未输出/提交。 |
| `pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts` | 最后补丁后 8/8 通过，真实父子 composition 完成链。 |
| 构建及静态检查 | `pnpm build`、`pnpm run typecheck` 通过；所有变更 TS 的 Prettier 与 `git diff --check` 通过。最终 lint 通过、零警告；三批源码/测试提交的 hooks 均执行全量 lint/typecheck 并通过。 |

开发中全量运行发现过旧类别调度断言、准备/开始时刻假设、路径显示与权限规则兼容、新测试类型、恢复夹具竞争等问题，均逐项修复并定向复验；不将失败运行描述为通过。并行跑工作区 typecheck 与会删除 dist 的 CLI 构建曾造成 TS6305，随后构建和 typecheck 串行通过，未据此修改产品类型。

原始本机日志位于 `/tmp/ohbaby-pre-c2-20260926/`，不作为长期测试依赖；可重复执行用例均提交仓库。

## 子代理审查

三个子代理分别负责共享资源、会话容量与契约/owner 审查，并对集成后的代码复验。审查发现并补了实际失败回归：

- 逻辑 scope dispose 的超时清理可能销毁仍被真实工具使用的 adapter：增加 retained operation 所有权，延迟物理销毁，立即关闭新准入。
- 准备阶段的取消和重复 callId、环境 retain 失败、读取正在被创建的文件：注册/释放/存在性检查分别回到其真实生命周期。
- Full Access 等待中切回 default、审批后异步目标检查期间切换权限、symlink 审批期间改向：在异步准备前捕获快照，变化后重新准备，不持容量/资源等审批。
- todo 的 active goal 在准入后改变可能写入未锁范围：解析时捕获 scope，包装器与实际 execute 复用。
- 慢兄弟 plan 的 Promise.all 阻塞明确独立的控制调用：各项独立推进，未知范围仍保守，已知/异步 scope 前序保持顺序。
- 共享资源队列中慢路径规范化也会形成全局队头阻塞：同步捕获声明 scope，保留未知文件别名的文件顺序，让空访问及独立 scope 继续。
- 同步执行取消的事实顺序、实际开始时间与环境 release 异常：补足事件时序与错误观察回归。

最终局部复审未留有已确认的 C2 阻塞问题。完整 C3 能力不纳入本次通过结论。

## Pi 独立审查及取舍

按用户指定渠道使用 `opencode/claude-opus-5-5`、medium，独立会话 `codex-pre-c2-review-20260926-0bb2d5a9`，启动目录为仓库根目录。Pi 阅读完整未提交 diff 和新增文件，独立运行 14 文件/181 项定向测试；资源队列补丁后又复验 3 文件/26 项，并用 `/tmp/pi-probe` 的一次性脚本检查队列阻塞。没有读 `.env`，没有代替主任务跑全量、构建、真实模型或 E2E。原始最终回复已完整呈现在实施会话，不将探针或整段回复复制进仓库。

结论为可以分批本地 commit，无阻断缺陷。采纳 read/read 补强后同会话再次复审，Pi 独立探针确认只读可推进、写仍保守等待，3 文件/27 项通过；最终结论为补丁足够、无新阻断或确认缺陷，并接受以下取舍。处理建议：

- 采纳已复现的低级问题：前后文件访问均只读时，未完成的路径规范化也不应阻挡后者；任何一方写入仍保守等待，scope 单独按真实 key/mode 比较。
- Pi 推断锁内再次解析遇到目标变化可能返回 lease 范围错误。实际参数已固定为批准的规范化路径，原始别名改变不会改写目标；若规范化目标本身在取得保护后仍被外界改变，拒绝执行是安全边界。本次“重新审批”覆盖 invoke 前可确认的变化，不承诺在已进入工具后自动重跑。外部进程重定向竞争不在合作锁保证内。
- 不采纳删除进程内工具的有限观察窗口：这会违背已确认 C.5/C.6、D30/D31。观察到期只让尚未执行的冲突新调用返回普通错误，绝不释放旧操作资源；未知期限的永久等待不是本次约定的交付。
- 权限使用当前策略快照，不记录每次变化的 epoch。若等待中 A→B→A 且最终规则完整恢复，不因历史变化单独重审批；实际准入仍执行当前明确 deny 和目标检查。
- C3 需要由真实执行源上报清理事实、按进程终止时刻计算观察预算、给后台 job 接延续 owner/retain，并为来源限制提供真实等待原因；不能直接把 `canAcquire=false` 的容量原因冒充 source-cleanup。Bash 仍按未知访问范围，不因 Pi 的一般性建议额外增加命令访问推断。

## 保留限制与 C3 交接

- C2 不是完整 C 的验收。C08/C09/C12、C10/C11/C14/C15 的 Bash/后台 job/source-cleanup 部分尚未实施；不据此打开合并门或 improve-2 S0。
- C3 须实现 TERM→KILL、进程组/平台真实停止确认、输出收尾、同来源主会话限制、job 超时/取消与 cleanup owner 延续、热替换及历史淘汰保护。来源身份可复用 workspaceKey＋rootSessionId；scopeKey 是实际环境范围，不能拿父子不同 scopeKey 当成来源树分隔。
- 未知工具目前只有批次顺序约束，不承诺与另一批/另一主会话的未知副作用互斥。可信 MCP readonly 不是完整文件访问描述。
- 仅保护同一进程中合作工具的规范化目标。没有跨进程/跨重启锁，不承诺解决硬链接、外部进程或任意文件系统重定向竞争；不合作操作可长期保有真实资源。
- 本次平台为 macOS arm64；没有 Linux/Windows 原生运行证据。C3 的 Windows 进程终止验收仍需补齐，不能用 mock 代替。
- 第二轮仍需接事实持久化和 UI；此次后台 hook 测试不替代真实 SQLite 争用下取消响应与保存失败 fatal 组合测试。

## 本地提交与结论

| 提交 | 批次 |
|---|---|
| `7e733ada` | 共享资源、每会话准入、工具接线、准备/清理事实与单元/集成回归。 |
| `2ea87a03` | 真实 owner 解析、sandbox retain/延迟物理销毁、worker 接线及真实 composition 回归。 |
| `04455413` | 恢复测试先等待真实持久投影，消除 provider 输出与投影之间的夹具竞争。 |
| 本记录所在文档提交 | C2 验收、Pi 取舍、C3 交接和前置索引。 |

**结论：C2 已完成本地实施、macOS 验收、子代理审查及指定 Opus 5.5 两轮审查；完整 C 仍待 C3 组合验收。** 保留 `codex/pre-c2-resource-admission` 供 C3 继承。开发分支仍为 `68b11ba2`，C1 分支仍为 `0bb2d5a9`；本次没有 merge、push 或创建 worktree。
