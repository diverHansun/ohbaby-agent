# 02 · 简版方案与改动范围

状态：选型已确认（00/D10–D14），第一批已在分支 `feat/windows-job-cleanup` 实施，待 Windows 实机验证。实施中的调整见文末。依据 [00](00-discussion.md)、[01](01-problem-analysis-and-current-state.md) 与 [参考对照](03-reference-projects.md)。

## 方案边界

复用现有 runtime、ShellJobRegistry 和 SDK。Windows 的清理证据集中在进程执行边界；macOS 保留进程组与身份检查。任务跟随实际运行它的 runtime，浏览器和 remote TUI 断开不停止后台任务。

Windows 的做法（D11）：

1. `tools/bash.ts` 照常用 Node `spawn` 启动解释器。spawn 返回后立即用 Koffi 新建 Job（设置 KILL_ON_JOB_CLOSE，不设置 BREAKAWAY_OK），按 PID 打开子进程并加入 Job。
2. Koffi 在第一次需要时用 `createRequire` 同步加载，因为现有 spawn 与登记流程是同步的。spawn 本身失败、拿不到 PID（如解释器不存在）时，仍按现有规则记为启动失败，不算原生能力不可用。
3. Job 按 ChildProcess 保存，与 `shell/process.ts` 里按 ChildProcess 记录终止尝试的方式一致。只有 bash 的命令进程有 Job；没有 Job 的子进程（如 `tools/utils/ripgrep-search.ts`、`ripgrep-files.ts` 启动的 rg）在 Windows 上保持现有处理。
4. 判断是否已清理：Job 活跃进程数为 0 即 stopped，大于 0 即 running。自然退出时由现有 `exit`/`close` 回调触发判断，不再依赖“taskkill 成功过”。
5. 取消、超时和轮次结束：调用 TerminateJobObject，再在现有观察预算内等待活跃进程归零。
6. `shell/process.ts` 第一次读到活跃进程为 0 时就关闭 Job 句柄：不允许 breakaway 的 Job 清空后不会再有进程加入，之后的判断直接返回 stopped。Job 非空时不关闭，因为关闭会结束其中的进程。runtime 退出时句柄随进程关闭，由系统结束 Job 内剩余进程，符合 D03“任务跟随 runtime”。

保证边界（D10）：Windows 的 confirmed 只表示 Job 已空。`Start-Process` 等方式启动、脱离 Job 的进程不在保证范围，与 macOS 上 `setsid` 脱离进程组同级。

原生能力不可用（D13）：Koffi 加载、建 Job 或加入 Job 失败时，任务记为 unconfirmed 并在报错和日志中写明原因；不以父进程退出作为证据。现有 abandon 只能解除原 runtime 已退出的任务，所以这类任务要在重启 runtime 后才能由用户解除（00/D13，用户已确认）。

不做：C#/.NET helper、独立进程服务、挂起启动、保留后代模式、通用 OS 抽象层。

## 建议阶段与完成条件

| 阶段 | 改动目标 | 完成条件 |
| --- | --- | --- |
| 第一批（D12） | Koffi Job 接入；终态耗时冻结；解释器提示；报错写明阻塞原因并接通用户解除入口；最小安装包验证与强杀检查 | 自然退出和失败退出不再误阻塞；取消、超时、自动转后台结果正确；旧阻塞记录可见、可由用户解除；Windows x64 安装包可用，macOS 无回归。对应 04 的 T01–T07、T10–T13 |
| 第二批 | Windows 新任务的重启恢复接线；入口生命周期（W09）；更大的 OS/CPU/解释器矩阵 | 对应 04 的 T08，以及第二批确认后补充的场景 |
| 另开议题 | Web PTY（W07） | 先做真实验证，有泄漏证据再立项 |

## 关键改动清单（第一批）

下表 agent 内路径相对于 `packages/ohbaby-agent/src/`，其余标明仓库根路径。检查项不等于必改。

