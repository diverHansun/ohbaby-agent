# Sandbox 接入方案：增 / 改 / 删

本文给出 sandbox improve-1 的文件级实施方案。Shell 侧的 parser、arity、bash 进程硬化见
[shell integration-plan](../../shell/improve-1/integration-plan.md)，这里只描述 sandbox
如何成为统一 execution environment，并把 workspace 边界事实接入 permission。

## 总览

| 模块 | 增 | 改 | 删 / 收敛 |
|---|---|---|---|
| [src/shell/analysis/](../../../packages/ohbaby-agent/src/shell/) | 由 shell/improve-1 新增 | `shell/preflight.ts` 逐步瘦身 | sandbox 不再拥有 parser |
| [src/sandbox/](../../../packages/ohbaby-agent/src/sandbox/) | `paths.ts` / `boundary.ts` / `denylist.ts` / `preflight.ts` | `types.ts` / `lease.ts` / `index.ts` / `adapters/host-local.ts` | 保留 rich 架构 |
| [src/runtime/run-manager/](../../../packages/ohbaby-agent/src/runtime/run-manager/) | — | `types.ts` 类型指向 rich sandbox | 删除简版 SandboxLease / SandboxManager 二次定义 |
| [src/adapters/ui-runtime/](../../../packages/ohbaby-agent/src/adapters/ui-runtime/) | — | `composition.ts` 接入 rich `SandboxManager` | `host-local-environment.ts` 删除简版 manager，保留测试用 environment 工厂 |
| [src/core/tool-scheduler/](../../../packages/ohbaby-agent/src/core/tool-scheduler/) | — | `scheduler.ts` external-first 编排 | 不把 external path 塞成 bash ask 升级 |
| [src/tools/](../../../packages/ohbaby-agent/src/tools/) | — | `bash.ts` 支持 commandPrefix + 进程硬化；fs tools 继续走 `resolvePath*` | 不在 tool 内直接 ask permission |
| [src/permission/](../../../packages/ohbaby-agent/src/permission/) | 可选 `metadata` 字段 | 补齐 `external_directory` / `sensitive_path` pattern 与 type 推断 | 不重写 permission 系统 |

## 阶段 0：文档与分支

- 在临时分支 `codex/shell-sandbox-improve-1` 上进行。
- 先提交 shell / sandbox improve-1 文档，确认设计后再进入代码实现。
- 后续按阶段小提交，方便回滚和审查。

## 阶段 1：shell analysis 先落地

这一阶段主要由 [shell improve-1](../../shell/improve-1/integration-plan.md) 承担。
sandbox 对它的最低依赖是：

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

export interface ShellAnalysisResult {
  readonly shellKind: ShellKind;
  readonly commands: readonly ShellCommandAnalysis[];
  readonly parseError?: string;
}
```

实现顺序建议：

1. 先用轻量 parser 包装当前 `shell/preflight.ts` 和 `utils/command-parser` 能力。
2. 让 `shell/preflight.ts` 停止把外部路径当错误抛出，只返回 shell facts。
3. tree-sitter 替换轻量 parser 内部留给后续增强；improve-1 只要求轻量 parser 覆盖本轮
   external-first、sensitive_path、denylist、git/docker arity 与 skill runtime 关键路径。

## 阶段 2：sandbox preflight facts

新增：

```text
packages/ohbaby-agent/src/sandbox/
  paths.ts
  boundary.ts
  denylist.ts
  preflight.ts
