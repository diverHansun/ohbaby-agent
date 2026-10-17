# 1. 问题基线与当前实施状态

> 时间口径：基于 `main` 分支 `0bcda484`（2026-10-17）。分析时还没有开始写任何导出代码。
> 下文的行号是这个时间点的快照。代码位置以符号名为准。

## 1.1 问题陈述

1. **用户没法把讨论带出 ohbaby。** 会话只存在 SQLite（`ohbaby.db`）里，没有任何导出入口。用户想留存讨论，只能手动复制屏幕上的文字，思考过程和工具调用基本带不出来。
2. **能"看到"的不等于"存着"的。** compact 以后 UI 不再显示原始消息，摘要也只显示一行。但数据库里其实全都留着。现在没有一条路径能把完整内容取出来。
3. **TUI 和网页端读取会话的路径不一样，权限也不一样。** 现有的会话读取接口只允许读当前选中的会话，但网页端菜单要导出的往往不是当前会话。所以没有现成接口可以直接复用。
4. **TUI 的命令默认在后端执行。** 远程模式下，如果让后端写文件，文件会落在后端那台机器上，不在用户手边。

## 1.2 已确认的边界

见 [00-discussion.md](./00-discussion.md)。新模块本身的设计见 [../goals-duty.md](../goals-duty.md) 等 5 份文档。本文只分析接入时要改动的已有模块。

## 1.3 数据层现状（导出的数据来源）

| 维度 | 现状 | 代码锚点 |
|---|---|---|
| 存储 | 一个 SQLite 文件，`session`、`message`、`part` 三张表。message 和 part 的 `data` 列存的是整个对象的 JSON | `services/database/schema.ts`、`core/message/database-store.ts:75-89` |
| 读取 | `listBySession(id, options?)`：不传 options 时返回所有 scope；传 `{contextScopeId: undefined}` 时只返回主上下文，并且**包含 compact 掉的 part** | `core/message/database-store.ts:701-750` |
| compact | `commitCompaction` 只给原 part 打上 `time.compacted`，再插入一条摘要消息，**不删除任何数据** | `core/message/database-store.ts:551-705` |
| part 类型 | 只有 4 种：`text`、`reasoning`、`tool`、`model-state` | `core/message/types.ts:83-159` |
| 隐藏内容 | model-context 的判断是 `isModelContextPart`，摘要的判断是 `isContextSummaryPart` | `core/message/origin.ts` |
| 会话元数据 | `Session` 上没有模型和 token。模型记在每条助手消息上，token 记在 `modelRequests[].usage` 或 part 的 `metadata.tokenUsage` 上 | `services/session/types.ts:11-25`、`core/message/store.ts:675-691` |
| UI 投影 | `messageToUiMessage` 会去掉 compact 掉的 part、隐藏 `select_tools`、`todo_read`、`todo_write`，摘要只显示一行。所以**不能拿来做导出** | `adapters/ui-state/persistent-store.ts:48-53,154-267` |

（上表路径都相对于 `packages/ohbaby-agent/src/`。）

**gap：** 数据完整，但没有"完整读取 + 面向导出的过滤"这一层。新模块要补的就是这一层。

## 1.4 SDK 与后端适配层现状

| 维度 | 现状 | 代码锚点 |
|---|---|---|
| 客户端契约 | `UiBackendClient = UiQueryClient & UiCommandClient`，TUI 拿到的是 `CoreAPI`（去掉了 `subscribeEvents`） | `packages/ohbaby-sdk/src/client.ts:232`、`src/rpc/types.ts:4` |
| 本机模式 | TUI 通过 RPC 代理调用后端，代理里有一张"哪个参数带 signal"的映射表 | `packages/ohbaby-sdk/src/rpc/proxy.ts:14-29`、`ohbaby-cli/src/bin.ts:193-199,646` |
| 远程模式 | `createRemoteCoreApiHost` 走 JSON-RPC，方法名白名单是 `DAEMON_RPC_METHODS` | `ohbaby-cli/src/bin.ts:386-393`、`ohbaby-server/src/protocols/jsonrpc/protocol.ts:3-44` |
| 后端实现 | `ui-inprocess.ts` 实现全部方法，`ui-persistent.ts` 是一层包装 | `adapters/ui-inprocess.ts:4493`（archiveSession）、`adapters/ui-persistent.ts:492` |
| 参考写法 | archive 一路的写法：SDK 类型 → ui-inprocess 实现 → persistent 包装 → JSON-RPC 三处（protocol、rpc-route、client）→ REST 路由 → web http/client/runtime | 见 1.5 |

