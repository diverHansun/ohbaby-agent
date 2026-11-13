# 自动转换的现状与问题

基线 f42608d4，未实施。产品决定见 [00](00-discussion.md)。

当前 bash 只有 timeout 和 run_in_background。默认 120 秒、最大 600 秒同时约束前后台；Registry 在启动时设置硬终止计时器，后台标志为只读字段，前台则 waitForTerminal。当前没有自动转换能力。

| 缺口 | 代码事实 | 要解决的行为 |
| --- | --- | --- |
| G1 等待与寿命混用 | tools/bash.ts 的参数校验；shell-job-registry.ts.start 的 timeoutId | 等待到点只尝试转换，显式寿命计时不变。 |
| G2 没有转换提交点 | ShellJob.background 为 readonly；Bash 只按初始 runInBackground 决定返回路径 | 同一任务原子转模式，不能重启命令或复制 job。 |
| G3 中止关联固定 | Bash 前台 abortHandler 始终调用 registry.kill；scheduler 在执行前计算 detachedCleanup | 转换提交后解除主代理轮次中止关联，同时保留 owner 结束回收。 |
| G4 捕获模式固定 | 前台 captureMode=head，后台 tail | 自动转换后需要真实尾部，不能拿前台头部伪装尾部。 |
| G5 没有活动后台额度 | 当前 Registry 只有 MAX_RETAINED_SHELL_JOBS，限制历史内存记录 | improve-1 提供独立额度，本轮在转换时原子申请，满额停止当前命令。 |

调度 capacity、资源锁、环境 retain 和进程生命周期是不同责任；“工具已返回”只释放调用责任，不能证明进程已退出。用户输入、硬超时、自然退出、额度竞争同时发生时，必须有明确的先后判定。

参考本机 ZCode 的 commitBackground 可借鉴原子提交及脱离外部 abort，但不能照搬清除显式硬超时的行为。dsh 提前注册占额与本项目“前台不占后台额度”不同；Codex 淘汰旧进程也不是本轮已确认方案。具体证据见 [03](03-reference-projects.md)。
