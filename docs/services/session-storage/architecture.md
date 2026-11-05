# architecture

2026-11-05 实施状态：第一期、子代理结果搬迁与第二期 a 工具输出存盘已实现；当前归属按 `parentId ?? sessionId` 计算。本文涉及 side chat 共享、fork 独立目录及源文件读取的内容是后续议题的约束，尚未实现或验收；第二期 b 文件 API 与 Files 页尚未实现。

> 2026-11-04。以 [goals-duty](goals-duty.md) 为前提。路径缩写：`A/` = `packages/ohbaby-agent/src/`，`S/` = `packages/ohbaby-server/src/`，`W/` = `apps/ohbaby-web/src/`。

## 1. Architecture Overview

本模块很薄：一个“算归属、算路径、建目录”的函数，加上四个接入点。它本身不保存任何状态，目录就是全部的“数据”。

2026-11-05 复查确认：不改变 cwd、项目识别或相对路径解析。临时文件、报告和中间产物默认放进会话 `scratch/`，项目操作继续使用用户 workspace。固定规则分别写进主、子代理基础提示词，实际路径由环境提醒提供；这些提示词改动在本模块第一期完成。

```
工具请求的会话 ──► 归属会话 id ──► ~/.ohbaby/sessions/<ownerId>/      只读（session-storage）
  子代理  → 根会话 id                ├─ scratch/       agent 写的临时文件与产物，可写（session-scratch）
  side chat（后续）→ 主会话 id              ├─ subagents/     子代理的长报告（子代理结果搬迁议题）
  其他    → 自己的 id                └─ tool-results/  超长工具输出（第二期）
         │
         ├─ sandbox 创建上下文时：注入的回调建目录 + 登记两档可信路径
         ├─ 模型提示：主、子代理基础提示词分别写规则，环境提醒给 scratch 路径
         ├─ 会话永久删除后：cleanupDeletedSessionFiles 删除 sessions/<id>
         └─ 第二期：截断输出的工具存盘；服务端列文件、读文件
```

### 1.1 归属

- 一个父会话下的所有子代理共用一个子会话，彼此只靠 `contextScopeId` 区分（`A/agents/subagent-host.ts:1386-1400`），run 也是用这个子会话 ID 申请 sandbox（`A/runtime/run-manager/manager.ts:400-404`）。如果按会话 ID 分目录，兄弟子代理会共用一个目录，父会话读子代理写的报告也要弹确认。
- 存储区按归属会话分：子代理用它所属的根会话的目录。
- 2026-11-05 复查确认：主代理和所属子代理共用同一个 `scratch/`，运行时不强制建立 `scratch/<subagentId>/`，也不为各子代理登记单独的 scratch 可信路径。提示词要求文件名区分任务、保留其他代理的文件；共享目录不改变 `explore` 的只读要求。
- side chat 议题落地时，隐藏根会话使用 `data.sideChat.mainSessionId` 指向的主会话目录；当前还没有这个归属分支。
- fork 议题落地时，新会话作为独立根会话使用自己的目录，不复制源会话文件。

参考：claude-code 的 scratchpad 按主会话分，主会话和它的子代理共享（`claude-code/src/utils/permissions/filesystem.ts:384`）。

### 1.2 接入点

1. **sandbox**：sandbox 上下文按 `(sessionId, contextScopeId)` 创建，在一轮运行第一次申请时懒创建（`A/adapters/ui-runtime/host-local-environment.ts:208-215`），换运行目录、释放子代理作用域、daemon 重启后都会重建。`SandboxManager` 是通用组件，不应直接知道 `OHBABY_HOME`。做法是给 `SandboxManagerOptions` 加一个注入的回调 `initialTrustedRoots(scope)`，在 `TrustedRootRegistry.create` 处调用（`A/sandbox/manager.ts:123`）。回调由 `composition.ts` 提供。它只拿到 sandbox 作用域（`sessionId`、`contextScopeId`），拿不到工具请求，所以用 `sessionManager.get(scope.sessionId)` 查会话来定归属：有 `parentId`（子代理会话）就用 `parentId`，否则用自己；side chat 的归属分支留给其后续议题。子代理不能再创建子代理（`agent` 工具对子代理禁用，`A/core/tool-scheduler/constants.ts:30`），所以一层就够。然后建目录，返回两条：`{ kind: "session-storage", path: 会话目录 }`（只读）和 `{ kind: "session-scratch", path: 会话目录/scratch }`（可写）。写法沿用 sandbox 的依赖注入方式；子代理结果直接使用本回调登记的只读根，不保留专用读取通道。每次重建上下文都会重新登记。
2. **环境提醒**：`A/services/reminder/environment.ts` 在现有几行之后给出本次运行已准备好的 scratch 绝对路径。不能只按 sessionId 重新拼路径就宣告可用：目录创建和可信路径登记都成功后才提供可用路径。准备失败时保留 cwd、平台、日期等信息，明确提示 scratch 暂不可用；状态变化要参与现有提醒的去重，避免重建失败后继续沿用旧的可用提示。具体状态传递复用当前运行上下文，不新增数据库状态或目录管理服务。
3. **删除**：`A/services/session/archive-files.ts` 的 `cleanupDeletedSessionFiles` 在数据库删除提交后清理快照引用，并按 `resolveSessionStorageDir(id)` 删除整个 `sessions/<id>`；测试可通过 `sessionStorageRoot` 隔离目录。子代理报告已归入会话目录，不再单独清理旧结果目录。`result.sessionIds` 是整棵会话树（`A/services/session/archive.ts:101-104`），里面有根会话 ID；子会话 ID 没有目录，`rm -f` 不报错。
4. **第二期**：截断输出的工具调用存盘函数；服务端加两个只读路由；Web 右侧面板加 Files 页。

