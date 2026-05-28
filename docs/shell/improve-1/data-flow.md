# Shell 运行时数据流

本文描述 shell improve-1 后，`bash` 工具从收到 command 到进程启动的完整数据流。
与 sandbox 数据流的衔接见 [sandbox data-flow](../../sandbox/improve-1/data-flow.md)。

## 端到端流程

```text
Agent tool_call: bash({ command, timeout })
  |
  v
ToolScheduler.prepareCall
  |
  |-- shell.detectShellKind(shellPath)
  |-- environment.preflight(command, shellKind)
  |     |
  |     |-- shell.analysis.parse(command, shellKind)
  |     |-- sandbox.preflight(workdir, analysis)
  |
  |-- permission phase 1: external_directory
  |-- permission phase 2: sensitive_path
  |-- permission phase 3: bash
  v
bash.execute()
  |
  |-- resolveCommandContext()
  |-- shellArgs(shellPath, command)
  |-- apply commandPrefix if present
  |-- build non-interactive env
  |-- spawn()
  |-- close stdin
  |-- stream stdout/stderr with truncation
  |-- timeout/abort kill process tree
  v
ToolExecutionResult
```

## shell analysis 输出

shell analysis 不抛 workspace 越界错误。它只描述命令：

```ts
export interface ShellAnalysisResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly ShellCommandAnalysis[];
  readonly parseError?: string;
}

export interface ShellCommandAnalysis {
  readonly source: string;
  readonly tokens: readonly string[];
  readonly root: string;
  readonly pathArgs: readonly string[];
  readonly arityKey: string;
  readonly danger: "readonly" | "mutating" | "dangerous";
  readonly hasDynamic: boolean;
}
```

示例：

```bash
cat ../notes/today.md && git status
```

应得到：

```ts
{
  shellKind: "bash",
  commands: [
    {
      source: "cat ../notes/today.md",
      tokens: ["cat", "../notes/today.md"],
      root: "cat",
      pathArgs: ["../notes/today.md"],
      arityKey: "cat *",
      danger: "readonly",
      hasDynamic: false
    },
    {
      source: "git status",
      tokens: ["git", "status"],
      root: "git",
      pathArgs: [],
      arityKey: "git status *",
      danger: "readonly",
      hasDynamic: false
    }
  ]
}
```

`../notes/today.md` 是否在 workspace 外，不由 shell 判断。

glob 也不被 shell 当作动态路径拒绝。`*.md`、`src/*.ts`、`build/**/*.tmp`
会作为 path arg 保留，sandbox 用 glob 前的字面目录前缀做 workspace 边界和敏感路径判断。
真动态表达式（`$()`、`${}`、反引号、未求值变量）仍通过 `hasDynamic=true` 透传给 permission。

## external_directory 优先

用户已确认采用 opencode 风格：

> 无论绝对路径还是 `../`，只要能解析到 workspace 外，就走 `external_directory` ask。

因此数据流必须是：

```text
shell extracts path arg
  -> sandbox resolves absolute path
  -> sandbox classifies outside
  -> scheduler asks external_directory
  -> if approved, scheduler asks sensitive_path when needed
  -> if approved, scheduler evaluates bash permission
  -> if bash approved, bash.execute spawn
```

不能再出现：

```text
scheduler approves bash
  -> bash.execute preflight throws "outside workspace"
```

这个旧流程对 skill scripts 尤其有害，因为 scripts 经常需要访问 skill 目录、临时目录、
或用户显式指定的 workspace 外路径。

## bash.execute 的职责

当 `bash.execute()` 被调用时，permission 已经完成。

它只负责执行：

```ts
const commandContext = resolveCommandContext(context);
const shellPath = shell.acceptable();
const args = shellArgs(shellPath, command);
const env = stateEnvironment({ ... });
const child = spawn(shellPath, args, { cwd, env, ... });
child.stdin?.end();
```

`stateEnvironment()` 需要包含：

```ts
{
  ...process.env,
  NO_COLOR: "1",
  TERM: "dumb",
  GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT ?? "0",
  SHELL: shellPath,
  ...input.env,
  OHBABY_CALL_ID,
  OHBABY_MESSAGE_ID,
  OHBABY_SESSION_ID,
  OHBABY_WORKDIR,
}
```

`input.env` 放在 non-interactive 默认值之后，允许 adapter 或用户明确覆盖。

## commandPrefix 数据流

`ToolCommandContext.commandPrefix` 是 adapter 对命令执行的包装能力。

HostLocal：

```ts
{ kind: "host-local", cwd, commandPrefix: [] }
```

未来 OS sandbox adapter：

```ts
{
  kind: "seatbelt-host",
  cwd,
  commandPrefix: ["sandbox-exec", "-p", policy, "--"]
}
```

improve-1 的 bash 工具不能继续 throw `"commandPrefix is not supported"`。
它必须支持这个字段，或在具体 prefix 无法表达时给出可诊断错误。

## 错误流

| 错误 | 所属模块 | 行为 |
|---|---|---|
| shell 路径找不到 | shell detector / bash tool | ExecutionError |
| shell 语法无法完整解析 | shell analysis | 返回 `parseError` + fallback analysis |
| 动态路径无法解析 | shell analysis | `hasDynamic=true`，不阻断 |
| 外部路径 | sandbox + permission | `external_directory` ask |
| 敏感文件 | sandbox + permission | `sensitive_path` ask |
| denylist | sandbox + scheduler | PermissionDeniedError |
| spawn 失败 | bash tool | ExecutionError |
| timeout | bash tool | TimeoutError |
| abort | scheduler / bash tool | CancelledError |

## skill scripts 约束

skill 模块不应新增独立脚本执行器绕开本链路。

后续如果 skill 提供 `scripts/` 运行时工具，它应通过 scheduler 调用 builtin `bash`，
并继承同一套：

- shell analysis
- sandbox preflight
- external_directory permission
- sensitive_path permission
- bash permission
- process hardening

这避免 shell/sandbox/permission 的第三套实现。
