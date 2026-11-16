# 05 · Windows 实机实施验收

## 范围与结论

验收日期：2026-11-16。分支：`feat/windows-job-cleanup`。原实现为 `6215c072..b057a770`，本轮在 `b057a770` 上审查、补修并测试。远端获取后确认仍为同一基线；未合并。补修提交：`d94ef201`（后端与诊断）、`6c8e9daa`（详情状态）、`e2aa571d`（请求与安装包测试）。

**部分通过：Windows 核心命令链及 Web 请求已验证；完整双平台发布矩阵尚未完成。** 本机为 Windows x64，Node 25.6.0，并使用 Node 24.22.3 复测关键测试。macOS 本轮无法实机复测；04 中的 macOS 结果属于原实施记录，不能替代本轮修改后的回归。

## 对照方案与实际改动

| 规划项 | 实际结果与差异 |
| --- | --- |
| Koffi 进程内 Job，保留 Node spawn | 已接入。修正首次调用时的加载顺序：先加载原生库，再 spawn 并立即加入 Job；仍接受 D11 的短暂窗口，没有增加挂起创建或 helper 服务。 |
| Job 为空才能确认清理 | 正常退出、非零退出、硬超时均验证。补修原生接管失败后的路径：taskkill 只尽力终止，不能把 native-unavailable 升级为 confirmed。 |
| 前台转后台 | 实测只启动一次、job/PID 不变、原硬截止不变；主 run 结束后，显式后台任务继续运行。 |
| 清理失败可解释 | 原有错误只显示通用阻塞信息。现将 native-unavailable 等原因传入 source guard，并经现有 reader/SDK 展示；底层具体失败信息进入当前 runtime 的工具错误。 |
| Web 与 TUI 可放弃旧任务 | 原分支已实现操作。补修成功后关闭旧详情，避免已移出列表的前台记录或缓存的后台详情仍显示旧操作；测试覆盖不在当前分页中的详情。 |
| 耗时冻结、旧记录处理 | 保留原实现，registry/query/reader/source-cleanup 回归通过。未修改数据库结构；实时诊断不伪造为历史记录的原因。 |
| 安装包原生能力 | 在原 packaging smoke 中增加安装后的真实 bash → 下一轮 read → dispose；无需开发依赖，不增独立框架。 |

接口只增加可选 `cleanupReason` 与内部清理诊断 `detail`，持久化结构不变。依赖仍为原分支选定的 Koffi 3.1.1，本轮没有新增依赖。额外变动仅为 Windows 测试夹具：原生 exe 直接传 argv；路径比较先 realpath；reader 使用 dirname 和 Windows junction。

## 验收证据

| 04 项目 | 本轮证据与限制 |
| --- | --- |
| T01 | 真实 Job 的 exit 0/7；编译后 Web 经批准执行 PowerShell 短命令，再发下一轮 read，刷新后结果一致；runtime 请求测试下一轮执行 glob/grep/edit/read，检查真实返回与磁盘修改。macOS 未复测。 |
| T02 | 原生集成测试验证父进程退出、后代仍在时不能确认，终止 Job 后确认。breakaway 边界沿用既有实验，本轮未重跑 Start-Process。 |
| T03 | 新生命周期用例验证前台自动转后台、硬截止与 PID 不变并超时清理；请求用例验证显式后台完成。 |
| T04–T05 | registry、bash、source-cleanup 回归通过，含清理与耗时状态；不宣称覆盖全部并发排列。 |
| T06、T13 | query/reader/source-cleanup 与 Web/TUI 组件测试通过，验证异常前台可见、当前 owner 的限制、确认后放弃及详情收起。没有完成真实终端内逐个历史记录的手工恢复矩阵。 |
| T07 | 本机原生 PowerShell 请求、文件工具和安装路径得到验证；两种 PowerShell、中文/跨盘符及 macOS 全组合未完成。 |
| T08、T12 | 独立 runtime 被强杀后，Job 成员真实退出；后台任务跨主 run 继续。真实模型 Web 验收另证实浏览器断开后任务仍运行并完成。remote TUI 断线、强杀后重启及放弃的完整组合未完成。 |
| T09 | PTY 未改，按原决定另开议题。 |
| T10 | 安装包验收结果见下方；尚未覆盖安装包自动转后台与 macOS 安装。 |
| T11 | 原生接口失败注入测试通过；接管失败 + taskkill 成功仍保持 unconfirmed，包含失败原因；真实缺失原生包后重启恢复的整条流程未做。 |

