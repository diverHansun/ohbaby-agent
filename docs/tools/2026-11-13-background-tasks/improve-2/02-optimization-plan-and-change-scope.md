# 自动转后台：改造方案

状态：待实施设计。产品规则以 [00](00-discussion.md) I2-D01–D09 为准；本轮只改后端。复用 improve-1 的唯一 Registry、持久记录、归属、后台配额、通知与回收，最终模型接口采用 improve-3 的 task。

## 最小参数契约

下列名称和数值校验是本次规划收尾采用的工程方案，用户已确认对应行为：

| 参数/配置 | 含义 |
| --- | --- |
| bash.timeout | 显式进程硬超时，整数毫秒；从实际启动起计时，不因转换重置。 |
| bash.wait_ms | 本次前台等待上限，整数 1–600000 毫秒；缺省取配置，默认 120000。不是进程寿命。 |
| bash.auto_background | 可选布尔；false 关闭本次转换。true 只能在全局允许时使用，全局关闭时显式要求 true 在启动前拒绝。 |
| bash.run_in_background | true 直接后台启动，不受自动转换开关影响；与显式 wait_ms/auto_background 同传时拒绝，避免无效参数被静默忽略。 |
| shell.json 顶层 autoBackground | 全局允许自动转换，默认 true。 |
| shell.json 顶层 defaultForegroundWaitMs | 全局默认等待，默认 120000，范围与 wait_ms 相同。 |

配置放入 ~/.ohbaby/tools/shell.json，与 improve-1 的 maxRunningBackgroundJobs/maxRunningSubagentBackgroundJobs 同为顶层键，没有额外 shell 嵌套，不增加第二套加载器。单次禁止转换或全局禁止时，wait_ms 不适用，显式提供则在启动前报参数错误。实际角色没有任务管理能力时，不得进入后台。角色声明/提示词须先明确它只能纯前台：未显式请求后台策略的普通 bash 按纯前台默认 120 秒执行；显式 run_in_background=true、auto_background=true 或 wait_ms 则在启动前拒绝。这是按实际工具能力形成的执行策略，不在转换点才静默降级；旧工具名配置错误仍按 improve-3 拒绝角色激活。

| 有效路径 | 没传 timeout | 显式 timeout 上限 |
| --- | --- | --- |
| 显式后台 | 不限时，立即返回 | 86400000 ms |
| 允许自动后台 | 无隐式硬超时，前台等待后尝试转换 | 86400000 ms |
| 纯前台 | 保留 120000 ms 硬超时 | 600000 ms |

超时值必须为正整数；不引入 0 表示无限。硬截止时间等于 startedAt + timeout。等待阈值与硬截止相同或硬截止更早，按 timed_out 处理。等待只控制当前调用何时让出，不改变显式硬截止。

## 自动转换的唯一提交点

1. 启动时仍是 foreground，不占后台额度；从第一字节开始维护与显式后台共用的有界尾部，不等转换时再切换采集器丢失早期数据。前台现有正文展示可保留头部截断，底层尾部只有一份。
2. 等待到点时重新检查任务是否已退出、停止是否已先发生、执行准入是否关闭、硬截止是否已到。已经终止则返回原结果，不抢后台名额；硬截止到点先停止。
3. 先等待现有 runWriteTransaction 获得写锁，在其同步 callback 内重新检查终态、取消、准入和硬截止，再检查并申请同一归属的后台名额、持久更新 mode=background、promoted_at 及首份内存尾部/输出计数快照；COMMIT成功后、事务Promise resolve前的同步提交钩子立即完成内存转换（中间没有await或外部可重入回调）、通知可信清理归属切换并解除前台 abort 关联。不能在这些动作中间发布外部事件或返回成功；不重新 spawn、不变 jobId/start time/deadline/owner。
4. 转换成功后发布状态事件、返回后台运行回执，并释放本次工具调用的普通执行名额。Registry 继续持有任务和环境引用；任务不是随工具返回就释放的资源。
5. 申请失败则以 cancelled + capacity-limit 停止当前命令，返回已有输出与真实 cleanup，不杀旧任务、不超发、不重跑。转换持久化失败则不返回成功，按 cancelled + internal-error 进入受控停止并报告持久化错误。已预留资源及未确认清理责任不提前释放；不把故障伪装成满额或超时。

