# Shell 架构

Shell 模块负责选择可用的原生解释器、从 AST 提取可靠事实、保留已有静态政策，并提供进程树清理。工具名继续使用 `bash`，实际方言保留为 `bash / zsh / sh / powershell / cmd`。

## 准备与执行

```mermaid
flowchart LR
    A[原始命令与 Bash 实例] --> B[固定解释器、argv、cwd、前缀]
    B --> C[加载 WASM 并提取可靠 AST 事实]
    C --> D[静态政策与 sandbox 路径检查]
    D --> E[主会话权限审批]
    E --> F[取消检查与最新代理环境]
    F --> G[ShellJobRegistry 原样执行]
```

Bash 实例在现有 `ToolAdmission` 上提供专用 `prepareShell`。scheduler 在前驱完成后准备一次，审批或资源排队重试使用同一份 `shellAnalysis` 和执行绑定。`contextFor` 与实际调用 `executeToolWithTimeout` 都传入绑定。直接内部调用走同一准备入口；交互或 scope 调用仍要求可信 owner。

权限层只接收可选 `shellAnalysis`，不接收 AST、环境或完整准备对象。执行层只需要固定的 command、解释器、argv、cwd 和前缀；启动时读取当前环境与 improve-1 代理配置。命令与准备值不一致会失败，执行失败不会换解释器重跑。

## 解释器选择

支持且可用的原生 `SHELL` 名称或路径优先。明确配置的受支持解释器缺失时报告配置错误。fish、nu 等继承偏好，以及 Windows 中无法原生使用的 `/usr/bin/bash`、`/bin/bash`，按平台默认选择。

| 平台 | 未配置时选择 |
| --- | --- |
| Windows | `pwsh.exe`，然后 Windows PowerShell |
| macOS | `/bin/zsh` |
| Linux | 可用 bash，然后 `/bin/sh` |

Windows 不再自动探测 Git Bash。需要 Git Bash 时设置可用的原生完整路径；裸 bash 命中系统 WSL 启动器时明确拒绝。本批不适配 WSL。PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`；POSIX 使用 `-lc`，用户启动文件仍可能改变环境。

## 分析与边界

`web-tree-sitter` 加载 Bash、PowerShell grammar。Bash grammar 也用于 zsh/sh 的共同语法；恢复节点、方言差异、变量、命令替换、未知结构、无法可靠确定的 cwd 都产生 incomplete。保留可靠字面事实，不求值展开。静态自定义 CLI 可以 complete，风险仍保守为 mutating。

只有成功分支内部的静态 `cd … && …` 可以关联后续相对路径。条件、循环、OR fallback、无条件 `cd; …`、改变 cwd 的 env wrapper 不伪造确定路径；未知 cwd 中的绝对事实仍可检查。AST 决定管道和重定向，必要 argv 语义留在 `path-args.ts`。下载输出本身不算执行，只拒绝下载内容进入 Shell 或随后明确执行同一下载文件。

已知政策拒绝先于任何路径审批。default 下 incomplete 必须整条 Once / Reject，历史宽 allow 不能跳过；Full Access 保留既有意图，明确 deny 始终优先。真实退出码及 stderr 保留，没有根据 exit 2 合成 syntax_error。

## 资源交付与清理

grammar 固定版本为 Bash 0.25.0、PowerShell 0.25.10，作为开发依赖；构建复制两份 WASM 和原始许可证到 `dist/assets`。运行时依赖 `web-tree-sitter` 0.25.10。发布代码固定从自身 assets 加载；缺失或损坏明确失败，不回退到开发依赖或旧 parser。pnpm 9 的 `neverBuiltDependencies` 禁止这两个只取 WASM 的包进行不必要的原生构建。

现有 `ShellJobRegistry`、取消、前后台任务、owner 和进程清理机制保留。分析和审批不是 OS 隔离，也不证明未知脚本的所有副作用。旧 parser、light-parser、旧 roots/path helper 及其公开导出已移除。
