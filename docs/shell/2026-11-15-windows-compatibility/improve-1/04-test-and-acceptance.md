# 04 · 简版测试与验收

状态：规划草案；本节是后续验收目标，不是已通过报告。沿用仓库 Vitest 的 unit / contract / integration / smoke 组织，不另建测试框架。批次与 [02](02-optimization-plan-and-change-scope.md) 对应。

## 关键场景

| ID / 批次 | 可重复场景 | 验收结果 |
| --- | --- | --- |
| T01 / 第一批 | 真实 pwsh 与 macOS shell 执行 exit 0、exit 7，结束当轮后再调用 read/grep/glob/edit/bash | 保留真实退出码；Windows 以 Job 活跃进程为 0 确认清理；下一轮不被误阻塞 |
| T02 / 第一批 | Node 夹具产生子进程后父进程先退出，随后取消或触发硬超时；另用 pwsh `Start-Process` 启动后台进程 | 父进程退出不等于清理完成，Job 内子进程被回收后才 confirmed；`Start-Process` 进程按 D10 属于已知边界，测试记录其行为，不宣称回收 |
| T03 / 第一批 | 同一命令分别以前台、显式后台、短等待自动转后台执行 | 自动转换只启动一次、只加入一次 Job，job 不变，原硬截止不变；正常完成和停止都能结算 |
| T04 / 第一批 | 启动与取消相撞、连续停止、子进程持续持有输出句柄 | 不重复结算，不无限等待；输出读完不等于清理成功；Job 非空时不关闭句柄；grep/glob 取消时行为与改动前一致 |
| T05 / 第一批 | 任务结束后间隔查询内存和持久记录 | 耗时冻结；结果、cleanup、放弃跟踪各自含义一致 |
| T06 / 第一批 | 用隔离数据库构造旧 unconfirmed、其他活跃 owner、可放弃的记录；重启并打开界面 | 前台阻塞项可见，报错写明任务与原因；旧记录不伪造证据、不误杀其他 owner；用户可按条件解除，模型不可；不自动重跑 |
| T07 / 第一批 | 分别运行 pwsh、Windows PowerShell 和 macOS shell，使用中文/空格路径、引号、CRLF 文件及跨盘符目录 | 工具描述与环境提示写明实际检测到的解释器，PowerShell 下才出现 `Start-Process` 提示；输出可读，参数和路径正确，编辑内容正确；不支持的解释器明确报错 |
| T08 / 第二批 | 关闭浏览器、断开 remote TUI、退出本地 TUI、停止 runtime；另测 runtime 被强杀 | 客户端断开不杀后台任务；正常 runtime 退出按预算收尾；强杀后 Windows 由 KILL_ON_JOB_CLOSE 回收 Job 内进程，macOS 按 D04 边界恢复 |
| T09 / 另开议题 | Web PTY 启动含子进程的命令，再关闭终端并重连 | 单独观察进程和输出，不用 bash 测试代替；有泄漏证据再定改动 |
| T10 / 第一批 | 在没有开发依赖的目录安装真实发布包（Windows x64），执行 T01、T03 | koffi 平台包随安装到位，无需现场编译，Job 能力可用；macOS 安装后行为不变 |
| T11 / 第一批 | 模拟 Koffi 加载失败、建 Job 失败、加入 Job 失败；另模拟解释器不存在 | 前三种记为 unconfirmed，报错写明原生能力不可用、需重启后解除，重启后用户可解除；不以父进程退出确认清理；日志记录一次明确原因。解释器不存在仍按启动失败处理 |
| T12 / 第一批 | 运行中的前台和后台命令各带一个子进程，直接结束 runtime 进程，再重启 | Job 内进程全部被系统结束；重启后这些记录保持 unconfirmed，用户可解除；不自动重跑 |
| T13 / 第一批 | 构造三类前台/后台任务：可解除的旧 unconfirmed、当前后端仍在管理的 unconfirmed、正常完成；分别在 Web 侧栏和 TUI `/bg` 中操作 | 两端都列出前两类并用错误色说明行标出；只有第一类出现“放弃跟踪”，确认后不再阻塞文件工具、进程事实不被改写；第二类显示“需重启后解除”；只有这类任务时 `/bg` 也能打开；被阻塞的工具报错指向 `/bg` 或侧栏 |

