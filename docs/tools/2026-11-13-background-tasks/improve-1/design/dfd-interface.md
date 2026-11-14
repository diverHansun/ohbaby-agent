# 数据流与接口边界

状态：待实施设计。状态和字段的含义见 [data-model](data-model.md)。

已纳入输出尾部持久化、实际请求消费、统一输入协调及保守恢复契约。当前仅完成后端规划，整体尚未实施；前端展示另行交付。

## Context and Scope

本模块的输入是 `bash` 调用、生命周期事件（Stop、子代理结束、归档、删除、回滚、退出、启动）和用户的停止请求；输出是工具返回值、运行时输入（结束通知）和给 UI 的只读数据。不负责 UI 渲染，不负责模型如何处理通知。

## Data Flow

### 启动

1. Bash 先完成参数、权限、目录等准备。显式后台未传 timeout 默认不限时，显式 timeout 最多 24 小时；纯前台沿用 2/10 分钟规则。
2. 通过现有 runWriteTransaction 取得写锁，在同步 callback 内重检可信执行准入，并原子检查后台额度、插入 shell_job 启动占位。占位使用同一张表，包含 jobId、owner、mode、created_at；status、started_at 和 pid 暂空。后台占位立即占额度，纯前台不占。满额或提交失败时不 spawn。
3. 事务提交后、实际 spawn 前再次检查取消和执行准入。已取消就把占位记为 cancelled、清理 confirmed，不启动进程。否则在事务外调用一次 spawn，立即登记内存句柄、启动硬超时，补写 running、实际 started_at、PID/PGID；身份采集完成后补写出生标识。启动失败写 failed + error，释放未产生进程的占位。
4. 进程启动后补写失败，统一停止已启动进程并保留清理责任；原占位仍在库里，仍占后台额度。数据库恢复可写后更新同一行，不重跑命令，不需要保留整个模型轮次的持久认领。后台仅在启动事实已保存后返回 jobId 和回执；前台等待实际结果。

占位不是第七种 TaskStatus，不作为“进程正在运行”的任务行暴露；列表单独给出 pendingStartCount，预留占额可解释。正常情况下它很快转为运行或启动失败；原后端死亡且占位仍无 PID 时，不能推断一定没有 spawn，恢复为 lost + unconfirmed。D28 的极端窗口缩小为 spawn 至进程身份补写，不能声称已消除。

现有事务入口会异步排队、让出事件循环及重试 BEGIN，故准入和额度在获锁 callback 内检查。事务中不启动进程、不探测系统、不等待外部操作；只在确认预登记提交成功后 spawn。取消、崩溃、写库失败都不能重新执行同一命令。

### 前台超时与显式后台边界

前台到达 timeout 时，经统一停止路径记录 `timed_out + timeout`，将结果返回当前工具调用；`mode` 保持 `foreground`，不生成后台结束通知。所有前台命令执行同一规则，不检查是否以 `sleep` 开头，也不尝试申请后台名额。

显式后台在启动时确定模式并登记；当前轮 Stop 不影响它，单任务 Stop、归属方结束和服务退出仍可停止它。自动转换及相应接口、字段留 improve-2。

### 结束与通知

```mermaid
flowchart TD
  end[退出或进入停止路径] --> feedback[持久更新当前状态，UI 即时反馈]
  feedback --> settle[有限等待退出观察和输出收尾]
  settle --> rec[保存已知事实与完整性，异常明确标注，设置 result_ready_at]
  rec --> judge{需要通知？}
  judge -- 否 --> sup[notice_state = suppressed]
  judge -- 是 --> pend[notice_state = pending]
  pend --> busy{归属方有正在执行的轮次？}
  busy -- 是 --> step[下一次 beforeStep 写成运行时输入]
  busy -- 否，且允许唤醒 --> wake[唤醒一轮，通知作为开场输入]
  busy -- 否，不允许唤醒 --> wait[等下一轮 beforeStep]
  step --> acc[notice_state = accepted]
  wake --> acc
```

