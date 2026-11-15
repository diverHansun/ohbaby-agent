# 详细调查与实验记录

本文保留调查过程中的日志、代码清单、阶段性建议和实验结果。过程中的“待确认”“后续文档”等表述是当时状态；当前决定见 [00](00-discussion.md)，简版分析与方案见 [本轮索引](README.md)。本文不作为独立实施契约。

日期：2026-11-15。状态：问题登记与逐项讨论中，尚未形成实施契约。

代码勘测基线：`6215c072b4402869ebfd3df6881e201c31411e52`。

## 文档与范围

本目录按 plan-code-improvement 流程记录本次 Windows 工具失效事件。用户要求先记录问题、逐项讨论规划，再实施。本阶段只建立索引、事实记录和已确认的协作边界；技术选型未获确认。

- [00-discussion.md](00-discussion.md)：用户已明确的协作边界。
- 后续 01：现状诊断，在问题与范围讨论后形成。
- 后续 02：优化方案与改动面，在技术取舍确认后形成。
- 后续 03：参考实现（如需要）。
- 后续 04：测试与验收契约，在目标行为确认后形成。

后续文档由谁撰写按用户后续安排执行，不提前代写完整设计。当前 README 是事件登记，不替代 01 的完整诊断或 02/04 的实施契约。

## 事件与证据

- 会话：`session_1794719094565_yskir81`。
- 导出：`C:\Users\Hansun2026\Downloads\ohbaby-20261115-131107-yskir81.jsonl`。
- 页面：`http://127.0.0.1:4096/#directory=C%3A%5CUsers%5CHansun2026&session=session_1794719094565_yskir81`。
- 数据库：`C:\Users\Hansun2026\AppData\Local\ohbaby\ohbaby.db`，只读查询 `shell_job`。
- 原会话版本 0.1.17；本机验证环境 Windows、Node 25.6.0。现有 CI 使用 Node 24，本轮未重复最低 Node 版本验证。
- 原会话根工作区为用户目录，实际待验仓库在 D 盘；所有文件工具被拦截不能归因于目标目录不存在。

### 数据库事实

| Job ID | 命令概要 | status | exit_code | ended_at-started_at |
| --- | --- | --- | --- | --- |
| 0a3bb276-67f6-47f5-90d8-d633d7f19327 | PowerShell 列 JSON | completed | 0 | 702 ms |
| 08b00efd-9fba-4b01-82ff-aaa6fd8180ce | PowerShell 搜索 model | completed | 0 | 755 ms |
| 6b67db7e-2423-4b2e-9a08-32b4fe607737 | Unix find 语法 | failed | 1 | 1102 ms |
| 4b6c8a4f-1ef4-423f-a05b-ed02cc3b2af8 | Unix grep 语法 | failed | 1 | 1783 ms |
| 5598492d-0e14-4005-9bd1-3b543b78591e | 错误的 Select-String 参数 | failed | 1 | 839 ms |

五行均为 foreground、cleanup=unconfirmed，settled_at/tracking_released_at/pgid/process_start_token/owner_start_token 为空；有 ended_at。重新启动 daemon 并打开原会话后再次查询，五行仍未解除清理状态。

### 最小复现

在独立进程中使用源码的 ShellJobRegistry、InMemoryShellJobStore、killTree 和 getSourceCleanupState；启动真实 Node 子进程，仅打印一行后自然退出；等待 close，再调用 stopForeground(rootRunId, "owner-ended")。

```text
natural_exit: status=completed, exitCode=0, cleanup=null,
              settledAt=null, sourceGuard=null, treeProbe=unknown
after_run_end: status=completed, exitCode=0, cleanup=unconfirmed,
               settledAt=null, sourceGuard=unconfirmed
dispose: Shell process cleanup is unconfirmed
```

复现使用内存存储，没有改写用户会话或数据库。临时探针位于 `%TEMP%/ohbaby-win-cleanup-probe.mts`，不是仓库正式测试；可能被临时目录清理。以上步骤为可重建证据。

### 已运行检查与限制

定向运行以下文件：shell/shell.unit.test.ts、core/tool-scheduler/source-cleanup.integration.test.ts，以及 tools 下的 read/edit/grep/glob.unit.test.ts。

结果：6 个文件通过；110 项通过，3 项跳过。不是全量 preflight，不代表原 Web 后台任务验收完成。原日志中没有 edit 实际失败调用；edit 被同类准入规则覆盖属于代码推断，其基础测试通过。

## 问题登记与建议讨论顺序

以下为调查结论或待验证项，不代表用户已批准方案或批次范围。

