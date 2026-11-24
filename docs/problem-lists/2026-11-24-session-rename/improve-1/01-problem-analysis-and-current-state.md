# 1. 现状与问题分析

> 后端路径相对仓库根目录，Web 路径相对 `apps/ohbaby-web/src/`。行号以 2026-11-24 的 `main`（`3652021a`）为准。

## 1.1 标题从哪来

| 阶段 | 做什么 | 位置 |
|---|---|---|
| 新建会话 | 标题是 `New session` | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 约 3673 行 |
| 第一条消息被接收 | 用消息内容生成临时标题，`applyTemporarySessionTitle` 写入 | 同文件约 4091 行 |
| 第一轮开始后 | `scheduleSessionTitleGeneration` 让 LLM 生成正式标题，`applyGeneratedSessionTitleIfUnchanged` 写入 | 同文件约 4129、4158 行 |

标题的唯一来源是会话表（`sessionManager`）。线上用的 `stateStore` 是 `createPersistentUiStateStore`（`ui-persistent.ts` 约 868 行）：它的 `getSession` 每次从会话表读标题，`upsertSession` 什么都不做（`ui-state/persistent-store.ts` 约 678 行，注释写明快照可能在并发改名后过期，不能把标题写回去）。只有不传 `stateStore` 时用的内存版才会真的存一份 `UiSession`，那是测试场景。

窗口知道标题变了靠两条路：

- 实例发 `session.updated` 事件，打开着的会话、顶栏标题跟着变。
- 实例让会话索引失效（`publishSessionIndexInvalidation`），侧边栏和搜索重读。

自动起标题就是这么做的，改名照搬。

## 1.2 自动标题不会覆盖手动改名

两道检查已经存在：

1. `applyGeneratedSessionTitleIfUnchanged` 先读会话表，标题不等于 `expectedTitle`（它起名前看到的临时标题）就放弃；写的时候再带 `{ expectedTitle }` 条件写一次，防止读和写之间被改。
2. `isFirstUserMessageForTitle`：会话标题既不是默认值、也不是预期的临时标题时，不再自动起名。用户先把空会话改了名再发消息，就不会被自动标题顶掉。

结论：只要手动改名写的是同一个会话表字段，就天然赢过自动标题，不需要新加锁或标记。

## 1.3 改名会让会话跳到列表顶部

`packages/ohbaby-agent/src/services/session/manager.ts` 的 `update` 固定写入 `updatedAt: now()`。全局列表按 `updated_at` 倒序排（Web 端 `store/global-catalog.ts` 的 `sortSessions` 也一样）。直接复用 `update`，改完名会话就会跳到最上面，违背 00 C2。

底层 `store.update`（内存版 `store.ts`、数据库版 `database-store.ts` 约 636 行）只合并传进来的字段，不传 `updatedAt` 就保持原值。问题只在 manager 这一层。

## 1.4 写操作要经过哪些层

现有的会话级写操作有两类：

| 类型 | 例子 | 路由 | 走谁 |
|---|---|---|---|
| 工作区实例 | 归档、改模型、改推理强度 | `PATCH /v1/sessions/:id/archive` 等，在 `packages/ohbaby-server/src/protocols/web/routes/sessions.ts` | 请求带工作区目录头，daemon 转给对应实例；实例改库、改内存、发事件 |
| daemon 全局 | 移动工作区、恢复归档、永久删除 | `POST /v1/sessions/:sessionId/workspace` 等，在 `packages/ohbaby-server/src/runtime/daemon/server.ts` | daemon 直接改库 |

改名必须更新实例内存里的 `UiSession` 并发 `session.updated`，否则打开着的会话顶栏还是旧名字。所以它属于第一类，照归档的走法。

以 `updateSessionReasoning` 为样板，一个实例级命令要改这些地方：

