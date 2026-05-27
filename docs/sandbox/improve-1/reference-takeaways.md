# 业界参考项目的设计借鉴

本文按项目分四节，每节先描述项目实际做了什么、然后明确"我们采纳 / 不采纳 / 改造"。
不是综述，是抉择记录。

## 一、opencode（主要标杆，采纳最多）

### 1.1 opencode 实际架构

opencode **没有 sandbox 模块**——它的整个安全模型分布在 [bash tool 自身](../../../opencode/packages/opencode/src/tool/bash.ts) 和 [permission/](../../../opencode/packages/opencode/src/permission/) 两处。

[bash.ts](../../../opencode/packages/opencode/src/tool/bash.ts) 的关键能力：

| 行 | 能力 |
|---|---|
| L299-324 | lazy 加载 `web-tree-sitter` + `tree-sitter-bash` + `tree-sitter-powershell` WASM |
| L91-117 | `parts(node)` 从 tree-sitter Node 抽出参数列表 |
| L123-125 | `commands(node)` 从 AST 拿到所有 `command` 子节点（支持 `;` `&&` 多命令） |
| L174-179 | `dynamic()` 识别 `$()`、`${}`、反引号、未求值变量 |
| L154-160 | `expand()` 展开 `~`、`$HOME`、`$env:NAME`、`%USERPROFILE%` |
| L336-354 | Git Bash 场景的 `cygpath -w` 兼容（POSIX `/c/foo` → Windows `C:\foo`） |
| L365-394 | `collect()` 协调：扫描每个 FS 操作命令的路径参数，挑出 workspace 外的 |
| L258-279 | `ask()` 分两类发问：`external_directory`（pattern 是 `"<dir>/*"`） + `bash`（pattern 是命令源 + arity 通配） |

[permission/arity.ts](../../../opencode/packages/opencode/src/permission/arity.ts) 是 100+ 条
工具→token 长度的静态字典，配合 `BashArity.prefix(tokens)` 用于 always-allow 通配键计算。

[permission/evaluate.ts](../../../opencode/packages/opencode/src/permission/evaluate.ts) 仅 16 行：
按"最后匹配优先"评估 rule 链，没匹配默认 ask。

### 1.2 采纳列表

| 设计点 | 采纳形式 |
|---|---|
| tree-sitter 多语言 AST 解析（bash + powershell） | 直接采纳，但落在 [shell/improve-1](../../shell/improve-1/integration-plan.md) 的 `src/shell/analysis/` |
| `dynamic()` 识别动态表达式 | 采纳，作为 `ShellCommandAnalysis.hasDynamic` 字段，再由 PreflightResult 透传 |
| `expand()` 路径前缀展开（~/$HOME/$env） | 采纳，作为 `src/sandbox/paths.ts` |
| Git Bash 的 `cygpath -w` 兼容 | 采纳，作为 `paths.ts` 的 Windows 分支 |
| `Instance.containsPath` workspace 边界 | 采纳，作为 `src/sandbox/boundary.ts` |
| 两类 ask：external_directory + bash | 采纳，但由 scheduler 编排；先 external_directory，批准后再 bash |
| 100+ arity 字典 | 整表拷贝，建议作为 `src/shell/analysis/arity.ts` |
| `BashArity.prefix(tokens).join(" ") + " *"` 通配键 | 采纳，作为 `ShellCommandAnalysis.arityKey` |

### 1.3 不采纳 / 改造

| 设计点 | 我们的选择 | 原因 |
|---|---|---|
| sandbox 作为 bash tool 内部模块（无独立 sandbox 抽象） | **改造**：shell 做命令分析，sandbox 做 workspace facts，rich `SandboxLease` 暴露 preflight | 我们已有 rich 抽象骨架；保留多 adapter 多态是好事 |
| `(/permission/)Bash` ask 时把"是否动态命令"等元信息直接塞 metadata | **采纳**：通过 `ShellCommandAnalysis.hasDynamic` / `PreflightResult.commands[].hasDynamic` 字段实现 | 字段命名标准化 |
| `Plugin.trigger("shell.env", ...)` 让插件注入 env | 不采纳（improve-1） | 没有插件系统，工作量大 |
| `Truncate.Service` 输出截断（按 bytes/lines 双限） | 不强采纳 | 现有 bash.ts 已有 `appendLimitedOutput` 截断，等效 |
| `Effect`-based 异步流（Effect.scoped / Effect.raceAll） | 不采纳 | 项目用 native Promise，改成 Effect 是另一个项目 |
| `web-tree-sitter` 的 WASM 加载方式（`import ... with: { type: "wasm" }`） | 采纳 | 跨平台一致，不需要 native build |

