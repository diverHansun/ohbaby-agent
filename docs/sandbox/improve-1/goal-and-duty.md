# Sandbox 模块的职责定位

## 现状误差

### 同名抽象有两套，且彼此不相往来

仓库里同时存在两个名为 `SandboxManager` 的接口：

| 抽象 | 位置 | 实际状态 |
|---|---|---|
| Rich `SandboxManager` + `AdapterRegistry` + `HostLocalAdapter` + 全套 capabilities/lease 生命周期 | [src/sandbox/](../../../packages/ohbaby-agent/src/sandbox/) | 通过 [src/index.ts](../../../packages/ohbaby-agent/src/index.ts) 对外导出，但 `src/` 内部**零运行时引用**。`AdapterRegistry.register()` 在生产代码中没有任何调用方。死代码。 |
| 简版 `SandboxManager`（仅 `acquire` / `release`） | [runtime/run-manager/types.ts](../../../packages/ohbaby-agent/src/runtime/run-manager/types.ts) + [adapters/ui-runtime/host-local-environment.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts) | 真正在跑。被 [composition.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) 注入 RunManager，[manager.ts](../../../packages/ohbaby-agent/src/runtime/run-manager/manager.ts) 调用 `acquire` 拿 lease 挂进 `RunContext.sandboxLease`。 |

简版实质只做一件事：**路径越界校验**（[host-local-environment.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts) 的 `assertInsideWorkdir`）。
没有命令解析、没有黑名单、没有 OS 级隔离、没有任何能称为 "sandbox" 的行为。
名字与实质不匹配。

### bash tool 留了洞但没有人填

[tools/bash.ts](../../../packages/ohbaby-agent/src/tools/bash.ts) 已经从 `commandContext` 里读
`commandPrefix`，但当 `commandPrefix.length > 0` 时直接 throw：

```
"ToolExecutionContext commandPrefix is not supported by builtin bash yet;
 wire a command context bridge with final cwd/env before running bash."
```

接入点早就设计好了，预留了 sandbox 改写命令的能力，但补完工作一直没人做。
improve-1 要补完的就是这条线。

### permission 也留了类型但没有人 ask

[permission/types.ts](../../../packages/ohbaby-agent/src/permission/types.ts) 第一行：

```ts
export type PermissionType =
  | "tool"
  | "bash"
  | "skill"
  | "external_directory"
  | "sensitive_path";
```

`external_directory` 这个枚举值早已存在，但 improve-1 之前全仓库**没有任何
`ask({ type: "external_directory", ... })` 调用**。原因正是 sandbox 这一层不报"哪些路径在外部"
这个事实，permission 想问也无从问起。

`sensitive_path` 是本轮 review 后补上的窄类型，用来把 `.env`、`*.pem`、`*.key`
这类项目内可能合法的敏感文件从 hard-deny 降级为可审计的 ask，避免 fixtures / dev cert
被无逃生口地拒绝。

## improve-1 的 Goal

> Sandbox 模块在 improve-1 之后承担**"workspace 边界事实供应方 + 敏感路径守门人 + 统一 execution environment"**的职责。
> 它不再二次实现 shell parser，而是消费 [shell/improve-1](../../shell/improve-1/goal-and-duty.md)
> 产出的 `ShellAnalysisResult`，把其中的 path args 解析成 workspace 边界事实：
> 哪些路径在 workspace 内、哪些解析到 workspace 外、哪些撞了 hard-deny denylist、
> 哪些需要 `sensitive_path` 二次确认。

这是一个**单一职责**：shell 理解命令语法，sandbox 理解 workspace 边界，
permission 理解决策和用户确认。

## 单一职责分解（4 个内聚单元）

improve-1 把 sandbox 拆为 4 个内聚单元，每个单元有清晰的对外契约：

### 1. preflight 协调器（`src/sandbox/preflight.ts`）

- **做什么**：接收 shell analysis、workdir 和 shellKind，返回 `PreflightResult`
- **怎么用**：`lease.preflight(command, shellKind)` 内部先调 shell analysis，再调 sandbox preflight
- **依赖**：shell analysis、路径解析器、边界检查、黑名单

### 2. shell analysis 消费层（不拥有 parser）

- **做什么**：读取 `ShellAnalysisResult.commands[].pathArgs / tokens / danger / arityKey / hasDynamic`
- **怎么用**：把 shell 事实透传进 `PreflightResult.commands`，并只对 `pathArgs` 做边界分类
- **边界**：tree-sitter、动态表达式识别、bash arity pattern、命令危险等级都属于 shell 模块

### 3. 路径解析器（`src/sandbox/paths.ts`）

- **做什么**：把 shell 标出的字面 path args 展开成绝对路径，处理 `~`、`$HOME`、`$env:USERPROFILE`、Windows 盘符、Git Bash 的 `cygpath`
- **怎么用**：`paths.resolveArgPath(arg, workdir, shellKind) → string | undefined`（动态或不可解析参数返回 undefined，由 bash permission 兜底）
- **依赖**：仅 `node:path` + `node:os`

### 4. 边界检查 + 敏感分类（`src/sandbox/boundary.ts` + `src/sandbox/denylist.ts`）

- **做什么**：判断一个绝对路径是否在 workspace 之内、是否撞中 hard-deny denylist 或 sensitive ask 列表
- **怎么用**：`boundary.classify(path, workdir) → "inside" | "outside"`，再由 `classifyDenylistedPath()` / `classifySensitivePath()` 补充安全事实
- **外部路径不是错误**：进入 `externalPaths`，由 scheduler 先触发 `external_directory` ask
- **hard-deny 只用于高确信 home 凭据目录**：`~/.ssh`、`~/.aws`、`~/.gnupg` 不进 permission ask 流程，直接拒绝
- **项目敏感文件走 ask**：`.env`、非模板 `.env.*`、`*.pem`、`*.key`、shell rc 进入 `sensitivePaths`