### 自动测试

- Node 24.22.3：12 个定向文件合计 **213 通过、2 跳过**。包括 windows-job unit/integration/lifecycle、registry、reader、query、source-cleanup、bash、SDK task view、Web、TUI、runtime 请求测试。
- 两个 skip：POSIX FIFO；当前 Windows 权限不允许的文件符号链接。Windows 目录 junction 用例实际执行，不把这些 skip 算成通过。
- Node 25.6.0：同组回归通过，但 Web 组件测试需要 `NODE_OPTIONS=--no-experimental-webstorage`，否则受 Node 25 全局 localStorage 行为影响。Node 24 复测不需要这个设置。
- `pnpm build` 通过；全项目 typecheck 通过。提交前 lint 检查发现测试断言/无 await 的 async 等问题，已修正，未绕过提交钩子。
- 安装包 smoke：**1/1 通过，260 秒**。从本地打包产物安装到隔离目录，使用 `--ignore-scripts`，验证真实 Bash、下一轮 read、dispose、随包 ripgrep/grammar、CLI help/version。前两次分别暴露测试夹具的 exe 引号与短路径比较问题，修正后整条通过。
- 完整提交钩子 lint/typecheck 通过；lint 保留 248 个存量 warning、0 error。单独对 packaging 文件运行类型感知 ESLint 会因该文件不在现有 tsconfig/project service 范围而报解析错误，因此不宣称该文件单独 lint 通过；它由真实 packaging smoke 和 Prettier 检查。

