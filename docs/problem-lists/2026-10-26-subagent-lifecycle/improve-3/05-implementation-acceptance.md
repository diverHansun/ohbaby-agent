# 5. 实施验收

## 第一轮（2026-10-29）：实施方自检通过，等用户审查

实施方：Claude（D49）。分支 `subagent/frontend`，从 `subagent/backend` 的 `b94cc001`（improve-2 已完成）切出，worktree 在 `.claude/worktrees/subagent-frontend`。按用户要求，改动**还没有提交**，分批方案见本文最后一节。

### 做了什么

- **C1 右侧容器：** 主区顶栏右端加开关；右侧栏有 Tab 栏、添加页面菜单、改宽把手（320–720px，可用方向键）和入口页。同一种页面可以开多个 Tab（D36）。刷新后只记住是否展开和宽度（D50）。窄屏（< 1024px）下盖住主区，显示 `Back to chat`，Escape 也能返回；主区设为 `inert`，但不卸载、不暂停。
- **C2 列表：** 用 SDK 的 `createSubagentInstanceReader` 读快照，只传 `rootSessionId`。按 Active/Done 分组，显示真实状态、任务说明、相对时间和未处理消息条数。刷新失败保留上一份列表。
- **C3 详情与停止：** 在同一个 Tab 里进入详情，标题显示实例快照里的当前状态。消息流复用旧浮层的阅读部分：从 `SubagentView` 原样拆出 `SubagentConversationBody`，旧浮层的行为不变。停止按钮带上当前的 `currentExecutionId`，在执行结束、收尾完成前一直显示 `Stopping…`。实例被 close 后自动退回列表；返回列表时焦点回到原来那一行。
- **Web client：** `listSubagentInstances` 和 `stopSubagent` 接到 HTTP 路由上，由 client 注入当前绑定。
- **B4 兜底（improve-3/02 §2.7）：** 详情按 `latestExecutionId` 读一次执行记录再打开；只把 `SUBAGENT_SNAPSHOT_CHANGED` 当成“已提交”；页面自己在 `session.resync-required` 后刷新列表。
- **小重构：** `useMinuteClock` 从 `Sidebar.tsx` 挪到 `shared/`，列表也用它；`viewport.ts` 加了会随窗口变化的 `useNarrowViewport`。

### 检查结果

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误，109 个警告，和 `b94cc001` 一样，没有新增 |
| Web 测试 `vitest run apps/ohbaby-web` | 71 个文件、827 项全部通过（视觉优化后是 828 项，见补充一节） |
| SDK sync 测试 | 5 个文件、67 项通过（没有改 SDK，只是确认） |
| `pnpm build` | 通过 |
| 编译后的 Web E2E | 通过，退出码 0。在内置浏览器里走完 E01–E05：刷新前后最终回复各 1 条，会话不变，没有运行时标记；后端、清理、诊断都是 PASS |
| `pnpm test:smoke` | 没跑。它的用例都依赖真实模型服务，这一批只改了 Web |

### 浏览器走查（编译产物 + 真实后端）

写了一个只在本地用的场景脚本（不进仓库）：用编译后的 `ohbaby serve` 加一个脚本化的 OpenAI 兼容模型，让主代理一次派出三个子代理。Code reviewer 读文件后完成；Log watcher 持续输出、一直运行；Shell runner 跑 bash，停在审批上。走查都在 1440×900 和 820×800 两种尺寸下做。

| 看了什么 | 结果 |
| --- | --- |
| 第一次展开 | 入口页只有 Subagents 一项；添加页面菜单也只有它；可以开两个 Subagents Tab |
| 列表 | Active 里是 `Needs approval`（带琥珀点）和 `Running`，Done 里是 `Completed`；行内有任务说明和 `now` |
| 实时变化 | 在主会话批准 bash 后，Shell runner 自动从 Active 移到 Done，Active 显示 `None` |
| 详情 | 有 `From parent` 任务、read 工具行和结果；运行中的实例可以看到持续追加的输出 |
| 停止 | 点 Stop 后先显示 `Stopping…`，然后变为 `Interrupted`，Stop 按钮消失；主会话的审批浮层和另外两个子代理都没受影响 |
| 关闭 Tab、收起、切换会话 | 收起再展开，两个 Tab 还在；切到新对话显示 `Open a chat to see its subagents.`；切回来列表重新读取，Log watcher 一直在运行 |
| 改宽 | 拖动把手，宽度从 420 变为 577px，并记进 localStorage |
| 窄屏 | 盖住主区，右上角显示 `Back to chat`，主区是 `inert`；Escape 关闭后焦点回到顶栏开关，主会话和审批浮层原样还在 |
| 焦点 | 关掉右侧栏后焦点回到顶栏开关；从详情返回后焦点回到那一行（有测试） |

