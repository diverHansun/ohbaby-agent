# Shell 接口与数据流

## 公开入口

- `resolveAcceptableShell(input?)`：选择可用原生解释器；受支持的显式配置缺失时报错。
- `resolvePreferredShell(input?)`：保留继承的首选偏好；没有偏好时选择平台默认。
- `Shell.acceptable()` / `Shell.preferred()`：现有 lazy namespace 入口。
- `detectShellKind(shellPath)`：保留 bash、zsh、sh、powershell、cmd 方言。
- `shellArgs(shellPath, command)`：原文生成非交互启动参数。
- `analyzeShellCommand(command, shellKind)`：异步成熟分析，返回 [数据模型](data-model.md) 定义的可靠事实与完整性。
- `preflightShellCommand({command, cwd, shellAnalysis})`：消费同一分析结果，保留静态政策与可靠路径检查。
- `classifyShellCommand(shellAnalysis?)`：聚合风险；缺失或 incomplete 保守处理。
- `killTree`、`probeProcessTree`：既有进程清理与观察入口。

## 工具与权限接线

Bash 实例通过现有 admission 提供 `prepareShell(params, context)`，固定实际注入的解释器。scheduler 在前驱完成后调用，之后重用结果；直接内部调用没有绑定时走同一入口。执行中读取当前 env，但 command、解释器、argv、cwd 和前缀保持准备值。

PermissionCall、PermissionAskInput、PermissionPatternInput 与 PermissionPort.ask 可选接收 `shellAnalysis`。非 Shell 调用不使用它。Bash 未提供分析时按 incomplete 处理；params 或 metadata 中同名字段无效。sandbox 使用 `preflightSandboxShellAnalysis({shellAnalysis, workdir, trustedRoots})`，不在 scheduler 中再次调用 environment.preflight。

## API 迁移说明

删除旧 `parseCommand`、`ParsedCommand`、`CommandDetail`、`detectPaths`、`getCommandRoots`、`analyzeShellCommandLight` 和 Git Bash 自动探测 helper；包根、shell、utils barrel 同步清理。通用 `matchesPattern` 保留。消费者需要改用异步 analyzeShellCommand 与真实完整性合同，不能依赖旧同步 parser。

Windows 默认改为 pwsh → Windows PowerShell；Git Bash 仍可显式配置原生完整路径。没有执行失败后的解释器回退。

## 子进程代理环境

启动前从共享代理快照构造环境，规则见 [MCP 子进程代理环境契约](../mcp/dfd-interface.md#子进程代理环境契约)。常见系统域名绕过规则尽力转换为 `NO_PROXY`，无法通用表达的规则省略，不因 `*.local` / `<local>` 阻止本地命令启动。网络配置不改变 Shell 分析、审批与固定执行绑定。