- “需要通知”和“允许唤醒”的判定表见 data-model。
- 停止请求立即反馈，不等于结束通知已经就绪；所有投递入口都要求 `result_ready_at` 非空。正常结果收尾后再发布，观察或收尾超时则发布明确的异常结果。退出码/信号未知时保持未知，晚到事实更新记录与 UI，不重复自动唤醒。
- 同一归属方的多条待送通知合并成一条运行时输入。
- 唤醒使用会话闸门和 `prepareSession` 的准入检查。已有轮次在执行、会话被闸门占用、或准入不通过时都不唤醒，通知留到下一轮。
- Goal 活跃时，已有 Goal 轮次通过统一输入协调器接收结果；空闲且任务 goal_id 匹配当前 Goal 时，复用 `subagent-wakeup.ts` 的 Goal 准入、预算与票据路径。Goal 已暂停、完成或归属不匹配时不绕过闸门自动开普通轮，通知留待后续合法用户/模型轮次。不得把所有后台 ShellJob 加入 shouldWaitForSubagents，否则不限时服务会卡死 Goal。提示词要求对后续步骤依赖的命令使用有界 task(output) 等待；长期服务不成为 Goal 自动等待条件。

### 生命周期事件

| 事件 | 调用 | 影响范围 | 停止原因 |
| --- | --- | --- | --- |
| `task(stop)` | `stop(jobId, owner, "model")` | 单个任务，需归属方匹配 | `model` |
| 用户停止 | `stop(jobId, rootSessionId, "user")` | 单个任务，只校验它属于这个会话树 | `user` |
| 当前轮被用户 Stop，或因其他原因取消、失败 | `stopForeground(jobId, reason)` | 只停本轮正在等待的前台任务，后台任务不受影响 | 用户 Stop 记 `user`，其他记 `owner-ended` |
| 子代理正常交付、失败或被用户/主代理停止 | 关闭本次执行准入，`stopScope(sessionId, contextScopeId, "owner-ended")` | 该作用域全部任务；清理完成前保留责任 | `owner-ended`（不覆盖先前原因） |
| 回滚 | `stopByRootRun(rootRunId, "rewound")` | 被回滚轮次启动的任务 | `rewound` |
| 会话删除或归档 | `stopSession(sessionId, "session-closed")`，包括子会话 | 会话树全部任务 | `session-closed` |
| 服务正常退出 | `dispose("shutdown")` | 当前后端管理的任务 | `shutdown` |
| 输出达到 1GB | 内部触发 | 单个任务 | `output-limit` |

所有停止都走同一条终止路径（现有的 `terminate` → `killTree`），先停的原因优先。

### 启动恢复与按需复查

1. startupReady 扫描旧后端的启动占位、running，以及 cleanup 未确认或 settled_at 缺失的任务，排除用户已放弃追踪的行。只将旧占位/running 改为 lost，已有终态保持原结局。原管理后端仍活跃时不认领、不发信号。
2. 同一检查函数用于启动恢复和按需复查。列表刷新、额度准入、stop、删除/归档前，有限地重新探测相关未确认项；并发请求合并，不新增常驻轮询。**查询和额度检查只核实事实，不触发杀进程**。明确进程组不存在时更新 confirmed，收尾后释放名额；权限不足、身份不匹配、PID 缺失均保留 unconfirmed。
3. 只有原后端确认退出且目标组长的 OS 出生身份、组号与记录一致时，恢复/显式停止路径才能发信号。先用同一行 recovery_claim 做持久 CAS 认领，原子条件同时要求 tracking_released_at IS NULL，并比较刚核验的原 owner 与旧认领身份，保存处理后端的进程身份；只有认领者执行有界终止。另一活跃认领者存在时不重复发信号；认领者死亡后按原生身份核验再接管。结束本次处理并解除全部信号定时器后清认领，不用 TTL 猜测失效，也不引入通用锁服务。
4. process-identity 返回 present/absent/unknown。Linux 使用 /proc 启动标识与 boot identity。macOS 复用仓库现有 osascript/JXA 系统调用方式，通过 proc_pidinfo(PROC_PIDTBSDINFO) 读取 pid、pgid、start_sec/start_usec；不增加原生 npm 模块、第三方 FFI 或通用桥接框架。本机 arm64 已做只读能力探测，尚不是产品实现或恢复验收；实施须核对 ABI/返回长度，覆盖真实进程、身份不匹配和错误分类。
5. 缺少已保存身份、API 失败、权限不足、未知平台都不授权发信号；不以 ppid=1、相同命令或秒级 ps 时间替代出生身份。组长 PID 不存在不等于整组不存在；组长死亡且仅剩数字 PGID 时不重新取得信号权。每次升级信号前重检身份，组已消失后永久释放旧信号权。查验/信号间仍有 OS 竞态，不宣称系统托管级保证。Windows 本轮不扩展恢复信号授权。
6. 后台恢复读取持久尾部检查点并说明其时刻与不完整性；前台没有持久尾部时明确不可用，不伪装空输出。已登记但尚无 PID/身份的占位也可能实际启动过，保留 lost + unconfirmed。spawn→身份补写窗口及主动脱离托管进程组的服务仍受 D28 限制。

