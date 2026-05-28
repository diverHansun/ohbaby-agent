# Sandbox improve-2 职责定位

## improve-1 的边界与本轮扩展点

improve-1 确立（保持不变）：

- sandbox = workspace 边界事实供应方 + 统一 execution environment（rich `SandboxLease`）。
- shell = 命令语法分析；permission = 决策。
- sandbox 只产事实，不做 permission 决策（A 模式契约）。

improve-2 在此之上补两件事，目标都是为 skill `scripts/` 打地基：

1. **从单根到 session 动态多根**：当前 [boundary.ts](../../../packages/ohbaby-agent/src/sandbox/boundary.ts)
   只对一个 workspace 根判 inside/outside。skill 脚本在 workspace 外 → 每次 external ask。
   improve-2 引入 session 级 trusted roots，让已加载 skill 的 exact `baseDir`、用户 always 批准的外部目录、
   workspace 内 skill output 目录成为共享可信根。
2. **消费脚本执行事实**：[shell improve-2](../../shell/improve-2/goal-and-duty.md) 新增了
   `executedScript`，sandbox 负责把它和 `pathArgs` 一样过 boundary / denylist / sensitive。

## improve-2 的 Goal

> sandbox 在 improve-2 之后，对路径事实的判定基于**当前 session 的动态可信根集合**而非单一 workspace；
> 并把"被执行的脚本"纳入与数据路径相同的边界 / denylist / sensitive 判定；
> 同时通过 `resolveCommandContext` 为脚本执行提供 cwd / env 注入点。
> 这让 skill 脚本可以在 workspace 之外的 skill 目录里**默认可信地运行**，而越界访问仍受控。

仍是单一职责：sandbox 回答"相对可信根，这条路径在内/外、是否敏感、在哪执行"，
不回答"这条命令的语法结构"（shell）也不回答"最终 allow/ask/deny"（permission）。

## 单一职责分解（本轮新增/调整单元）

### 1. Session trusted roots 模型（新增 registry）

- **做什么**：新增 session 级 `TrustedRootRegistry`（或等价结构），记录当前 session 可视为 boundary-inside
  的 roots。
- **怎么用**：workspace root 初始化写入；`skill` 工具成功加载 skill 后写入 exact `baseDir`；
  `external_directory` 的 `always allow` 写入批准目录；workspace 内 skill output root 可初始化或按需写入。
- **边界**：sandbox 不扫描 skill，也不替用户决定系统 temp 是否可信。它只消费调用方和 permission 链路
  写入的 trusted roots。

建议类型：

```ts
type TrustedRootKind =
  | "workspace"
  | "active-skill"
  | "external-approved"
  | "skill-output";

interface TrustedRoot {
  readonly path: string;        // canonical absolute directory
  readonly kind: TrustedRootKind;
  readonly source?: {
    readonly skillName?: string;
    readonly permissionPattern?: string;
  };
}
```

重要语义：trusted root 只解决"路径边界是否 external"，**不跳过** bash / Read / Write / Edit 的工具权限，
也不跳过 denylist / sensitive。

### 2. 多根 boundary（`src/sandbox/boundary.ts` 改）

- **做什么**：`classifySandboxPath(path, roots)` —— 在**任一**可信根内即 `inside`，全不在才 `outside`。
- **怎么用**：preflight / file resolve 从 `TrustedRootRegistry` 读取当前 session roots 后传入。
- **边界**：纯路径包含判断（复用现有 `containsOrEqualPath`），无 IO。

### 3. executedScript 消费（`src/sandbox/preflight.ts` 改）

- **做什么**：对 shell 的 `command.executedScript` 解析 → canonicalize → 走 denylist / 多根 boundary / sensitive，
  归入对应的 `externalPaths` / `denylistHits` / `sensitivePaths`，并在结果里标注它是"被执行脚本"。
- **怎么用**：在遍历 `pathArgs` 的同一循环里加一支处理 `executedScript`。
- **边界**：消费 shell 事实，不自己解析命令。

### 4. 执行环境注入约定（`src/sandbox/lease.ts` / `adapters/host-local.ts` 扩展）