**gap：** 没有 `exportSession` 方法。按 archive 的写法新增一个，大约要改 8 处，每处都很小。export 是只读操作，**不用**进 `ui-command-gateway` 和 `command-record` 的变更记录（archive 是变更操作，所以在那里）。

## 1.5 server 现状

| 维度 | 现状 | 代码锚点 |
|---|---|---|
| archive 路由 | `PATCH /v1/sessions/:id/archive`：依次校验 token、clientId、client 是否已注册，然后调 `commandBackend(...).archiveSession` | `ohbaby-server/src/app/create-app.ts:1999-2026` |
| 会话读取路由 | `/v1/sessions/:id/view\|history\|control` 走 `sessionReadForClient`，**只允许读当前选中的根会话** | `create-app.ts:1450-1473`、`src/coordination/session-access.ts:120-150` |
| 错误体 | `webErrorBody(message)` 只有 message，没有 code。状态码由 `mutationErrorStatus` 按 message 前缀猜 | `create-app.ts:199-201,289-295` |

**gap：**
- 导出不能走 `sessionReadForClient`，否则从菜单导出非当前会话时会被拒绝。导出的校验应该和 archive 一样，只读操作直接调 `this.options.backend`。
- 错误体要带上 code，状态码按 code 映射，不按 message 前缀猜。

## 1.6 TUI 现状

| 维度 | 现状 | 代码锚点 |
|---|---|---|
| 命令目录 | 所有 slash 命令都在后端的 `BUILTIN_COMMANDS` 里，用 `surfaces` 控制哪些端可见 | `ohbaby-agent/src/commands/catalog.ts:8-12,61-72` |
| 本地拦截 | `INTERACTIVE_COMMAND_IDS`（connect、connect-search、effort）命中后，TUI 本地处理，**不发给后端** | `ohbaby-cli/src/tui/components/dialog/command-panel-state.ts:51-55`、`components/prompt/index.tsx:1349-1386` |
| 后端占位 | `effort` 在后端只有一个 `INTERACTION_REQUIRED` 占位实现 | `ohbaby-agent/src/commands/builtin.ts:663-672` |
| 本地提示 | TUI 自己发提示用 `store.dispatch({ type: "notice.emitted", … })` | `ohbaby-cli/src/tui/app.tsx:453-467` |
| 写本地文件 | 已经有先例：`pending-prompts.ts` 用 `node:fs` 和 `homedir()` 写文件 | `ohbaby-cli/src/tui/pending-prompts.ts` |
| Downloads | **没有**任何解析 Downloads 目录或 `XDG_DOWNLOAD_DIR` 的代码 | — |
| 命令拦截点 | `app.tsx` 的 `executePromptCommand` 已经在拦截 `compact`，它作为 `executeCommand` 注入给 prompt | `ohbaby-cli/src/tui/app.tsx:164-182,1145` |
| 带参数的命令 | 解析器要求命令声明 `acceptsArguments: true`，否则拒绝带参数的写法 | `ohbaby-sdk/src/slash-command/resolve.ts:118-122` |
| 当前会话 | `activeSessionIdRef` 可以直接读到 | `ohbaby-cli/src/tui/app.tsx:152-156` |
| 提示 helper | `emitNotice` 定义在 effect 里面，级别固定为 `warning` | `ohbaby-cli/src/tui/app.tsx:453-467` |
| 会话 id 格式 | `session_<毫秒时间戳>_<随机段>`，前 8 位恒为 `session_` | `ohbaby-agent/src/services/session/id-generator.ts:16` |

