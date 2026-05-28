# Sandbox improve-2 接入方案

本文给出 sandbox improve-2 的文件级改动与分阶段实施。shell 侧的 `executedScript` 产出见
[shell improve-2 integration-plan](../../shell/improve-2/integration-plan.md)。

## 总览

| 模块 | 增 | 改 | 删 / 收敛 |
|---|---|---|---|
| [src/sandbox/](../../../packages/ohbaby-agent/src/sandbox/) | `trusted-roots.ts` | `types.ts` / `context.ts` / `manager.ts` / `lease.ts` / `boundary.ts` / `preflight.ts` / `paths.ts` | 合并双 canonicalize（M3） |
| [src/utils/](../../../packages/ohbaby-agent/src/utils/) | `path-canonicalize.ts` | — | shell/sandbox 双 walk-up canonicalize 收敛到共享工具 |
| [src/shell/preflight.ts](../../../packages/ohbaby-agent/src/shell/preflight.ts) | — | import 共享 canonicalize | 删自有 `canonicalizeStaticPath` 副本 |
| [src/adapters/ui-runtime/composition.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) | — | 创建/注入 session `TrustedRootRegistry`，初始化 workspace root | — |
| permission / scheduler | — | `external_directory always` 后写入 `external-approved` root；`allow once` 不写 | 保持 ask 顺序 |

## 文件改动详情

### `src/sandbox/types.ts`

```ts
type TrustedRootKind =
  | "workspace"
  | "active-skill"
  | "external-approved"
  | "skill-output";

interface TrustedRoot {
  readonly path: string;
  readonly kind: TrustedRootKind;
  readonly source?: {
    readonly skillName?: string;
    readonly permissionPattern?: string;
  };
}

interface SandboxLease {
  // ...existing...
  trustedRoots(): readonly TrustedRoot[]; // 或 readonly trustedRoots 属性，由实现选择
  containsTrustedPath(absolutePath: string): boolean; // scheduler externalWrite 与 file tools 共用
}
// PreflightExternalPath / PreflightInternalPath / PreflightDenylistHit / PreflightSensitivePath
// 各加 readonly isExecutedScript?: boolean
```

### 新增 `src/sandbox/trusted-roots.ts`

- 提供 session-scoped registry：
  - `add(sessionId, root)`：canonicalize 后去重写入。
  - `list(sessionId)`：返回 workspace + active-skill + external-approved + skill-output。
  - `clearSession(sessionId)`：session 结束/清理时释放。
- `workspace` root 在 sandbox context/session 创建时写入。
- `active-skill` root 由 skill tool 成功加载 `SKILL.md` 后写入 exact `baseDir`，并保留到 session 结束。
- `external-approved` root 只由 `external_directory` 的 `always` 响应写入；`once` 不写。
- `skill-output` root 使用 workspace 内目录，供后续 skill script 输出和 file tools 读取。

### `src/sandbox/context.ts` / `manager.ts`

- context 仍保留 primary `workdir`，不把 trusted roots 固定为 create-time 数组。
- manager / lease 持有 `TrustedRootRegistry` provider，并在 preflight / resolvePath* 时读取当前 session roots。
- 其余生命周期（lease 计数、drain）不变；destroy/clear 时清理 session roots。

### `src/sandbox/boundary.ts`

- `classifySandboxPath(path, trustedRoots)` 改为遍历根（见 [data-flow.md](data-flow.md)）。
- 保留 `containsOrEqualPath`（已在 improve-1 实现），不重写。

### `src/utils/path-canonicalize.ts`（解决 M3）

- 把 shell `canonicalizeStaticPath` 与 sandbox `canonicalizeSandboxPath` 的 walk-up 逻辑抽成**唯一**实现。
- 命名建议：`canonicalizePathForExistingOrFutureTarget(inputPath)` 或 `canonicalizePathTarget(inputPath)`。
- 放在 `src/utils/`，避免 `shell -> sandbox` 与 `sandbox -> shell` 的双向依赖。

### `src/sandbox/paths.ts`

- 改用共享 canonicalize helper。
- `resolveSandboxPathArg` 不变（仍处理 `~`/`$HOME`/msys/盘符）。
- 顺带：`stripMatchingQuotes`/`msysPathToWindowsPath` 改 import 自共享 `src/utils/path-strings.ts`
  （shell improve-2 S1 产出），消除副本。

### `src/sandbox/preflight.ts`