| 类型 | 文件 / 符号 | 拟改内容 |
| --- | --- | --- |
| 新增 | `shell/windows-job.ts` | 用 Koffi 封装 Job 的创建、加入、活跃进程数查询、终止、关闭；只在 win32 同步加载；失败时返回原因，不抛到调用方 |
| 核心 | `shell/process.ts`：`probeProcessTree`、`killTreeWithPlatform` | 有 Job 的子进程改用 Job 证据，读到 0 即关闭句柄；没有 Job 的子进程保持现有逻辑；`KillTreeResult.reason` 增加原生能力不可用；保留“进程退出后不按旧 PID 发 taskkill”的规则 |
| 核心 | `tools/bash.ts`：spawn 处（约 362 行） | spawn 后立即加入 Job；前台、显式后台、自动转后台共用这一处，不另造执行器 |
| 核心 | `shell-jobs/registry.ts`：`markUnconfirmed`、`snapshot` | `markUnconfirmed` 带上原因并保存在内存任务上，供报错和快照读取，第一批不新增持久字段；内存快照带上 endedAt（W05）。`terminate()` 对 confirmed 已直接返回，不需要改 |
| 提示 | `core/system-prompt/layers/environment.ts`、`tools/bash.ts`：工具描述（约 188 行） | 写明实际检测到的解释器（可能是 PowerShell，也可能是用户配置的 Git Bash）；解释器是 PowerShell 时，提示长期运行的进程用 bash 的后台模式，不要用 `Start-Process` |
| 诊断 | `core/tool-scheduler/source-cleanup.ts`、`core/tool-scheduler/scheduler.ts` | 保护规则不变（D07）；报错中写明阻塞的任务、原因，以及能否立即解除或需要重启后解除 |
| 用户入口（Web） | 仓库根 `apps/ohbaby-web/src/ui/side-panel/background-tasks/`：`BackgroundTasksPage.tsx`、`BackgroundTaskDetail.tsx`、`TaskCancelButton.tsx` | 按 00/D14：列表查询不再限定 `mode: "background"`，带上清理未确认的前台任务并用错误色说明行标出；可解除的任务提供“放弃跟踪”，复用取消按钮的确认方式；当前后端仍在管理的给出“需重启后解除”说明 |
| 用户入口（TUI） | 仓库根 `packages/ohbaby-cli/src/tui/components/background-tasks/`：`background-task-browser.tsx`、`use-background-tasks.ts`、`task-lines.ts`；`packages/ohbaby-cli/src/tui/app.tsx`（`/bg` 的存在性判断） | 与 Web 相同的列表与操作；放弃跟踪用 `y` 在 5 秒内确认，与现有取消一致；只有清理未确认的任务时 `/bg` 也能打开 |
| 依赖 | 仓库根 `packages/ohbaby-agent/package.json`、`pnpm-workspace.yaml` | 新增 koffi，锁定 3.1.1；koffi 带 install 脚本，若升级到 pnpm 10，需在 `allowBuilds` 中放行 |
| 回归 | `tools/utils/ripgrep-search.ts`、`tools/utils/ripgrep-files.ts`、`tools/builtin.ts`、`shell/index.ts` | 不改；验证 grep/glob 取消时行为不变 |
| CI | 仓库根 `.github/workflows/ci.yml` | Windows 跑真实生命周期用例，不再用模拟探针代替；保留 macOS/Linux 回归 |

现有终态耗时：`tools/task.ts` 已优先使用 endedAt，缺口只在 registry 的内存快照，不需要改 task.ts。

连带接线：SDK `contract/shell-job.ts` 已有 `unconfirmedCount`、`managedByCurrentBackend` 和 `abandonShellJob`，server `protocols/web/routes/shell-jobs.ts` 与 RPC 已接通 abandon。列表筛选需要一个新取值，见文末“实施中的调整”。

