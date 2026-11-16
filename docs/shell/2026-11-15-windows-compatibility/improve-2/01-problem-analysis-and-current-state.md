# 01 · 问题基线

基线 `a405f6b6`，Windows x64 / Node 25.6.0。第一轮已验证工具和 Job 主链；这次用真实仓库测试补出以下缺口。

| ID | 现象与证据 | 代码锚点 |
| --- | --- | --- |
| W1 | 商店版 pwsh 路径 `existsSync=false / stat=EACCES`，但实际 spawn 输出正常，lstat 识别为链接。父 runtime 自动找到 shell，子进程继承绝对 SHELL 后却被拒绝。是真实产品缺陷。 | `shell/detector.ts:resolveAcceptableShell`；`tools/bash.ts:stateEnvironment` |
| W2 | preflight 在格式检查报 1547 个文件。core.autocrlf=true；12 样本中 8 个 CRLF 失败，仅内存转换 LF 后通过，内容与 Git blob 一致。 | `.gitattributes`；`package.json:format:check` |
| W3 | Node 25 下 13 个 Web 用例在 afterEach 的 localStorage.clear 失败；单独禁用 Node webstorage 后 13/13 通过。测试体已经执行，不是 Windows 专有的组件缺陷。 | `tests/setup/vitest-env.ts`；Web `BackgroundTasksPage.integration.test.tsx` |
| W4 | shell-jobs 18 失败：registry.integration 9、persistence.integration 8、output-file 1。包含 POSIX 命令、未绑定 Job 的 Node 夹具、文件 symlink 权限限制；不能全归为环境或直接 skip。 | `shell-jobs/{registry,persistence}.integration.test.ts`；`output-file.unit.test.ts` |
| W5 | 原超时命令使用 PowerShell 不支持的 printf；改成 Write-Output 能捕获开始标记。但真实 Cancel 后进程均退出、cleanup confirmed，output_complete=false，仍需独立定位输出收尾。 | `shell-jobs/registry.ts:confirmStopped`、`outputDrain`；`shell/process.ts` |

W1/W4 的路径均相对 `packages/ohbaby-agent/src/`。原报告 registry 单测 47 的数字不准确，原始日志为 62 通过。

原会话 6 次主/子代理运行 succeeded，11 条 Shell 任务都 cleanup confirmed；说明命令失败与工具不可运行必须区分。用户没有点击原 Cancel；补测 job `1491dfb5-13d8-4bc4-8370-b707a70c76e6` 实点后为 cancelled/user/confirmed，PowerShell、Node 和 conhost 均退出，输出最终 48 ticks 加 incomplete 标记。

现有结构适合局部修正：detector 决定 shell，Bash 将其传给 spawn，Registry 分别记录进程清理与输出完整性，Web 读取这些事实。数据库、协议、任务归属均不需要改。SWE 重点是修正错误的可执行性假设和测试前提，不把平台差异扩散到业务组件。

格式旁支：`prettier.config.json` 当前未被 Prettier 自动加载。不能直接改名启用其 singleQuote/printWidth 等规则，否则会造成额外风格改写。