| 编号 | 问题与证据等级 | 代码锚点 | 待讨论事项 |
| --- | --- | --- | --- |
| W01 | 已复现：Windows 自然退出无法取得进程树清理确认，轮次结束后形成资源保护 | `shell/process.ts`：probeProcessTree、killTreeWithPlatform；`shell-jobs/registry.ts`：observeStopped、stopForeground、terminate；`adapters/ui-runtime/composition.ts`：currentRunInputs.close | 原生 Windows 支持目标、可靠进程归属实现、自然结束和终止的统一契约 |
| W02 | 已观察并有代码依据：旧任务清理状态跨 daemon 重启保留；Windows 进程出生身份能力不足 | `shell/process-identity.ts`：readProcessIdentity；`shell-jobs/recovery.ts`：groupState、identityDead、abandon | 新任务恢复能力、旧数据处理、放弃跟踪和确认清理的区别 |
| W03 | 已观察：根会话保护影响主代理和子代理；错误缺少具体阻塞任务与可执行恢复路径 | `core/tool-scheduler/source-cleanup.ts`：sourceKey、getSourceCleanupState；`core/tool-scheduler/scheduler.ts`：sourceSensitive、sourceWait | 保护粒度是否调整、错误证据、Web 恢复入口、阻止模型无效重试 |
| W04 | 已观察：模型对实际 pwsh 解释器输出 Unix 命令，并误用 PowerShell 参数 | `tools/bash.ts`：describe；`shell/detector.ts`、`shell/interpreters.ts` | PowerShell/Git Bash 支持边界、环境提示、真实命令评测 |
| W05 | 日志与源码交叉确认：内存 snapshot 缺少 endedAt，task 输出用当前时间回退，终态耗时继续增长 | `shell-jobs/registry.ts`：snapshot；`tools/task.ts`：elapsedMs 计算 | 运行耗时与清理等待展示、内存和持久记录字段一致性 |
| W06 | 已确认覆盖缺口：CI 有三平台矩阵，但真实进程组集成测试跳过 Windows，部分清理测试注入模拟探测结果 | `.github/workflows/ci.yml`；`shell/process.integration.test.ts`；`shell-jobs/cleanup.unit.test.ts` | 真实跨轮链路、正常/失败退出、子孙存活、取消/超时/重启、发布包验证 |
| X01 | 页面另有 `Invalid models[0].contextWindowTokens: undefined`；尚未定位配置问题根因 | 模型设置相关模块待定位 | 单独配置议题，不作为 Windows 清理故障根因 |

所有代码锚点除 CI 外相对于 `packages/ohbaby-agent/src/`。

## 既有约束与关联文档

- [Shell 目标职责](../../goals-duty.md)：保持原命令与解释器一致、不在失败后自动换解释器；现有契约不适配 WSL。
- [后台任务规划与验收](../../../tools/2026-11-13-background-tasks/README.md)：主代理当轮 Stop 与后台任务生命周期区分；不要求任务跨服务重启常驻；身份不确定时不贸然发信号；已有用户放弃跟踪机制。
- 上述为既有文档约束，不代表此次讨论不可修订。若修改，应明确记录并同步权威文档。

## 未决项

1. Windows/macOS 已确认为正式支持平台；具体 OS/架构和默认 shell 范围仍待讨论。
2. 已接受随包分发小型 Windows 原生组件；helper/原生扩展及具体交付形式仍待讨论。
3. daemon 异常退出时托管进程的目标行为，以及 Job Object 句柄/进程身份如何支撑恢复。
4. 历史 unconfirmed 任务的处置策略；不能从旧记录凭空证明子孙进程已结束。
5. 资源保护范围和诊断体验是否纳入同批；各项实施顺序待讨论。

Job Object 目前只是助手推荐调研的候选方向，并非已批准选型；未完成实现、打包或真实生命周期验证。

后续进展：第 2 项已由 00/D11 决定（Koffi 进程内调用），第 5 项的第一批范围见 00/D12；Job Object 的保证边界见 00/D10。

## TUI / Web / 未来 App 的边界勘测

本节是源码现状和后续讨论素材，不是已经批准的目标架构。D01/D02 的用户决定见 00。

### 实际执行入口

- 默认 TUI：`cli/commands/terminal.ts` 设置 inProcess=true，经 `bin.ts` 创建本地 CoreAPI host；`host/core-api-factory.ts` 创建持久 UI backend。
- 显式 remote TUI：同一 terminal 命令提供 remote-port，通过远程 CoreAPI host 连接 server。
- Web：`cli/commands/serve.ts` 调用 startDaemonServer；server 的 `runtime/daemon/main.ts` 为工作区创建持久 UI backend，浏览器通过 HTTP/事件订阅访问。
- 本地 TUI 和 daemon 最终共用 agent runtime、工具和 ShellJobRegistry。只在 daemon 加平台补丁无法覆盖默认本地 TUI。
- Web 的交互终端另走 server/terminal 下的 PTY 管理，与模型 bash 的管道执行路径不同。需要分别定义和验收生命周期；暂不要求强行合并两套执行器。

### 关联代码文件清单

下面路径相对于仓库根目录；“检查”不等于确认存在缺陷或必然需要修改。

