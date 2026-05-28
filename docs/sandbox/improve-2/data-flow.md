# Sandbox improve-2 数据流

本文描述 session 动态可信根与脚本执行事实如何流经 sandbox preflight。shell 侧产出见
[shell improve-2 data-flow](../../shell/improve-2/data-flow.md)。

## 端到端流程（多根 + 脚本）

```text
Agent tool_call: bash({ command: "python ~/.claude/skills/foo/run.py data.json" })
  |
  v
ToolScheduler.prepareCall
  |-- environment.preflight(command, shellKind)
  |     |
  |     |-- shell.analyzeShellCommand(command, shellKind)
  |     |     -> commands[0] = {
  |     |          interpreter: "python",
  |     |          executedScript: "~/.claude/skills/foo/run.py",
  |     |          pathArgs: [],            // 裸 data.json 语义不明，默认不抽
  |     |          danger: "mutating", ...
  |     |        }
  |     |
  |     |-- sandbox.preflight({ shell, trustedRoots })
  |           trustedRoots(session) = [
  |             workspace,
  |             active-skill: ~/.claude/skills/foo,
  |             external-approved: <only dirs user chose always allow>,
  |             skill-output: <workspace>/.ohbaby/skill-runs/...
  |           ]
  |           |
  |           |-- 对 executedScript:
  |           |     resolve -> /home/u/.claude/skills/foo/run.py
  |           |     denylist? no
  |           |     classifySandboxPath(path, trustedRoots) -> inside (active-skill exact baseDir 命中)
  |           |     -> internalPaths（带 isExecutedScript 标注），不进 externalPaths
  |           |
  |           |-- 对 pathArgs: []（无）
  |
  |-- denylistHits? -> reject
  |-- externalPaths? -> external_directory ask   ← 本例为空，跳过（已加载 skill baseDir 可信）
  |-- sensitivePaths? -> sensitive_path ask       ← 空
  |-- bash permission（mutating -> ask 或按 rule）
  v
bash.execute()
  |-- resolveCommandContext() -> { cwd, env(注入 skill-dir 变量) , commandPrefix }
  |-- spawn / 非交互 env / stdin close / 截断
  v
ToolExecutionResult
```

对比 improve-1：同一条命令在单根下 `~/.claude/skills/foo/run.py` 会判 `outside` → 每次 external ask；
improve-2 因为该 exact skill `baseDir` 已在 session trusted roots 内 → `inside` → 不弹窗。
这就是多根的核心收益。注意：信任的是 `~/.claude/skills/foo`，不是 `~/.claude/skills` 父目录。

## 多根 boundary 判定

```ts
// boundary.ts (改)
export function classifySandboxPath(input: {
  readonly absolutePath: string;
  readonly trustedRoots: readonly string[];
}): SandboxPathBoundary {
  for (const root of input.trustedRoots) {
    if (containsOrEqualPath(root, input.absolutePath)) {
      return "inside";
    }
  }
  return "outside";
}
```

规则：**inside 任一可信根即 inside**；全部不在才 outside。trusted root paths 已 canonicalize（realpath）后传入。

## 判定优先级（不变式落地）

对每个 resolved 路径（无论来自 `executedScript` 还是 `pathArgs`），顺序固定：

```text
1. denylist（home 凭据目录）         -> 命中即 hard-deny，停止
2. sensitive（.env/*.pem/*.key/rc）  -> 命中则记入 sensitivePaths（不停止，仍判边界）
3. 多根 boundary                     -> outside 记 externalPaths；inside 记 internalPaths
```

关键：**denylist 优先于多根**。即使某可信根恰好包含 `.ssh`（例如 skill 根设错），
`cat <root>/.ssh/id_rsa` 仍 hard-deny。可信 ≠ 豁免凭据保护。

## executedScript 在 PreflightResult 的落点

```ts
// 复用 improve-1 的三个 bucket，附 isExecutedScript 标注
interface PreflightExternalPath {
  readonly original: string;
  readonly absolutePath: string;
  readonly askPattern: string;
  readonly isExecutedScript?: boolean;   // 新增
}
interface PreflightInternalPath {
  readonly original: string;
  readonly absolutePath: string;
  readonly isExecutedScript?: boolean;   // 新增
}
// PreflightDenylistHit / PreflightSensitivePath 同样可加 isExecutedScript?
```

`isExecutedScript` 让 UI / 日志能区分"执行脚本 X（在外部）"与"读取数据文件 Y（在外部）"，
permission ask 的措辞可以更准确（"将执行 workspace 外脚本：…"）。功能上不改变 ask 流程。

`external_directory` 的 `askPattern` 继续表达"本次要批准的目录"：若 resolved path 已存在且是目录，
pattern 指向该目录本身；若它是文件或尚不存在，则指向父目录。这样 `cd /tmp/foo` 的 always allow
只升级 `/tmp/foo`，不会意外把 `/tmp` 整体写入 trusted roots。

## trusted roots 的来源（session 动态事实）