每个单元都满足：
- 对外只暴露一个或两个纯函数 / 方法
- 不依赖 permission、不依赖工具执行、不依赖 IO
- 可独立单测（不需要起进程、不需要起 DB）

## 非目标声明（不做的事）

下列内容**明确不在 improve-1 范围内**，避免后续讨论再拉扯：

### 1. 不做 OS 级隔离

- 不调用 `sandbox-exec`（macOS Seatbelt）
- 不调用 `landlock_create_ruleset()`（Linux Landlock）
- 不调用 `bwrap`（Bubblewrap）
- 不创建 Windows Job Object 或 AppContainer
- 不启动容器或 microVM

理由：跨平台破碎、策略难写、调试地狱、Windows 端不对称，且参考标杆
（opencode、kimi-code）都明确选择不做。详见 [reference-takeaways.md](reference-takeaways.md)。

### 2. 不做 syscall 拦截 / ptrace / seccomp

- 命令一旦启动就是裸的 child process
- 进程层的硬化（timeout / stdin close / kill chain / 输出截断）由 bash tool 自己做（与 kimi-code 一致）

### 3. 不做配置化的 allow/deny 列表

- 不引入 `.ohbaby/sandbox.json` 或类似配置文件
- 黑名单是内置常量，不可被用户配置（improve-1 后再考虑）

### 4. 不做容器 / 远程 adapter

- `SandboxIsolation` 类型保留 `"none" | "worktree" | "container" | "remote"`，但
  improve-1 只实装 `"none"`（host-local）
- 其他枚举值在 adapter 注册时报 NotImplemented

### 5. 不重写 permission 系统

- permission 的 evaluator / classifier / state 沿用现状
- 只新增"读 preflight 事实"的胶水代码，不改 PermissionRule schema、不改 PermissionDecision schema

### 6. 不改 snapshot 模块

- snapshot 的 `workspaceSource: "sandbox"` 写死字符串保留现状
- 解耦到 `lease.capabilities` 推导留给 improve-2

## 与 permission 的职责契约

```
sandbox 产出  ─►  permission 消费
─────────────     ──────────────
PreflightResult   PermissionDecision
{                 { type: "allow" | "ask" | "deny" }
  commands: [
    { tokens, arityKey, danger }
  ],
  externalPaths: ["/abs/path", ...],
  denylistHits: [
    { path, reason }
  ],
  sensitivePaths: [
    { path, reason }
  ],
}
```

**契约的不变式**：

1. **sandbox 永远不返回 PermissionDecision**。它只产出事实。
2. **permission 永远不解析命令**。它只读 shell / sandbox 的结构化事实和已有的 sessionRules / level。
3. **denylistHits 非空 ⇒ permission 必须拒绝**。这是 sandbox 对 permission 的强约束，
   permission 不应该把 hard-deny 命中物再拿去 ask 用户。代码上由 scheduler 在 ask 前早返实现。
4. **externalPaths 非空 ⇒ scheduler 必须先走 `external_directory` ask**。这是 external path
   priority：无论是绝对路径还是 `../` 解析出的外部路径，都先问外部目录权限；外部路径被批准后，
   再继续 sensitive / bash 阶段。
5. **sensitivePaths 非空 ⇒ scheduler 必须走 `sensitive_path` ask**。这不是 hard-deny，
   而是给 `.env` / key fixture / dev cert 留出用户确认和 session rule 的逃生口。
6. **commands 数组对应多命令拆分**（`a; b && c` 拆成三个）。permission 按数组遍历问。
7. **PreflightResult 内的所有字段都是事实，不是建议**。permission 不需要"信任"sandbox 的判断，
   只需要消费数据。

这个契约是 A 模式的核心。它让 sandbox 可以被独立替换（未来加 SeatbeltAdapter 时，
事实结构不变，只是多了 OS 级 enforcement），也让 permission 系统对 sandbox 的存在
不敏感（即使 sandbox 返回空 PreflightResult，permission 依然能用原有规则跑）。

## 与 PermissionType 的映射

improve-1 使用三类 permission ask，其中 `sensitive_path` 是 review 后新增的窄类型：

| sandbox 产出 | permission ask 类型 | pattern 形态 |
|---|---|---|
| `externalPaths: ["/Users/foo/.config"]` | `external_directory` | `"/Users/foo/.config/*"` |
| `sensitivePaths: ["/repo/.env"]` | `sensitive_path` | `"/repo/.env"` |
| shell commands（经 PreflightResult 透传） | `bash` | once: `"git push origin main"`，always: `"git push *"` |

`denylistHits` 不进 ask 流程，直接 deny，不映射 PermissionType。

## 边界声明

improve-1 的 sandbox 边界是**逻辑边界，不是 OS 边界**。具体含义：

- 一个被识别为"外部路径"的命令，**仍然可以执行**（如果 `external_directory` 和后续 bash 权限都放行）
- 一个被识别为"内部路径"的命令，**也可能误判**（动态表达式 `$()`、变量、未识别的命令）
- hard-deny 命中即拒绝，但仅限**字面路径**——`rm -rf $(echo ~/.ssh)` 这种动态构造的路径，
  sandbox 识别不出来，依赖 permission 对 bash 命令模式的兜底（`rm -rf *` 应该是 dangerous）

这种"不完美但比裸跑安全"的取向，与 opencode / kimi-code 是一致的——它们都依赖
**permission ask + 用户判断**作为最终安全闸，sandbox 只是把闸门更容易打开/关闭。
