# Sandbox 运行时数据流

本文描述 improve-1 之后，一次 `bash` 工具调用如何经过 shell / sandbox / permission，
最后才进入 `child_process.spawn`。Shell 侧的配套数据流见
[shell data-flow](../../shell/improve-1/data-flow.md)。

## 端到端流程

```text
Agent tool_call: bash({ command: "cat ../notes/today.md && git status" })
  |
  v
ToolScheduler.prepareCall
  |
  |-- detectShellKind(shellPath)
  |-- environment.preflight(command, shellKind)
  |     |
  |     |-- shell.analysis(command, shellKind)
  |     |     -> commands/tokens/pathArgs/danger/arityKey/hasDynamic
  |     |
  |     |-- sandbox.preflight(workdir, shellAnalysis)
  |           -> internalPaths/externalPaths/denylistHits/sensitivePaths
  |
  |-- if denylistHits: reject immediately
  |-- if externalPaths: evaluate/ask external_directory first
  |-- if sensitivePaths: evaluate/ask sensitive_path
  |-- after external approval: evaluate/ask bash permission
  |
  v
bash.execute()
  |
  |-- resolveCommandContext()
  |-- apply commandPrefix if present
  |-- build non-interactive env
  |-- spawn()
  |-- close stdin
  |-- stream stdout/stderr with truncation
  |-- timeout/abort kill process tree
  v
ToolExecutionResult
```

核心顺序是：

```text
shell 语法事实 -> sandbox workspace 事实 -> external_directory -> sensitive_path -> bash -> execute
```

不能再出现：

```text
bash permission allow -> bash.execute -> sandbox/path check throws outside workspace
```

这个旧流程会伤害 skill scripts，因为 scripts 经常需要访问 skill 目录、临时目录、
或用户显式指定的 workspace 外路径。

## lease.preflight 的边界

`SandboxLease` 对 scheduler 暴露一个统一入口：

```ts
preflight(command: string, shellKind: ShellKind): Promise<PreflightResult>
```

但这个入口内部不是让 sandbox 重新理解 shell 语法，而是组合两个领域：

```ts
const shell = await analyzeShellCommand(command, shellKind);
return sandboxPreflight({
  workdir: lease.workdir,
  shellKind,
  shell,
});
```

因此：

- shell 模块拥有 parser、tokens、dynamic、danger、arityKey。
- sandbox 模块拥有 path expansion、workspace boundary、denylist 和 sensitive path 分类。
- permission 模块拥有 allow / ask / deny。

这避免 `src/shell/`、`src/sandbox/`、`src/tools/bash.ts` 各自长出一套命令解析。

## PreflightResult schema

```ts
export interface PreflightCommand {
  /** shell-owned: 单条命令原文，用于 once-only bash rule */
  readonly source: string;
  /** shell-owned: 解析后的 token 列表，首位是 command name */
  readonly tokens: readonly string[];
  /** shell-owned: command root，如 "git" / "npm" / "python" */
  readonly root: string;
  /** shell-owned: 用于 always-allow 的 pattern，如 "git push *" */
  readonly arityKey: string;
  /** shell-owned: readonly / mutating / dangerous */
  readonly danger: "readonly" | "mutating" | "dangerous";
  /** shell-owned: 存在 $()、${}、反引号或未求值变量 */
  readonly hasDynamic: boolean;
}

export interface PreflightInternalPath {
  readonly original: string;
  readonly absolutePath: string;
}

export interface PreflightExternalPath {
  readonly original: string;
  readonly absolutePath: string;
  /** external_directory permission 的 pattern，通常是 "<dir>/*" */
  readonly askPattern: string;
}

export type DenylistReason =
  | "ssh-key-dir"
  | "aws-credentials"
  | "gnupg-dir"
  | "env-file"
  | "private-key"
  | "shell-rc";

export interface PreflightDenylistHit {
  readonly original: string;
  readonly absolutePath: string;
  readonly reason: DenylistReason;
}

export interface PreflightSensitivePath {
  readonly original: string;
  readonly absolutePath: string;
  /** sensitive_path permission 的 pattern，通常是精确路径 */
  readonly askPattern: string;
  readonly reason: DenylistReason;
}

export interface PreflightResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly PreflightCommand[];
  readonly internalPaths: readonly PreflightInternalPath[];
  readonly externalPaths: readonly PreflightExternalPath[];
  readonly denylistHits: readonly PreflightDenylistHit[];
  readonly sensitivePaths: readonly PreflightSensitivePath[];
  readonly overallDanger: "readonly" | "mutating" | "dangerous";
  readonly parseError?: string;
}
```

