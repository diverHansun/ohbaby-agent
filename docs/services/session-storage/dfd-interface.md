# dfd-interface

2026-11-05 实施状态：第一期、子代理结果搬迁、第二期 a 工具输出存盘及第二期 b 后端文件 API 已实现；当前归属按 `parentId ?? sessionId` 计算。本文涉及 side chat 共享、fork 独立目录及源文件读取的内容是后续议题的约束，尚未实现或验收；Files 前端已实现，S17 浏览器走查见 [frontend-implementation](frontend-implementation.md)。

> 2026-11-04。路径缩写同 [architecture](architecture.md)。

## 1. Context & Scope

本模块的输入是归属会话 ID 和 `OHBABY_HOME`。调用方：

| 调用方 | 用来做什么 |
|---|---|
| `composition.ts` 提供给 sandbox 的回调 | 算归属 ID、建目录、返回要登记的可信路径 |
| 环境提醒 | 拿到 scratch 路径写进提醒 |
| 会话删除的文件清理 | 删除目录 |
| 子代理结果导出（[子代理结果搬迁议题](../../problem-lists/2026-11-05-subagent-results-location/README.md)） | 用 `resolveSessionStorageRoot()` 定位，把长报告写进 `subagents/` |
| 第二期：截断输出的工具 | 存完整输出 |
| 第二期：服务端会话路由 | 列文件、读文件 |

它不调用数据库，不发事件。

## 2. Data Flow Description

### 2.1 建目录与授权（第一期）

以下审批行为以默认 `default` 权限档位、没有预先放行该操作的用户授权为基线。系统文件默认只读：模型请求改写时先弹审批，拒绝或取消后不执行写入，批准后按既有授权规则执行。系统自身保存报告和工具原文不属于模型工具写入，不触发这类审批。

```
会话运行初始化，首轮模型请求及工具使用之前申请 sandbox（A/adapters/ui-runtime/host-local-environment.ts:208-215）
  → SandboxManager 创建 (sessionId, contextScopeId) 的上下文
  → 调用注入的 initialTrustedRoots(scope)
      → sessionManager.get(scope.sessionId) 定归属：有 parentId → parentId；否则 → 自己（side chat 分支待其议题实现）
      → ensureSessionStorage(ownerId)：建 sessions/<ownerId>/scratch
      → 返回 [{ kind: "session-storage", path: sessions/<ownerId> },
              { kind: "session-scratch", path: sessions/<ownerId>/scratch }]
  → TrustedRootRegistry 登记
  → 本次运行里：
      scratch/ 内的读、写、Bash 路径都视为可信，不弹确认
      会话目录其余部分：read、grep 等读取不弹确认；写入按外部写入确认；Bash 按外部路径确认
      写入及 Bash 预检先判断系统文件范围，再判断普通 cwd 或上级可信根；上级目录自动放行不能覆盖系统文件审批
```

读取、写入、Bash 目录访问使用可区分的现有审批规则身份。“始终允许”保存和后续匹配都遵守这个区分，读取批准登记的路径也只能用于读取。用户明确批准某项写入或 Bash 访问后，按对应授权范围复用；不为此增加新的审批服务或交互。

`ensureSessionStorage` 失败时（例如磁盘只读）记录错误，不登记会话可信路径，也不向模型宣告 scratch 可用。沿用原方案允许会话继续的处理，但环境提醒必须明确说明 scratch 暂不可用；审批不能解决磁盘或目录准备失败。上下文重建（换运行目录、释放子代理作用域、daemon 重启）时重新准备，重复建目录不报错。该目录准备结果应传给环境提醒，不增加独立的持久化状态。

### 2.2 告诉模型（第一期）

此流程只告知文件落点，不切换 cwd，也不改变相对路径含义。2026-11-05 复查确认采用“基础提示词写规则，环境提醒给路径”，主代理和子代理都覆盖。

固定规则分别写进 `prompts/primary/base.md` 和 `prompts/subagents/base.md`，不新增共用提示词模块。内容要求如下，英文措辞在实施时按现有风格编写：

