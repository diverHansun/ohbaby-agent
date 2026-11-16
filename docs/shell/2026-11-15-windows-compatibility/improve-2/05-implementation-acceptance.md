# 05 · 实施验收

日期：2026-11-16。基线 `a405f6b6`，分支 `feat/windows-job-cleanup`。**部分通过：本轮局部修复已验证，但商店版 PowerShell 后代终止、完整 Windows 测试及 macOS 实机仍未验收通过。** 不合并、不推送。

## 对照 02 的实际改动

| 项目 | 实际结果 |
| --- | --- |
| 执行别名 | detector 默认在 Windows 用 lstat 接受文件/链接，保留 existsSync 注入、WSL 排除及 POSIX 行为；真实 Store alias 经绝对 SHELL 传给嵌套 Node 后可以执行。未增加探测进程或解释器回退。 |
| 工程环境 | `.gitattributes` 约定 LF，恢复检出时的换行，不提交全库重排；Vitest setup 为 DOM 测试绑定所属 jsdom 的 Storage。没有升级依赖、启用另一套 Prettier 配置或修改全局 Git 设置。 |
| 进程夹具 | 三个既有测试文件使用 Node 夹具与真实 Job；固定测试解释器，明确输出握手、故障放行和清理观察；symlink 仅实际 EPERM 时 skip。 |
| 输出收尾 | 生产代码只把 drain timer 清理移到 child.close 入口，避免取消/超时已进入终态后 finish 提前返回，旧 timer 又把 true 改回 false。未延长等待或放宽清理条件。 |

接口、数据库和依赖没有增加。夹具调整的原因是 Windows Job 活动计数可能晚于 exit/close 事件归零；实测一次事件时计数为 1，20 ms 后复查为 0。测试调用现有 refreshLocalOwner 获取真实证据，不用假 probe。父进程退出而子进程仍活的测试改由 Registry 直接启动 Node，避开 PowerShell 包裹进程的生命周期差异，仍验证子 PID 存活、配额占用和释放。

## 对照 04 的证据

| 验收项 | 结果及边界 |
| --- | --- |
| A1–A2 | detector 三文件 12/12，真实 alias 没有 skip。该测试只证明嵌套解析和执行；不单独证明 Job 清理。真实模型组合场景的后代终止问题见下节。 |
| A3 | 全仓 format:check 通过；Git diff 无数千文件换行重排。 |
| A4 | BackgroundTasksPage 在 Node 25 默认环境及 Node 24 均 13/13，无需手动 NODE_OPTIONS。 |
| A5 | 最终 Node 24 合并回归 19 文件，237 passed / 4 skipped。包括 shell-jobs、detector、真实 Windows Job 生命周期和 runtime 请求。Node 25 在 SHELL 指向 Git Bash 的环境下，三项修改夹具合计 43 passed / 1 skipped，测试仍使用明确配置的解释器。 |
| A6 | 原始 Node / 系统 PowerShell / Store pwsh，各做 raw、取消、超时，9 场景。修复前六项 Registry 场景均 true→false，修复后保持 true。该矩阵的 PowerShell 命令没有再启动 Node，不能代表嵌套后代终止。 |
| A7 | 新编译产物 + 当前 glm-5.2 / high / OpenAI-compatible，6 轮、22 次模型请求、17 次工具调用均完成，1 个子代理成功。前台、显式后台、自动转后台、read/edit/glob/grep 均执行。超时/取消的 Job 为空，但 Store pwsh 后代终止未通过，不能把 cleanup=confirmed 当整棵进程树退出。 |

四个 skip：两项当前权限不允许的文件符号链接、POSIX FIFO、POSIX 进程恢复。没有把它们计为通过。macOS 未在本轮实机运行。