| 层 | 文件 |
|---|---|
| SDK 契约 | `packages/ohbaby-sdk/src/contract/client.ts`（`UiBackendClient`） |
| 真正干活 | `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` |
| 持久客户端转发 | `packages/ohbaby-agent/src/adapters/ui-persistent.ts` |
| 命令网关与记录 | `packages/ohbaby-agent/src/host/ui-command-gateway.ts`、`command-record.ts` |
| JSON-RPC | `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`、`client.ts`、`rpc-route.ts` |
| REST | `packages/ohbaby-server/src/protocols/web/routes/sessions.ts`、`packages/ohbaby-server/src/app/openapi.ts` |
| Web 客户端 | `api/daemon/http.ts`、`client-commands.ts`、`client.ts` |

`UiBackendClient` 是 TypeScript 接口，实现它的地方漏了会编译失败，包括这些测试里的假实现：

- `packages/ohbaby-server/src/app/create-app.unit.test.ts`
- `packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts`、`client.integration.test.ts`、`main.unit.test.ts`
- `apps/ohbaby-web/src/api/daemon/server-client.integration.test.ts`
- `packages/ohbaby-sdk/src/contract/context-window.contract.test.ts`

但有几层漏了不报错，只是行为不对，要手动对照：`ui-command-gateway.ts` 的 `RECORDED_METHODS` 和 `command-record.ts` 的分支（漏了就不记录这条命令），以及 `openapi.ts`。另外 Web 和 server 通过 `dist` 引用 SDK，改完 SDK 要先构建，下游的类型检查才看得到新方法。

## 1.5 Web 侧边栏现状

- 会话菜单 `ui/sidebar/SessionMenu.tsx`：第一级是 Pin、Move to workspace…、Export…、Fork、分隔线、Archive。`…` 按钮和右键打开的是同一个菜单。菜单项靠 `data-menu-shortcut` 支持单键快捷键（`ui/shared/Menu.tsx` 约 215 行）。
- 会话行 `ui/sidebar/SessionRow.tsx`：标题在打开会话的 `<button>` 里面，悬停时标题太长会滚动。按钮里不能放输入框，编辑时要把这个按钮换成输入框。
- 行列表 `ui/sidebar/SessionList.tsx`：管理菜单开关、置顶、归档，归档的回调从 `ui/shell/AppController.tsx` 传进来，最终调 `runtime/index.ts` 的 `archiveSession`。
- `runtime/index.ts` 的 `archiveSession`：会话正打开且在当前实例时走 `instance.client`，否则走 `global.scopedHttp(会话目录)`；先乐观改目录（catalog），用 `global.beginWrite()` 防止进行中的列表刷新把乐观结果盖掉，失败就恢复。
- 顶栏标题来自 `view.activeSession?.title`（实例快照），收到 `session.updated` 后自动更新。

## 1.6 风险点

- **运行中改名**：线上 `upsertSession` 是空操作（§1.1），一轮开始、结束时写回的旧 `UiSession` 不会把标题改回去。剩下的是事件层面的小问题：`updateSessionReasoningInternal` 发的 `session.updated` 用的是 await 之前读到的会话（约 3436–3441 行），如果恰好和改名交错，顶栏可能短暂显示旧名字，下一轮结束时重新发布（约 5034–5047 行）会纠正。改名自己发事件时用 `sessionManager.rename` 的返回值，不会有这个问题。
- **乐观标题被盖回**，有两条路：
  - 全局列表刷新：归档已经用 `beginWrite` 解决，照搬。
  - 实例索引同步：`runtime/index.ts` 的 `syncFromInstanceIndex`（约 921–960 行）把实例索引里的标题直接写进侧边栏目录，不看有没有写操作在进行。别的会话一轮结束就会触发索引刷新，如果刷新结果在改名生效前回来，行上会闪回旧名字。`beginWrite` 管不到这里，要单独处理。
- **编辑时列表重排**：侧边栏按 `updatedAt` 排序，别的会话有新动静会把行挪位置，`SessionList` 也会因此关菜单（约 77–81 行）。React 移动 DOM 节点时，里面有焦点的输入框会失去焦点；如果"失焦就保存"，会把输入到一半的名字存下来。
- **切换窗口**：用户 Alt+Tab 走开也会触发输入框失焦。
- **手机宽度**：单击会话会关掉侧边栏抽屉（`AppController.tsx` 约 401–403 行），双击在手机上用不了。