### 1.4 我们补强的（opencode 没有但我们做的）

| 增量 | 为什么 |
|---|---|
| denylist（`~/.ssh` 等 hard-deny） | opencode 完全靠 external_directory ask 走兜底；我们觉得 ssh-key 这类不应该让用户能"always allow"。属于产品决策。 |
| PreflightResult schema 标准化 | opencode 把 sandbox 嵌入 bash tool，所以没必要标准化；我们要给 permission 消费，需要结构化字段。 |
| scheduler 做 external-first 编排 | opencode 在 bash tool 内部先问 external_directory 再问 bash；我们的工具不直接 ask，所以把同样顺序放到 scheduler。 |

## 二、kimi-code（次要标杆，采纳进程硬化思路）

### 2.1 kimi-code 实际架构

kimi-code 的 [bash.ts](../../../kimi-code/packages/agent-core/src/tools/builtin/shell/bash.ts) 走的是
**"不解析命令，靠 permission 模式 + 强硬化"** 路线：

| 部分 | 实现 |
|---|---|
| 命令解析 | **没有**。命令是 string，直接交给 shell |
| workspace 边界 | **没有**。完全依靠外部 permission 模式（manual/yolo/auto） |
| 进程硬化 | 极强：timeout（前台默认 60s/最大 5min、后台默认 10min/最大 24h）；stdin 立即关闭（防 `cat`/`read` 挂死）；SIGTERM → 5s grace → SIGKILL；输出走 `ToolResultBuilder` 截断 |
| 后台任务 | 一等公民：`BackgroundProcessManager` 可注册/查询/停止；每任务有 task_id；agent 可 poll；用户 `/tasks` 看面板 |
| non-interactive env | `NO_COLOR=1`、`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SHELL` 显式设置 |
| Windows 兼容 | Git Bash 路径转换（C:\foo → /c/foo）、`>NUL` → `>/dev/null` 重写 |

### 2.2 采纳列表

| 设计点 | 采纳形式 |
|---|---|
| non-interactive env 三件套（NO_COLOR / TERM / GIT_TERMINAL_PROMPT） | **采纳，且不在 sandbox 模块**——这是 bash tool 自己的 env 注入，improve-1 顺手加到 [tools/bash.ts](../../../packages/ohbaby-agent/src/tools/bash.ts) 的 `stateEnvironment()` 里 |
| stdin 立即 end | **采纳**，加在 bash.ts spawn 后 |
| SIGTERM → grace → SIGKILL | 现有 [bash.ts shell.killTree](../../../packages/ohbaby-agent/src/tools/bash.ts) 已经做了类似的杀进程树，improve-1 不动 |
| Windows `>NUL` 重写、cygpath 兼容 | cygpath 在 §1 已采纳；`>NUL` 重写改造到 [shell/preflight.ts](../../../packages/ohbaby-agent/src/shell/preflight.ts) 顺手做 |

### 2.3 不采纳 / 改造

| 设计点 | 我们的选择 | 原因 |
|---|---|---|
| 不解析命令 | **不采纳**——我们采用 opencode 的 tree-sitter 路线 | kimi-code 牺牲了"边界提示能力"，我们更想要 |
| `Kaos` 跨平台 shell 抽象 | 不采纳 | 项目直接用 `node:child_process`，引入 Kaos 是 lockin |
| BackgroundProcessManager / `/tasks` 面板 | 不在 improve-1 | 与 sandbox 正交；现有 ohbaby-agent 是否要后台任务是单独决策 |
| 命令默认 60s 短 timeout | 不采纳 | 现有 ohbaby-agent 默认 120s，更保守，沿用 |

