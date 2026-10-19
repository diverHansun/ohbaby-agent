# Shell 测试

遵循既有项目测试规范。unit 就近验证解释器选择、AST 可靠事实、风险和政策；跨模块集成放 `tests/integration/shell-tools/`；已安装产物使用现有 CLI packaging smoke。

| 范围 | 关键行为与位置 |
| --- | --- |
| 平台选择 | detector.unit、detector-windows、shell.unit：原生 SHELL、配置错误、PowerShell 默认、MSYS/fish/nu 偏好、WSL 拒绝、sh/zsh 方言 |
| 真实 grammar | analysis/parser.unit 与 argv.unit：字面参数、引号、管道、重定向、展开、恢复节点、未知 CLI、wrapper、cwd 分支与嵌套、转义和必要 argv 语义 |
| 静态政策 | preflight.unit：根目录破坏、关机、下载进入 shell、下载后执行文件；curl -o 输出和随后读取不误判执行 |
| 权限贯通 | analysis-permission.integration：宽 allow 不跳过 incomplete、Once/Reject、非法 Always 保留 pending、另一个 Always 不自动批准、deny 优先、模式粒度 |
| 固定执行 | bash-binding.integration：原文、注入解释器、argv、cwd、前缀、最新 env、伪造输入无效、排队后新 deny、Full Access 变化重试、直接调用与真实 exit 2/stderr |
| 生命周期回归 | Bash/scheduler/registry 与 process.integration：前后台、取消、超时、owner、task_output/task_kill、scope/session 清理 |
| 发布资源 | packaging-smoke.integration + installed-grep fixture：脱离仓库 cwd 加载两份 grammar；移走任一 WASM 明确不可用，发布包不依赖 grammar 原生安装 |

危险字面用例只分析或 stub spawn，不实际执行破坏性命令。实际 POSIX 执行用受控输出与临时目录，并根据解释器可用性跳过不适用平台；模拟平台选择不等于真实 Windows/Linux 主机验收。当前实机为 macOS，Windows PowerShell 5.1 编码和 Linux 实机运行仍需要对应主机验证。

```sh
pnpm exec vitest run packages/ohbaby-agent/src/shell packages/ohbaby-agent/src/sandbox packages/ohbaby-agent/src/permission packages/ohbaby-agent/src/tools/bash.unit.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts tests/integration/shell-tools
pnpm typecheck
```

发布包测试会取得全局 package-build-lock；与全仓 preflight/build 协调运行，避免终止持锁进程。完整构建、真实 CLI/主子代理审批和安装验收结果记录在本批验收文档，不用开发目录 import 代替。

## 系统代理绕过回归

`tests/integration/core/bash-tool-scheduler.integration.test.ts` 使用含 `*.local` / `*.crashlytics.com` / `<local>` 的系统代理配置，经过真实 permission 审批后执行 `echo ok`、`true` 和临时文件写入，断言退出码与文件内容。`tests/integration/network-proxy/child-routing.integration.test.ts` 验证 Shell / MCP 可以启动、curl 对域名后缀直连且无关域名仍走代理。不要再把常见 bypass 导致进程无法启动当作正确行为。