可重复的定向入口（Node 24 使用其 node.exe 运行同一 Vitest 入口）：

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/shell-jobs packages/ohbaby-agent/src/shell/detector packages/ohbaby-agent/src/shell/windows-job.integration.test.ts packages/ohbaby-agent/src/shell/windows-job-lifecycle.integration.test.ts tests/integration/adapters/ui-runtime/windows-command-requests.integration.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/side-panel/background-tasks/BackgroundTasksPage.integration.test.tsx
```

## 输出诊断与新发现

两件事必须分开：旧 timer 覆盖已排空状态是实现错误，已修复；取消/超时日志原有 `finish(false)` 的 partial 标记策略没有修改。此次真实模型测试又揭示第三件事：**本机商店版 PowerShell 启动的 Node 后代未被计入同一个 Job**。终止 PowerShell 后 Job 为空，Node 仍继续输出；drain 到期销毁管道，因此 outputComplete=false 是真实信号，不能强改为 true。

进一步用静默 Node 子进程对照：本机商店打包版 PowerShell 7.7.0 的 alias 与直接安装目录 exe 均未把后代计入 Job，停止根进程 1.6 秒后子 PID 仍活。系统 Windows PowerShell 与普通便携版 PowerShell 7.6.9 均能计入并终止后代。因此不是单纯 alias 路径问题。具体 Windows 机制尚未界定，不能仅凭表现断言是某种 broker 或 breakaway 标志，也不外推到所有版本。静默探针遗留均按记录的 PID 精确清理；主模型验收的两个持续输出 Node 在事后查询时已不存活，这不等于 Job 保证了它们退出。

KISS 建议：补齐同版本安装方式对照，明确支持范围，再决定是否对商店版给出限制或引导使用普通安装版。现有 7.7.0 与 7.6.9 对照尚未排除版本因素。不要直接加入进程扫描、轮询杀进程或通用 OS 层。本轮不擅自改变用户已确认的 shell 优先级。

真实模型验收首次漏复制隔离模型配置，未发出模型请求，补齐后才得到上述结果。最终脚本因停止任务的 outputComplete 断言失败而退出 1，这次验收不是全通过。用户先前授权的 Web Cancel 实点确已发出取消、UI 与数据库一致，但它不能替代本次 Store 后代测试。

## 完整 preflight 的限制

format、lint、typecheck 通过，lint 有 248 个既有 warning、0 error。最终夹具修正前的一次全量测试为 **36 文件失败、127 项失败、8408 通过、56 跳过、4 个未处理错误**，所以 preflight 未执行末尾 build。修正后重跑定向回归，未再次运行全量。随后独立 `pnpm run build` 通过。

| 失败类别 | 已知事实 |
| --- | --- |
| 本轮三项夹具 | 输出尚未到达、Job 尚未观察归零、写入重试竞态；后续已修，最终定向回归通过。不能归为存量。 |
| 31 项 SQLite 删除锁 | 报 EBUSY 删除数据库/WAL/SHM；一个 ui-persistent 用例独跑仍复现，fixture 在 afterEach 关库之前删目录。其余同类尚未逐项验证根因。 |
| 15 项 symlink | 实际 EPERM，其他模块未处理当前权限条件；不代表其保护断言通过。 |
| 12 项 PTY | POSIX 命令/默认 sh 假定，另有产品进程检查明确不支持 Windows。PTY 不在本轮范围内。 |
| CLI 构建入口 | 一处直接 spawnSync pnpm.cmd 报 EINVAL；packaging 内部构建另有 180 秒超时。独立正式 build 通过不等于本轮 packaging smoke 通过。 |
| 其余 | 启动/等待超时、路径转义、SQLite 参数数量、Goal/reasoning 等。一个全量失败的 todo 用例独跑通过；不能据此把全部超时都归因于负载。四个未处理错误来自 ui-inprocess。 |

没有逐项做基线对照，故不宣称其余失败全部是存量，也不扩大本轮修复。后续优先处理 Windows fixture 清理顺序、PTY 支持范围与安装方式矩阵。

## 审查与代码工艺

独立子代理分别检查范围、实现和验收。Pi 使用 `copilot/gemini-4-carbon high` 审查两轮，采纳 existsSync 注入被绕过的意见；新增 true/false 契约回归先红后绿。采纳子代理关于 Git Bash 环境与 PowerShell 测试语法不匹配的意见，固定夹具解释器。最新 diff 复审无代码阻断项，但审查不能替代随后发现的 Store 后代兼容缺口。

改动没有新增平台框架、持久化字段或依赖。维护成本主要是把测试中的时间假定改成明确事件，而生产改动仍集中在 detector 和 close 回调。取消日志 partial 的策略不在本轮重定义。

证据：[输出时序前后对照](evidence/output-drain-before-after.json)、[真实模型结果](evidence/store-pwsh-real-model.json)、[安装方式与后代归属](evidence/store-descendant-boundary.json)、[完整测试失败清单](evidence/preflight-failures.json)。前两轮规划保留原验收契约，当前结论以本文件为准。