- **做什么**：`resolveCommandContext(options)` 支持返回注入的 `env`（如 active skill dir / output dir 变量）
  与按需的 `cwd`。
- **怎么用**：首批 host-local 默认仍以 workspace 为 cwd；未来 skill 调用上下文可注入
  `OHBABY_SKILL_DIR` / `OHBABY_SKILL_OUTPUT_DIR` 等变量。
- **边界**：sandbox 提供注入**通道**，不定义 skill manifest 或脚本调度器。skill 模块需要优化时另开轮次。

### 5. 路径解析收敛（解决 M3）

- **做什么**：合并 [shell/preflight.ts canonicalizeStaticPath](../../../packages/ohbaby-agent/src/shell/preflight.ts)
  与 [sandbox/paths.ts canonicalizeSandboxPath](../../../packages/ohbaby-agent/src/sandbox/paths.ts) 为一份
  walk-up 实现（两者逻辑现已一致，只是各一份拷贝）。
- **怎么用**：放进 `src/utils/path-canonicalize.ts` 共享工具，shell preflight 与 sandbox paths 都 import。
  不让 shell import sandbox，避免方向依赖变乱。
- **边界**：纯路径 + fs.realpath，无策略。

## 非目标声明

### 1. 不做 skill 模块本身
skill 发现、清单（manifest）解析、`scripts/` 目录约定、skill 生命周期都不在本轮。
sandbox 只提供"session trusted roots + 注入通道"这层地基。skill 根由 `skill` 工具/未来 skill runtime
在成功加载或激活时写入 registry，sandbox 不去扫描 `~/.claude/skills`，也不把父级 skills 目录整体信任。

### 2. 不削弱 denylist
多根让更多目录"可信"，但 hard-deny（`~/.ssh`/`~/.aws`/`~/.gnupg`）**优先于**任何可信根：
即使某可信根恰好包含 `.ssh`，denylist 仍先命中并拒绝。次序见 [data-flow.md](data-flow.md)。

### 3. 不做 OS 级隔离
adapter 接口仍保留（`commandPrefix` 等），但本轮只实装 host-local。

### 4. 不默认信任系统 temp，也不做配置文件
系统 temp 默认不进入 trusted roots；如果用户通过 `external_directory` 选择 `always allow`，或未来配置明确
信任，它才作为 `external-approved` root 进入 session。配置化 trusted roots 留后续。

### 5. 不改 permission 链路
`external_directory` / `sensitive_path` 的 ask 编排沿用 improve-1 的 scheduler 实现。
多根只改变"什么算 external"，不改变"external 怎么问"。

## 与 permission 的契约（改动点）

`PreflightResult` 在 improve-1 基础上**只增不改**：

```ts
interface PreflightExternalPath {
  readonly original: string;
  readonly absolutePath: string;
  readonly askPattern: string;
  readonly isExecutedScript?: boolean;   // 新增：该外部路径是被执行的脚本
}
// PreflightDenylistHit / PreflightSensitivePath 同样可加 isExecutedScript? 标注
```

不变式：

1. **denylist 优先级最高**：脚本或数据路径命中 home 凭据目录 → hard-deny，先于多根 boundary。
2. **多根 inside 不进 externalPaths**：路径在任一 trusted root 内即视为内部，不弹 external。
3. **executedScript 与 pathArgs 走同一判定**：脚本不享有豁免——skill 脚本若试图读 `~/.ssh` 同样被拒。
4. **只有 always allow / 明确手动信任会升级为 shared trusted root**；`allow once` 只放行当前调用。
5. **registry 只有 workspace root 时，行为退化为 improve-1**，保证兼容。
6. sandbox 不决定 skill roots / temp roots 的内容，只消费 session registry。

## 边界声明

- 多根是**逻辑可信边界**，不是 OS 隔离：可信根内的脚本仍是裸进程，能力由 permission + 未来 OS adapter 限制。
- `executedScript` 的内容（脚本里写了什么）sandbox 不分析；只判定脚本文件本身的位置归属。
- skill 根"可信"意味着不弹 external_directory，但 denylist / sensitive 仍照常——可信 ≠ 无限制。
