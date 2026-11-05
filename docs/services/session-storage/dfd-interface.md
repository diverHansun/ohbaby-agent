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

```
一轮运行第一次申请 sandbox（A/adapters/ui-runtime/host-local-environment.ts:208-215）
  → SandboxManager 创建 (sessionId, contextScopeId) 的上下文
  → 调用注入的 initialTrustedRoots(scope)
      → sessionManager.get(scope.sessionId) 定归属：有 parentId → parentId；是 side chat → data.sideChat.mainSessionId；否则 → 自己
      → ensureSessionStorage(ownerId)：建 sessions/<ownerId>/scratch
      → 返回 [{ kind: "session-storage", path: sessions/<ownerId> },
              { kind: "session-scratch", path: sessions/<ownerId>/scratch }]
  → TrustedRootRegistry 登记
  → 本次运行里：
      scratch/ 内的读、写、Bash 路径都视为可信，不弹确认
      会话目录其余部分：read、grep 等读取不弹确认；写入按外部写入确认；Bash 预检不认 session-storage，按外部路径确认
```

`ensureSessionStorage` 失败时（例如磁盘只读）记日志，返回空列表，运行照常继续。这时 agent 写存储区会按外部路径走权限确认。上下文重建（换运行目录、释放子代理作用域、daemon 重启）时会再次调用，重复建目录不报错。

### 2.2 告诉模型（第一期）

```
准备一轮运行，收集环境提醒
  → environment 提醒在现有几行之后加一行：
    "Session scratch directory: <path> (shared by this session, its subagents and its side chat; for temporary files and outputs; not part of the workspace)"
  → 只写 scratch 路径。subagents/、tool-results/ 的路径由系统在交付结果时直接给出，不在提醒里列
  → 算路径失败时只省略这一行，其余内容照常
  → 路径对一个会话固定，提醒内容不变就不重发
```

### 2.3 删除（第一期）

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
  → 写文件失败：照现在的方式截断，不附路径
```

接入的工具：`list`（经 `renderList`，`A/tools/list.ts:59`）、`glob`（直接调 `truncateIfTooLong`，`A/tools/glob.ts:81`）、`web`（`renderResult` 现在拿不到调用上下文，`web.ts:487`，要把 `sessionId` 和 `callId` 传进去）。

Bash：`A/tools/shell-job-registry.ts` 在捕获时只保留头尾（`OUTPUT_CAPTURE_CHAR_LIMIT`，:29、:132-150）。任务启动参数里已有 `sessionId` 和 `owner.callId`（:42-54，`A/tools/bash.ts:248-259`）。第二期由 `bash.ts` 给任务传一个可选的输出文件路径 `tool-results/<jobId>.log`，任务在捕获的同时把完整的 stdout 和 stderr 追加写进去（上限 10 MB）；输出被截断时在结果里附上路径。任务登记本身不认识存储区。

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
isShellTrustedRootKind(kind: TrustedRootKind): boolean  // session-storage 返回 false，其余 true

// A/core/tool-scheduler/scheduler.ts
isWriteTrustedRootKind(kind)  // 现有三种 + session-scratch；session-storage 不算可写
```

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