## 三、DeepSeek-TUI（参考但不采纳——OS 级 sandbox 的代价）

### 3.1 DeepSeek-TUI 实际架构

[DeepSeek-TUI](../../../DeepSeek-TUI/crates/tui/src/sandbox/mod.rs) 是真正做 OS 级隔离的：

| 平台 | 实现 |
|---|---|
| macOS | [seatbelt.rs](../../../DeepSeek-TUI/crates/tui/src/sandbox/seatbelt.rs)：`sandbox-exec -p '<scheme policy>' -- <cmd>`，TrustedBSD 框架拦 syscall |
| Linux | [landlock.rs](../../../DeepSeek-TUI/crates/tui/src/sandbox/landlock.rs)：进程通过 `landlock_create_ruleset()` 给自己装上不可逆访问限制 |
| Windows | [windows.rs](../../../DeepSeek-TUI/crates/tui/src/sandbox/windows.rs) + [opensandbox.rs](../../../DeepSeek-TUI/crates/tui/src/sandbox/opensandbox.rs)：**仅** Job Object 做进程包容；**明确声明** "不做 FS/网络/注册表隔离" |

它的 `SandboxManager.prepare(spec) → ExecEnv` 把 sandbox 透明拼到命令前缀
（如 `["sandbox-exec", "-p", policy, "--", "echo", "hello"]`）。

### 3.2 为什么不采纳（improve-1）

| 痛点 | 详情 |
|---|---|
| 跨平台破碎 | 三平台三套实现 + 三套测试 + 三套调试手感 |
| Windows 残废 | Job Object 不做 FS/网络隔离，Windows 端的"sandbox"实际只是进程树包容，跟 macOS/Linux 不对等 |
| 策略难写 | Seatbelt 的 Scheme DSL 不开源也不稳定；Landlock 只管 FS、不管网络/进程 |
| 调试地狱 | 命令失败时，是命令错还是策略错？需要工具读 syslog/audit log |
| 外部依赖 | Linux 要求装 `bwrap`；macOS 的 `sandbox-exec` 苹果一直说要废弃但没废 |
| Nested 环境怪事 | 在 docker / WSL 里跑 agent，再嵌一层 bubblewrap，触发各种 corner bug |
| 工作量 | 估计是应用层方案的 3-5 倍 |

参考标杆（opencode、kimi-code）明确选择不做 OS 级，理由相同。

### 3.3 留作未来 adapter 的接口

虽然不在 improve-1 实装，但 rich `SandboxAdapter` 接口已经为它留好了位置：

```ts
// 未来 src/sandbox/adapters/seatbelt-host.ts（不在 improve-1）
export class SeatbeltHostAdapter implements SandboxAdapter {
  readonly id = "seatbelt-host";
  getCapabilities(): SandboxCapabilities {
    return { isolation: "none", canExecCommands: true, supportsGit: true, readOnly: false };
  }
  resolveCommandContext(handle): CommandContext {
    return {
      kind: "seatbelt-host",
      cwd: handle.workdir,
      commandPrefix: ["sandbox-exec", "-p", buildPolicy(handle), "--"],
    };
  }
  // ...
}
```

bash tool 已经从 `commandContext.commandPrefix` 读，HostLocalAdapter 永远返回空，
未来 SeatbeltHostAdapter 返回非空——零修改 bash tool。这是 improve-1 保留 rich 抽象的核心收益。

### 3.4 DeepSeek-TUI 的 snapshot 设计（与 sandbox 无关，但顺手记下）

[snapshot/](../../../DeepSeek-TUI/crates/tui/src/snapshot/) 用 **side git repo**
（`~/.deepseek/snapshots/<project>/<worktree>/.git`）做 pre/post-turn 双快照，带 7 天保留 + 50 个上限。
这是 snapshot/improve-2 的好参考——但不在本轮 sandbox scope。

## 四、pi（参考——extension 化的思路）