```ts
// 现有：遍历 command.pathArgs
// 新增：先处理 command.executedScript（若存在），再处理 pathArgs，共用同一判定函数
async function classifyOnePath(input: {
  original: string;
  isExecutedScript: boolean;
  shellKind, trustedRoots, canonicalRoots
}) { /* denylist -> sensitive -> 多根 boundary，写入对应 bucket，带 isExecutedScript */ }
```

- `canonicalWorkdir` 改为 `canonicalRoots = trustedRoots.map(root => root.path)`（registry 写入时已 canonicalize）。
- `classifySandboxPath` 传 `canonicalRoots`。
- `preflightSandboxShellAnalysis` 的入参 `SandboxShellAnalysisPreflightInput` 增加 `trustedRoots`。

### `src/sandbox/lease.ts`

- 透出 `trustedRoots()` 与 `containsTrustedPath(absolutePath)`（从 registry 读取当前 session）。
- `resolvePath` / `resolvePathForExisting` / `resolvePathForWrite` 的 boundary 由单 workdir 改为 trusted roots。
  这让用户 always 信任系统 temp 后，bash 和 Read/Grep/Glob/Write/Edit 共享同一边界事实。
- `preflight()` 内部把当前 trusted roots 传给 `preflightSandboxCommand`。
- `resolveCommandContext` 签名已支持 env 注入；host-local 默认不注入（行为不变）。

### `src/core/tool-scheduler/scheduler.ts`

- `ToolExecutionEnvironment`（或等价 adapter）需要暴露 trusted boundary helper，例如
  `trustedRoots()` / `containsTrustedPath()`，否则 scheduler 仍只能看 `environment.workdir`。
- `preparePermissionContext` 当前用 `isOutsideWorkdir(environment.workdir, canonicalPath)` 判断 write/edit
  的 `externalWrite`。本轮必须改为按 trusted roots 判断：
  - canonicalPath 在 workspace / active-skill / external-approved / skill-output 任一 root 内 ⇒
    `externalWrite = false`，但 Write/Edit 的普通工具权限仍照常 ask/allow。
  - canonicalPath 不在任何 trusted root 内 ⇒ `externalWrite = true`，继续走现有外部写确认与隔离包装。
- `confirmExternalPreflightPermissions` 需要拿到 `external_directory` ask 的实际响应：
  - `once`：继续执行当前调用，不写 trusted roots。
  - `always`：把 `externalPath.askPattern` 对应的 canonical directory 写入 `TrustedRootRegistry`，
    kind = `external-approved`；不要把 glob pattern 本身当 root 存。
- 若 `evaluatePermission` 因已有 session rule 返回 `allow`（auto-approved external_directory），也要幂等写入
  同一个 canonical directory root，保证 permission 规则与 sandbox/file boundary 同步。
- 当前 `confirmPermission()` 会把 `once`/`always` 都折叠成 `null` 返回；实现时要么让它返回 response，
  要么为 external_directory 使用专门的确认函数，避免丢失 "always" 语义。
- permission session rule 仍保留，trusted root 是给 sandbox/file tools 共享的边界事实，两者互补。

### `src/skill/tool.ts` / registry 接缝（仅接入，不优化 skill 模块）

- `skill` 工具成功加载并返回 `baseDir` 后，调用 trusted root registry 写入：
  `kind = "active-skill"`，`path = exact baseDir`，`source.skillName = name`。
- `skill_resource` 成功读取 resource 并返回 `baseDir` 后也写入同样的 active-skill root；
  这样"读 reference 后执行同一 skill 的 script"不会反复 external ask。
- 不改变 skill 发现/加载策略，不重构 `skill/loader.ts`；skill 模块的 config 拆分另开轮次。

### `src/shell/preflight.ts`

- 删 `canonicalizeStaticPath`，import `src/utils/path-canonicalize.ts` 的共享 walk-up helper。
- 不让 shell import sandbox，避免 sandbox 已经依赖 shell analysis/types 时形成方向混乱。
- directory-changing commands（`cd`/`pushd`/`Set-Location`）当前以 workspace `rootCwd` 为硬边界。
  已确认：shell hard preflight 应允许 cd 到任一 trusted root；未信任外部目录不要在 shell 层自行拒绝，
  应作为 external path 进入 `external_directory` permission 流。动态 cd 目标仍按现有静态检查策略处理。

### `composition.ts`

- 初始化 `TrustedRootRegistry` 并写入 `{ kind: "workspace", path: workdir }`。
- 将同一个 registry/provider 传给 sandbox manager、scheduler、skill tool 接缝，保证 bash 与 file tools
  看到同一组 roots。