### 1.3 基础提示词与环境提醒的分工

- `A/core/system-prompt/prompts/primary/base.md` 和 `prompts/subagents/base.md` 分别加入固定规则，不写具体会话 ID 或路径，不新增公共提示词模块。规则见 [dfd-interface §2.2](dfd-interface.md#22-告诉模型第一期)。
- 子代理基础提示词已有“长日志或长分析写文件”的句子，同步改为需要保存时使用 session scratch，避免旧句子与新规则并存。`generic`、`explore`、`research` 都经过子代理基础提示词；`explore` 的只读要求继续有效。
- `environment` 提醒已有 `audience: "both"`，在其中提供 scratch 绝对路径；保留当前 cwd 信息，不能把 scratch 当成 cwd。路径沿用现有提醒的去重机制。
- 修改基础提示词后运行 `pnpm -C packages/ohbaby-agent prompt:generate`，同步生成资源和已有提示词断言；第一期检查 `prompt:check`。
- 借鉴 Claude 本地实现对临时文件用途的说明；“基础规则与动态路径分开”是适配本项目现有结构的选择，不是 Claude 的原样实现。来源与覆盖限制见[参考项目 §3.9](../../problem-lists/2026-11-05-subagent-results-location/improve-1/03-reference-projects.md#39-实施前复查提示词与运行目录)。

## 2. Design Pattern & Rationale

- **路径由 ID 算出，不入库。** 一个归属会话的存储区永远是 `<OHBABY_HOME>/sessions/<id>`。不需要表、不需要迁移，删库删目录各管各的。对应目标 5。
- **按根会话分，不按工作区分。** 会话可以在工作区之间移动，按工作区分就得搬目录；子代理和 side chat 是在替主会话干活，和主会话共用目录最自然。对应目标 1、4。
- **授权复用现有机制，补齐两档权限和判断顺序。** 2026-11-05 复查确认：单纯增加可信路径不够，第一期一并修正以下内容，不新增权限服务或数据库。
  1. `TrustedRootKind` 增加 `session-storage` 和 `session-scratch`。读取可使用两者，只有 scratch 提供默认写权限；scratch 内的路径按真实目标判断，链接指向系统目录时不能获得 scratch 写权限。
  2. 调度器在普通 cwd、上级可写可信根放行之前，先判断目标是否位于已登记的 session-storage 范围且不属于对应 scratch。命中时进入现有写入审批流程，不能仅因 cwd 是 `~` 或 `~/.ohbaby` 而放行。不硬编码用户 home，复用当前上下文登记的规范化路径。
  3. Bash 预检同样优先识别系统文件范围，再判断普通 cwd 和可信根。`bash.ts` 和 `lease.preflight` 必须将 session-storage 与 scratch 的范围信息传到预检层；只过滤一条可信根不够。读取授权也不能作为 Bash 的目录访问授权。按本次已确认规则，用 Bash 读取系统文件仍需审批，直接读取可用 `read`、`grep`。**不要过滤供普通读取使用的 `trustedRootPaths()`**，避免破坏只读文件访问。
  4. 读取批准只登记只读、且不被 Shell 自动信任的路径；写入批准与 Bash 目录访问保留各自明确授权的范围。不能只交换 `trustExternalReadPath` 与 `trustExternalWritePath` 的类型值就认为修复完成。
  5. 同时修正“始终允许”保存的会话规则：读取规则不能匹配写入或 Bash 目录审批。复用现有 `PermissionRule.tool` 和 `tool(pattern)` 格式，为不同操作使用可区分的规则身份，生成、保存、匹配一起接通；不新增规则表或授权服务。没有操作含义的旧 `external_directory(...)` 许可不能被推断成用户已经批准了系统文件写入。本项目不要求旧权限数据兼容。

  系统文件仍可由用户明确批准修改；保留拒绝规则和 `full-access` 的既有语义，不把审批改成不可批准的硬拒绝。命中系统目录后，用户对具体写入或 Bash 访问作出的有效授权仍可以按对应范围复用，普通 workspace 放行和读取授权不能冒充该授权。

  唯一的 sandbox 适配器是 `A/sandbox/adapters/host-local.ts`，没有操作系统级的沙箱配置会挡住写入。对应目标 3。
- **为什么系统文件只读。** `subagents/` 和 `tool-results/` 里的文件，父代理会当成可信的原始记录来读。假如某个子代理读了藏有恶意指令的网页，被诱导去改写兄弟子代理的报告，父代理读到的就是假报告。参考项目没有一家让模型写这类文件：claude-code 只让 scratchpad 和计划文件免确认可写；minimax 对 `tool-outputs` 等只给只读授权；dsh 的设计笔记写明超长输出文件是“运行时产物，不是模型写的工作区文件”。
- **运行初始化时建目录。** 在首轮模型请求和工具使用前，通过 sandbox 上下文初始化创建 scratch，不等到第一次写入再建。会话不运行就不会创建上下文，从没运行过的会话不会留下空目录。先建目录，再登记可信路径，最后向模型提供可用路径；创建失败不能仅留下日志却继续宣告路径可用。登记时解析真实路径，目录已存在才能解析到最终位置（例如 macOS 上 `/var` 实际指向 `/private/var`），这样登记的路径和工具实际访问的路径才对得上。
- **三个子目录，两档权限。** `scratch/` 给 agent，`subagents/` 和 `tool-results/` 给系统，一种内容一个名字明确的文件夹，参考项目都这样分（kimi-code 的 `tasks/`、`tool-results/`、`plans/`，claude-code 的 `subagents/`、`tool-results/`）。权限只有两档，不按文件夹逐个登记。第一期只建 `scratch/`；`subagents/` 由子代理结果搬迁议题在第一次导出时创建，`tool-results/` 由第二期在第一次写入时创建。

## 3. Module Structure & File Layout

| 文件 | 内容 |
|---|---|
| `A/paths/session-storage.ts`（新） | `resolveSessionStorageRoot(options?)`、`resolveSessionStorageDir(ownerSessionId, options?)`、子目录名常量 `SCRATCH_DIR`、`SUBAGENTS_DIR`、`TOOL_RESULTS_DIR`、`ensureSessionStorage(ownerSessionId, options?)`；校验 ID。写法照 `A/paths/default-directory.ts:24-33` 的 `ensureDefaultDirectory` |
| `A/sandbox/trusted-roots.ts` | 增加两档会话路径类型，保证读取授权不提供写入或 Shell 自动信任；新增或调整现有类型判断 |
| `A/sandbox/{types,preflight,lease}.ts`、`A/tools/bash.ts` | 向 Bash 预检保留会话系统范围与 scratch 例外，先判断系统文件再判断 cwd；普通读取所用的 `trustedRootPaths()` 不过滤 |
| `A/sandbox/manager.ts` | `SandboxManagerOptions` 加 `initialTrustedRoots`，创建上下文时调用 |
| `A/core/tool-scheduler/scheduler.ts` | scratch 写权限、系统文件优先审批、区分外部读写与 Shell 的可信路径登记和审批规则身份 |
| `A/permission/{matcher,manager,rule,types}.ts` 的相关接入 | 复用现有规则结构，为操作生成并匹配不同规则身份；核对真实 always 保存流程，不为本议题重写审批框架 |
| `A/adapters/ui-runtime/composition.ts` | 提供 `initialTrustedRoots` 回调；算归属 ID（子代理 → 根会话，其余 → 自己）；side chat 分支待其议题实现 |
| `A/services/reminder/{index,environment}.ts` 及运行上下文接入处 | 将当前运行准备结果传给提醒：成功提供实际 scratch 路径，失败明确说明不可用；不在提醒中另行拼出未准备好的路径 |
| `A/core/system-prompt/prompts/{primary,subagents}/base.md` | 分别写固定文件落点规则，子代理旧报告提示同步改写；重新生成 `templates.generated.ts` 并更新提示词断言 |
| `A/services/session/archive-files.ts` | 删除 `sessions/<id>` |
| 第二期 a 已实现 | `A/services/session-storage.ts`：从已登记根准备输出目录并保存文本；`A/utils/capped-output-file.ts`：同步有界文件捕获、10 MiB 上限与完整性说明 |
| 第二期 a 接入 | `A/tools/utils/output.ts` 的显式异步包装与 list/glob/web 调用方；Bash 准备目录，shell registry 仅负责按 jobId 捕获日志及实际 stdio 生命周期 |
| 第二期 b 规划 | `A/services/session-storage.ts` 的 `listSessionFiles`、`readSessionFile`；`S/protocols/web/routes/sessions.ts`、`W/ui/side-panel/`、`W/ui/session-files/` |

## 4. Architectural Constraints & Trade-offs

### 4.1 约束

2026-11-05 复查确认：本文“默认只读、改写需审批”针对默认 `default` 权限档位下的模型工具调用，不代表给文件设置操作系统只读属性，也不阻止系统导出报告。代码中的 `default` 是权限档位（`permission/types.ts` 的 `Level`），与 `plan`、`auto` 运行模式不同。本模块保留 `full-access` 和明确写入授权的既有语义，但修正读取许可错误扩张为写权限的行为。

| 约束 | 做法 |
|---|---|
| id 不能造成路径穿越 | 只接受 `[A-Za-z0-9_-]`，长度不超过 128；现有会话 ID（`session_<毫秒>_<base36>`，`A/services/session/id-generator.ts:16`；以及 UUID，`S/app/create-app.ts:139`）都符合 |
| 只有当前用户能读写 | 照 `A/observability/process-logger.ts:253-266`：`mkdir` 带 `mode: 0o700`，非 Windows 再 `chmod`；第二期写的文件 0600。Windows 上不做权限位处理 |
| 尊重 `OHBABY_HOME` | 路径基于 `resolveOhbabyHome()`（`A/paths/ohbaby-home.ts:65`） |
| 第二期读文件不越界 | 只读归属目录 `scratch/` 内的普通文件，真实路径必须仍在其内，拒绝符号链接；单次读取设上限 |
| 敏感文件 | 沿用 sandbox 现有的敏感文件名单，不另设规则 |
| 只读靠调度器落实 | sandbox 层的 `resolvePathForWrite` 接受任何类型的可信路径（`lease.ts:25-34`、`:106-110`），“写入要确认”完全由调度器的写入分类决定（`scheduler.ts:202-232`，按 `file_path`、`filePath`、`path` 参数识别，`:271-279`）。以后新增写工具时要沿用这几个参数名 |

### 4.2 取舍

| 取舍 | 选择 | 代价 |
|---|---|---|
| 放 `~/.ohbaby/` 还是平台数据目录 | `~/.ohbaby/`，用户确认 | 和数据库不在一处，删除要两边各删一次；`cleanupDeletedSessionFiles` 本来就是“提交后清文件”，不增加复杂度 |
| 保留与自动清理 | 2026-11-05 复查确认：文件随根会话保留，仅在永久删除归属会话时一起清理；暂不做定时清理 | 归档和长期未使用的会话仍占磁盘。第一期不引入过期时间、定时任务或额外清理索引 |
| side chat 用主会话的目录 | 能直接读主会话的文件 | side chat 写的文件关闭后仍留在主会话那里 |
| fork 用自己的目录 | 不复制、不授权读取源会话 | 历史里提到的源会话文件，读取时要确认 |
| 归档 | 保留文件 | 归档的会话占着磁盘 |
| 权限分两档 | `scratch/` 可写，其余默认只读，系统文件审批优先于普通 workspace 放行 | 第一期补齐调度器与 Bash 的路径判断顺序，并隔开读取与写入授权；不再接受上级 workspace 覆盖只读规则或读取许可授予写权限这两项例外 |

### 4.3 实施分期

| 期 | 内容 | 依赖 |
|---|---|---|
| 第一期 | 归属与路径、初始化建目录、两档可信路径及权限优先级修正、读取与写入授权分离、主子代理基础提示词、环境提醒、随删除清理 | 无。side chat 的归属分支由本模块第一期和 side chat 议题中后落地的一方接上（见 side chat 02 Stage 1 第 7 步） |
| 第二期 a | 超长工具输出存盘：`web`、`list`（经 `renderList`）、`glob`（经 `truncateIfTooLong`）和 Bash | 第一期 |
| 第二期 b | 服务端列文件、读文件；Web 右侧面板 Files 页 | 第一期 |

第二期 a 与 b 互不依赖。

### 4.4 需要同步的权威文档

| 文档 | 改什么 |
|---|---|
| `docs/sandbox/improve-2/integration-plan.md`（:21-25、:49 列了可信路径类型） | 加两档会话可信路径；说明系统文件判断优先于 cwd，读取许可不放行写入或 Bash 目录访问 |
| `docs/permission/` 的现有权限说明 | 同步读写规则身份和 always 授权范围，保留原审批交互 |
| `docs/services/session/` 中会话删除的说明 | 删除时多删一个目录 |
| 第二期：`docs/tools/` 中输出截断的说明、`docs/ohbaby-web/` 的右侧面板说明 | 存盘与 Files 页 |