不变式：

1. `denylistHits` 是 hard-deny 事实，不再进入 ask 流程。
2. `sensitivePaths` 可以与 `internalPaths` 或 `externalPaths` 重叠；外部敏感路径先问 `external_directory`，再问 `sensitive_path`。
3. `internalPaths` / `externalPaths` / `denylistHits` / `sensitivePaths` 只覆盖 shell 能静态识别的路径。glob 使用字面前缀目录做边界判断，例如 `build/*.tmp` 先检查 `build/`。
4. 真动态路径（`$()`、`${}`、反引号、未求值变量）不阻断；`hasDynamic=true` 只提示 bash permission 阶段应保持保守。
5. `overallDanger` 来自 shell command danger 的最大值。

## external_directory 优先

用户已确认采用 opencode 风格：

> 无论绝对路径还是 `../`，只要能解析为 workspace 外部路径，都走 `external_directory` ask。

调度器必须按下面的顺序执行：

```ts
if (preflight.denylistHits.length > 0) {
  return rejected("PermissionDeniedError");
}

for (const externalPath of groupExternalDirectories(preflight.externalPaths)) {
  const externalCall = {
    ...originalBashCall,
    toolName: "external_directory",
    category: "dangerous",
    params: { path: externalPath.absolutePath },
  };
  const externalDecision = evaluatePermission(externalCall, permissionState);

  if (externalDecision.type === "ask") {
    const response = await permission.ask({
      toolName: "external_directory",
      category: "dangerous",
      params: { path: externalPath.absolutePath },
      metadata: { preflight },
    });
    if (response !== "allow") return rejected("PermissionRejected");
  }

  if (externalDecision.type === "deny") {
    return rejected("PermissionDeniedError");
  }
}

for (const sensitivePath of uniqueSensitivePaths(preflight.sensitivePaths)) {
  const sensitiveCall = {
    ...originalBashCall,
    toolName: "sensitive_path",
    category: "dangerous",
    params: {
      path: sensitivePath.absolutePath,
      pattern: sensitivePath.askPattern,
      reason: sensitivePath.reason,
    },
  };
  const sensitiveDecision = evaluatePermission(sensitiveCall, permissionState);

  if (sensitiveDecision.type === "ask") {
    const response = await permission.ask({
      toolName: "sensitive_path",
      category: "dangerous",
      params: sensitiveCall.params,
      metadata: { preflight },
    });
    if (response !== "allow") return rejected("PermissionRejected");
  }

  if (sensitiveDecision.type === "deny") {
    return rejected("PermissionDeniedError");
  }
}

const bashDecision = evaluatePermission(originalBashCall);
// bashDecision 如果是 ask，继续走原有 bash ask UI。
```

要点：

- `external_directory` 不是把 bash allow 升级成 ask，而是 bash 之前独立评估的权限类型。
- 如果用户已经记住某个外部目录的 allow rule，可以不弹窗，但仍然先经过 external_directory 规则。
- `sensitive_path` 同样是 bash 之前独立评估的权限类型，用于 `.env`、非模板 `.env.*`、`*.pem`、`*.key` 和 shell rc 文件。
- 外部路径和敏感路径批准后，不代表 bash 自动批准；`git push`、`rm -rf` 等仍按原 bash 规则继续 ask/deny。
- denylist 只保留高确信 home 凭据目录（如 `~/.ssh`、`~/.aws`、`~/.gnupg`）的 hard deny，不能被 full-access 或 always allow 绕过。

