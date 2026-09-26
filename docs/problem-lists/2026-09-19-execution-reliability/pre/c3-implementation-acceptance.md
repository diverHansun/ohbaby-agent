# C3 Bash 与清理：实施与验证记录

## 范围与基线

2026-09-26 从 `codex/pre-c2-resource-admission` 的 `ad92e49e` 建立本地临时分支 `codex/pre-c3-bash-cleanup`，沿 C1 → C2 → C3 继承，未使用 worktree。该历史包含 A/B、improve-1/1.1、C1 与 C2。已通过浏览器阅读用户给出的[约定方案](https://chatgpt.com/s/cx_6ab75648f3608191a655ae3e03ca94e7)，最后一段明确允许分别保留三条线性继承分支。此次不 merge、不 push；用户后续共同验收完整 C 后再决定合回。

本轮按 [C.5–C.8](c-concurrency-and-resource-protection.md) 实施，沿用 C2 的文件保护、会话容量、真实 owner 和事实接口。基线定向 6 文件、116 项测试通过。重点是将逻辑调用结果、真实进程停止与输出管道收尾分开，避免另建调度器、数据库状态机或前端清理提示。

## 实现

- `shell/process.ts` 返回 `confirmed/unconfirmed` 及失败原因。POSIX 通过所属进程组探测，TERM 后最多 200ms，仍存活才发 KILL，随后最多观察 1000ms；探测错误、终止错误、缺 PID 都不冒充停止。没有按进程名扫描或向正 PID 降级。按 ChildProcess 对象保存唯一终止尝试，重复调用不延长观察、不重新发信号。
- Windows 的终止确认要求 taskkill 成功及所属进程退出证据。已知 leader 已退出且没有先前的终止成功证据时，直接返回未确认，不向可能复用的 PID 发 taskkill。真实 Windows 能力限制见下文。
- `ShellJobRegistry` 保存原 owner、每个 job 的清理状态、终止任务和环境引用。清理登记及来源保护先于逻辑超时/取消结果，调用名额可以立即归还。正常后台派遣返回 jobId 不建立来源限制，也不占整个 job 的派遣槽。
- `source-cleanup.ts` 按 `workspaceKey + rootSessionId` 保存进程生命周期的独立记录；仅在没有 workspaceKey 时使用 scopeKey，root 缺失时使用 sessionId。真实 composition 复用已有会话父子关系，不从页面、模型参数或权限弹卡推断。子 scope、后续 run 和 scheduler 重建不能绕过限制；两个残留独立确认。
- 来源敏感调用包括受信文件范围以及未知 Bash/扩展/MCP。受信的空访问范围、独立业务 scope、控制与派遣入口可继续；派遣后的子工具自行准入。正常清理等待不占容量，明确失败或观察到期让已有及新等待者收到普通英文资源错误，execute 次数为零、无开始事实，不自动重放。独立 root 不被来源等待者占住文件队列。
- 在状态事件订阅者、环境 retain 回调之后、实际时间戳与 invoke 之前再次复查来源保护和取消。同步回调中新出现的限制不能被越过；失败时归还尚未交付执行的环境引用、资源和容量。
- job ID 分配和重复检查先于进程 factory 调用；retain 后及身份回调后均复查取消。stdin 关闭晚于 registry 登记和事件监听，抛错时仍由 registry 清理。身份分配失败不启动进程、不泄漏环境引用。
- 交互式或带 context scope 的 Bash 若缺少可信 owner，直接在启动前报错；仅独立非交互调用允许以当前 session/workdir 建立来源。
- Bash 使用受信 `cleanupOwner: "tool"` 和 `reportCleanup`，scheduler 不再用 Bash 逻辑 Promise 结束伪造进程清理确认。事实仍携带原 owner、按调用顺序进入既有 hook，迟到清理不改结果、不重复还槽。环境释放失败使用独立 `reportCleanupError`，不让已确认清理倒退。
- 进程停止证据到达后立即解除该 job 的来源保护和环境引用，输出最多另收尾 1000ms。普通 close 可以形成真实 shell 退出结果，但不能替代后代停止证明；未确认时仍保留 owner、环境引用和生命周期期限，后续清理不改写已经交付的结果。未确认 job 不被普通历史上限淘汰，scope/session dispose 继续接管，不能静默删除。
- 内置终止函数负责自己的 TERM/强杀观察时钟，registry 不再叠一个从取消时起算的 1200ms 时钟抢先结束真实强杀观察。自定义旧式终止 helper 使用有界兜底，测试可注入预算；返回 void 本身不构成确认。

## 验证映射

| 要求 | 证据 |
|---|---|
| C07 | C2 批次保守规则保持；source-cleanup 与 Bash scheduler 集成验证独立 root、可信独立工具及控制可继续。 |
| C08/C09 | shell unit 与真实 `process.integration.test.ts`：TERM、忽略 TERM、leader 先退同组 child 仍活、关闭输出仍活、组停但管道未关；缺 PID、探测失败、终止失败、重复调用不重发。 |
| C10 | scheduler 启动边界回归与 Bash 集成：先登记来源保护再返回取消/还槽；同会话独立工具和其他 root 能启动；已有排队文件项仍受保护。真实 composition 验证 Full Access 下的父子 owner。 |
| C11 | 两个残留分别确认；迟到事件不改变原取消结果、不重放；普通历史超过 100 个及 dispose 不丢未确认 owner。source 记录跨 scheduler 重建；真实 sandbox 的逻辑 destroy 等到 job retain 释放。 |
| C12 | 正常后台派遣不触发限制；超时/取消才建立保护；task_output/task_kill 可用且授权范围不扩大；重复 kill 不重新发信号。 |
| C13 | 真实进程夹具只清理自身创建的进程组；另行建立持管道的隔离进程 fixture 并最终清理。服务、SQLite、临时目录由端到端夹具 finally 关闭。没有跨进程内存锁保证。 |
| C14/C15 | 查询和新等待者不延长观察；已有/新冲突调用均失败且不 invoke；迟到确认只开放将来的新调用。取消优先；StatusChanged/retain 同步回调竞态有先红后绿回归。 |
| C1–C3 组合文件门 | C2 的真实 scheduler → Write/Edit 超时与延迟 rename、同文件保护、不同文件推进、容量只归还一次的回归继续纳入全量和定向测试。 |

## 测试记录

本机为 macOS arm64。临时原始日志在 `/tmp/ohbaby-pre-c3-20260926/`，可重复用例在仓库中；密钥仅由现有真实模型夹具读取，未输出或提交。

| 检查 | 结果 |
|---|---|
| 最终全量 `pnpm exec vitest run` | Pi 修复后最终代码：411 文件、4466 项通过；6 文件/17 项按既有条件跳过，退出码 0，约 264 秒。包含真实 CLI/daemon、打包冷安装、身份分配、stdin 接管、探测恢复与 owner 回归。 |
| scheduler、shell、registry、真实 composition 定向 | Pi 修复后 22 文件、290 项通过，含 50 个真实 zsh 进程组夹具。 |
| 最终 build / typecheck / lint | 均退出码 0。 |
| 子代理端到端 | `pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts`：8/8 通过。 |
| 新增真实模型端到端 | `OHBABY_RUN_REAL_BASH_CLEANUP=1 pnpm exec vitest run --config tests/smoke/bash-cleanup-real.vitest.config.ts`：1/1 通过；真实 HTTP listener + persistent runtime + Zenmux `openai/gpt-5.6-luna`，7 次模型请求。后台 sleep 超时、task_output 查询确认、后续 Bash 输出 `C3_RECOVERED`。 |

真实模型最初的测试错误地断言 task_output 的 UI 状态必须 completed。排查 SQLite 原始工具记录后确认控制调用成功、job 为 timed_out/cleanup confirmed；既有 UI 的 `tool-ui-outcome.ts` 会将观察到的 job 超时投影为 failed。测试改为同时核对 HTTP 展示与持久化真实状态，没有修改 UI 或将 job 超时伪装成成功。模型尝试加载仓库外 skill 被夹具拒绝，不属于 C3 成功证据。

## 子代理与外部审查

三个子代理分别实现/检查进程证据、来源准入，以及真实 Bash/composition 集成，并交叉审查。已确认并修复：启动边界的同步回调竞态、正常 shell 结果与后代停止证明混淆、Windows 旧 PID 终止风险、环境释放错误倒退清理状态。进程真实 fixture 曾有一次未确认结果，随后增强失败断言，连续五轮及额外 100 个 owned TERM fixture 未复现；未据此增加猜测性重试或放宽停止判定。

Pi 审查使用 `opencode/claude-opus-5-5`、medium，独立会话 `codex-pre-c3-review-20260926-ad92e49e`，启动目录为仓库根目录。两轮完整正文均已原样呈现在实施会话。处理如下：

- 采纳 POSIX 发出终止信号后短暂探测失败的复查建议：只使用原有限观察预算继续读取停止证据，不重发信号、不重置时钟、不将不确定状态视为可继续强杀的证据。registry 的 exit/close 只接受真实停止，不用瞬时不确定状态抢先结束终止负责人观察。初次探测失败仍不发送信号，持续失败仍保留 unconfirmed。
- 采纳 owner 回退限制，仅允许独立非交互调用；真实 run/context 缺少 owner 报错。
- Windows 问题是已知能力缺口，不仅是缺少运行证据。没有采用“普通 close 直接 confirmed”：这会违反 C.6 对整个受管理范围的要求，不能把仍在原范围内的后代一律称作已脱组。该平台不具备完整 C 合并条件。
- POSIX 正常 shell 返回后仍存活的组沿原 job 的固定期限继续受管理，超时才进入来源限制；已交付 shell 结果不改写。此取舍依据 C.5“普通 Bash 正常运行不触发来源限制”和 C.6 固定期限/进程范围规则。隐式 `&` 或 `nohup` 若仍留在所属组，不能借 leader/管道先退出绕过期限；这会改变过去可无限存活的行为，明确记录，不恢复旧的提前丢 owner 行为，也不提前冻结正常任务。
- 受信 resolve/plan 是实现对象上的 WeakMap 注册，不接受模型或工具名字自报；todo 等已明确的非文件范围不新增工具名白名单。plan 接口本来要求只声明范围，无权限/存在性/内容副作用。
- 仓库实际 lint 未发现 Pi 插件提到的 async map return 问题，不为适配外部插件规则改写无误逻辑。

复审结论：macOS 无剩余阻断项，允许分批本地提交；Windows 能力阻塞保持开放。Pi 另跑 5 文件 76 项测试以及 60 次真实 zsh 终止，全部通过。首轮偶发 OS 探测异常没有在复审中再次出现，不能以该样本声称完整复现并证明修复；短暂失败恢复由确定性回归验证。Pi 撤回普通 close 后继续执行固定 job 期限需要另行确认的意见，接受可信 admission 和仓库 lint 的说明。

## 保留边界与验收门

**不能把本记录当作完整 C 的合并许可。** 本轮只在 macOS 执行真实进程验证；Windows 平台仍阻塞。Windows 目前缺少能在 leader 退出后持续持有的原生进程树/Job Object 证据，普通 shell 可以交付真实退出结果，但无法据此释放未确认的环境引用；生命周期到期或 dispose 后可能保守保留来源限制。mock 仅验证不伪造确认和不误杀旧 PID，不能填补该原生能力与验收缺口。Linux 也未取得原生运行证据。

POSIX 仍有进程组 ID 复用的低概率边界：leader 已退出，剩余组成员在期限前自行消失，若同一 pgid 在期限前被重用，后续到期信号可能命中新组。当前没有跨越该时间窗口的内核级进程组所有权句柄；Pi 将此列为非阻断限制。

进程外、跨重启、主动脱组后代、硬链接及任意外部文件改写不在本次保护保证内。第二轮仍负责事实持久化、普通工具错误交付、fatal 保存失败与真实 SQLite 争用下 Stop；第四轮负责整树 Stop/冷恢复。未把这些后续职责顺带实现。

后续仍需用户一起验收 C1–C3，核对 Windows 阻塞项后决定完整 C 合并门及 improve-2 S0；开发分支、C1/C2 分支保持原提交。

## 本地提交

- `263516f2`：进程停止证据、registry 所有权、来源保护、scheduler/Bash 接线，以及对应单元与集成回归。
- `5ee7e570`：真实 HTTP + LLM Bash 清理端到端测试。
- 本记录及前置任务索引独立作为文档批次提交。

各批提交保留仓库原有 lint/typecheck 钩子。未 merge、未 push；`codex/pre-c2-resource-admission` 保持 `ad92e49e`，`codex/execution-reliability` 保持 `68b11ba2`。