### 验收项

| 项 | 证据 | 结论 |
| --- | --- | --- |
| I3-01 | `SidePanel.unit.test.tsx`：入口页、只列能用的页面、多个 Tab、收起保留 Tab、方向键和 Delete、只记住展开状态和宽度、窄屏默认收起；浏览器走查 | 通过。编译后的 E2E 脚本没有右侧栏步骤，右侧栏的编译产物证据来自上面的浏览器走查 |
| I3-02 | `SubagentsPage.integration.test.tsx`：分组、真实状态、未处理消息、刷新失败保留列表、重连后刷新；`instance-status.unit.test.ts`；浏览器走查 | 通过 |
| I3-03 | 测试：标题读实例快照（运行中 → 收尾中）；浏览器走查：实时输出 | 通过。按锚点定位移到 improve-4 的 I4-02（文档已改） |
| I3-04 | 测试：只停当前 execution、`Stopping…` 一直持续到收尾结束、`SUBAGENT_SNAPSHOT_CHANGED` 当成已提交、`execution_changed` 恢复按钮、其他错误显示原因；`server-client.integration.test.ts` 经真实 server 路由停止，`abortRun` 没有被调用；浏览器走查 | 通过。“主代理正在前台等待时停止”没有单独测；按钮不依赖主代理状态，后端已在 I2-03 覆盖 |
| I3-05 | 测试：页面卸载只释放 watch、不调用 stop；close 后退回列表；换会话不串数据；换会话清掉选中；浏览器走查 | 通过 |
| I3-06 | 复用旧浮层的阅读组件，原有分页、迟到事件、阅读位置测试照常通过；从详情返回后焦点回到原行；浏览器走查了窄屏、Escape 和焦点 | 基本通过。“来回切换不丢阅读位置”靠的是共用的阅读缓存，没有单独测；人工走查清单（04 §4.3 第 4 条）留给用户审查时确认 |

### 子代理审查与处理

两个子代理分别从“代码规范”和“是否符合设计”审查。下面的问题都已改完，测试也补了：

- **D36 冲突：** 原来同一种页面只能有一个 Tab，现在改成每次都新开 Tab。
- **tablist 结构：** tablist 里原来有可聚焦的关闭按钮，不合 ARIA 规范。现在关闭按钮只给鼠标用，键盘用 Delete 关闭；左右方向键在 Tab 间移动；只有选中的 Tab 带 `aria-controls`。
- **焦点丢失：** 返回列表、实例被 close、关闭右侧栏这几种情况，焦点原来都会丢；现在分别回到原行、列表、顶栏开关。
- **窄屏可访问性：** 主区还能被 Tab 键选中，也没有 Escape。现在主区设为 `inert`，并加了 Escape 返回和 `Back to chat` 文字。
- **焦点样式和时间：** 改宽把手原来去掉了全局焦点环，已恢复。列表在渲染里调用 `Date.now()`，改用 `useMinuteClock`。
- **详情页细节：** 打开详情时原来一片空白，现在超过 300ms 显示 `Loading…`。`onSelect` 每次渲染都变，导致 effect 反复执行，已修。阅读缓存改成每个会话一份。
- **测试补充：** 新增打开失败后重试、Back 恢复焦点、`execution_changed`、换会话隔离、窄屏默认收起、键盘操作，以及 Web client 经真实 server 路由的测试。
- **文档：** 修正了状态标签用词、409 只认这一个错误码、05 里关于“收起”的说法、04 新增“没有打开的会话”，并给 D46、improve-2/05 加了注记。

没有改的：

- **reader 的创建方式：** reader 在 `useMemo` 里创建、在 effect 里销毁，StrictMode 下会出问题。现有的 `useSessionInteractions` 也这样写，而 Web 没开 StrictMode，保持一致。
- **拖动时的写入：** 拖动时每次 pointermove 都写一次 localStorage。量很小，没改。
- **`SUBAGENT_SNAPSHOT_CHANGED` 的类型：** SDK 里没有这个错误类型，前端按字符串判断。已写进 improve-2/05，请 Codex 在 B4 里加。

### 留给后面的

- **B4 合并后：** 把 §2.7 的三处兜底换成正式接口（`selectInstance`、SDK reader 自己处理重连），删掉页面里对应的代码。
- **improve-4：**
  - 主会话入口和按锚点定位（I4-02）。
  - Web 对满额被拒的 spawn 仍显示派遣行，send 的标题写死。这是 improve-1/05 第 9 项，留给 improve-4 改入口时一起处理。