权威文档需同步：`docs/shell/architecture.md`、`docs/shell/dfd-interface.md`、`docs/shell/test.md`；前端的 `docs/ohbaby-web/background-tasks/` 与 `docs/ohbaby-cli/background-tasks/` 两组文档（各自的 00、01、03、04、06、08）中“放弃追踪不做”“只列后台任务”的约定按 00/D14 修改。历史验收记录（09）不回写。

## 第二批待讨论项

- **Windows 新任务的重启恢复。** 用 Job 托管的任务，原 runtime 退出时系统已结束 Job 内进程。若持久记录标明“由 Job 托管”，且能确认原 runtime 已退出，恢复时可按 D10 的边界判定已清理。难点在于 Windows 上虽然记录了 owner PID，但没有进程启动标识，无法排除 PID 已被别的进程复用。在此之前，这类记录在重启后保持 unconfirmed，由用户解除。
- **旧记录。** 第一批之前留下的 unconfirmed 记录没有 Job 证据，只能由用户解除（D05），不批量改为 confirmed。

## 兼容与风险

- **逃逸进程。** `Start-Process` 等方式启动的后台进程不受 Job 管理（D10）。用提示引导模型使用 bash 的后台模式，并在文档中写明边界，不承诺回收。
- **嵌套 Job。** runtime 可能已在终端、sshd 或 libuv 的 Job 里。实验在 sshd Job 内加入成功；Windows 8 起支持嵌套 Job。
- **PID 复用。** 加入 Job 时按 PID 打开进程。此时 Node（libuv）仍持有该进程的句柄，Windows 在句柄关闭前不会复用这个 PID。
- **加入前的窗口。** 接受 spawn 与加入之间的极短窗口（codex 同样接受）。pwsh 启动约需 400 ms 才执行用户命令。
- **原生依赖缺失。** 按 D13 如实报告。因为失败时每条命令都会进入 unconfirmed，且运行中无法解除，安装包验证必须覆盖“平台包存在且能加载”。
- **工具协议与数据。** bash/task 工具协议不变；第一批不新增持久字段。重启不重跑原命令。
- **回退。** 出现回归时回退整个适配版本，保留旧数据和输出；回退不等于 Windows 故障已解决。

## 实施中的调整（第一批）

以下几处与上文计划不同，原因都是实施时核对代码后找到了更简单或更准确的做法。

- **列表筛选新增 `mode: "background-or-unconfirmed"`。** 原计划“不传 mode”。核对后发现不传时还会带上刚结束、尚未收尾的普通前台命令，会在列表里一闪而过。新取值只多带“清理未确认且尚未放弃追踪”的前台任务。改动在 SDK `contract/shell-job.ts`、`sync/shell-job-list-reader.ts` 与 agent `shell-jobs/reader.ts`、`shell-jobs/query.ts`（内存与 SQLite 一致）；server 路由原样透传，不用改。
- **Web 客户端补 `abandonShellJob`。** `apps/ohbaby-web/src/api/daemon/client.ts`、`http.ts` 原先只实现了 stop，现按同样方式补上 abandon。
- **解释器提示只放在 bash 工具描述里。** 工具描述本来就写明解释器路径，只在 PowerShell 下追加一句方言与 `Start-Process` 提示；`core/system-prompt/layers/environment.ts` 不改。
- **原因不单独写日志。** 项目的诊断日志要先定义事件，成本偏高。未确认的原因记在任务快照的 `cleanupReason`，被阻塞的工具报错列出阻塞任务并指向 `/bg` 与 Web 侧栏。00/D13 中“记录一次明确日志”以此代替。
- **Web 的确认方式。** Web 原有的取消没有二次确认，Stop tracking 采用“点一次进入确认、5 秒内再点一次执行”，与 TUI 的 `y` 确认时限一致。
- **被阻塞时的报错**由 `core/tool-scheduler/source-cleanup.ts` 的 `SourceCleanupUnavailableError` 给出，清理记录带上 jobId，以便列出阻塞任务。

验收标准见 [04](04-test-and-acceptance.md)。