**gap：**
- `/export` 不需要弹面板，拦下来之后直接执行，执行完发提示就行。所以不该塞进 `INTERACTIVE_COMMAND_IDS`（那会打开面板）。在现有的 `executePromptCommand` 里加一个分支是改动最小的做法。
- 要有一个能指定级别的提示 helper。
- Downloads 目录解析要新写。

## 1.7 Web 现状

| 维度 | 现状 | 代码锚点 |
|---|---|---|
| 菜单 | `SessionActionsMenu` 里写死了两个 `<button role="menuitem">`（Pin、Archive）。键盘导航是查询菜单里所有 `button`，用上下键移动 | `apps/ohbaby-web/src/ui/session/SessionActionsMenu.tsx:18-131` |
| 接线 | `SessionSidebar` 负责 setPin 和 archive，然后渲染菜单 | `SessionSidebar.tsx:139-170,234-248` |
| 调用链 | `SessionScreen` → `runtime.archiveSession` → `client.archiveSession` → `http.archiveSession` | `SessionScreen.tsx:708-716`、`runtime.ts:150-151`、`api/daemon/client.ts:979-983`、`api/daemon/http.ts:332-339` |
| HTTP | 统一的 `request()` 带 Bearer token，并按 JSON 解析响应 | `api/daemon/http.ts:543-583` |
| 子菜单、下载 | **没有**子菜单组件，也**没有**任何 `createObjectURL` 或 `download` 的工具函数 | — |

**gap：**
- 要新增子菜单交互，还要处理好键盘：主菜单的上下键导航不能把子菜单里的项也算进去。
- 要新增 Blob 下载。
- 因为请求要带 token，不能用 `<a href>` 直链下载。

## 1.8 跨模块一致性

- TUI 和网页端最终都调同一个 `exportSession`，内容由同一个模块生成，所以两边导出的内容不会不一样。
- archive 会拒绝子代理会话（`isPrimarySession`）。导出保持同样的规则，由模块抛出 `SUBAGENT_SESSION`。
- archive 只校验"client 已注册"，**不校验会话是否属于这个 client 的工作区**。导出沿用同样的级别，没有比 archive 放得更宽。这一点在 04 里列为审查项。

## 1.9 改动影响面（现状视角）

- **新增**：`ohbaby-agent/src/services/session-export/`、一个资源生成脚本、TUI 的 Downloads 和保存工具、web 的子菜单和下载工具。
- **修改**：SDK 契约和 RPC 代理、ui-inprocess 和 ui-persistent、JSON-RPC 三处、REST 一处、命令目录和占位实现、TUI 的命令分发、web 的菜单、侧边栏、runtime、client、http。
- **不动**：数据库 schema、消息存储、compact 逻辑、UI 投影。

## 1.10 SWE 原则审视

- **依赖方向**：新模块放在 services 层，只依赖 core 的类型，以及注入进来的两个 manager。上层（adapter、server、TUI）调用它，方向正确。
- **信息隐藏**：过滤规则、模板、安全措施都封装在模块内部，对外只暴露一个函数和一组错误码。
- **YAGNI**：没有导入、没有格式注册表、没有流式输出、没有自定义路径。
- **可逆性**：JSONL 格式一旦发布就有用户依赖，属于半不可逆的决定，所以用 `version` 字段兜底。其他改动都是可以撤回的新增。

## 1.11 与既有文档的关系

- `docs/core/message/data-model.md` §4.5–4.8 还写着 FilePart、StepStart 等类型，和代码不一致。本议题以代码为准，不修那份文档，只在这里标注。
- `docs/ohbaby-web/session-archive/` 是 archive 功能的设计文档，本文的接入方式参考了它。
- `docs/commands/` 描述了命令体系。新增的"TUI 本地执行命令"会在 02 里说明，实施时要同步更新 `docs/commands/architecture.md`。