1. 需要创建临时脚本、中间结果或非项目报告时，使用环境提醒给出的 session scratch 绝对路径，不默认写进用户 workspace。
2. 正常项目修改和用户明确指定落点的文件，仍按任务要求写入；cwd 不变。
3. 不为每次汇报额外生成文件。确实需要保存时才写文件，并返回文件路径；共享目录里的文件名要能区分任务，避免覆盖其他代理的文件。
4. scratch 的存在不扩大任务权限。`explore` 等只读角色继续不写文件；它们直接返回结果，系统仍可按现有机制导出长报告。
5. 环境提醒未提供 scratch 路径时，不猜测路径，也不默认回退到用户项目写临时报告；先在回复中提供必要结论。用户已明确指定文件落点的任务仍按任务要求处理。

子代理基础提示词中原有的“长日志或长分析写文件”句子同步改写，避免它变成无条件生成文件的要求。

```
组装系统提示词
  → 主代理：primary/base.md 提供固定规则
  → 子代理：subagents/base.md 提供固定规则，再叠加角色要求
准备一轮运行，收集环境提醒
  → environment 提醒在现有几行之后加一行：
    "Session scratch directory: <path>"
  → 只写 scratch 路径。subagents/、tool-results/ 的路径由系统在交付结果时直接给出，不在提醒里列
  → 只有目录与可信路径准备成功才提供上述可用路径；失败时改为 "Session scratch directory: unavailable"，其余环境信息照常
  → 路径对一个会话固定，提醒内容不变就不重发；可用状态变化也会更新提醒
```

### 2.3 删除（第一期）

2026-11-05 复查确认：一轮任务或子代理结束、关闭、会话归档、恢复、移动 workspace 都不触发会话文件的自动删除，也不新增定时清理。只有永久删除归属根会话时，才一起清理其 `scratch/`、`subagents/`、`tool-results/`；不触碰用户 workspace 中的项目文件。

```
归属会话永久删除提交到数据库
  → cleanupDeletedSessionFiles(result, { ..., sessionStorageRoot })
  → 对 result.sessionIds 里的每个 id：rm -rf sessions/<id>，force，失败只记日志
```

目前唯一的删除路径是 daemon 的会话删除（`S/runtime/daemon/main.ts:557-566`）。side chat 议题落地时，其关闭与启动清理也需遵守归属规则；不能因关闭 side chat 而删除主会话目录。

### 2.4 超长工具输出（第二期 a）

```
工具已取得的输出 text，超过现有显示阈值（默认 8k token）
  → 从 context.environment.trustedRoots() 读取已登记的 session-storage 根
  → writeToolOutput({ environment, callId, text })：建 tool-results/，写 <safe-callId>-<UUID>.txt
    文件上限为 10 MiB = 10,485,760 字节，截断说明也计入上限；目录 0700、文件 0600（POSIX）
  → 返回给模型：原截断内容 + "Full output (N bytes) saved to <path>. Use read or grep to inspect it."
    只有文件包含本次已取得的全部输出时使用 Full output；达到文件上限时明确说明 Partial output 及路径
  → 写文件失败：返回保留的截断内容，并明确说明完整输出未能保存、不附成功路径；例如 "Full output could not be saved; only the truncated output is available."
```

接入的工具是 `list`、`glob`、`web_search` 与 `web_fetch`。它们在最后的显示截断处调用 `persistDisplayedOutput`，短结果不落盘。`list` 的条目 limit、`glob` 的扫描限制和 Web provider 的采集限制保持不变；文件保存已取得的内容及原有不完整说明，不补采未取得的数据。

Bash 由 `bash.ts` 准备输出目录并传可选 `outputDirectory`；`ShellJobRegistry.start` 使用自己生成的 jobId 建 `<jobId>.log`。registry 不接触存储归属、会话数据库或 `OHBABY_HOME`。stdout/stderr 的原始 Buffer 按事件到达顺序同步写入文件，然后更新原有的有界内存头部或尾部；不承诺两个流在操作系统层面的全序。达到 10 MiB 后保留带截断说明的部分文件，停止后续写盘并关闭句柄，继续消费流与更新内存。同步写入处理短写，没有待写队列，UTF-8 截断不留下半个字符。