## Scheduler 接入点

`createPermissionContext` 是最合适的 preflight 调用点，因为它已经在 permission 评估之前，
并且现有 `externalWrite` 也是在这里预计算。

```ts
interface ToolPermissionContext {
  readonly externalWrite: boolean;
  readonly untrustedMcp: boolean;
  readonly params: Record<string, unknown>;
  readonly preflight?: PreflightResult;
}
```

对 bash 类工具：

```ts
if (tool.name === "bash" && request.environment?.preflight) {
  const command = typeof request.params.command === "string" ? request.params.command : "";
  const shellKind = detectShellKind(shellPath);
  const preflight = await request.environment.preflight(command, shellKind);
  return { externalWrite: false, untrustedMcp, params: request.params, preflight };
}
```

preflight 失败时，scheduler 应记录 warning 并退化为无 preflight 的旧行为；普通解析失败则应由
shell analysis 返回 `parseError` + fallback facts，不应让整个工具链断掉。

## Runtime / Lease 生命周期

improve-1 不是让 rich sandbox "接管 runtime"。

准确说法是：**rich sandbox 完全替换 runtime 下的简版 sandbox 二次实现，
让 rich `SandboxLease` 成为统一 `ToolExecutionEnvironment`；runtime/run-manager
的底层架构保持不变。**

```text
Session / Run lifecycle keeps existing RunManager architecture
  |
  |-- RunManager acquires SandboxLease
  |-- RunContext.sandboxLease = rich SandboxLease
  |-- ToolScheduler passes lease as ToolExecutionEnvironment
  |-- tools use resolvePath* / resolveCommandContext / preflight
  |-- RunManager releases lease
```

`ToolExecutionEnvironment` 与 rich `SandboxLease` 的字段高度重合：

- `workdir`
- `resolvePath`
- `resolvePathForExisting`
- `resolvePathForWrite`
- `resolveCommandContext`
- `preflight`

因此 runtime 层不需要重写，只需要删除简版 `SandboxManager` / `SandboxLease` 的重复定义，
把类型和实现指向 rich sandbox。

## 错误传播路径

| 错误来源 | 所属模块 | 行为 |
|---|---|---|
| shell 语法无法完整解析 | shell analysis | 返回 `parseError` + fallback commands，不阻断 |
| 动态路径无法解析 | shell analysis / sandbox paths | 标记 `hasDynamic=true`，不阻断 |
| 外部路径 | sandbox + scheduler | 先走 `external_directory` 评估 / ask |
| denylist 命中 | sandbox + scheduler | 直接 rejected，不进入 ask |
| 敏感文件命中 | sandbox + scheduler | 先走 `sensitive_path` 评估 / ask |
| permission ask 被拒 | scheduler | rejected |
| spawn 失败 | bash tool | ExecutionError |
| timeout / abort | bash tool / scheduler | TimeoutError / CancelledError |

## 与 snapshot 的接触点

improve-1 不修改 snapshot 模块。snapshot 通过 `RunHookContext.sandboxLease?.workdir`
取工作目录，这条路径在 rich `SandboxLease` 成为统一 execution environment 后仍然有效。

[adapters/ui-persistent.ts](../../../packages/ohbaby-agent/src/adapters/ui-persistent.ts) 中
`workspaceSource: "sandbox"` 的命名债务留给后续 improve-2，不混入本轮。

## 小结

- shell 负责理解命令。
- sandbox 负责理解 workspace 边界。
- scheduler 负责 external-first 与 sensitive-path 编排。
- permission 负责最终决策与记忆。
- bash tool 只在 permission 完成后执行命令并做进程硬化。