## 执行入口与发布条件

- 现有定向入口：在仓库根运行 `pnpm exec vitest run packages/ohbaby-agent/src/shell-jobs/registry.unit.test.ts packages/ohbaby-agent/src/shell-jobs/cleanup.unit.test.ts packages/ohbaby-agent/src/shell-jobs/recovery.unit.test.ts packages/ohbaby-agent/src/tools/bash.unit.test.ts`。
- Job 封装的单元测试注入假的原生接口，覆盖 T11；真实生命周期用例补入 `packages/ohbaby-agent/src/shell/process.integration.test.ts` 及对应工具集成测试。Windows 必测场景不能再被平台 skip 或模拟探针代替。
- T06、T08、T09 使用实际 TUI/Web 操作或对应端到端测试；安装包用独立工作区，夹具与数据库自建，不改用户旧会话。
- 进程夹具记录自身 PID 并负责清理，测试超时也要收尾，不扫描和停止无关进程。T02 的 `Start-Process` 夹具必须自行结束它启动的进程。
- 第一批发布前：Windows x64 与 macOS 通过 T01–T07、T10–T13，覆盖项目最低 Node 24。第二批再扩到更大的 OS/CPU/解释器矩阵。

## 已有证据与空白

- 第一轮：148 项定向单测通过；C# helper 的 Job Object 实验 6 项、Registry 桥接 3 项、PowerShell 退出码 4 项通过。该 helper 只用于证明 Windows 能力，已不是选定方案。
- 第二轮：Koffi 进程内实验确认 spawn 后加入 Job 可行，自然退出时 Job 活跃进程为 0，TerminateJobObject 与 KILL_ON_JOB_CLOSE 有效；同时发现 `Start-Process` 和 .NET `Process.Start` 启动的后台进程不在 Job 里。详见 [实验记录](evidence-notes.md)。
- 两轮实验都在 SSH 会话中运行；`Start-Process` 等逃逸场景已由用户在普通 Windows Terminal 中复测，结果相同。第二轮用的是 koffi 2.9.0，选定的 3.1.1 在 Windows 上的安装与加载由 T10 证明。
- 第一批实施后（分支 `feat/windows-job-cleanup`，2026-11-15）：
  - macOS 本机：format、typecheck、lint（0 错误）、全量测试 8551 项通过。
  - Windows 实机（Node 25.6.0，pwsh 7.7.0，koffi 3.1.1，临时目录副本）：`windows-job.integration.test.ts` 的 2 项真实进程用例（自然退出 exit 7 后 Job 为空即确认；父进程退出、后代仍在时先报 running，终止 Job 后确认且后代已结束）及 shell、registry、bash、source-cleanup、query 共 7 个文件 174 项全部通过。
  - Windows 上 shell-jobs 的 registry/persistence/reader 三个真实进程集成测试文件，main 基线失败 19 项，本分支失败 18 项，失败集合相同（本分支多通过 1 项）。这些用例按 POSIX shell 编写，属于既有 Windows 测试缺口，不由本批引入，留待后续把用例改写为跨平台。
  - Web 背景任务集成测试在 Windows 的 Node 25 下因 `localStorage.clear is not a function` 全部失败，与本批无关（CI 用 Node 24）。
- 尚未完成：正式接入、真实 TUI/Web、macOS 回归、发布包、历史数据恢复和完整竞态验证。

验收审查重点：PID 复用导致误杀、Job 非空却误报已清理、断线误杀后台任务、原生依赖缺失后静默失真、runtime 被强杀后进程残留。分别用 T04/T06/T08/T11/T12 检查；平台保证不了的边界必须如实记录。最终结果在实施后另写 05。