### 清理未确认的人工出口（D29）

用户专用 abandonShellJob 在再次复查后，仅允许对“原启动后端已确认退出、无本地活跃命令句柄或其他活跃恢复认领、lost/终态且 cleanup=unconfirmed”的任务放弃追踪。请求必须明确 confirm=true；用户权限按会话树验证，模型 task 不增加此 action。操作只持久保存 tracking_released_at，不发任何进程信号、不改 status/stopReason、不把 cleanup 改为 confirmed。

放弃后该项不再占额度、不再阻塞删除/归档，也不再进入自动恢复；历史仍明确标注“用户已放弃追踪，进程是否仍存在未知”。本地已无进程句柄时可释放剩余的观察/元数据责任，不把它记为进程回收成功。重复请求幂等；与恢复或实际清理完成竞争时用条件更新：同时检查未放弃、cleanup=unconfirmed，且 recovery_claim 仍是刚核验的空值/死亡认领身份；若被另一活跃恢复抢先认领就返回忙，不继续放弃。返回实际结果。不能让模型调用、超时策略或重试次数自动替用户做这个决定。

### 多后端管理边界（D30）

standalone TUI 与 Web daemon 可以是两个共享数据库的后端；连接 daemon 的 remote TUI 则仍由同一后端管理。session/scope 是代理归属，owner_id 是管理进程身份，两者不能混为一谈。

原后端仍活跃时，其他后端可列出任务、读取持久尾部或已有日志，并返回 managedByCurrentBackend=false、checkpoint 时刻及 canStop=false。task(output, block=true) 如需等待远端结果，仅在本次有界调用期间读取数据库，等待到期/steer/取消即撤销；不假装订阅了另一 Registry。跨进程实时输出与失效事件转发不在本轮，用户刷新时读取最新持久快照。

其他后端的 stop 返回明确 SHELL_JOB_OTHER_BACKEND 错误，提示从原 Web/TUI 后端操作；不能直接凭 PID 杀活后端的任务。删除、归档、回滚等需清理任务的操作，在产生部分停止/删除副作用前先检查整个目标集合；存在 foreign-live-owner 就拒绝并说明原因。当前后端正常退出只停止自己管理的任务。原后端死亡后按上述恢复合同处理，不能因“只有原后端能停”永久禁止崩溃回收。任务结果的通知仍通过共享持久输入/既有轮次准入消费，不能因换客户端伪造已送达。

跨后端关轮竞态的已确认边界：若另一独立后端占用会话，本后端保留结果及尚未使用的唤醒机会；对方关轮后若没有本地会话事件，不承诺即时自动唤醒。结果在后续合法轮次或本地会话事件中重新处理并可靠接收。本轮不新增跨进程空闲观察、控制转发或常驻轮询。

