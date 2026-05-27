# Shell 模块职责定位

## improve-1 的目标

shell improve-1 的目标是把 `src/shell/` 从“shell 路径检测 + 进程树 kill 工具”
扩展为完整的 **shell 命令分析与执行支撑层**。

它负责回答：

- 当前应使用哪个 shell？
- 这个 shell 属于 bash / cmd / powershell 哪一类？
- 一段命令包含哪些 command 节点、tokens、path 参数、动态表达式？
- 运行命令时应怎样构造 args、env、cwd、stdin、取消和超时行为？

它不负责回答：

- 这个路径是否允许访问？
- 这个命令是否应该向用户 ask？
- 这个工具调用是否应被 deny？

这些决策分别属于 [sandbox](../../sandbox/improve-1/goal-and-duty.md) 和 permission。

## 职责分解

### 1. Shell 检测

文件：`packages/ohbaby-agent/src/shell/detector.ts`

职责：

- 解析用户或环境提供的 shell 路径。
- Windows 优先选择可接受的 Git Bash / bash / PowerShell / cmd。
- 拒绝 `fish`、`nu` 等当前 parser 与执行语义无法可靠覆盖的 shell。

### 2. Shell 参数构造

文件：`packages/ohbaby-agent/src/shell/preflight.ts` 当前已包含 `shellArgs()`，后续可拆到
`src/shell/args.ts`。

职责：

- bash-like shell 使用 `-lc` 或后续登录 shell wrapper。
- PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`。
- cmd 使用 `/d /s /c`。

### 3. Shell 命令分析

文件建议：

```text
packages/ohbaby-agent/src/shell/analysis/
  index.ts
  types.ts
  light-parser.ts
  tree-sitter.ts
  bash.ts
  powershell.ts
```

职责：

- 把 command string 解析为 `ShellCommandAnalysis[]`。
- 多命令拆分：`a; b && c | d` 需要保留每条 command 的 `source`。
- 抽取 tokens：用于 bash permission pattern 与 arity。
- 抽取 path args：只做 shell 层面的“哪些 token 可能是路径”。
- 标记动态表达式：`$()`、`${}`、反引号、PowerShell 未求值变量等。
- 计算 bash permission 所需的 `arityKey`。
- 产出命令危险等级：`readonly` / `mutating` / `dangerous`。

非职责：

- 不判断 path inside/outside。
- 不展开到真实 filesystem 边界。
- 不 hard deny。

### 4. 进程执行硬化

文件：`packages/ohbaby-agent/src/tools/bash.ts` 与 `packages/ohbaby-agent/src/shell/process.ts`

职责：

- 注入 non-interactive env：
  - `NO_COLOR=1`
  - `TERM=dumb`
  - `GIT_TERMINAL_PROMPT=0`，但尊重用户显式环境变量
  - `SHELL=<resolved shell path>`
- spawn 后关闭 stdin，避免 `cat`、`read`、REPL 等等待交互输入。
- timeout / abort 时杀进程树。
- 保持 stdout/stderr 截断，避免输出拖垮上下文。

### 5. commandPrefix 桥接

文件：`packages/ohbaby-agent/src/tools/bash.ts`

职责：

- 支持 `ToolCommandContext.commandPrefix`。
- HostLocalAdapter 默认返回空 prefix。
- 未来 OS sandbox 或 remote adapter 可以返回 prefix，不需要改 builtin bash。

实现原则：

- improve-1 可以只支持“prefix 作为执行 wrapper”，不扩展为复杂 shell DSL。
- 如果 prefix 语义无法在当前 shell 安全表达，应显式返回清晰错误，而不是静默忽略。

## 与 sandbox 的契约

shell 提供结构化语法事实：

```ts
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

sandbox 使用这些事实做 workspace 事实分析：

- `pathArgs` → 解析为绝对路径。
- inside path → 记录为内部事实。
- outside path → `externalPaths`，交给 `external_directory` permission。
- denylist path → `denylistHits`，交给 scheduler hard deny。

这条边界遵循 SRP：shell 理解 shell，sandbox 理解 workspace，permission 理解决策。

## 与 permission 的契约

shell 不调用 `permission.ask()`。

permission ask 的顺序由 scheduler 编排：

1. `external_directory` 优先。
2. 外部路径批准后，再按原 bash rule 判断 `bash` 权限。
3. denylist 命中直接拒绝，不进入 ask。

这样可以支持 skill scripts 中常见的 `../`、绝对路径和 `~` 路径，同时仍保留用户控制。

## 非目标

- 不创建后台任务系统。
- 不引入 Kaos 或 Effect runtime。
- 不做 OS syscall 拦截。
- 不做 network allowlist。
- 不让 LLM 判断命令安全性。
- 不在 skill 模块里复制一套 shell 执行逻辑。

## 工程原则

- **KISS**：shell analysis 只产出语法事实，不混入 permission。
- **YAGNI**：不提前实现容器、远程 shell、后台任务。
- **DRY**：skill scripts、agent bash、未来 automation bash 都走同一个 bash tool。
- **SOLID**：parser、path boundary、permission evaluator 分属不同模块，避免胖接口。