- **观察到但没查的：** 停止后，详情里的 `[Response cancelled by the user.]` 显示在被中断的那段输出上面。这是共用的消息流组件的排序，旧浮层应该也一样，和这一批无关，记下来以后再查。

## 补充（2026-10-29）：对照 Codex、Claude、Cursor 的视觉优化

用户给了三家的整体布局截图，要求按“简洁大气、高级感”优化右侧栏，并为以后的文件预览、终端、内置浏览器、Side chat 和 improve-4 留好位置（D52）。

### 三家的共同做法，以及这次怎么用

| 参考 | 做法 | ohbaby |
| --- | --- | --- |
| Codex、Cursor 的 Tab | 图标加名称，选中的是浅色胶囊，关闭按钮悬停才出现 | 照做 |
| Cursor 的 `+` 菜单 | 每项带图标（还有快捷键） | 带图标；快捷键先不做，现在只有一种页面 |
| 三家右上角 | 都有“展开”，让右侧栏盖住主区 | 加了“展开”：盖住主区，保留左侧栏，Escape 恢复；接替旧浮层的放大，improve-4 删旧浮层时不丢能力 |
| Claude 的任务列表 | 分组可折叠，带数量；左边标题，右边安静的状态 | 分组可折叠并带数量；运行中带转圈，等审批用琥珀点，失败用 danger 文字；不做卡片（D4） |
| Codex 的文件页头 | 名称一行，操作放右边，不加分隔线 | 详情头：名称下面一行是任务说明，右边是状态和黑色描边的停止按钮，下面不加分隔线 |
| Cursor 的新页面 | 一个简短的启动菜单 | 入口页标题 `Open a page`，每项是图标方块、名称和一句说明 |

三家都有的文件、终端、浏览器、Changes 页面，这一批照 D38 不做，也不放占位页。

### 为以后的页面留的位置

- **页面登记表：** 新增 `side-pages.ts`，每种页面登记标题、图标、说明、初始状态和是否跟会话走。Tab 栏、添加菜单、入口页都从这张表生成。
- **Tab 状态：** 每个 Tab 带各自页面的状态（`{ id, kind, state }`），类型由页面种类决定。切换主会话时，只有跟会话走的页面会回到初始状态。
- **渲染：** 新增 `SidePanelPage` 负责按页面种类渲染，外部依赖都放在 `SidePageContext` 里传进去。`AppController` 只剩一行接线。
- **给 improve-4 用：** `openPage(kind, state)` 可以直接打开到某个实例的详情，improve-4 的“xx 子代理启动”入口会用它。

加一种页面只改三处：登记表、状态类型、渲染分支（见 Web 设计文档 05 SidePanel）。

### 检查

- `pnpm typecheck` 通过；lint 0 个错误，没有新增警告。
- Web 测试 71 个文件、828 项通过。新增“打开时直接带状态”和“展开后用 Escape 恢复、展开不被记住”两项。
- 重新构建后，用场景脚本在浏览器里看过：入口页、Tab、分组折叠和数量、转圈和琥珀点、详情头、停止按钮、展开和 Escape 恢复。

## 分批提交方案（等用户审查后执行）

每一批单独都能编译、通过测试。

1. `docs: plan the right panel and record D49–D51`：`docs/ohbaby-web/redesign-2026-10/`（README、03、04、05），`docs/problem-lists/2026-10-26-subagent-lifecycle/`（README、improve-1 的 00/01/02、improve-2/02、improve-3 的 02/04/05、improve-4 的 02/04）。
2. `refactor(web): share subagent reading and add instance client calls`：`ui/session/SubagentConversationBody.tsx`、`SubagentView.tsx`、`useSessionInteractions.ts`、`SubagentView.unit.test.tsx`，`ui/shared/use-minute-clock.ts`、`ui/sidebar/Sidebar.tsx`，`ui/shared/viewport.ts`，`api/daemon/client.ts`、`http.ts`、`server-client.integration.test.ts`。
3. `feat(web): add the right panel with the Subagents page`：`ui/side-panel/**`（含页面登记表 `side-pages.ts`、`SidePanelPage.tsx`、`subagents/InstanceStatus.tsx`）、`ui/shell/AppController.tsx`、`AppShell.tsx`、`MainHeader.tsx`、`ui/styles.css`。

`improve-1/05` 和 `improve-2/05` 的第二轮验收在主 checkout（`subagent/backend`）的工作区里，也没提交，和 Codex 的分支一起处理。