### 4.1 pi 实际架构

pi 的核心**不预设 sandbox 抽象**，把 sandbox 做成可选 extension：
[examples/extensions/sandbox/index.ts](../../../pi/packages/coding-agent/examples/extensions/sandbox/index.ts)

| 部分 | 实现 |
|---|---|
| 启用方式 | `pi -e ./sandbox` CLI 参数，或 `pi -e ./sandbox --no-sandbox` 关闭 |
| 隔离引擎 | `@anthropic-ai/sandbox-runtime`（封装 sandbox-exec / bubblewrap） |
| 配置 | `~/.pi/agent/extensions/sandbox.json` 全局 + `<cwd>/.pi/sandbox.json` 项目本地，project 覆盖 global |
| 配置内容 | `network.allowedDomains` / `network.deniedDomains` / `filesystem.denyRead` / `filesystem.allowWrite` / `filesystem.denyWrite` |
| 集成方式 | 通过 ExtensionAPI 覆盖（或包装）内置 `bash` 工具 |

### 4.2 借鉴的设计哲学

| 设计点 | 我们的选择 |
|---|---|
| 配置文件 schema（denyRead/denyWrite/allowWrite/allowDomains）| **未来借鉴**：improve-2 如果做配置化策略，用类似的 schema |
| `pi -e ./sandbox` extension 化机制 | **不采纳**：ohbaby-agent 当前没有 extension 系统，sandbox 留在核心，作为可禁用模块（`OHBABY_SANDBOX_PREFLIGHT_ENABLED`） |
| denylist 默认值（`~/.ssh`、`~/.aws`、`~/.gnupg`、`.env`、`*.pem`、`*.key`） | **直接采纳**：作为 `src/sandbox/denylist.ts` 的初始内容 |
| network allowlist（npmjs.org/pypi.org/github.com 等） | **不采纳**：网络隔离是 OS 级才能强制的，改造到应用层意义不大 |

## 五、整体决策摘要表

| 项 | opencode | kimi-code | DeepSeek-TUI | pi | improve-1 决策 |
|---|---|---|---|---|---|
| OS 级隔离 | ❌ | ❌ | ✅ | ✅(extension) | ❌（但留 adapter 接口） |
| tree-sitter 解析 | ✅ | ❌ | n/a | ❌ | ✅（shell 模块负责） |
| workspace 边界 | ✅ | ❌ | n/a | ✅(配置) | ✅ |
| 敏感路径黑名单 | ❌ | ❌ | n/a | ✅ | ✅ |
| arity 字典 | ✅ | ❌ | n/a | ❌ | ✅（shell analysis 负责） |
| external_directory ask | ✅ | ❌ | n/a | n/a | ✅（scheduler external-first） |
| 配置化策略 | ❌ | ❌ | ❌ | ✅ | ❌（improve-2 候选） |
| 进程硬化 | ✅ | ✅(最强) | ✅ | 委托引擎 | 沿用现状，补 non-interactive env |
| 后台任务 | ❌ | ✅ | ❌ | ❌ | 不在 sandbox scope |

## 六、不会被借鉴的"看上去很对但实际没用"的东西

记录这些是为了防止 future round 重复讨论：

| 想法 | 不做的原因 |
|---|---|
| "给 sandbox 加配置文件，让用户自定义 allow/deny" | improve-1 范围控制；后续看是否真有用户场景 |
| "用 docker/容器做隔离" | 启动慢（短命令场景 unacceptable），nested 环境兼容性差，对 agent 的"快速试错"模式不友好 |
| "用 firejail 做轻量隔离" | Linux only；与 bwrap 重叠；维护活跃度低 |
| "用 gVisor / Firecracker" | microVM 启动慢；syscall 兼容性问题；过度工程 |
| "把 sandbox 拆成独立进程，通过 RPC 调用" | 加一层进程边界对解析+权限决策没有可见收益，调试更难 |
| "让 LLM 帮忙判断命令是否危险" | LLM 已经在生成命令了，再用 LLM 做安全判断是循环依赖；快速 + 确定性的规则更可靠 |
