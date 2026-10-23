# 02 前端架构

> 本文只写这次改版带来的架构变化。没有提到的部分沿用 [Web 架构](../architecture.md)：单向数据流、不做乐观更新、`api/daemon` 纯逻辑不依赖 React、SSE 走 fetch-stream。

## 1. 技术栈与边界

| 方面 | 选择 | 说明 |
|---|---|---|
| 框架与构建 | React 19 + Vite（不变） | |
| 路由 | 不引入路由库（不变） | 视图状态写进 URL hash，见 §4 |
| 状态 | 自写 store + `useSyncExternalStore`（不变） | 不引入 Zustand、TanStack Query |
| 样式 | 手写 CSS，类名沿用 `ohb-` 前缀 | 新增一份 token 文件，见 03 §3 |
| 图标 | lucide-react（已安装） | 统一用这一套，不混用其他图标库或手写 SVG（字标除外） |
| 弹出类交互 | 自己写，照 pi-web `components/SidebarMenu.tsx` | 一个通用的 Menu：挂到 body、fixed 定位、贴边翻转、键盘导航、关闭后焦点回到触发按钮。不做二级子菜单 |

边界：

- 不迁移到 Tailwind 或 shadcn，不引入第二套样式方案（CSS-in-JS、CSS Modules），也不引入 Radix 等交互组件库。
- 组件样式只引用 token 变量，不写字面量颜色。token 文件本身除外。
- 现有的模态（目录选择、命令结果）继续用现有实现，只改样式。
- 组件里不直接 `fetch`，继续走 `api/daemon` 和 SDK client。

**为什么不引入 Radix**：2026-10-22 用户要求照 pi-web 做，pi-web 的菜单是自己写的。原来需要二级子菜单的“Project”，改成点“Move to project…”后，在原位置换成项目列表（03 §4.4），于是最难写的二级子菜单就不需要了。剩下的定位和键盘逻辑，照 pi-web 写一个通用 Menu 就够了。

## 2. 渲染策略

纯客户端渲染，不做 SEO，由 daemon 同源伺服静态产物（不变）。

## 3. 模块组织

### 3.1 目录变化

```text
src/
  runtime/            由 runtime.ts 拆成 façade、全局层、实例层、草稿（improve-2，见 §3.2）
  api/daemon/
    global-sessions.ts  新增全局接口：会话列表、搜索、改项目归属（improve-2）
    settings-client.ts  improve-2 提供最小模型读取，improve-4 扩展完整设置接口
    client.ts           实例 client，按职责拆出 client-sync、client-prompts、client-commands（improve-2）
  store/
    store.ts          保留现有实例状态入口；全局会话、草稿和设置缓存各有独立切片与选择器
  ui/
    App.tsx           挂载应用控制层，不再区分“有无 workspace”
    shell/            新增：AppController（runtime 接线、视图切换、目录选择）、AppShell（布局、收起、窄屏抽屉）
    sidebar/          新增：由 session/SessionSidebar 等迁入并改写；项目分组、会话行、会话菜单
    search/           新增：侧栏内的搜索框与结果列表（由 sidebar 挂载）
    settings/         新增（第二批）：设置页与各分区
    session/          SessionScreen 继续组合对话视图；草稿态并入这里
    conversation/     不变（只改样式）
    composer/         Composer 拆出 ComposerControls、ComposerInput 和项目选择器（见 05）
    commands/         improve-1 换肤；improve-4 删除 Web 的 connect 浮层及入口
    permissions/      审批改为非模态 ApprovalPanel；权限控制移入输入框
    shared/           新增无业务依赖的基础组件
    workspace/        删除 ProjectRail；保留 directory-picker
    styles/           只留 tokens.css 和 base.css；各功能的 CSS 放在功能目录里（shell/shell.css、sidebar/sidebar.css …），
                      empty-state.css、conversation-layout.css 迁入对应功能，删除 overrides.css
                      入口 styles.css 的引入顺序：tokens → base → shared → 各功能
```

大文件随所在批次拆分（D24）：`SessionScreen.tsx`（1292 行）、`Composer.tsx`（1312 行）在 improve-1 拆，`client.ts`（1447 行）、`runtime.ts`（625 行）在 improve-2 拆。拆分原则：

- 一个文件只做一件事；组件文件以不超过约 400 行为目标，超过时先看能否按职责拆出子组件或 hook，不为凑行数硬拆。
- 纯逻辑（选择器、提交状态推导、请求编排）放进不依赖 React 的 `.ts` 文件，组件只做组合与渲染。
- 每个功能目录自带自己的 CSS 文件，不再往 `styles/overrides.css` 里堆跨功能覆盖；improve-1 结束时删掉它。
- 拆分时行为不变，先保证现有测试通过，再改样式或逻辑。
- `store.ts` 当前已有 658 行，不把全局列表、搜索和设置缓存继续堆进同一文件。按状态所有权拆切片，保留统一订阅入口；选择器不反向导入 UI。React hook 可以依赖 React，“纯逻辑不依赖 React”只约束选择器、字段映射和请求编排。

### 3.2 运行时：从“当前 workspace”改为“当前会话”

现在是“选一个目录 → 建一个实例 client → 一条 SSE”，侧栏只显示这个目录的会话。改版后分成两层：