```text
session start / sandbox context init
   -> TrustedRootRegistry.add({ kind: "workspace", path: workdir })

skill tool 成功加载 SKILL.md
   -> TrustedRootRegistry.add({ kind: "active-skill", path: exactSkillBaseDir, source: { skillName } })

external_directory ask
   -> allow once: 不写 registry，只放行当前调用
   -> always allow: TrustedRootRegistry.add({ kind: "external-approved", path: approvedDirectory })

skill run/output setup
   -> TrustedRootRegistry.add({ kind: "skill-output", path: <workspace>/.ohbaby/skill-runs/... })

lease.preflight / resolvePath* / file tools
   -> 读取 registry 当前 session roots
   -> 多根 boundary 判定
```

improve-2 约定：
- workspace root 总是存在，是 primary cwd 与默认读写边界。
- active skill root 的粒度是**已加载过的 exact skill baseDir**，保留到 session 结束；不会提升到父级
  skills 目录，也不会信任未加载 skill。
- external-approved root 只来自用户 `always allow` 或未来明确配置；`allow once` 不升级。
- 系统 temp 默认不信任；如果用户批准 temp always，则作为 `external-approved` 进入 registry，bash 与 file
  tools 共同消费，避免"脚本能写、Read 读不了"。

## 执行环境注入（G5，为 skill 预留）

```ts
// lease.resolveCommandContext(options) 可返回：
interface CommandContext {
  readonly kind: SandboxAdapterId;
  readonly cwd: string;                          // 默认 workspace；skill 可要 skill 目录
  readonly env?: Record<string, string>;         // skill 注入 OHBABY_SKILL_DIR 等
  readonly commandPrefix?: readonly string[];    // OS adapter 用，host-local 为空
}
```

host-local 默认返回 `{ cwd: workspace, kind: "host-local" }`（无额外 env），行为与 improve-1 一致。
skill 调用上下文未来可注入：

```text
OHBABY_SKILL_DIR=<active exact skill baseDir>
OHBABY_SKILL_OUTPUT_DIR=<workspace>/.ohbaby/skill-runs/<sessionId>/<callId>
```

这只是执行环境地基，不等于本轮实现 skill manifest 或专用 `run_skill_script`。

## 与 inlineEval 的关系

shell 标 `inlineEval = true`（如 `python -c '...'`）的命令通常没有 `executedScript`，
sandbox 无路径可查，`externalPaths`/`internalPaths` 对它为空。安全性由 permission 按
`danger`（improve-2 中 inlineEval 建议标 dangerous，见 [shell data-flow D2](../../shell/improve-2/data-flow.md)）兜底。

## 已确认决策

- **D1（skill 根注入粒度）**：已确认采用"所有已加载过的 exact skill baseDir，保留到 session 结束"。
  不信任父级 skills 目录，不信任未加载 skill。
- **D2（temp 目录是否默认可信）**：已确认默认不信任系统 temp，但允许用户通过 `external_directory`
  的 always allow 或未来显式配置手动信任；一旦信任，bash/file tools 共享。
- **D4（cd/pushd/Set-Location 到 trusted root）**：shell hard preflight 目前的 directory-changing
  安全闸以 `rootCwd` / workspace 为中心。已确认：允许 cd 到任一 trusted root；未信任外部目录不由
  shell 自行硬拒，而是进入 external_directory permission 流，由用户/权限档位决定。
- **D5（skill_resource 是否激活 skill root）**：现有 `skill_resource` 可按 name 直接读取 skill 内 reference，
  不一定先调用 `skill` 工具。已确认：`skill` 和 `skill_resource` 成功返回 skill 内容时都视为"已加载"，
  都注册 exact baseDir。

## 待确认决策

- **D3（isExecutedScript 是否影响 ask 文案/粒度）**：本轮只加标注、不改 ask 行为。是否要为
  "执行外部脚本"单列一种比 external_directory 更强的确认？留未来。

## 运行权限档位说明

当前 permission 模型已有 `mode=auto` 与 `level=full-access`。它可以自动 allow 大多数普通 tool/bash/
external_directory/sensitive_path permission，但仍不是完整 autopilot：

- sandbox denylist（例如 home 凭据目录）仍在 permission ask 前 hard-deny。
- shell hard preflight（例如危险根删除、无法安全静态检查的命令形态）仍可能直接拒绝。
- scheduler 目前对 workspace 外写有额外确认逻辑；improve-2 会让它按 trusted roots 判断，但未信任外部写
  是否在 full-access/autopilot 下自动放行，需要 permission 模块另行定义。

已确认：本轮不新建 `autopilot` 档位。若后续需要"自动驾驶"档位，应在 permission 模块定义明确
profile（例如 `autopilot`）：默认不询问，只保留少量硬安全闸（系统盘 OS 文件、凭据目录、破坏性根
删除等）。本轮 shell/sandbox 只保证现有档位有足够路径事实可用，不直接重写 permission profile。