日志完成由实际 stdio `close` 决定，不能绑到提前发布的逻辑终态。运行中给出目前捕获的路径与 `in-progress`；取消、排空超时或 dispose/prune 放弃捕获时标记 `partial`，按已有清理期限封口并释放句柄。仅正常 stdio close 且文件关闭成功后给出 `full`。open/write/close 失败为 `unavailable`，不附成功路径，也不改变命令的 status、exitCode 或 executionOutcome。文件随根会话保留，任务淘汰和 registry dispose 不删除日志。

内部写入拒绝被重定向的根、tool-results 目录与预置同名文件/链接；文件使用独占创建。缺少已登记根时不按 `context.sessionId` 猜路径，也不做每工具一次的数据库归属查询。

### 2.5 列文件与读文件（第二期 b）

```
Web 右侧面板 Files 页打开
  → GET /v1/sessions/:id/files?runtimeEpoch=...&bindingGeneration=...
      → 当前绑定根会话 scratch/ 下的普通文件列表（相对路径、字节大小、ISO 修改时间），递归后按路径排序
  → 用户点开一个文件
  → GET /v1/sessions/:id/files/content?runtimeEpoch=...&bindingGeneration=...&path=<相对路径>
      → path 非空，使用 / 分隔；拒绝绝对路径、NUL、反斜杠和 .. 路径段
      → sessions、根会话、scratch 及内部每个路径分量都不能被符号链接重定向；允许配置 home 的系统规范路径别名
      → 目标必须是 scratch 内的普通文件，打开前后核对真实路径及文件句柄身份
      → 文本最多 1 MiB（1,048,576 字节），严格 UTF-8 解码，原文以 text/plain; charset=utf-8 返回；HTML、SVG 同样按文本返回
      → PNG、JPEG、GIF、WebP 按内容签名识别，最多 10 MiB（10,485,760 字节），返回原始图片字节及对应 MIME
      → 其他二进制或无效 UTF-8 返回 415，界面以后只显示文件名和大小
  → Web 用带鉴权的 fetch 取回内容再展示（需要新写一个取二进制的小函数，现有的 download-file.ts 只能把文本转成下载）
```

鉴权复用 `/view` 的 bearer token、已注册客户端、`runtimeEpoch` 和 `bindingGeneration` 检查。专用 `sessionFileReadForClient` 在异步文件读取前后检查绑定和根会话仍然有效，不加载完整聊天 view。绑定变化或根会话不可用沿用 409。两个文件路由均带 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`；错误继续返回 `{ ok: false, error: { code, message } }`。

列表只列普通文件，跳过符号链接及非普通条目，不列 `subagents/`、`tool-results/` 或其他根会话。scratch 尚未创建时返回空列表，读取请求不会创建目录；其他磁盘故障如实返回错误。内容用真实句柄有界读取，文件在读取时增长也不能突破固定容量，句柄在 `finally` 中关闭。这些检查不是操作系统级的文件隔离。

前端已实现：Web 用 `DaemonHttpClient.send` 带 bearer token 取原始响应，图片转 object URL，文本直接显示。页面行为见 `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` §4.9 的 Files 页。

## 3. Interface Definition

### 3.1 第一期

```ts
// A/paths/session-storage.ts
export const SUBAGENTS_DIR = "subagents";
export const SCRATCH_DIR = "scratch";
export const TOOL_RESULTS_DIR = "tool-results";
resolveSessionStorageDir(ownerSessionId: string, options?: OhbabyPathOptions): string
resolveSessionStorageRoot(options?: OhbabyPathOptions): string  // <OHBABY_HOME>/sessions
ensureSessionStorage(ownerSessionId: string, options?: OhbabyPathOptions): Promise<string>  // 建会话目录和 scratch/，返回会话目录
// 不合法的 id 抛 InvalidSessionStorageIdError