```text
全局层（不带目录头，token 鉴权）
  ├── 项目列表 GET /v1/scopes（含 defaultWorkspace）
  ├── 会话列表 GET /v1/sessions
  ├── 搜索     GET /v1/sessions/search
  └── 改归属   POST /v1/sessions/:id/project

实例层（带 x-ohbaby-directory，同一时间只连一个）
  └── 当前会话的执行目录 → client + SSE（沿用现有 BrowserDaemonClient）
```

- 侧栏和搜索只读全局层，不依赖某个实例。
- 打开会话时，按服务端返回的执行目录（有待生效目录时优先用它）切换实例 client。旧 client 失效后再启用新的，沿用现有切换保证。
- 草稿没有会话，不提前建实例。第一次发送时，按所选项目或默认目录建 client 并创建会话。草稿里的斜杠命令按草稿当前的目录（所选项目或默认目录）建 client 后执行。有些命令需要已有会话（如 `/compact`）；现有代码在没有会话时如何处理，实施时先核对。要求是：在草稿里不可用的命令要么不出现在候选里，要么执行时说明原因，不能静默失败。
- 收到“会话已移动”的错误时，由 runtime 统一处理：换到目标目录的 client，重发，并切换 SSE。UI 层不感知这件事。同一次发送最多自动重发 2 次，仍然失败就按普通发送失败处理（04 §2.2）。
- 已打开会话在运行中改项目时，保留当前执行目录的 client、SSE 和审批绑定直到本轮结束；只更新下一轮的请求目录。重新打开会话仍按 `globalSessionRequestDirectory` 取目录。归档、导出其他目录的会话使用短期 HTTP 请求，不切走当前对话的 SSE。
- `SESSION_MOVED` 只重放被明确拒绝的原请求，保留 `clientRequestId`、会话 ID 和冻结的正文，不把超时或未知提交结果当成移动重试。HTTP 层必须保留 `targetDirectory`，切换过程中继续用 generation 防止旧请求写回。
- 设置页（第二批）按“当前会话的执行目录，或草稿所选目录，或默认目录”取实例。

依赖方向：

```text
bootstrap → runtime → api/daemon
App → AppController → AppShell + sidebar / search / session / settings
session → conversation / composer / commands / permissions / shared
sidebar、search 只依赖 runtime 暴露的全局能力和 shared，不依赖 session 内部
shared 不反向依赖任何功能目录
```

## 4. 状态分类

| 类型 | 内容 | 放在哪里 |
|---|---|---|
| URL（hash） | 当前会话 ID 和执行目录；设置页分区 | 沿用 `replaceNavigationHash`，在现有格式上扩展 |
| 服务端状态：全局 | 项目列表、会话列表（分页）、搜索结果 | store 新增的全局切片；REST 拉取，触发刷新的时机见 06 |
| 服务端状态：实例 | 当前会话的消息、运行状态、审批、模型、上下文用量 | 不变：SSE → eventReducer → store |
| 浏览器本地 | 草稿文字和草稿所选项目；侧栏收起、项目分组折叠；置顶；设置上次停留的分区 | 草稿沿用 `draft-storage` 的 sessionStorage（按标签页隔离，刷新保留），但 key 改为不含目录（06 §3.5）；其余用 localStorage。置顶改为全局 key（06 §3.6）。读写都包 try/catch，读不到就用默认值 |
| 组件局部 | 菜单开关、搜索框输入、hover | useState |

规则：会话的项目归属、执行目录只认服务端返回的值，前端不自己推断。

## 5. 组件层级

```text
AppController（订阅 runtime、组合功能区）
└── AppShell（通过区域插槽接收内容，布局不含业务）
    └── 功能区：Sidebar / SidebarSearch / SessionScreen / SettingsPage
    └── 组合组件：SessionRow、ProjectGroup、ComposerControls、ProjectPicker …
        └── 基础组件：IconButton、Menu（照 pi-web 自写）、Spinner、Kbd …
```

- AppShell 只管区域划分、收起和窄屏抽屉，不知道“会话”是什么。
- AppController 负责目录选择和侧栏/设置/对话的接线；断开提示由控制层提供给外壳。草稿没有实例 client 属于正常状态，不能因此显示断开。
- 基础组件不认识业务概念。比如 `Menu` 不知道 Project 菜单，Project 菜单由 sidebar 组合出来。
- 具体清单与契约见 05。

## 6. 错误处理

| 错误 | 在哪处理 | 怎么显示 |
|---|---|---|
| 发送或创建会话失败 | Composer | 输入框上方一行提示，保留文字，可再次发送 |
| 会话加载失败、执行目录不可用 | SessionScreen | 主区内显示原因，带“重试”或“换项目”的引导 |
| 侧栏列表加载失败 | Sidebar | 列表位置显示一行错误和“重试”，不影响主区 |
| 搜索失败 | SidebarSearch | 结果区提示，保留关键词 |
| 改项目归属失败 | Sidebar | 侧栏不变，在对话区右上角显示通知（03 §4.8） |
| 会话已移动 | runtime | 自动换目录重发，不显示 |
| daemon 断开 | AppShell | 主区顶部一条提示，恢复后消失；常态不显示连接状态 |
| 设置分区读取失败（第二批） | SettingsPage | 只有该分区显示错误和“重试” |
| 设置字段校验失败（第二批） | 编辑子页、单页表单 | 出错字段下写原因，保留输入（06 §4） |

判断规则：和当前位置有关的错误在原地提示；操作成功不提示（README 的 D16）；不在原地的失败和需要用户处理的后台事件用对话区右上角的通知。
