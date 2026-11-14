# 08 测试与验收

测试放置和命名遵循仓库现有规则：Web 的单元测试是 `*.unit.test.ts(x)`，跨组件集成测试是 `*.integration.test.tsx`（参照 `SubagentsPage.integration.test.tsx`）。Mock 场景见 [06 §6](06-data-api-and-state.md#6-mock-场景)。

## 1. 验收标准

### UC-BGT-01 查看任务列表

- [ ] `bg-none`：会话只跑过前台命令（Mock 里有两条前台记录），`[+]` 菜单和入口页都没有 Background tasks。
- [ ] `bg-running`：列表里没有 `git status --short`、`sleep 600` 两条前台命令，组标题数量不算它们（D12）。
- [ ] `bg-running`：菜单里有 Background tasks；打开后 Running 组 2 行、Done 组 3 行，组标题数量分别是 2 和 3。
- [ ] 运行中行的时长每秒更新，宽度不抖；Done 组里失败的行显示红字 `Failed`，成功和被取消的行只显示灰色时长。
- [ ] 列表里没有卡片、胶囊、状态圆点；命令是等宽灰字，单行省略。
- [ ] 首次加载延迟 1 秒时，300ms 后出现 `Loading…`；延迟 100ms 时不出现。
- [ ] 加载失败显示原因和 `Retry`；已有列表时失败不清空列表。
- [ ] `bg-many-done`：列表里没有 `Show more` 按钮；滚到底部附近自动追加下一页，直到 250 行全部加载，末尾不出现任何“已到底”说明；组标题数量始终是 250。
- [ ] 加载到 150 行后收到失效事件，列表仍是 150 行，刷新期间不变短。
- [ ] 下一页加载失败时，列表末尾出现错误和 `Retry`，继续滚动不会反复请求。
- [ ] mock 里启动一个新任务后，不刷新页面，列表出现新行。
- [ ] `bg-running` 每秒一次失效事件时，列表请求不超过每 2 秒一次，并且每次请求都能完成（网络面板里没有一连串被取消的请求）。
- [ ] 页面切到后台时不再发列表和探测请求；切回前台后补一次。

### UC-BGT-02 按启动者筛选

- [ ] `bg-running`（只有主代理）：没有筛选图标。
- [ ] `bg-subagents`：有筛选图标；菜单三项一行一个，默认 Main agent 带对勾；选 Subagents 后只剩子代理的 4 行，每行显示启动者名字。
- [ ] `bg-subagents-only`：打开时筛选自动为 All，列表不为空。
- [ ] 快速连续切换筛选，最终列表和最后一次选择一致。
- [ ] 切换会话后筛选回到默认。

### UC-BGT-03 查看详情和输出

- [ ] 点击列表行进入详情，焦点落在返回按钮；返回后焦点回到该行。
- [ ] 运行中任务的输出每 2 秒增长并自动贴底；向上滚动后停止跟随，出现“回到底部”，点击后恢复。
- [ ] 任务结束后输出不再轮询（网络面板里不再有 output 请求）。
- [ ] 页面切到后台标签页时停止轮询，切回来恢复。
- [ ] `bg-special`：`lost`、清理未确认、由别的后端管理、`owner-ended` 各显示 03 §5.3 对应的说明行；`timed_out` 在列表里是红字 `Timed out`；由别的后端管理的运行中任务没有 Cancel。
- [ ] `bg-special`：输出超过 32KiB 时显示 `Showing the last 32 KB.`，有日志路径时带复制图标；日志被截断时多一行说明；没有保存输出尾部时显示 `No output was saved for this task.`（03 §5.4）。
- [ ] 服务重启后（mock 里把所有旧任务的 `managedByCurrentBackend` 设为 false），已结束的任务不出现 “Cancel it there” 说明。
- [ ] `bg-output-fail`：输出区上方显示错误和 `Retry`，已有输出保留，点 `Retry` 后恢复轮询。

### UC-BGT-04 取消任务

- [ ] 点击 `Cancel` 后立刻变为禁用的 `Cancelling…`，按钮宽度不变，行没有进入详情。
- [ ] 连点 3 次只发出 1 个 stop 请求。
- [ ] 后端状态变为 `cancelled` 后，行移到 Done 组，显示灰色时长，不标红；详情状态行为 `Cancelled by you · …`。
- [ ] 在列表点 Cancel 后进入详情，详情里也是 `Cancelling…`。
- [ ] `bg-cancel-errors`：`OTHER_BACKEND` 后 Cancel 消失并出现说明行；`CLEANUP_BUSY` 显示 `ohbaby is already cleaning up this task.`；`NOT_FOUND` 在详情里显示不存在；网络错误恢复 Cancel，列表顶部或标题区下方显示一行错误，没有 Retry。
- [ ] 取消成功没有任何 Toast。

### UC-BGT-05 从 bash 工具卡打开

- [ ] `bg-chat`：启动后台任务的 bash 卡片下有 `Background task ›`；前台 bash 卡片下没有。
- [ ] 右侧栏收起时点击入口行，右侧栏展开并进入该任务详情；已有 Background tasks Tab 时复用它，不新开。
- [ ] 任务状态变化后，入口行文字不变。
- [ ] 子代理对话里的 bash 卡片入口行能切到 Background tasks Tab 并打开该任务。
- [ ] 任务不存在时详情显示 `This task is no longer available.`。

### UC-BGT-06 隐藏任务结果消息

- [ ] `bg-chat`：对话流里看不到 `background-task-result` 的内容；被它唤醒的助手回复正常显示。
- [ ] 该消息不能被编辑，不出现在编辑提示里。

### 入口随会话变化（01 §2.4）

- [ ] `bg-two-chats`：打开 Background tasks Tab 后切到没有任务的会话，探测返回后 Tab 隐藏，选中规则和 Side chat 一致；切回来 Tab 重新出现并显示列表。
- [ ] 在两个都有任务的会话之间切换，Tab 不闪、不丢选中。
- [ ] 探测请求失败时，已显示的 Tab 不隐藏。

## 2. 测试分层

| 层 | 工具 | 覆盖 | 不覆盖 |
|---|---|---|---|
| 单元 | Vitest | ViewModel 转换（03 §5.2 每种状态行、§5.3 说明行选择、时长计算）；读取器的乱序丢弃和失败保留 | DOM |
| 组件 / 集成 | Vitest + Testing Library + mock 客户端 | 列表分组、筛选、滚动自动加载、Cancel 各分支、输出轮询和贴底、焦点、入口行显示条件、对话过滤 | 真实后端、视觉 |
| 后端连通 | 现有 daemon 集成测试方式 | Web 客户端新增方法带上绑定参数、错误码透传 | UI |
| 视觉走查 | 浏览器截图 + 模型判断 | 03 §6 的口径 | 像素比对 |

不新增 E2E。真实 daemon 下手动走一遍：让 agent 启动 `sleep 120 && echo done` 和一个 dev server，查看、取消、看到行移到 Done。

## 3. 关键场景

| 场景 | 来源 | 验证层 |
|---|---|---|
| 没有任务的会话完全看不到入口；探测未知时不闪 | D1、04 §2.1 | 集成 |
| 失效事件密集时请求节流且能完成 | 06 §3.1、§3.2 | 单元 + 集成 |
| 取消只发一次请求，状态以后端为准 | UC-BGT-04、06 §3.4 | 集成 |
| 详情离开或任务结束后不再轮询 | 06 §3.3 | 集成 |
| 任务结果消息不出现在对话里 | UC-BGT-06 | 集成 |
| 筛选快速切换不串数据 | UC-BGT-02、06 §3.1 | 单元 + 集成 |
| 真实 daemon 下取消一个 dev server | UC-BGT-04 | 手动 |

## 4. 视觉验收清单

| 页面 | Mock 场景 | 视口 | 检查点 |
|---|---|---|---|
| 列表 | `bg-running` | 1440，右侧栏 420px | 03 §4.1 线框；没有卡片、胶囊、状态点；只有失败行是红色；时长等宽数字 |
| 列表 | `bg-subagents`，筛选 All | 1440 | 筛选图标位置；菜单一项一行；启动者行的层级 |
| 详情 | `bg-running` 运行中任务 | 1440 | 03 §4.2 线框；固定区和滚动区；输出区无边框浅底和顶部渐隐 |
| 详情 | `bg-special` | 1440 | 说明行灰字、不抢眼 |
| 入口行 | `bg-chat` | 1440 | 和 Subagents 委派入口行风格一致 |
| 列表 | `bg-running` | 390（手机，右侧栏全屏） | Cancel 可见可点；命令省略不撑破布局 |