// A/sandbox/manager.ts
interface SandboxManagerOptions {
  // ...现有字段
  readonly initialTrustedRoots?: (scope: NormalizedSandboxScope) => Promise<readonly { kind: TrustedRootKind; path: string }[]>;
}

// A/sandbox/trusted-roots.ts
type TrustedRootKind = /* 现有五种 */ | "session-storage" | "session-scratch";
isShellTrustedRootKind(kind: TrustedRootKind): boolean  // session-storage、仅获读取批准的类型返回 false

// A/core/tool-scheduler/scheduler.ts
isWriteTrustedRootKind(kind)  // session-scratch 可写；session-storage 与仅获读取批准的类型不可写
```

上述类型筛选不足以单独落实保护。调度器和 Bash 预检还需拿到已登记的会话系统范围与 scratch 例外，按真实目标优先判断系统文件，再应用 cwd 和普通可信根。审批请求沿用现有 `PermissionRule.tool` / `tool(pattern)`，区分读取、写入和 Bash 目录访问，生成、保存及匹配一起调整；具体命名在实施时沿用仓库风格，不新建规则格式。

### 3.2 第二期

```ts
// A/services/session-storage.ts
prepareToolOutputDirectory(environment?: Pick<ToolExecutionEnvironment, "trustedRoots">): Promise<string | undefined>
writeToolOutput(input: {
  environment?: Pick<ToolExecutionEnvironment, "trustedRoots">;
  callId: string;
  text: string;
}): Promise<OutputFileSnapshot>
// 替换草案的 string | undefined，区分完整、达上限与失败，避免把部分文件称为完整。
// 非 Bash 的返回只会是 full、partial(size-limit) 或 unavailable。
// Bash 快照额外允许 in-progress、partial(stdio-incomplete)。
type OutputFileSnapshot =
  | { status: "unavailable" }
  | { status: "full" | "in-progress"; path: string; sizeBytes: number }
  | { status: "partial"; path: string; sizeBytes: number; reason: "size-limit" | "stdio-incomplete" };

// 第二期 b 后端：
export const SESSION_TEXT_FILE_MAX_BYTES = 1024 * 1024;
export const SESSION_IMAGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
interface SessionFileEntry { readonly path: string; readonly size: number; readonly modifiedAt: string }
type SessionFileContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly contentType: string; readonly bytes: Uint8Array<ArrayBuffer> };
listSessionFiles(ownerSessionId: string, signal?: AbortSignal): Promise<readonly SessionFileEntry[]>
readSessionFile(ownerSessionId: string, relativePath: string, signal?: AbortSignal): Promise<SessionFileContent>
// 文件错误抛 SessionFileError，code 为下表四种值；这些 API、类型及常量从 ohbaby-agent 根入口导出。
```

```
GET /v1/sessions/:id/files?runtimeEpoch=...&bindingGeneration=...
  → { ok: true, files: SessionFileEntry[] }
GET /v1/sessions/:id/files/content?runtimeEpoch=...&bindingGeneration=...&path=<相对路径>
  → 原始文本或图片字节
400 INVALID_PATH            路径越界、是符号链接或不是普通文件
404 FILE_NOT_FOUND
413 FILE_TOO_LARGE
415 UNSUPPORTED_FILE_TYPE   不是文本也不是图片
```

## 4. Data Ownership & Responsibility

| 数据 | 谁写 | 谁读 | 谁删 |
|---|---|---|---|
| `scratch/` 下的文件 | 根会话、它的子代理、它的 side chat（经工具） | 同上；第二期的 Files 页 | 根会话删除时由本模块删 |
| `subagents/` 下的文件 | 子代理结果导出（子代理结果搬迁议题） | 根会话、它的子代理、它的 side chat（只读） | 同上 |
| `tool-results/` 下的文件 | 第二期的工具 | agent（只读） | 同上 |
| 目录本身 | 本模块（sandbox 回调） | — | 同上 |

本模块对文件内容不做任何解释。