| 层次 | 文件 | 当前职责 / 适配关注点 |
| --- | --- | --- |
| CLI 入口 | `packages/ohbaby-cli/src/bin.ts` | 选择本地/远程 CoreAPI host、装配 serve、打开浏览器；原生能力须能被本地 runtime 使用 |
| TUI 入口 | `packages/ohbaby-cli/src/cli/commands/terminal.ts` | 默认 inProcess，显式远程模式，TUI 卸载与 host.dispose |
| 一次性 CLI | `packages/ohbaby-cli/src/cli/commands/run.ts` | 同样使用本地 host；共享执行层改动的回归调用方 |
| CLI 退出 | `packages/ohbaby-cli/src/cli/host-shutdown.ts` | 信号、停止准入、十秒共享退出预算；终端窗口被强关另需实测 |
| Web 启动 | `packages/ohbaby-cli/src/cli/commands/serve.ts` | 服务 start/status/stop、浏览器打开、服务复用 |
| 本地 runtime 装配 | `packages/ohbaby-agent/src/host/core-api-factory.ts` | 本地 CoreAPI 接入持久 backend |
| daemon 装配 | `packages/ohbaby-server/src/runtime/daemon/main.ts` | 为工作区创建持久 backend、启动监督器和 HTTP 服务 |
| daemon 生命周期 | `packages/ohbaby-server/src/runtime/daemon/supervisor.ts`、`stop.ts`、`state-file.ts`、`pid-file.ts`（同目录） | 退出预算、身份、停止和落盘回执；进程退出与任务清理分开 |
| 共享 runtime | `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` | 注册 ShellJobRegistry、轮次关闭、停止与恢复接线 |
| runtime 退出 | `packages/ohbaby-agent/src/runtime/shutdown.ts` | 清理结果和期限汇总 |
| 命令工具 | `packages/ohbaby-agent/src/tools/bash.ts` | 命令准备、spawn、环境、前后台等待和生命周期交接 |
| 命令平台实现 | `packages/ohbaby-agent/src/shell/process.ts`、`process-identity.ts` | Windows 清理缺口、POSIX 进程组、出生身份；平台实现边界候选 |
| Shell 方言 | `packages/ohbaby-agent/src/shell/detector.ts`、`execution.ts`、`analysis/parser.ts`、`preflight.ts` | 解释器选择、argv、语法和路径分析；Windows/macOS 保留真实方言 |
| 任务生命周期 | `packages/ohbaby-agent/src/shell-jobs/registry.ts` | 正常完成/超时/停止、输出收尾、平台清理证据 |
| 持久化与恢复 | `packages/ohbaby-agent/src/shell-jobs/store.ts`、`recovery.ts`、`reader.ts` | 运行事实、旧任务恢复和身份、输出读取 |
| 准入保护 | `packages/ohbaby-agent/src/core/tool-scheduler/source-cleanup.ts`、`scheduler.ts` | 根会话清理保护、相关工具准入 |
| 文件工具 | `packages/ohbaby-agent/src/tools/read.ts`、`edit.ts`、`grep.ts`、`glob.ts` | 共享文件能力；验证路径与准入恢复，不按前端复制 |
| 路径规范 | `packages/ohbaby-agent/src/utils/path-canonicalize.ts`、`paths/ohbaby-home.ts`、`paths/session-storage.ts` | 盘符/大小写/工作区身份、配置与数据目录；需区分检查项和本次已证实根因 |
| task 表面 | `packages/ohbaby-agent/src/tools/task.ts` | 任务 list/output/stop；耗时与清理状态投影 |
| SDK 契约 | `packages/ohbaby-sdk/src/contract/shell-job.ts` | 跨 TUI/Web 的任务管理契约 |
| SDK 共享展示 | `packages/ohbaby-sdk/src/util/shell-job-view.ts`、`sync/shell-job-list-reader.ts` | 状态含义、列表读取和同步 |
| Web 任务接口 | `packages/ohbaby-server/src/protocols/web/routes/shell-jobs.ts` | 查询、停止、abandon；保护用户/会话归属 |
| Web 客户端 | `apps/ohbaby-web/src/api/daemon/client.ts`、`http.ts`（同目录） | 服务连接和请求；断开不应被误认成服务退出 |
| Web 任务界面 | `apps/ohbaby-web/src/ui/side-panel/background-tasks/BackgroundTasksPage.tsx`、`BackgroundTaskDetail.tsx`、`TaskCancelButton.tsx`（同目录） | 列表、详情、取消/恢复反馈 |
| TUI 任务界面 | `packages/ohbaby-cli/src/tui/components/background-tasks/background-task-browser.tsx`、`use-background-tasks.ts`、`task-lines.ts`（同目录） | 同一任务契约的终端呈现 |
| 交互终端 PTY | `packages/ohbaby-server/src/terminal/pty.ts` | Windows inspectChildren 返回 []；close 调用 native.kill 后等待终端退出。后代回收能力需真实验证 |
| 交互终端生命周期 | `packages/ohbaby-server/src/terminal/terminal-manager.ts`、`terminal-session.ts`、`shell-launch.ts` | 创建/关闭/重连、输出与交互 shell 环境 |
| PTY macOS 支撑 | `packages/ohbaby-server/src/terminal/process-tree.ts`、`macos-session.ts` | POSIX 进程身份与 session 查询；不可因修复 Windows 而回退 |
| npm 分发 | `packages/ohbaby-agent/package.json`、`packages/ohbaby-server/package.json`、`packages/ohbaby-cli/package.json` | 原生产物需进入真实发布包；组件形式后由 00/D11 选定为 Koffi |
| 构建资产 | `packages/ohbaby-agent/scripts/copy-shell-assets.mjs`、`packages/ohbaby-cli/scripts/copy-web-assets.mjs`、`packages/ohbaby-cli/tsup.config.ts` | 现有资产复制与构建；不能假设源码目录的 helper 在安装后仍可访问 |
| CI | `.github/workflows/ci.yml` | 已有三 OS 矩阵；补真实生命周期及发布包测试，保留 macOS 回归 |

### 新增检查项

- W07（代码观察，非泄漏实证）：Web 内嵌终端 Windows 子进程查询返回空列表，不能据此断言实际没有子进程；与 bash 独立验证。
- W08（分发规划项）：Windows helper 不能只在开发仓库可用；安装后的路径解析、CPU 架构、版本匹配、缺失/加载失败需设计。当前 package files 白名单不会自动纳入任意 exe。
- W09（入口生命周期规划项）：本地 TUI 退出、remote TUI 断开、浏览器关闭、serve 服务退出应区分；不得按“窗口关闭”统一结束全部任务。