```

职责：

- `paths.ts`：把 shell `pathArgs` 展开成绝对路径，支持 `~`、环境变量、Windows 盘符、Git Bash 路径。
- `boundary.ts`：判断 resolved path 是 inside 还是 outside workspace。
- `denylist.ts`：内置 hard-deny 规则只覆盖高确信 home 凭据目录，如 `~/.ssh`、`~/.aws`、`~/.gnupg`；项目内 `.env`、非模板 `.env.*`、`*.pem`、`*.key`、shell rc 归入 `sensitive_path` ask。
- `preflight.ts`：组合 shell facts + path facts，产出 `PreflightResult`。

修改：

| 文件 | 修改 |
|---|---|
| [src/sandbox/types.ts](../../../packages/ohbaby-agent/src/sandbox/types.ts) | 在 `SandboxLease` 上新增 `preflight(command, shellKind): Promise<PreflightResult>`，并导出 `PreflightResult` 相关类型。 |
| [src/sandbox/lease.ts](../../../packages/ohbaby-agent/src/sandbox/lease.ts) | `createSandboxLease()` 增加 `preflight` 方法；`resolvePath*` 仍保持 workspace 内路径校验，外部路径 ask 只针对 bash 命令 preflight。 |
| [src/sandbox/adapters/host-local.ts](../../../packages/ohbaby-agent/src/sandbox/adapters/host-local.ts) | 保持 host-local adapter 为 `isolation: "none"`；必要时迁入当前简版 manager 里成熟的 path normalization 辅助函数。 |
| [src/sandbox/index.ts](../../../packages/ohbaby-agent/src/sandbox/index.ts) | 导出新增类型与 preflight 工具。 |

关键约束：

- 绝对路径和 `../` 只要解析到 workspace 外，都进入 `externalPaths`。
- 外部路径不是异常，不从 sandbox 抛出。
- denylist 命中是异常事实，由 scheduler 转成 rejected。
- sensitive 命中是可确认事实，由 scheduler 在 bash 前触发 `sensitive_path` ask。
- glob 不是动态路径；先取字面前缀目录做 boundary / denylist / sensitive 判断，例如 `src/*.ts` 检查 `src/`。
- 真动态路径不阻断，只依赖 bash permission 兜底。

## 阶段 3：rich SandboxLease 统一 execution environment

准确目标：

> rich sandbox 完全替换 runtime 下的简版 sandbox 二次实现，让 rich `SandboxLease`
> 成为统一 `ToolExecutionEnvironment`；runtime/run-manager 底层架构不变。

修改：

| 文件 | 修改 |
|---|---|
| [runtime/run-manager/types.ts](../../../packages/ohbaby-agent/src/runtime/run-manager/types.ts) | 删除本文件内的简版 `SandboxLease` / `SandboxManager` 接口，改为从 `../../sandbox/index.js` re-export。 |
| [runtime/run-manager/manager.ts](../../../packages/ohbaby-agent/src/runtime/run-manager/manager.ts) | 保持现有 `acquire(sessionId)` / `release(lease)` 生命周期；类型换成 rich lease 后不改变 run-manager 架构。 |
| [core/tool-scheduler/types.ts](../../../packages/ohbaby-agent/src/core/tool-scheduler/types.ts) | 让 `ToolExecutionEnvironment` 包含可选 `preflight`，结构上与 rich `SandboxLease` 兼容。 |
| [adapters/ui-runtime/composition.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts) | 用 `AdapterRegistry + HostLocalAdapter + SandboxManager` 替换 `createHostLocalSandboxManager(options.workdir)`，按 session 调 `ensureContext(sessionId, { workdir })`。 |
| [adapters/ui-runtime/host-local-environment.ts](../../../packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts) | 删除简版 `HostLocalSandboxManager`，保留 `createHostLocalEnvironment` 作为测试 / sub-context 工厂。 |

这个阶段的成功标志不是“runtime 被 sandbox 接管”，而是：

- `RunContext.sandboxLease` 仍由 run-manager 挂载。
- lease 实例来自 rich sandbox。
- 工具拿到的 `context.environment` 结构兼容 rich lease。
- 简版 sandbox manager 不再存在。

## 阶段 4：scheduler external-first 权限编排

修改 [scheduler.ts](../../../packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts)。

`ToolPermissionContext` 新增：

```ts
readonly preflight?: PreflightResult;
```

`createPermissionContext` 对 bash 工具：

```ts
if (tool.name === "bash" && request.environment?.preflight) {
  const preflight = await request.environment.preflight(command, shellKind);
  return { externalWrite, untrustedMcp, params, preflight };
}
```

权限顺序：

1. `preflight.denylistHits.length > 0`：直接 rejected。
2. `preflight.externalPaths`：先逐目录评估 / ask `external_directory`。
3. `preflight.sensitivePaths`：再逐路径评估 / ask `sensitive_path`。
4. external / sensitive 全部批准后，调用原有 `evaluatePermission()` 处理 bash。
5. bash 若 ask，再进入原有 bash ask UI。
6. 全部允许后才调用 `bash.execute()`。

不要实现为：

```ts
if (decision.type === "allow" && externalPaths.length) {
  return { type: "ask", category: "bash" };
}
```

这会丢失 `external_directory` 这个权限类型，也不能表达“外部路径已批准但 bash 仍需 ask”。

external path 阶段使用合成 permission call，而不是复用 bash call：

```ts
const externalCall: PermissionCall = {
  ...bashCall,
  toolName: "external_directory",
  category: "dangerous",
  params: { path: externalPath.absolutePath },
};
```

对应 permission 侧要补齐：

- `inferPermissionType("external_directory", params) -> "external_directory"`
- `generatePermissionPattern({ type: "external_directory", params: { path } }) -> external_directory(<dir>/**)`
- `matchesPermissionRule()` 能用 `params.path` 匹配 `external_directory` rule。
- `inferPermissionType("sensitive_path", params) -> "sensitive_path"`
- `generatePermissionPattern({ type: "sensitive_path", params: { path, pattern } }) -> sensitive_path(<pattern-or-path>)`
- `matchesPermissionRule()` 能用 `params.path` / `params.pattern` 匹配 `sensitive_path` rule。

### PermissionAskInput metadata

建议正式扩展 permission ask input，而不是把 `_preflight` 塞进 params：

```ts
interface PermissionAskInput {
  // existing fields...
  readonly metadata?: {
    readonly preflight?: PreflightResult;
  };
}
```

UI 可以用 `metadata.preflight.externalPaths` 渲染外部路径列表；不支持 metadata 的调用方可以忽略。
这是比 `_preflight` 更干净的接口，符合 DRY / SRP。

## 阶段 5：bash tool 与 fs tools

### bash.ts

修改 [tools/bash.ts](../../../packages/ohbaby-agent/src/tools/bash.ts)：

- 不再 throw `"commandPrefix is not supported"`。
- 支持 `commandPrefix` 作为执行 wrapper；HostLocalAdapter 返回空 prefix。
- 注入 non-interactive env：`NO_COLOR=1`、`TERM=dumb`、`GIT_TERMINAL_PROMPT=0`、`SHELL=<shellPath>`。
- spawn 后关闭 stdin。
- 保留现有 timeout、abort、killTree、输出截断。
- 不在 `execute()` 内调用 `permission.ask()`；调度器已完成 permission。

### fs tools

文件工具继续走 `context.environment.resolvePath*`：

- read / glob / grep / list：`resolvePathForExisting`
- write / edit：`resolvePathForWrite`

fs tools 的外部路径权限已在 permission/improve-1 侧存在，不与 bash 的 external-first 混成一套。
如果后续发现 fs tools 仍有绕过 `resolvePath*` 的 path.resolve，应单独收敛。

## 阶段 6：测试

### 单元测试

新增 / 更新：

| 测试 | 覆盖点 |
|---|---|
| `shell/analysis/*.unit.test.ts` | tokens、pathArgs、hasDynamic、danger、arityKey |
| `sandbox/paths.unit.test.ts` | `~` / env / Windows / Git Bash 路径展开 |
| `sandbox/boundary.unit.test.ts` | inside/outside、`../`、绝对路径、大小写规则 |
| `sandbox/denylist.unit.test.ts` | ssh/aws/gnupg hard-deny、env/private-key/shell-rc sensitive ask |
| `sandbox/preflight.unit.test.ts` | shell analysis + boundary facts 组合 |
| `sandbox/manager.unit.test.ts` | rich lease 暴露 `preflight` |
| `runtime/run-manager/manager.unit.test.ts` | run-manager 仍 acquire/release lease |
| `core/tool-scheduler/scheduler.unit.test.ts` | denylist reject、external_directory first、sensitive_path second、bash last |
| `tools/bash.unit.test.ts` | commandPrefix、env、stdin close |

### 集成测试

重点场景：

- `cat ../outside/file.txt`：触发 `external_directory`，批准后再看 bash 规则。
- `cat /etc/hosts` 或 Windows 等价外部绝对路径：触发 `external_directory`。
- `cat ~/.ssh/id_rsa`：denylist rejected。
- `cat .env`：触发 `sensitive_path`，批准后再看 bash 规则。
- `cat .env.example`：普通 workspace 内路径，不触发 `sensitive_path`。
- `cat ../outside/.env`：先 `external_directory`，批准后再 `sensitive_path`，最后 bash。
- `cat src/*.ts` / `rm build/*.tmp`：glob 用字面前缀目录检查，不因 `*` / `?` / `[]` 直接抛错。
- `git status`：无外部路径，按 bash readonly 规则。
- `git push origin main`：无外部路径时仍按 bash mutating/dangerous 规则 ask。
- 外部路径批准 + `git push /outside/repo`：先 external_directory，再 bash ask。
- preflight 失败：warning + 退化，不导致普通 bash 崩溃。

### e2e

实现完成后按仓库 [ohbaby-e2e-test.md](../../../ohbaby-e2e-test.md) 使用真实 API key 运行 e2e。
e2e 要覆盖 skill scripts 的真实调用路径，确认 scripts 不会绕开 builtin `bash`。

### 子代理审查

代码完成并通过测试后，启动子代理做 code-quality review，重点看：

- 是否出现 shell parser / path boundary / permission ask 的第三套实现。
- external-first 是否真正是 `external_directory` 类型，而不是 bash ask 伪装。
- sensitive 文件是否走 `sensitive_path`，而不是退回无逃生口 hard-deny。
- rich `SandboxLease` 是否成为统一 environment。
- KISS / YAGNI / DRY / SOLID 是否被破坏。

## 迁移顺序

```text
1. docs
2. bash execution hardening
3. shell analysis light implementation
4. sandbox paths/boundary/denylist/preflight
5. rich SandboxLease as ToolExecutionEnvironment
6. scheduler external_directory -> sensitive_path -> bash sequencing
7. unit + integration + e2e + subagent review
8. 后续：tree-sitter parser upgrade
```

每一步都可以独立提交。第 3 步用轻量 parser 是方案二；当前 improve-1 通过结构化 facts
和 targeted arity 达到本轮方案三效果，完整 tree-sitter 作为后续替换 parser 内部的增强。

## 已登记技术债

- `shell/preflight.ts` 与 `sandbox/paths.ts` 已在行为上对齐缺失父目录的 canonicalize：
  两边都向上查找最近存在祖先，再拼回缺失 suffix，避免 `mkdir -p a/b/c`、`touch build/out.txt`
  这类命令被原始 `ENOENT` 阻断。后续仍应把该 walk-up helper 抽到共享路径工具，减少 M3
  的两套路径解析器风险。
- `stripMatchingQuotes`、`msysPathToWindowsPath`、option/value 解析等字符串层 helper 仍散落在
  `shell/preflight.ts`、`shell/path-args.ts`、`sandbox/paths.ts`。这不阻塞 improve-1，但应在
  下一轮 DRY 整理中收敛，避免 glob / dynamic / Windows 路径规则再次分叉。

## Rollback 策略

实现期可以加临时开关：

```text
OHBABY_SANDBOX_PREFLIGHT_ENABLED=0
```

关闭后：

- `lease.preflight` 返回空 facts。
- scheduler 不触发 denylist / external-first / sensitive_path 增强。
- bash 行为退化到旧 permission 规则。

这个开关只作为上线保险，不作为长期产品配置。

## 验收清单

- [x] `bash.ts` 不再 throw `"commandPrefix is not supported"`。
- [x] `cat ../outside/file.txt` 触发 `external_directory`。
- [x] `cat /absolute/outside/file.txt` 触发 `external_directory`。
- [x] 外部路径批准后，bash 原权限规则仍会继续判断是否 ask。
- [x] `cat ~/.ssh/id_rsa` 被 denylist hard deny。
- [x] `cat .env` 触发 `sensitive_path` ask。
- [x] `.env.example` 不触发敏感路径 ask。
- [x] glob 路径用字面前缀目录校验，不被当作动态路径硬拒。
- [x] `git status` 在默认策略下不被外部路径逻辑干扰。
- [x] `git push` 仍按 bash 权限规则 ask，always pattern 来自 arity。
- [x] rich `SandboxLease` 是 runtime/tool-scheduler 使用的统一 execution environment。
- [x] runtime 下简版 sandbox manager / lease 二次实现被删除。
- [x] skill scripts 通过 builtin `bash`，没有新增脚本执行绕行。
- [x] unit、integration、e2e 全部通过。
- [x] 子代理审查通过。
