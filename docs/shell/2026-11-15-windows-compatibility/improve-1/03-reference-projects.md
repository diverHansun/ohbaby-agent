# 03 · 参考项目与取舍

2026-11-15 阅读本地源码，未运行参考项目的测试，不代表上游最新实现。Windows 主机的参考仓库位于 `D:/Projects/code-cli/`，macOS 主机位于 `~/Projects/code-cli/`，两边 HEAD 相同。

## 对照总表

| 项目 / HEAD | Windows 命令进程怎么管 | 本轮借鉴 | 不借鉴 |
| --- | --- | --- | --- |
| codex / `b016cd18472588606c04af565528c4cd6746a41f` | Rust 直接调 Win32。命令执行路径先 spawn，再用子进程句柄加入 Job，接受中间的小窗口；加入失败退回只结束单个进程 | attach-after-spawn 的结构、失败回退的位置 | Job 默认允许 breakaway；根进程正常退出后 `preserve_descendants()` 放走后台后代。codex 只把 Job 当取消工具，ohbaby 的 D07 需要清理证明 |
| ZCode / `fec975905a2abd4c07e35c40d51fa097a2258ec9` | Bash 用 taskkill；MCP stdio 用 Koffi 2.x 在 spawn 后加入 Job，失败退回 taskkill | Koffi 进程内调用、spawn 后加入 Job 的写法（约 200 行） | koffi 2.x 全平台合一的包（约 41 MB）；Windows 默认优先 Git Bash |
| deepseek-harness（dsh）/ `39163dd30f703a79079e2d2446545cff3c453738` | 普通命令在 Job 可用时走私有 runner，用 Koffi 3.x 挂起创建进程、加入 Job 再恢复；不可用时退回较弱路径并告警一次 | koffi 3.x 按平台拆分的打包方式；“目标进程退出”和“Job 已空”分开报告；README 明确 breakaway 进程不在保证范围 | runner 子进程、挂起创建（要重写整套 spawn）、Linux scope、沙箱与插件体系 |
| kimi-code / `f082f04a093a3e71a2263c5461d52507dc31f83a` | Node 进程服务：Windows 用 `taskkill /T /F`，最多等 5 秒；POSIX 用进程组；支持前台自动转后台 | 平台差异集中在一处；转后台时保留同一任务 | taskkill 的返回不能证明整树已清空；timeout 语义与 ohbaby 的硬截止不同 |

OpenCode 已在上一轮对照过：Node spawner 用 taskkill，Rust process-daemon 在 Windows 用 kill-on-close Job。本轮不引入它的跨 server 重启接管服务，详见 [证据附件](evidence-notes.md)。

## 用户入口对照（00/D14）

| 项目 / HEAD | 怎么让用户看到并处理后台进程 |
| --- | --- |
| claude-code / `963e0013184ecc1521289a0fc7d5da4bb6e45356` | 状态栏显示任务数，点开 `BackgroundTasksDialog`，选中后按 `x` 停止；列表只放运行中和等待中的任务 |
| kimi-code | TUI `tasks-browser`：全部/进行中切换，`lost` 等异常状态用错误色，停止需在 5 秒内按 `y` 确认 |
| codex | `/ps` 列出后台终端，`/stop` 停止全部 |

三家都是“一个任务列表 + 单项操作”，都没有“清理未确认、放弃跟踪”这一层，因为它们不做清理证明。ohbaby 的 `/bg` 与 Web 侧栏已是同样形态，所以只在现有列表里加上异常任务和一个单项操作，交互沿用 kimi-code 式的 `y` 确认；不加状态栏计数和批量操作。

## 关键源码

- codex：[pipe.rs](D:/Projects/code-cli/codex/codex-rs/utils/pty/src/pipe.rs:185)（spawn 后加入 Job）、[job.rs](D:/Projects/code-cli/codex/codex-rs/utils/pty/src/win/job.rs:72)（Job 标志与 `preserve_descendants`）。
- ZCode：[windows-job-object.ts](D:/Projects/code-cli/ZCode/apps/zcode-cli/packages/adapters/src/mcp/windows-job-object.ts:27)、[stdio-transport.ts](D:/Projects/code-cli/ZCode/apps/zcode-cli/packages/adapters/src/mcp/stdio-transport.ts:88)、[Bash 进程处理](D:/Projects/code-cli/ZCode/apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts:146)。
- dsh：[平台选择](D:/Projects/code-cli/deepseek-harness/packages/subprocess/subprocess-local/src/index.ts:250)、[Job 生命周期](D:/Projects/code-cli/deepseek-harness/packages/subprocess/subprocess-local/src/spawn-runner.ts:353)、[Win32 启动](D:/Projects/code-cli/deepseek-harness/packages/subprocess/win32-process/src/process.ts:554)、[保证范围说明](D:/Projects/code-cli/deepseek-harness/packages/subprocess/subprocess-local/README.md:151)。
- kimi-code：[hostProcessService.ts](D:/Projects/code-cli/kimi-code/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts:164)、[bashTool.ts](D:/Projects/code-cli/kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:95)。

## 影响方案的四点

1. **Job 是取消工具还是清理证明，各家不同。** codex 正常退出后放走后代，opencode 允许成功命令留下后台进程，这两家都不需要清理证明。ohbaby 的 D07 需要，所以 Job 在 ohbaby 里同时承担“取消”和“证明已空”两件事，并按 D10 写清证明的范围。
2. **spawn 后加入就够用。** codex 和 ZCode 都保留原生 spawn 再加入 Job；只有 dsh 为了零窗口改用挂起创建，代价是重写整套进程启动。ohbaby 选前者（D11）。
3. **breakaway 是公认的边界。** dsh 在 README 里写明，codex 甚至默认允许。ohbaby 不允许 breakaway，但实测 `Start-Process` 启动的进程仍会脱离，所以只能写明边界、用提示引导，不承诺回收（D10）。
4. **原生能力不需要独立服务。** ZCode 和 dsh 都在 Node 进程内用 Koffi 调 Win32。koffi 3.x 按平台拆分预编译包，但带 install 脚本，加载失败时会尝试源码编译；ohbaby 已有的 `@lydell/node-pty` 也按平台拆分，但没有 install 脚本。因此安装链路要单独验证（04/T10）。

本表结论已进入 [02](02-optimization-plan-and-change-scope.md)；完整阅读记录和实验见 [证据附件](evidence-notes.md)。