### 建议边界（待用户确认）

- 共享 agent/任务/权限业务与 SDK 契约，平台分支集中在进程管理、路径及必要系统能力。
- Windows 新增原生托管实现；macOS 优先复用现有 POSIX 路径并用相同用户场景验收，尚不承诺两平台具有相同的 OS 级崩溃回收能力。
- TUI、Web、未来 App 可各自维护入口、窗口/终端、服务装配和分发；App 后续如何承载 runtime 单独决策。
- 现有 Linux 代码和 CI 不因本次 Windows/macOS 支持目标而删除；是否扩大正式支持承诺另行讨论。

## D03 后续议题：异常退出与恢复（待讨论）

客户端断开不停止后台任务已获用户确认，见 00/D03。以下仍为助手分析与建议，不是已批准的实施契约。

### 当前实现依据

- `runtime/shutdown.ts` 的 collectCleanup/withinShutdown 提供有截止时间的正常清理和结果汇总；不能仅凭有退出钩子就承诺强杀时也会执行。
- `shell-jobs/recovery.ts` 的 resultPatch 已区分任务 lost 与 cleanup confirmed/unconfirmed，保留已有 completed/failed 状态；应保留这两个维度。
- 同文件 matchesTarget 依赖 pid、pgid、processStartToken，当前不能直接承载 Windows Job Object 归属恢复。
- Windows 原生 Job Object 可使用 KILL_ON_JOB_CLOSE；触发条件是最后一个句柄关闭，并非任意拥有者进程退出。若 helper 持有句柄，必须另行设计 runtime 丢失后 helper 如何退出/回收、句柄继承如何限制。
- macOS 当前进程组信号实现可以执行组级停止，但源码中这条路径不构成 runtime 强杀后的独立监督能力。

### 推荐讨论的产品规则

1. 不把后台任务承诺为跨 runtime 重启常驻；崩溃后不自动重新执行原命令，避免重复副作用。
2. 正常退出须按预算停止与确认；异常退出尽量自动回收，并在重启后依据证据修复状态。
3. 进程已结束、命令是否成功、输出是否完整、是否放弃跟踪分别记录；无证据时不能互相推导。
4. 默认优先 Windows 原生托管 + macOS 既有进程组/身份恢复，公开两平台异常回收时效差异；若用户要求 macOS 在 runtime 强杀后且不重启也自动回收，再评估独立监督组件。
5. 旧版本 unconfirmed 记录与新托管任务分开恢复；新组件不能补出旧任务缺失的归属证据。

### 原始参考