## 分阶段实施

| 阶段 | 内容 | Exit criteria |
|---|---|---|
| **S1：canonicalize 合并（M3）** | 新增共享 utils canonicalize，shell/sandbox 双方 import | 全量测试绿；行为不变；无 shell↔sandbox 循环 |
| **S2：TrustedRootRegistry 管线** | 新增 registry，workspace root 初始化，lease/file resolve/preflight 读取 registry | 单 workspace 行为与 improve-1 等价；registry 去重/清理单测 |
| **S3：多根 boundary** | `classifySandboxPath` 遍历 trusted roots | boundary 单测覆盖 inside-第二根 / 全 outside |
| **S4：executedScript 消费** | preflight 处理 executedScript + isExecutedScript 标注 | 依赖 shell improve-2 S2 已产出 executedScript；新增 preflight 单测 |
| **S5：external always 共享根** | scheduler 捕获 external_directory always，将目录写入 registry；once 不写 | always 后 bash/file tools 都不再视该目录为 external；once 后仍 external |
| **S6：scheduler/file boundary 共用** | `externalWrite` 与 file tools 改用 trusted boundary helper，不再只看 workdir | external-approved temp/active-skill root 内写入不被误判为 workspace 外写；普通 Write/Edit 权限仍照常 |
| **S7：active skill root 接缝** | skill tool 成功加载后写入 exact baseDir | 已加载 skill script 不弹 external；未加载 skill 仍 external |
| **S8：注入通道（G5）** | resolveCommandContext env 注入约定 + 测试 host-local 默认空 | host-local 行为不变；约定有单测占位 |

依赖：**S4 必须在 [shell improve-2 S2](../../shell/improve-2/integration-plan.md)（executedScript 产出）之后**。
S1–S3、S5 与 shell 解耦，可并行。

## 迁移顺序（跨模块）

```
shell S1 (shared path utils) ─┐
utils canonicalize S1 ─┼─► sandbox S1 (canonicalize 合并)
sandbox S2 (TrustedRootRegistry) ─► sandbox S3 (多根 boundary)
shell S2 (executedScript) ─► sandbox S4 (消费 executedScript)
sandbox S5 (external always 共享根) ─► sandbox S6 (scheduler/file boundary 共用)
sandbox S7 (active skill root 接缝)
sandbox S8 (注入通道) ── 独立
```

## 兼容性与回滚

- registry 仅含 workspace root 时 ⇒ 与 improve-1 完全一致，是天然的兼容层。
- 多根、executedScript 消费都是"在既有 bucket 上加判定/加标注"，不改 PreflightResult 已有字段语义。
- 若 S4 出问题，可单独回退（shell 仍产出 executedScript，sandbox 暂不消费 = 退回 improve-1 的"脚本盲区"，
  但不崩）。

## 验收清单

- [ ] registry 仅含 workspace root 时，所有 improve-1 测试不变绿。
- [ ] registry 含第二根时，该根内路径不再进 externalPaths（不弹 external）。
- [ ] denylist 仍优先：可信根内的 `.ssh` 仍 hard-deny。
- [ ] 已加载 skill 的 exact baseDir 不弹 external；父级 skills 目录与未加载 skill 仍 external。
- [ ] `external_directory` once 不升级 trusted root；always 升级，且 bash/file tools 共享。
- [ ] 已有 session rule 自动 allow 的 external_directory 也幂等写入 canonical `external-approved` root。
- [ ] `external-approved` / `active-skill` root 内的 Write/Edit 不再被 `externalWrite` 误判，但仍走普通 write 权限。
- [ ] 系统 temp 默认不可信；用户 always 信任后才进入 `external-approved`。
- [ ] `python <skill根>/run.py` 在该根可信时不弹 external；不可信时弹 external 且标 isExecutedScript。
- [ ] `./run.sh`（workspace 内）识别为 executedScript 且判 inside。
- [ ] 仅一份 canonicalize 实现（grep 不到第二个 walk-up 拷贝）。
- [ ] `tsc -b` 干净，全量测试绿。

## 不在 scope 但要预留

| 事项 | 预留方式 |
|---|---|
| skill 模块 config 拆分 | 本轮只接入 active skill root；`config/skill` 另开轮次 |
| temp 目录默认可信 | 不默认；通过 external always 或未来显式配置进入 `external-approved` |
| OS adapter | `commandPrefix` 通道不变 |
| 配置化 allow/deny | 不做 |