可重复入口：

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/shell/windows-job-lifecycle.integration.test.ts tests/integration/adapters/ui-runtime/windows-command-requests.integration.test.ts
pnpm exec vitest run tests/integration/cli/packaging-smoke.integration.test.ts
```

### Web 与请求级验收

使用编译产物、隔离 OHBABY_HOME/数据库和本地脚本模型服务。在浏览器真实提交请求并点击 Allow once：PowerShell 输出 `OHBABY_WIN_BASH_OK`；下一轮 read 读取夹具；刷新后两轮消息和结果各出现一次。数据库记录为 `completed / exit_code=0 / cleanup=confirmed`，`ended_at=1794800839006`，`settled_at=1794800839008`。

该次会话为 `session_1794800823218_gok3b71`。本地派生验收脚本输出 `E2E_UI_EVIDENCE_PASS`、`E2E_BACKEND_PASS`（4 次模型请求，工具结果被消费）、`E2E_CLEANUP_PASS`（PID/端口释放）与 `E2E_DIAGNOSTICS_PASS`，exit 0。临时目录由脚本清理；没有写入用户旧会话。首次原版脚本因 stdin 无法提交证据，虽完成浏览器操作，但不计作脚本验收通过。

新增可重复的 runtime 请求集成测试使用真实 agent loop、工具、子进程与子代理：主代理启动后台 Bash，子代理执行 Bash/read；主 run 完成时后台任务仍在运行，解除夹具文件门闩后完成；下一轮 glob/grep/edit/read 均检查实际结果。**模型输出由脚本夹具控制**，不是对外部模型服务或随机模型决策的验收；该测试也不冒充 HTTP/浏览器测试。

### 当前配置的真实模型验收

随后按用户要求，复用当前配置的 **glm-5.2 / high / OpenAI-compatible**，复制配置到隔离 profile，使用真实服务请求。没有修改用户模型配置或旧会话。脱敏结果归档为 [windows-real-model-2026-11-16.json](evidence/windows-real-model-2026-11-16.json)。

- 编译后的 persistent backend：4 轮主会话、18 次实际模型请求、15 次工具调用全部完成；read/edit/glob/grep、前台 Bash、显式后台、自动转后台、子代理 Bash/read 均验证。4 条 Shell 任务均 `completed / exitCode=0 / cleanup=confirmed`；自动转换耗时 125 ms，硬截止仍为启动时间加 10000 ms。该路径实际检测到 Windows PowerShell `powershell.exe`。
- 编译后的 Web：浏览器确认 glm-5.2/high，完成 read → Bash → edit → read；启动一个等待外部夹具文件的后台 Bash，然后导航离开应用。离开后数据库仍为 running；从外部释放夹具，任务在重新连接前完成。重连后收到后台完成通知，再发一轮 glob/grep/read 成功。共 10 次工具调用完成，2 条 Shell 任务均清理已确认；文件内容独立核对。
- Web 会话为 `session_1794802598142_0id4e71`，后台 job 为 `4484dfc9-5cfc-4fbe-82e1-b58b7d19c6b3`。验收期间有两次 `UND_ERR_CONNECT_TIMEOUT`，现有请求重试生效，最终各轮成功；它们是连接层告警，不计为零告警运行。
- 两条路径都使用明确的验收提示，不代表任意模型行为都被覆盖。真实请求不放进默认测试，避免日常测试依赖付费服务或外网。

## 审查与 KISS 取舍

三个子代理分别检查原生生命周期、界面和参考项目/范围。另按要求通过 calling-pi-agent，使用 `copilot/gemini-4-carbon`、high 审查代码工艺与组织。

- 采纳 Pi 的诊断信息丢失意见：补齐现有数据链，不为诊断新增持久化表。
- Pi 提出的后台详情缓存问题，用关闭成功操作后的详情和回归测试解决；没有增加额外缓存失效系统。
- 未采纳只为隐藏一次调用而在 process.ts 再包一层 preload API：当前顺序在 bash 启动点直接可见，新增转发层收益不足。
- 参考 codex/ZCode 的 spawn 后 attach，保留 kimi-code 的同任务前后台切换思路；dsh 的挂起创建与独立 runner 超出本轮，不搬入。具体源码及版本见 03。

残余边界仍是 D10/D11：只保证 Job 成员，不能承诺回收逃逸进程；spawn→attach 窗口未消除。当前改动没有发现必须引入新 OS 层才能解决的问题。下一步优先补 macOS 回归与尚缺的发布矩阵，不扩大架构。

## 主要文件

- `packages/ohbaby-agent/src/shell/windows-job.ts`：原分支的原生 Job 封装。
- `packages/ohbaby-agent/src/tools/bash.ts`、`shell/process.ts`：加载顺序与清理证据。
- `packages/ohbaby-agent/src/core/tool-scheduler/{scheduler,source-cleanup}.ts`：阻塞诊断。
- `packages/ohbaby-agent/src/shell-jobs/{registry,reader}.ts`、`packages/ohbaby-sdk/src/{contract/shell-job,util/shell-job-view}.ts`：实时原因及界面说明。
- `apps/ohbaby-web/src/ui/side-panel/background-tasks/BackgroundTasksPage.tsx`、`packages/ohbaby-cli/src/tui/components/background-tasks/background-task-browser.tsx`：操作成功后的详情处理。
- `packages/ohbaby-agent/src/shell/windows-job-lifecycle.integration.test.ts`、`tests/integration/adapters/ui-runtime/windows-command-requests.integration.test.ts`：真实进程和请求回归。
- `tests/integration/cli/packaging-smoke.integration.test.ts`、`tests/integration/cli/fixtures/installed-windows-job-smoke.mjs`：安装包验证。