- [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：组级管理、句柄关闭条件、继承例外及查询能力。
- [Apple kill(2) 文档](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html)：负 PID 的进程组信号语义。此文档只支撑信号语义，不证明崩溃时存在自动监督。

上述分阶段异常回收路线已按用户选择记为 00/D04（方案 A）；具体恢复动作尚待确认。

## W02 讨论补充：恢复入口与历史记录

### 新确认的代码事实

- Web `BackgroundTasksPage.tsx` 与 TUI `background-task-browser.tsx` 均以 mode=background 查询任务。
- Web `BackgroundTasksPage.integration.test.tsx` 明确断言前台清理异常不出现在后台任务列表中。本次五条阻塞记录都是 foreground，不能期望用户从该列表自然找到它们。
- SDK `contract/shell-job.ts` 与 server `protocols/web/routes/shell-jobs.ts` 已提供 abandonShellJob；当前所查 TUI/Web 后台任务界面未接入 abandon 操作。
- recovery.ts 的 abandon 要求原 owner 已退出、无本地活跃 handle、任务非 running、cleanup=unconfirmed，并通过条件更新写 trackingReleasedAt；不会把 cleanup 改为 confirmed。
- 以上为产品恢复路径缺口，不等于批准取消后台列表原有过滤规则。

### 推荐方案（待确认）

1. 启动/恢复相关 runtime 时进行有时间预算的检查；界面提供按需复查，不让模型轮询，也不让查询接口隐式发信号。
2. 确认任务归属且原 owner 已退出时，允许恢复流程停止遗留的受管进程；其他活跃 runtime 的任务保留只读和原 owner 管理边界。
3. 证据足够则自动确认清理；证据不足则保持 unconfirmed，列出具体阻塞任务与原因。不能根据父 PID 不存在就推断所有后代消失。
4. 会话提供“待处理的进程清理”入口，覆盖前台和后台异常，独立于日常后台任务列表。TUI/Web 复用同一后端判定。
5. 对满足条件的旧记录提供用户“解除阻塞并放弃跟踪”动作，说明不终止进程、不证明清理成功。可聚合本会话候选项供一次确认，服务端逐项复核并返回结果，不扩大到全局记录。
6. 模型只获得阻塞原因和引导，不获得自行放弃清理跟踪的权限；重启也不自动重新执行原命令。
7. 必须区分该入口与本轮实际操作：讨论期间不修改用户的五条历史任务记录。

上述恢复方案已获用户同意，见 00/D05。用户同时要求避免过度设计，异常入口优先复用现有任务详情和操作，不据此新增独立管理系统。

## 自动转后台核对与 W03 建议

核对提交 `8e104e6e`（前台自动转后台）、`793c0883`（转换结果与清理边界）及当前源码：

- 支持纯前台、显式后台及自动转后台。自动转换默认等待 120 秒，可配置或用 wait_ms 调整；角色须具备后台管理能力。
- registry.ts 的 waitForForeground/promote 更新原任务的模式；保留同一 job 和进程，不重新执行命令，不重置显式 timeout。
- Windows 托管应在进程最初启动时建立，三种执行方式共用；不能等转后台后才纳入托管，否则前台短命令仍会触发原故障。
- 本次五条旧命令在约 0.7～1.8 秒内退出，没有发生自动转后台；其清理异常仍需要用户可见。

W03 助手建议，待确认：本批保留现有清理保护规则，先修复正常退出被误记为不确定的问题，并补具体阻塞任务及恢复入口。暂不新增文件影响范围追踪，不单独设计一套只读绕过规则。真正无法确认清理时，仍按现有规则暂停相关根会话的文件工具；已确认的用户放弃跟踪提供恢复路径。

以上 W03 建议已获用户确认，见 00/D07。

## 剩余讨论清单

### W04：默认 shell（助手建议，待确认）

- 沿用 detector.ts：未配置显式受支持的 SHELL 时，Windows 优先 pwsh，再使用 Windows PowerShell；macOS 默认 /bin/zsh。
- 保留现有受支持解释器的显式选择；Git Bash 作为用户选择，不要求用户安装 WSL 或 Git Bash 才能使用基础能力。具体正式验收的解释器范围仍须确定。
- 保留 bash 工具名和当前参数，避免修改历史消息与调用接口；在模型环境提示和工具描述中清楚说明实际解释器及版本。
- 命令准备、权限检查和执行使用同一个解释器；执行失败后不自动切换 shell。
- Windows PowerShell 与 pwsh 分别验证中文输出、引号及常见命令；不得把一种 PowerShell 的测试结果当作另一种通过。

### 后续范围

- 原生组件：是否采用及具体形式仍待确认；如采用，应随安装包交付，避免要求用户现场编译。支持的 OS 与 CPU 架构待定。
- 现有缺陷：修复任务耗时字段；验证中文/空格路径、跨盘符、输出编码和换行。将已证实缺陷与检查项分开，不预设需要重写路径层。
- 验收：两平台的本地 TUI、Web，以及已有 remote TUI；覆盖短命令、失败退出、显式后台、自动转后台、超时、取消、退出及恢复。Web PTY 另验，发布包安装后也要验。
- 当前模型 contextWindowTokens 报错是独立配置问题，不扩入 Windows 进程适配的根因修复。

## Windows 可行性实验（2026-11-15，已运行）

用户要求先测试方案，不急于实施。本节记录临时验证结果，不代表产品已经修复或通过端到端验收。

环境：当前 Windows 主机，Node 25.6.0，已有 .NET SDK 8.0.421。临时 C# helper 用 P/Invoke 调用 Job Object API，仅用于证明 Windows 能力，不代表选定 C#/.NET 为发布方案。首次 dotnet build 输出提示初始化了本机开发证书；本实验没有使用 HTTPS 或证书，也未执行信任操作。

生产源码、用户数据库和旧会话记录均未修改。探针在临时目录运行，Registry 实验使用内存存储。

### 对照实验

重跑此前未改动源码的自然退出探针：exitCode=0、status=completed；stopForeground(owner-ended) 后 cleanup=unconfirmed、sourceGuard=unconfirmed；dispose 报 Shell process cleanup is unconfirmed。原问题仍可复现。

### 底层 Job Object：6 个场景通过

创建独立 Job Object，设置 KILL_ON_JOB_CLOSE，以 suspended 模式创建进程，加入 Job 后恢复运行；查询 ActiveProcesses，不以父进程退出代替整组清理证据。

| 场景 | 观察结果 |
| --- | --- |
| 正常退出 | 退出码 0，ActiveProcesses 归零 |
| 失败退出 | 保留退出码 7，ActiveProcesses 归零 |
| 取消父子进程 | 实际调用 TerminateJobObject，组内进程归零 |
| 父进程先退出 | 确认父进程 exitCode=0 后子进程仍活着，再取消，组内进程归零 |
| 硬超时 | 到实验截止时间后终止整组，进程归零 |
| helper 被强制终止 | 观察记录中的父子进程均退出 |

最终原始结果：[results.json](evidence/results.json)。测试夹具路径包含中文和空格，这只验证该启动路径，不代表全部路径/输出编码场景通过。

首次探针对累计进程数写死为 2，导致父进程先退出场景等待超时。第二轮去掉精确数量假设后发现该夹具未充分证明“遗留子进程仍活着时执行了取消”。最终改用 detached 子进程，并增加父进程退出后再次检查子进程存活及 stop-requested 事件的断言，6 项通过。保留 [首次结果](evidence/results-attempt1.json) 和 [中间结果](evidence/results-attempt2.json)，中间结果不作为最终取消场景证据。额外进程来源未定位，实验不依赖其固定数量。

### 临时接入现有 Registry：3 个场景通过

使用现有 ShellJobRegistry 的 probeTree/killTree 注入点，将临时 helper 的整组归零证据提供给 Registry。helper 是 Registry 启动的 ChildProcess；此桥接不等于生产 bash 已完成适配，也未实现真实命令输出转发协议。

| 场景 | 结果 |
| --- | --- |
| 前台正常退出，再结束本轮 | completed、cleanup=confirmed，无 sourceGuard |
| 显式后台正常退出 | completed、cleanup=confirmed，无 sourceGuard |
| 100 ms 后自动转后台，1200 ms 原硬截止 | converted、timed_out、cleanup=confirmed，无 sourceGuard；实测退出耗时 1269 ms，含终止收尾 |

三项均只启动一次 helper，保留同一 job、helper PID 和原截止时间。原始结果：[registry-results.json](evidence/registry-results.json)。

### 真实 PowerShell 启动：4 个场景通过

分别通过 Job Object 托管 pwsh.exe、powershell.exe，执行短暂等待后 exit 0/exit 7。四项均保留预期退出码并确认组内进程归零。原始结果：[shell-results.json](evidence/shell-results.json)。未在此实验捕获命令 stdout/stderr，因此不宣称验证中文输出。

### 项目已有回归

运行 shell-jobs/registry.unit.test.ts、cleanup.unit.test.ts、recovery.unit.test.ts 和 tools/bash.unit.test.ts：4 个文件通过，148 项通过，0 项失败，0 项跳过。包含模拟测试，不能替代上述真实进程实验或正式端到端验收。

### 结论与剩余边界

- Job Object 能为这次故障提供缺失的清理证据；临时桥接可沿用 Registry 的前后台和自动转换逻辑，不必重写任务体系。
- 原项目仍存在原故障；目前没有把 helper 接入正式 bash、TUI 或 Web。
- 强杀 helper 后的进程回收已测；runtime 消失而 helper 尚存的情况未实现监督协议，也未验证。
- macOS、安装包分发、历史数据库恢复、Web/TUI 实际操作、PTY、真实输出转发与编码、启动/取消竞态均未在本次可行性实验中完成验证。
- 临时源码位置：`C:/Users/HANSUN~1/AppData/Local/Temp/ohbaby-win-job-probe-ba10062bc42443a59c5c15c5d3fd1522/`，含 Program.cs、Probe.csproj、run.mjs、registry-probe.mts 和中文路径夹具。临时目录可能被系统清理，原始结果已保存在本文 evidence 目录。

## 本地参考项目对照（2026-11-15）

用户要求参考现有 coding agent，避免扩建 OS 层。本节只依据本地检出代码，不代表上游最新状态；没有安装参考项目依赖或运行它们的测试。下列行号是本次阅读快照。参考仓库均位于 `D:/Projects/code-cli/`。

| 项目 | 本地 HEAD | 本轮查看的执行路径 |
| --- | --- | --- |
| kimi-code | `f082f04a093a3e71a2263c5461d52507dc31f83a` | agent-core-v2 的 Node 本地进程服务与 Bash 工具 |
| opencode | `d432a06b9c07bab0be4e8d642173b1cb14137f11` | Node spawner、Shell 与 Rust process-daemon |
| ZCode | `fec975905a2abd4c07e35c40d51fa097a2258ec9` | CLI Bash 执行 adapter、shell 选择与 MCP stdio |
| deepseek-harness（dsh） | `39163dd30f703a79079e2d2446545cff3c453738` | subprocess-local、Win32 进程调用与 PowerShell 选择 |

### kimi-code：较轻的 Node 进程路径

- `kimi-code/packages/agent-core-v2/src/os/backends/node-local/hostProcessService.ts:139`：用直接子进程的 `exit` 提供退出码；Windows `kill()` 调用 `taskkill /T /F`，等待最多 5 秒。非 Windows 向进程组发信号。
- 该路径没有提供 Job Object 整组归零证明；taskkill 结束或报错都会结束其等待，不能把这一行为解释为严格确认整棵树已清空。
- `kimi-code/packages/agent-core-v2/src/agent/tools/os/bash/bashTool.ts:95`：有前台超时自动转后台选项。可借鉴保留同一任务的思路，但不能照搬其 timeout 语义，ohbaby 已区分前台等待时间和硬截止时间。

### OpenCode：轻量路径和原生进程服务并存

- `opencode/packages/util/src/cross-spawn-spawner.ts:384`：分别观察 `exit` 与 `close`；直接进程退出后对输出收尾设置等待边界。Windows 停止使用 taskkill，非 Windows 使用进程组信号。
- `opencode/packages/core/src/shell.ts:145`：本地命令在进程 daemon 可用时走 daemon，以支持计划内 server 重启后接管；远程或 daemon 不可用时保留直接 spawn。
- `opencode/packages/process-daemon/src/service/pipe/windows.rs:1`：Windows 命令放入 kill-on-close Job，停止使用 `TerminateJobObject`。因此不能将这个检出版本概括成“OpenCode 只用 taskkill”。
- `opencode/packages/core/src/shell.ts:435`：其命令完成语义允许成功命令留下后台进程。这与 ohbaby 当前的清理保护约定存在差别，不能直接移植其完成判定。
- 可借鉴进程适配集中、输出等待有上限；本轮不引入它的跨 server 重启进程接管服务。

### ZCode：Bash 与 MCP 分别选择清理强度

- `ZCode/apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-process.ts:145` 附近：Windows Bash/普通执行停止使用 taskkill；macOS 等 POSIX 路径使用进程组，Bash 还处理跨组后代。
- `ZCode/apps/zcode-cli/packages/adapters/src/exec/node-execution-adapter-run.ts:250`：取消会尝试结束执行；对于管道输出，最终释放自己持有的读取端，避免未知后代一直拖住 CLI。源码明确承认 taskkill/PGID 可能无法再寻址脱离的后代。此做法不能作为后代全部退出的证明。
- 等待上限不能概括到整个 shutdown：Bash 直接写输出文件，主要按根进程结果结算；普通管道 drain 存在保留执行后继续等待 close 的选项。`node-execution-adapter-base.ts:260` 的 shutdown 还会等待已登记的 taskkill completion，此处未见独立超时。
- `ZCode/apps/zcode-cli/packages/adapters/src/mcp/windows-job-object.ts:27` 与 `mcp/stdio-transport.ts:89`：MCP stdio 服务另外尝试通过 Koffi 使用 Job Object，失败保留 taskkill 回退；这不是普通 Bash 的启动实现。
- `ZCode/apps/zcode-cli/packages/adapters/src/exec/bash-shell-provider.ts:158`：Windows 自动选择优先 Git Bash，无可用 Git Bash 时返回 legacy system shell 路径；macOS 等 POSIX 选择 bash/zsh。ohbaby 已有 PowerShell 默认，不因参考此项目就改变默认。
- 值得借鉴的是按实际用途选择能力，不把 MCP、普通命令和交互终端硬塞成一套同等保证。

### dsh：普通 Windows 命令使用 Job，macOS 不强求同等托管

- 根 `package.json` 名为 `@deepseek-ai/dsh-root`，确认本地 deepseek-harness 即本轮 dsh 参考。
- `deepseek-harness/packages/subprocess/subprocess-local/src/index.ts:210`：普通命令在 Windows Job 能力可用时启动私有 runner，否则走较弱 fallback。`index.ts:265` 明确 Windows 普通命令、ConPTY、macOS 的能力不同；macOS 不具备该持久进程范围 owner，保留较弱进程树清理并记录限制。
- `deepseek-harness/packages/subprocess/subprocess-local/src/spawn-runner.ts:353`：分别报告直接进程退出码与 Job 是否清空。父进程退出不会立即丢掉仍有后代的 Job。
- `deepseek-harness/packages/subprocess/win32-process/src/process.ts:554`：挂起创建、加入 Job、恢复运行；底层通过 Koffi 调用 Win32。这个实现说明原生能力不必等于自建独立 Rust/C# 服务，但并不据此选定 ohbaby 的依赖或发布方式。
- `spawn-runner.ts:272`：runner 与父 runtime 的 IPC 断开后释放 Job；这是实际执行所有者退出的处理，不能绑定成浏览器断线就杀任务。
- `deepseek-harness/packages/shell/pwsh-local/src/resolve.ts:19`：PowerShell 7 安装位置、PATH、Windows PowerShell 5.1 兜底，与 ohbaby 的原生 Windows shell 方向接近。
- 可借鉴 Windows 小范围补能力、macOS 保留现有机制；不复制 dsh 的 Linux scope、沙箱、插件体系和整个 subprocess 服务。

### 对 ohbaby 的收敛建议（待讨论确认）

1. 保留 `ShellJobRegistry`、前台/显式后台/自动转后台及既有硬截止时间。TUI 和 Web 通过现有 runtime 共用它们；不新增独立进程 daemon。
2. 如维持 D07 的严格清理保护，优先在 Windows 进程启动与清理边界评估最小 Job Object 适配。它只负责自己启动的命令及后代，不做全机进程治理。macOS 保留现有进程组方案。
3. 可以选择更轻的 taskkill 路径，但必须承认它不能证明父进程已退出后的所有后代均消失。若据此直接解除保护，属于调整 D07 的语义，不能伪装成同等保证的修复。
4. 继续修复已有状态和界面问题：正常退出被误判、耗时不冻结、前台阻塞任务不可见、用户无法使用已有恢复能力。这些不需要新建 OS 层。
5. read/edit/glob/grep 先排除已确认的清理保护连带阻塞，再按中文/空格路径、盘符、输出编码、CRLF 和安装包依赖逐项验收，不先重写所有工具。

本轮结论是缩小实现范围，并非批准生产实现。上次 Job Object 实验只证明能力可用，当前参考阅读只证明这些代码路径存在；两者都不代表 ohbaby 的真实 TUI/Web 已通过验收。

## Koffi 进程内 Job 实验（2026-11-15，第二轮）

本节由第二轮评审在同一台 Windows 主机上完成，目的是验证 D11 的做法，并检查第一轮实验没有覆盖的后台启动方式。只用临时目录，没有修改项目源码、用户数据库或旧会话记录。

### 环境与方法

- Windows（内核版本 10.0.26300）x64，Node 25.6.0，pwsh 7.7.0，koffi 2.9.0（临时安装，仅用于实验）。
- 主要实验通过 SSH 运行。运行实验的 node 进程本身已在 sshd 的 Job 里，该 Job 的标志为 `0x2800`（BREAKAWAY_OK 与 KILL_ON_JOB_CLOSE）。后台启动方式的实验另由用户在普通 Windows Terminal 中复测。
- 做法与 ohbaby 的真实路径一致：Node 正常 `spawn` pwsh（非 detached，stdout/stderr 为管道），随后立即用 Koffi 调用 CreateJobObjectW、SetInformationJobObject（KILL_ON_JOB_CLOSE）、OpenProcess、AssignProcessToJobObject。用 QueryInformationJobObject 读取活跃进程数，用 IsProcessInJob 检查后台进程是否在 Job 里。
- 脚本位于 `%TEMP%\ohbaby-koffi-probe\`：`probe.mjs`（基础场景）、`probe2.mjs`（后台启动方式）、`probe4.mjs`（detached 对照）。临时目录可能被系统清理，结果以本节为准。

### 结果

| 场景 | 观察结果 |
| --- | --- |
| pwsh `exit 0` | 退出码 0，中文输出正确；`exit` 事件时 Job 活跃进程为 0，`close` 同时到达 |
| pwsh `exit 7` | 退出码 7；`exit` 时 Job 活跃进程为 0 |
| 父进程退出，Node detached 子进程继续运行 | 父进程退出时 Job 仍有 1 个活跃进程；TerminateJobObject 后归零，子进程已结束 |
| 关闭 Job 句柄（模拟 runtime 被强杀） | Job 内子进程被系统结束 |
| pwsh `Start-Process -WindowStyle Hidden` | 后台进程不在 Job 里；Job 活跃进程为 0；TerminateJobObject 后进程仍在运行 |
| pwsh `Start-Process -NoNewWindow` | 同上；该进程继承了输出管道，`close` 推迟到它结束后才到达 |
| .NET `[System.Diagnostics.Process]::Start`（UseShellExecute=false） | 同上，不在 Job 里 |

从 spawn 前到加入 Job 完成，耗时 5～120 ms，主要是 Windows 创建进程本身的开销；加入 Job 只是 spawn 返回后的一次同步调用。pwsh 从启动到执行用户命令约需 400 ms，实验中没有观察到命令在加入 Job 之前就派生子进程。

### 未定位的部分

- 后台进程为何不在 Job 里尚未定位。本实验创建的 Job 没有设置 BREAKAWAY_OK。外层 sshd Job 已由普通终端复测排除（见下）；剩下的候选是 libuv 为非 detached 子进程建立的全局 Job 影响了后代的归属，或 PowerShell/.NET 启动进程时自行请求脱离 Job。
- 尝试用 detached 方式启动 pwsh 做对照，但 detached 的 pwsh 没有执行命令（连 pid 文件都没写出），无法据此区分。
- 普通终端复测（用户执行 `cd $env:TEMP\ohbaby-koffi-probe; node probe2.mjs`）：`Start-Process -WindowStyle Hidden`、`Start-Process -NoNewWindow`、.NET `Process.Start` 三种方式启动的后台进程都不在 Job 里，TerminateJobObject 后仍在运行，与 SSH 下结果一致；`-NoNewWindow` 的 `close` 同样推迟到后台进程结束后才到达。
- 结论：逃逸与 SSH 环境无关。D10 的保证边界成立，dsh 的 `packages/subprocess/subprocess-local/README.md` 也明确把 breakaway 进程排除在保证之外。

### 与第一轮实验的关系

第一轮的 C# helper 实验以挂起方式启动，用 Node detached 子进程模拟后代；这种后代留在 Job 里，所以没有暴露 `Start-Process` 的逃逸问题。两轮结论合起来是：Job 能覆盖普通后代，覆盖不了主动脱离的后台进程。

## 参考补充：codex 与 Koffi 打包（2026-11-15，第二轮）

本地检出：codex `b016cd18472588606c04af565528c4cd6746a41f`；其余参考项目的 HEAD 与上文相同。

### codex 的 Windows Job 用法

- `codex-rs/utils/pty/src/pipe.rs:185`：命令执行路径先正常 spawn，再用子进程句柄把它加入 Job（不按 PID 重新打开）。注释写明接受这段小窗口，窗口内派生的后代可能逃出 Job；加入失败时退回只结束单个进程。
- `codex-rs/utils/pty/src/win/job.rs:72`：默认 Job 同时设置 KILL_ON_JOB_CLOSE 与 BREAKAWAY_OK；`create_without_breakaway()` 只用于 MCP 客户端、plugin-host、http-headers-helper 这几类需要严格托管的进程。
- `pipe.rs:261`、`win/mod.rs:76`：根进程正常退出后调用 `preserve_descendants()`，关闭 kill-on-close，让后台后代继续运行。codex 的 Job 只用于取消与超时，不作为清理证明。
- ohbaby 的 D07 要求清理证明，所以借鉴 attach-after-spawn 和失败回退的结构，不借鉴 BREAKAWAY_OK 与 `preserve_descendants`。

### Koffi 打包事实

- ZCode 使用 koffi 2.15.6，单个 npm 包内含全部平台二进制，解压后约 41 MB。
- dsh 使用 koffi 3.1.1：主包约 1.8 MB，各平台二进制拆成 `@koromix/koffi-win32-x64` 等可选依赖；npm 显示 win32-x64 包解压后约 1 MB（未下载核实）。
- koffi 3.1.1 带 install 脚本（`cnoke --prebuild`）：优先使用平台预编译包，加载失败时会尝试从源码编译。用户机器上一般走预编译包，但安装链路要在 T10 中验证。pnpm 10 默认拦截依赖的构建脚本，仓库若升级 pnpm，需要在 `pnpm-workspace.yaml` 的 `allowBuilds` 中放行 koffi（当前为 pnpm 9.15，已有 esbuild 一项）。
- ohbaby 已有按平台拆分的原生依赖：`packages/ohbaby-server` 的 `@lydell/node-pty`，但它没有 install 脚本，安装方式与 koffi 不完全相同。`packages/ohbaby-agent` 的 tsup 默认不打包 dependencies，Koffi 会作为普通依赖安装。
- 第二轮实验用的是 koffi 2.9.0，koffi 3.x 在 Windows 上的加载与安装只能由 T10 证明。
- dsh `subprocess-local/src/index.ts:250` 在 Job 能力不可用时退回较弱路径并只告警一次。ohbaby 的失败行为按 00/D13 处理，不沿用“退回后照常确认”。

