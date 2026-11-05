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
| permission / scheduler | — | 按 read/write/shell 操作分别保存 always 规则与可信根；`allow once` 不写 | 保持 ask 顺序 |

## 文件改动详情

### `src/sandbox/types.ts`

```ts
type TrustedRootKind =
  | "workspace"
  | "active-skill"
  | "external-approved"
  | "external-read-approved"
  | "external-write-approved"
  | "session-storage"
  | "session-scratch"
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
  - `list(sessionId)`：返回 workspace、skill、各操作已批准路径及会话存储区。
  - `clearSession(sessionId)`：session 结束/清理时释放。
- `workspace` root 在 sandbox context/session 创建时写入。
- `active-skill` root 由 skill tool 成功加载 `SKILL.md` 后写入 exact `baseDir`，并保留到 session 结束。
- `external_directory_read` 的 always 登记 `external-read-approved`，只供读取；`external_directory_write` 登记 `external-write-approved`，供读写但不自动授予 Bash 访问；`external_directory_shell` 登记 `external-approved`，供 Bash 目录访问。`once` 不登记。
- `session-storage` 默认只读，所属 `session-scratch` 默认可读写；两者由运行初始化回调创建并按真实路径登记。准备失败不登记会话根，环境提醒说明 scratch 不可用。
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
  读取边界保留所有可信根；调度器分别判断写入授权，Bash 只使用允许 Shell 访问的类型。读取批准不扩大成写入或 Bash 授权。
- `preflight()` 将 Shell 可用可信根，以及完整的 session-storage/scratch 范围传给 `preflightSandboxCommand`。先判断系统文件，再判断 cwd 或普通上级可信根；对应的明确 Shell 授权仍可复用。
- `resolveCommandContext` 签名已支持 env 注入；host-local 默认不注入（行为不变）。

### `src/core/tool-scheduler/scheduler.ts`

- `ToolExecutionEnvironment`（或等价 adapter）需要暴露 trusted boundary helper，例如
  `trustedRoots()` / `containsTrustedPath()`，否则 scheduler 仍只能看 `environment.workdir`。
- `createPermissionContext` 按真实目标判断写入边界：先判断已登记的 `session-storage` 减去所属 scratch，再判断 cwd、workspace、skill-output 或明确的 external-write-approved。系统文件不能因为 cwd 是 home、OHBABY_HOME 或上级可写可信根而免审批。scratch 内符号链接按最终目标判断。
- 写入系统范围需要已有明确写入授权或当前审批。普通 Write/Edit 工具权限保持原流程；明确拒绝规则在可信根放行前检查，`full-access` 保持原语义。
- 读取、写入和 Bash 目录访问分别使用 `external_directory_read(pattern)`、`external_directory_write(pattern)`、`external_directory_shell(pattern)`。PermissionManager 仍通过现有 `tool(pattern)` 格式生成、保存和匹配规则，不增加规则表或新审批交互。
- 没有操作含义的旧 `external_directory` allow 不再匹配这三种操作；旧 deny 仍拒绝对应路径。已保存规则在上下文重建后继续有效，trusted roots 只是当前上下文中的边界事实。

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
  应作为 external path 进入 `external_directory_shell` permission 流。动态 cd 目标仍按现有静态检查策略处理。

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
| **S5：external always 共享根** | scheduler 捕获 external_directory always，将目录写入 registry；once 不写 | always 只批准对应操作；读取不授权写入或 Bash，once 后仍 external |
| **S6：scheduler/file boundary 共用** | `externalWrite` 与 file tools 改用 trusted boundary helper，不再只看 workdir | scratch、workspace、skill-output、明确写入授权可写；系统范围先于 cwd 判断，普通 Write/Edit 权限仍照常 |
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
- [ ] 各操作的 once 不升级 trusted root；always 仅升级对应操作范围。
- [ ] read/write/shell 的 session rule 生成、保存及匹配互不混用；重建后仍按对应范围授权。
- [ ] scratch 默认可写；session-storage 的其余范围先于 cwd、普通上级可信根进入审批，符号链接按真实目标判断。
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
