# dfd-interface

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
      → sessionManager.get(scope.sessionId) 定归属：有 parentId → parentId；是 side chat → data.sideChat.mainSessionId；否则 → 自己
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
    "Session scratch directory: <path> (shared by this session, its subagents and its side chat; for temporary files and outputs; not part of the workspace)"
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

目前唯一的删除路径是 daemon 的会话删除（`S/runtime/daemon/main.ts:557-566`）。side chat 议题新增的关闭与启动清理也会调用这个函数，但 side chat 自己没有存储区，删除时是空操作。

### 2.4 超长工具输出（第二期 a）

```
工具得到完整输出 text，长度超过它现有的截断阈值
  （truncateOutput 默认 8k token，A/tools/utils/output.ts:4；web 的 WEB_OUTPUT_TOKEN_LIMIT 相同，A/tools/web.ts:28）
  → writeToolOutput({ ownerId, callId, text })：第一次写时建 tool-results/，写 tool-results/<callId>-<随机>.txt，上限 10 MB
  → 返回给模型：截断后的内容 + 一行 "Full output (N characters) saved to <path>. Use read or grep to inspect it."
    只有文件包含完整输出时使用 Full output；达到 10 MB 上限时明确说明只保存了部分输出及其路径
  → 写文件失败：返回保留的截断内容，并明确说明完整输出未能保存、不附成功路径；例如 "Full output could not be saved; only the truncated output is available."
```

接入的工具：`list`（经 `renderList`，`A/tools/list.ts:59`）、`glob`（直接调 `truncateIfTooLong`，`A/tools/glob.ts:81`）、`web`（`renderResult` 现在拿不到调用上下文，`web.ts:487`，要把 `sessionId` 和 `callId` 传进去）。

Bash：`A/tools/shell-job-registry.ts` 在捕获时只保留头尾（`OUTPUT_CAPTURE_CHAR_LIMIT`，:29、:132-150）。任务启动参数里已有 `sessionId` 和 `owner.callId`（:42-54，`A/tools/bash.ts:248-259`）。第二期由 `bash.ts` 给任务传一个可选的输出文件路径 `tool-results/<jobId>.log`，任务在捕获的同时把完整的 stdout 和 stderr 追加写进去（上限 10 MB）；输出被截断时在结果里附上路径。任务登记本身不认识存储区。

输出保存失败与命令执行失败要分开说明：命令已执行成功、但日志写盘失败时，保留真实命令结果，同时报告日志未能完整保存。部分写入或达到文件上限时不得将文件描述为完整输出；失败说明不假装提供成功保存的路径。第二期落实这一原则。

### 2.5 列文件与读文件（第二期 b）

```
Web 右侧面板 Files 页打开
  → GET /v1/sessions/:id/files              → 归属会话 scratch/ 下的文件列表（相对路径、大小、修改时间）
  → 用户点开一个文件
  → GET /v1/sessions/:id/files/content?path=<相对路径>
      → 真实路径必须在 scratch/ 内、是普通文件、不是符号链接
      → 文本文件不超过 1 MB 时返回文本；图片返回图片；其他类型返回 415，界面只显示文件名和大小
  → Web 用带鉴权的 fetch 取回内容再展示（需要新写一个取二进制的小函数，现有的 download-file.ts 只能把文本转成下载）
```

鉴权照 `/view` 的写法（`S/protocols/web/routes/sessions.ts:72-96`：`authorizePromptMutation` 加 `sessionReadForClient`），只允许客户端读自己绑定的会话。

## 3. Interface Definition

### 3.1 第一期

```ts
// A/paths/session-storage.ts
export const SCRATCH_DIR = "scratch";
export const TOOL_RESULTS_DIR = "tool-results";
resolveSessionStorageDir(ownerSessionId: string, options?: OhbabyPathOptions): string
// 子代理结果搬迁议题新增：SUBAGENTS_DIR = "subagents"、resolveSessionStorageRoot(options?)（返回 <OHBABY_HOME>/sessions）
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
writeToolOutput(input: { ownerSessionId: string; callId: string; text: string }): Promise<string | undefined>
listSessionFiles(ownerSessionId: string): Promise<ReadonlyArray<{ path: string; size: number; modifiedAt: string }>>
readSessionFile(ownerSessionId: string, relativePath: string): Promise<
  { kind: "text"; text: string } | { kind: "image"; contentType: string; bytes: Uint8Array }
>
```

```
GET /v1/sessions/:id/files
GET /v1/sessions/:id/files/content?path=<相对路径>
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
