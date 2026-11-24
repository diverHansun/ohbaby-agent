# 2. 优化方案与改动面

> 本文交给实施会话。Web 路径相对 `apps/ohbaby-web/src/`，后端路径相对仓库根目录。

## 2.1 方案总览

后端新增一个实例级命令 `renameSession`，走法和归档一样。Web 在会话菜单里加 Rename，双击标题也能进入编辑，标题原地变成输入框。

```
SessionMenu › Rename / 双击标题
  → SessionRow 原地显示输入框（Enter 或失焦保存，Esc 取消）
  → runtime.renameSession：先改侧边栏目录里的标题，失败再改回
  → PATCH /v1/sessions/:id/title（带会话所在工作区的目录头）
  → 实例 renameSession：校验 → sessionManager.rename（不刷新 updatedAt）
                       → 改内存 UiSession → 发 session.updated → 让会话索引失效
  → 顶栏、其他窗口、侧边栏、搜索各自刷新
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| B1 走哪一层 | 工作区实例，路由 `PATCH /v1/sessions/:id/title`，和归档同一套 | 改名要更新实例内存里的 `UiSession` 并发 `session.updated`，打开着的会话顶栏才会变（01 §1.4） | daemon 全局路由：只改库，顶栏不更新 | 命令要穿过 SDK、gateway、JSON-RPC、REST 好几层，和 `updateSessionReasoning` 一样多 |
| B2 不刷新 `updatedAt` | `SessionManager` 新增 `rename(sessionId, title)`：只把 `{ title }` 传给 `store.update`，再发 `SessionEvent.Updated` | 用户选定（00 C2）。底层 `store.update` 不传 `updatedAt` 就保持原值，只需要 manager 这层不加 `now()` | 给 `update` 加一个"别刷新时间"的参数：把一个只有改名用的开关塞进通用接口；opencode 的 `Session.rename` 也是单独的方法 | `InProcessSessionManager` 的 `Pick` 要带上 `rename`，放在 `Partial` 那组里，测试里的假实现不用改 |
| B3 校验放哪 | SDK 导出 `SESSION_TITLE_MAX_LENGTH = 120` 和 `normalizeSessionTitle(raw)`（去首尾空白、连续空白合成一个空格）。后端用它校验，归一后为空或超长就报错；Web 用同一个函数决定发不发请求 | 规则只写一份，前后端不会不一致 | 前后端各写一份 | 无 |
| B4 能改哪些会话 | 只能改主会话。用 `requireOwnedSession` 取会话（会话不属于这个工作区时报错）；side chat 抛 `SideChatUnsupportedError`；`isPrimarySession(core)` 为假时报错 | 用户只说了主会话（00 §0.4）。侧边栏按 `requestDirectory`（待生效目录优先）发请求，`requireOwnedSession` 两种目录都认，Recents 里的会话不会被误拒 | 无 | 无 |
| B5 运行中能不能改 | 能改，不进 `withSessionAdmission` | 改名不影响正在跑的任务；只改标题字段 | 运行中禁止：没有必要 | 有一个很短的竞态窗口（01 §1.6），用测试兜住 |
| B6 自动标题 | 不改 | 现有的 `expectedTitle` 检查已经保证手动改名赢（01 §1.2） | 加"用户改过名"的标记：重复 | 把空会话改成 `New session`、`Untitled session` 这类默认名时，系统仍把它当默认名，发第一条消息后会自动起名（00 §0.4） |
| F1 入口 | 菜单第一级在 Pin 下面加 `Rename`，图标 `Pencil`，快捷键 `r`；主按钮 `onDoubleClick` 也进入编辑 | 用户选定（00 C3）。单击已经用来打开会话 | 单击已选中的会话进入编辑：容易误触 | 双击时第一下会先打开会话，这是预期的；手机宽度下单击会关抽屉，只能用菜单 |
| F2 编辑状态放哪 | `SessionList` 记 `editingId`，`SessionRow` 收 `editing` 和三个回调 | 和菜单的 `menu` 状态放在一起；同一时间只有一行在编辑 | 放在 `SessionRow` 自己里：菜单在 `SessionList`，要往下传"开始编辑"的信号 | 无 |
| F3 输入框 | 编辑时用 `<input>` 换掉主按钮（按钮里不能放输入框），沿用行的字号和行高，不加卡片边框，只有一条细的焦点描边；自动聚焦并全选；`maxLength` 120；`aria-label="Rename chat"`。编辑时隐藏行尾的图钉和 `…`，停止标题滚动 | Web UI 不用卡片和胶囊样式（用户偏好） | 弹出对话框：多一步操作 | 无 |
| F4 按键 | Enter 保存，Esc 取消（00 C4）。输入法正在组字时的 Enter 不算保存，用现有的 `isImeComposing`（`ui/composer/ime.ts`，兼顾 Safari 的 `keyCode 229`）。Enter、Esc 都 `stopPropagation`，不让行和抽屉上的按键处理再响应一次。编辑时行容器的 `onKeyDown`（ContextMenu、Shift+F10 打开菜单）和 `onContextMenu` 都不生效 | 中文输入法用回车上屏，不判断会把半截拼音存成标题 | 无 | 无 |
| F4b 失焦 | 失焦后等一帧再判断：窗口本身没有焦点（`!document.hasFocus()`，比如切到别的程序）就继续编辑；输入框还在页面上但焦点落到了 `body`（列表重排移动了 DOM）就把焦点还给输入框，继续编辑；其他情况（点到了别处）才保存 | 00 C4 要失焦保存，但重排和切窗口不是用户"点别处"，不能把输入到一半的名字存下来（01 §1.6） | 重排时锁住列表顺序：要改排序逻辑，牵连更大 | 无 |
| F5 保存判断 | `normalizeSessionTitle` 之后为空，或和原标题相同，就直接退出编辑，不发请求 | 00 §0.4 | 空标题恢复成 `New session`：用户没要求 | 无 |
| F6 乐观更新 | `runtime.renameSession(id, title, directory?)`：先 `catalog.upsertSession({ ...row, title })`，用 `global.beginWrite()` 包住请求；同时把 `id → title` 记进 `pendingRenames`，`syncFromInstanceIndex` 遇到这个 id 就跳过；请求结束（成功或失败）都删掉这条记录。失败时恢复原行并抛错，由 `AppController` 的 `runAction` 弹错误通知；成功后 `global.refresh()` | 照抄 `archiveSession` 的写法挡住全局刷新；实例索引同步是另一条路，`beginWrite` 管不到（01 §1.6），用一个按 id 的集合挡住，只影响正在改名的那一行 | 等服务器返回再显示：输入框关掉后会闪回旧名字；写操作进行中整个跳过索引同步：会把别的行的更新也挡掉 | 无 |
| F7 发往哪个实例 | 会话正打开且在当前实例时走 `instance.client.renameSession`，否则走 `global.scopedHttp(会话目录).renameSession`；目录取 `session.requestDirectory` | 和 `archiveSession` 一致 | 无 | 无 |
| F8 焦点 | Enter、Esc 结束编辑后焦点回到这一行的主按钮；失焦结束时不抢焦点 | 键盘用户能接着操作；点到别处时焦点应该留在别处 | 无 | 无 |

## 2.3 分阶段实施

### Stage 1：后端

**`packages/ohbaby-sdk/src/contract/client.ts`**（或 SDK 里放会话工具函数的现有文件，实施时看哪里合适）

- 导出 `SESSION_TITLE_MAX_LENGTH = 120` 和 `normalizeSessionTitle(raw: string): string`。
- `UiBackendClient` 加：

  ```ts
  /** Renames a primary session without changing its place in the list. */
  renameSession(input: {
    readonly sessionId: string;
    readonly title: string;
  }): Promise<UiSession>;
  ```

**`packages/ohbaby-agent/src/services/session/types.ts`、`manager.ts`**

- `SessionManager` 加 `rename(sessionId: string, title: string): Promise<Session>`。
- 实现：`getExistingSession` 确认存在；`store.update(sessionId, { title })`，不带 `updatedAt`；发 `SessionEvent.Updated`；返回新会话。

**`packages/ohbaby-agent/src/adapters/ui-inprocess/session-controller.ts`**：`InProcessSessionManager` 的 `Partial<Pick<…>>` 加 `"rename"`。

**`packages/ohbaby-agent/src/adapters/ui-inprocess.ts`**：新增 `renameSessionInternal`，挂到返回对象的 `renameSession`。

1. `requireOwnedSession(sessionId)`；`isSideChat` 时抛 `SideChatUnsupportedError`。
2. 从 `sessionManager.get` 读核心会话，`isSubagent` 时报错 `Cannot rename subagent session`。
3. `normalizeSessionTitle`；为空报 `Title is required`，超过上限报 `Title is too long`。
4. 和当前标题相同就直接返回当前会话。
5. 没有 `sessionManager?.rename` 时报 `Session rename is not available in this backend`（和归档一致）。
6. `sessionManager.rename`；用返回值（不是一开始读到的会话）和 `messages` 拼出新的 `UiSession`，`upsertSession`（线上是空操作，内存版要它），发 `session.updated`，再 `publishSessionIndexInvalidation()`。

**`packages/ohbaby-agent/src/adapters/ui-persistent.ts`**：转发 `renameSession`。

**`packages/ohbaby-agent/src/host/ui-command-gateway.ts`、`command-record.ts`**：照 `updateSessionReasoning` 把 `renameSession` 加进 `RECORDED_METHODS` 和分支。记录里只放 `sessionId`，不放标题（标题是用户输入的文字）。

**测试里的假 `UiBackendClient`**：01 §1.4 列出的几个文件补一个 `renameSession`。

**构建**：改完 SDK 先构建，再跑 server 和 Web 的类型检查。

**`packages/ohbaby-server/src/protocols/jsonrpc/`**：`protocol.ts` 方法表、`client.ts`、`rpc-route.ts` 各加一项；`protocol.unit.test.ts` 如果对方法表做了快照，跟着更新。

**`packages/ohbaby-server/src/protocols/web/routes/sessions.ts`**：加 `PATCH /v1/sessions/:id/title`，鉴权、`clientId`、注册检查、读 JSON 照 `/reasoning`；`body.title` 不是字符串返回 400；调用 `commandBackend("server-rest", { clientId }).renameSession(...)`；成功返回 `{ ok: true, session }`，失败 `sessionFailure(context, error, 400)`。

**`packages/ohbaby-server/src/app/openapi.ts`**：补这个路由。

完成定义：04 的 S 组通过。

### Stage 2：Web

**`api/daemon/http.ts`**：`renameSession(input)` 发 `PATCH /v1/sessions/:id/title`，body `{ title }`。

**`api/daemon/client-commands.ts`、`client.ts`**：照 `updateSessionReasoning` 转发，返回 `session`。

**`runtime/index.ts`**：接口和实现加 `renameSession(sessionId, title, directory?)`，按 F6、F7 写。

**`ui/shell/AppController.tsx`**：给 `Sidebar` 传 `onRenameSession={(session, title) => runAction(() => runtime.renameSession(session.id, title, session.requestDirectory))}`。

**`ui/sidebar/Sidebar.tsx`**：透传 `onRenameSession` 给各组的 `SessionList`（必填，`Sidebar.unit.test.tsx` 的默认 props 跟着补）。

**`runtime/index.ts` 的 `syncFromInstanceIndex`**：按 F6 跳过 `pendingRenames` 里的 id。

**`ui/sidebar/SessionList.tsx`**

- 新 prop `onRenameSession: (session, title) => void`。
- 状态 `editingId: string | null`。菜单点 Rename：关菜单（不还焦点），设 `editingId`。
- `props.disabled` 变真时，和菜单一样清掉 `editingId`。
- 列表重排不清 `editingId`（菜单照旧会关）。
- 给 `SessionRow` 传 `editing`、`onRenameStart`、`onRenameCommit(title)`、`onRenameCancel`。
- `onRenameCommit`：清 `editingId`；按 F5 判断后调 `props.onRenameSession`。

**`ui/sidebar/SessionMenu.tsx`**：Pin 下面加 Rename 项（`Pencil` 图标，`data-menu-shortcut="r"`），新 prop `onRename`。

**`ui/sidebar/SessionRow.tsx`**

- 新 props：`editing`、`onRenameStart`、`onRenameCommit`、`onRenameCancel`。
- 主按钮加 `onDoubleClick={onRenameStart}`（禁用或移动中时不触发）。
- `editing` 为真时：前导列照常显示；主按钮换成 `<input className="ohb-session-rename">`，按 F3、F4、F4b、F8 处理；行尾按钮不渲染；标题滚动的 effect 不启动；行容器的 `onContextMenu`、`onKeyDown` 直接返回，让输入框用浏览器自己的右键菜单。
- 更新组件注释。

**`ui/sidebar/sidebar.css`**：`.ohb-session-rename`，宽度撑满主按钮的位置，字号、行高、内边距和 `.ohb-session-title` 对齐，背景透明，`:focus-visible` 用现有的焦点描边 token。

完成定义：04 的 W、B 组通过。

### Stage 3：同步设计文档

路径相对 `docs/ohbaby-web/redesign-2026-10/`。

| 文件 | 位置 | 改成 |
|---|---|---|
| `01-use-cases-and-user-flows.md` | §2.6 整理会话 | 加一支"重命名 → 标题原地变输入框，Enter 或点别处保存，Esc 取消；双击标题也可以" |
| `04-interaction-and-states.md` | §2.3 侧栏状态表 | 加"重命名中"状态：输入框、行尾按钮隐藏、失败时恢复原名并通知 |
| `04-interaction-and-states.md` | §2.5 菜单打开那一行 | 菜单项加 `Rename` |
| `05-components.md` | SessionRow | Props 加 `editing` 和改名回调；Accessibility 加输入框名称 `Rename chat` |
| `05-components.md` | SessionMenu | Anatomy 第一级加 `Rename`；Props 加 `onRename()` |
| `06-data-api-and-state.md` | §1 接口表 | 加 `PATCH /v1/sessions/:id/title`：目录取会话执行目录，乐观改目录、失败恢复，不改变排序 |
| `08-test-and-acceptance.md` | UC-SESSION-01 清单 | 加改名的验收条目 |

## 2.4 兼容与迁移

- 新命令、新路由、`SessionManager` 新方法都是新增，不改现有行为。
- 不改表结构，不迁移数据。
- TUI 不调用 `renameSession`，但它也实现 `UiBackendClient`（经 `ui-persistent` 或 JSON-RPC 客户端），这两处在 Stage 1 已经补上，编译能过。

## 2.5 风险与回滚

| 风险 | 应对 |
|---|---|
| 运行中改名，顶栏被别的命令发出的旧 `session.updated` 短暂盖回（01 §1.6） | 改名自己用最新的会话发事件；别的命令的旧事件这次不改，下一轮结束会纠正。04 S-8 用线上的 persistent store 验证 |
| 列表刷新、实例索引同步把乐观显示的新名字盖回旧名字 | `beginWrite` 加 `pendingRenames`（F6） |
| 编辑时列表重排或切走窗口，把半截名字存下来 | F4b |
| 中文输入法回车误保存 | F4 判断 `isComposing` |
| 输入框里的按键被行或抽屉再处理一次 | F4 `stopPropagation`，编辑时行的按键和右键处理不生效 |

后端（Stage 1）、Web（Stage 2）、文档（Stage 3）分三次提交，出问题可以单独回退。

## 2.6 审查后的调整

计划初稿写完后派子代理对照代码审了一轮，以下意见被采纳，上文已经改过：

| 意见 | 初稿 | 调整 |
|---|---|---|
| 线上 `stateStore` 的 `upsertSession` 是空操作，"一轮写回旧会话盖掉标题"的竞态不存在 | 01 §1.6 把它列为风险，02 准备写回前重读 | 改写 01 §1.1、§1.6；去掉重读方案；S-8 改用 persistent store |
| `syncFromInstanceIndex` 不看写操作，会把乐观标题盖回去 | 只用 `beginWrite` | 加 `pendingRenames`（F6） |
| 列表重排会让输入框失焦，"失焦保存"会存下半截名字；切窗口同理 | 失焦直接保存 | 新增 F4b |
| 漏列了测试里的假实现、`RECORDED_METHODS`、SDK 构建顺序；记录里不该放标题 | 01 §1.4 说"漏了都会编译失败" | 补进 01 §1.4 和 Stage 1 |
| "Esc 会停止运行"的说法不对，停止只绑在输入框上；输入法判断应复用 `isImeComposing`；编辑时行的 Shift+F10 会吞掉原生右键菜单 | F4 理由和 W-5 | 改 F4，编辑时禁用行的按键和右键处理，W-5 改写 |
| 归档并不调用 `requireOwnedSession` | B4 写"归档也是这么限制的" | 改 B4 理由，子代理判断用 `isPrimarySession` |
| 改成默认名会被当成默认名 | 没提 | 写进 00 §0.4 和 B6 |
| 手机上双击用不了 | 没提 | F1 注明，B-5 走菜单 |
| 补"消息已被接收、还没开始跑时改名"的场景 | 没有 | 加 S-12 |

## 2.7 留到以后

- TUI `/rename`。
- 顶栏标题点击改名。
- 让 LLM 根据对话重新生成标题。