本次执行准入优先复用现有执行租约；若需登记表，只有已登记且 open 的 run/execution 可启动任务，sealed 或不存在均拒绝。结束后删除登记不重新开放迟到旧调用。子代理 followup 可复用 scope，但须等前次清理完成并创建新的执行准入。

### 多来源输入汇总

现有 continuation-coordinator 的 beforeFinish 自行调用 tryCloseForCompletion。接入后台任务后，将子代理结果与后台结果各自的 reconcile/消费确认保留为来源逻辑，由一个共享组合入口负责：beforeStep 先汇总来源、只 seal 一次、只读取一次消息；beforeFinish 先汇总所有来源、再只尝试关闭一次；成功请求也只确认一次，然后按实际 inputIds 分派来源确认。

任何来源不能自行提前关闭当前轮。关闭与新结果并发时，写入关闭轮失败的结果保持 pending，交给会话准入协调器在当前 run 释放后处理，不丢弃、不在关闭轮内重新开输入。移除旧子代理入口独占 seal/close 的接线，保留其结果准备和子代理状态更新。

## Interface Definitions

### 给模型的工具

`bash`：

```ts
{
  command: string
  description?: string        // 新增；侧栏和通知的标题，建议 5–10 个词
  timeout?: number            // 前台：默认 120000，最大 600000；后台：默认不限，最大 86400000
  run_in_background?: boolean
}
```

`task({ action: "output", job_id, block?, wait_ms? })`：返回正文开头固定一行状态，后面是输出结尾。用户发来新消息时，`block` 等待提前结束，并在状态行后注明原因。

```text
[job 69853e79 · timed_out: timeout after 10m · ran 10m 0s · signal SIGTERM · 0 bytes captured · log: /…/tool-results/69853e79….log]
```

`task({ action: "list", include_finished?, status?, limit?, cursor? })`：只列调用者自己的后台任务及清理未确认的前台异常项，不列正常前台历史。默认包含最近结束的后台任务，`limit` 默认 20、最大 100。每行包括短 jobId、说明或命令摘要、模式、状态和停止原因、开始时间、时长、退出事实。

`task({ action: "stop", job_id })`：停止原因记为 model，按既定产品规则不触发通知；读工具不抑制通知。完整工具 schema 以 improve-3 为准。

### 结束通知（运行时输入正文）

来源 `background-task-result`，`sourceId` 为 `background-task:<notice_batch_id>`，inputId 再带接收 runId。批次成员与正文固定后不变，不能每次按当前 pending 集合重新造身份。一条输入可以包含多个任务：

```text
<background-task-results>
Background job 69853e79 "watch build" finished: failed, exit 1, ran 3m 12s, 48213 bytes. Log: /…/69853e79….log
Last output:
…最多 2KB…
</background-task-results>
```

已保存启动事实的 lost：`… lost: the managing ohbaby process exited before a final result was saved. A leftover process (pid 12345) may still exist.`

无 PID 占位的 lost：`… lost: the service exited before process registration completed. The command may or may not have started; its result is unknown.`

### 给 UI 的后端接口（本轮不实现界面）

调用方先验证当前客户端可访问 rootSessionId，再根据会话树及子代理实例归属判定目标 job。模型 own-only 与用户 tree-wide 是两个明确授权入口，不能复用一个可被模型传参放宽范围的 handler。