现有 runWriteTransaction 入口本身异步，会排队、yield和重试BEGIN，不能把整个调用当成同步原子段。只在其获锁后的callback做最终重检及SQL，提交成功后必须在Promise resolve前完成内存归属切换，不能用 await store.promote() 后再赋值冒充原子段。可对现有事务封装增加小型同步 afterCommit 接口或等价提交适配；钩子仅做预备好的无抛错赋值/解绑，不执行外部事件，不重试已提交事务。失败不宣称已转换。事务或临界区实现以当前事务能力和Registry为基础，不引入通用分布式锁。多运行实例访问同一库时，额度检查与更新必须有数据库事务保障，不能仅依赖各自 Map 计数。

## 取消、回收和调度接线

- 提交前当前轮 Stop 获胜，按前台取消；提交后主代理当前轮 Stop 不杀该后台任务。子代理本次执行结束仍回收其所有任务，自动转换不改变归属。
- 硬超时计时器独立存在，转换只清除前台等待计时器。取消读等待也不清除硬超时。
- 当前 scheduler 的 detachedCleanup 在调用前根据参数冻结，不能只把 auto_background=true 当成“已经后台”。需补充可信运行时 detachCleanupOwnership 回调（或同等单向信号），让清理归属在提交时切换；普通执行容量、调用资源锁、进程/环境引用、清理保护分别管理。Scheduler 自身 retain 仅保护 execute 栈，Bash 另有进程级 retain；问题是迟到 cleanup 回写旧 run，不是 Scheduler 释放自身引用会直接销毁进程环境。
- 转换后不长期占据整个工作区的普通调用资源锁；沿用显式后台的资源策略。进入停止且清理未确认时，既有 source-cleanup 保护必须持续生效。不能为解除阻塞绕过保护。
- 移除前台 abort listener、释放普通工具槽、保留 Registry 环境引用都必须恰好一次。提交后仍生效的范围包括单停、硬超时、输出上限、子代理执行结束、归档、删除和服务退出。
- 转换回执不是最终结果。只有已提交为后台的任务走后台结果通知；容量失败仍由本次前台调用返回，不新增后台结束唤醒。

## 改动范围及安全替换

bash 参数/提示词；Registry 内部转换、模式与计时；工具调度的可信清理归属通知；shell 配置；持久记录 promoted_at；后端结果投影与相关测试。内部转换方法不是公开手动转换 API。

拆除原“同一个 timeout 同时控制等待和寿命”的分支；保留纯前台的 120 秒默认硬超时兼容。拆开前台硬超时上限、后台硬超时上限及 task.output 等待上限常量，不把 task.output 的等待误放宽到 24 小时。移除旧静态 detachedCleanup 接线前，必须迁移真实 Bash 调用方和调度测试；其他仍需静态接线的工具不受影响。禁止保留两套 Bash 执行器或按命令首词判断的分支。

## 依赖和交付

先完成 improve-1 基础及 improve-3 最终工具表面，再实现本轮转换；联合实施直接发布最终接口。代码未落地，不宣称已完成。验证见 [04](04-test-and-acceptance.md)。用户手动转换、前端操作入口及跨重启常驻不在本轮。

## 简要关键改动清单

路径相对于 packages/ohbaby-agent/src；符号优先，行号是基线快照。

| 位置 | 改动 |
| --- | --- |
| tools/bash.ts | wait_ms/auto_background 参数、有效能力策略、返回转换回执；前台只在内存保留转换所需尾部。 |
| tools/shell-job-registry.ts | 独立等待/硬超时，唯一转换点，额度、尾部首次持久化、abort/清理归属切换。 |
| core/tool-scheduler/scheduler.ts:885、tool-admission.ts | 让可信 Bash 在真实转换提交时单向解除旧 run 的 cleanup 归属，不提前把候选自动后台当成后台。 |
| services/database/index.ts · runWriteTransaction | 狭窄的同步提交接点，COMMIT 后、Promise resolve 前仅做无抛错内存切换；不建设通用 hooks 框架。 |
| services/database/migrations.ts、schema.ts | 联合实施时 promoted_at 并入 shell_job 建表；若 improve-1 已发布，则用下一编号的加列迁移，不改已执行迁移。 |
| config/tools/shell/、工具描述和提示词 | 同一 shell.json 顶层配置和等待/寿命区别。 |

所有改动按 [04](04-test-and-acceptance.md) 验收；本清单不用于回写实施进度。