| 接口 | 契约 |
| --- | --- |
| listShellJobs | rootSessionId 必填；默认后台及清理异常前台；启动者（主代理/全部子代理/具体实例）、六状态筛选；limit 默认20、最大100；不透明 cursor 绑定范围和筛选。返回有界 rows、nextCursor、pendingStartCount、当前筛选计数及未放弃追踪的清理未确认数量。2026-11-14 精简时删除了命令/说明文本搜索，它没有经过确认，留到前端规划时再定。2026-11-14 前端规划新增可选 `mode=background`：只列后台任务（含自动转后台），计数同口径，cursor 绑定该参数；供用户任务面板使用，模型 `task list` 不传，行为不变，见 [Web 后台任务面板 D12](../../../../ohbaby-web/background-tasks/README.md)。 |
| getShellJobOutput | rootSessionId + jobId；立即返回状态、cleanup、捕获/日志/检查点完整性和日志可用性；后台附最多 32 KiB 尾部，前台未保存则 tailAvailable=false，不阻塞。 |
| readShellJobLog | rootSessionId + jobId + offset + maxBytes（最多64KiB）；只读该记录绑定的日志，返回 nextOffset/hasMore/截断和完整性；不接受客户端文件路径。 |
| stopShellJob | rootSessionId + jobId；停止原因为 user，返回操作受理情况与真实快照；不直接停止所属子代理，foreign-live-owner 返回明确错误。 |
| abandonShellJob | rootSessionId + jobId + confirm=true；仅用户可用，适用条件及含义见 D29。返回放弃事实和原 cleanup，不作为已杀死证明。 |
| shell-jobs.invalidated | 提交后发 `{rootSessionId, runtimeEpoch, revision}`，复用现有子代理投影的版本化失效通知模式；客户端再查询权威快照，不合并事件里的另一份任务状态。list/单任务快照带同一版本；重连或 epoch 变化全量刷新，旧 revision 不覆盖新快照。 |

rows 带 jobId、命令摘要/说明、mode、status、stopReason、cleanup、开始/结束/结果就绪时间，以及 ownerKind、subagentId、展示名称、childRunId（适用时）。名称是展示信息，可信 owner 键与实例关系决定权限；子代理已结束仍可识别启动者。日志路径缺失、IO失败不伪装成空输出。

分页排序稳定（确定的排序键加 jobId 决胜），不承诺跨并发变化的多页读取是同一数据库快照；客户端按 jobId 去重并可刷新。默认活跃视图保留未被用户放弃追踪的清理未确认项；显式状态/启动者筛选可隐藏不匹配行，但返回范围内异常计数。前端如何排列、默认筛选与专用卡片仍另行设计。

### SideChat 的归属与展示

SideChat 是独立的执行会话；它的任务 root_session_id 指向 SideChat 自身，使用自己的主代理额度，通知回到 SideChat。主会话列表聚合主代理及其子代理，不把 SideChat 自动当成子代理混入；在 SideChat 查询其自身任务即可。关闭 SideChat 先清理其任务；主会话删除/归档沿用现有 SideChat 关闭遍历，先检查涉及的后端归属并完成清理。此规则沿用会话边界，不引入新的跨会话控制权限。

### 会话删除、回滚与工作区迁移

删除/关闭 side chat 前：封闭准入 → 停止会话树任务 → 确认进程/输出/环境资源清理 → 删除记录及日志。清理未确认且未被用户明确放弃追踪则返回明确错误并保留数据；不能先依赖 ON DELETE CASCADE 清掉任务记录，再用 Session.Removed 异步清理进程。删除事件仍用于已完成删除后的普通投影与文件清理。启动时 deleteOrphanSideChats 同样须在恢复处理之后且仅对清理已确认或已被用户明确放弃追踪的会话执行。

回滚清理查询权威任务记录，不能仅靠 run ledger。工作区移动沿用现状：改变后续轮次的目录，不因后台任务活跃而新增禁止条件；既有任务保留启动时的 cwd、环境和 owner，移动不转移任务、不释放其旧环境引用。fork/复制历史不复制运行中任务所有权，不把历史 jobId 当作新会话可管理的任务。旧会话无任务记录才使用既有 tool part 兜底。

## Data Ownership

| 数据 | 所有者 | 读取方 |
| --- | --- | --- |
| `shell_job` 记录 | `ShellJobStore`，只由 Registry 和恢复流程写 | 工具、UI 接口、回滚判断 |
| 进程句柄和输出缓冲 | Registry，涵盖运行中及清理/输出/资源释放责任未完成的任务 | Registry 自己 |
| 日志文件 | Registry 写，随会话目录删除 | 模型（`read`）、UI |
| 结束通知 | 写入后归 `CurrentRunInputStore` | 生命周期 `beforeStep`、`beforeFinish` |
