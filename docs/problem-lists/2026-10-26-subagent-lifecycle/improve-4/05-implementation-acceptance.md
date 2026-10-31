# 5. 实施验收

## 第一轮（2026-10-30）：实施方自检通过，等用户审查

实施方：Claude。在本地分支 `subagent/improve-4` 上实施，从 `subagent/frontend` 的 `e7d6584e`（improve-3 及其复审修复）切出，在主 checkout 里做，不用 worktree（D53）。按 02 §2.7 的五点方案实施。

### 做了什么

- **入口行（I4-01）：** `DelegationRow` 完整保留 agent 工具卡，在下面加一行入口：图标、实例名、状态、用时和 `›`。
  - **显示条件：** 只看工具结果的元数据。`started: false`（满额、失败、投递给运行中实例的 send）不显示，由 `delegationNotStarted` 判断。
  - **前台执行：** 还没有结果时，靠执行记录匹配，确认启动后就显示入口。
  - **顺带修掉 improve-1/05 第 9 项：** 被拒绝的 spawn 只显示工具卡；send 的标题取实例名，快照读不到时退回 `message` 的第一行。
- **点击后（I4-02）：**
  - **选 Tab：** `useSidePanel.revealPage` 复用当前的 Subagents Tab，没有就用第一个，都没有才新开，然后展开右侧栏。
  - **定位：** Tab 状态带上 `{ subagentId, anchor: { executionId, token } }`，详情按这次派遣的执行记录打开并定位。同一个入口再点一次会再定位；从列表进入仍然保留阅读位置（improve-3 R2）。
- **会话层快照（I4-04）：**
  - **共用一份：** 实例快照由 `AppController` 通过 `useSubagentInstances`（`ui/shared/subagent-instances.ts`）读取，右侧栏列表和入口行共用。
  - **判断关闭：** `isClosedInstance` 只在“已加载的完整快照里没有这个实例”时算已关闭，读取失败或还没加载都不算。
- **删除旧浮层（I4-03）：**
  - **删掉的代码：** `SubagentView`、`subagent-layout.ts`、`childExpanded`、浮层专用的阅读器和测量，以及 `SessionScreen` 里锁输入框、隐藏审批的逻辑。
  - **顺带清掉的死代码：** 浮层专用 CSS、只读输入框（Composer 的 `readOnly`、“Read-only subagent” 标签）、`ApprovalPanel` 的 `visible`。
  - **订阅协调器（improve-3 R1）：** 也删了。现在由结构保证同一时刻最多一个订阅：只有 Subagents 页持有阅读器，右侧栏只渲染当前 Tab，有测试固定这一点。
- **阅读组件的测试：** 原 `SubagentView.unit.test.tsx` 里测阅读能力的用例（工具展开、流式更新、分页、锚点、无锚点提示）改名为 `SubagentConversationBody.unit.test.tsx` 保留下来；只测浮层外壳的两条（展开和 Escape）删掉了。

### 浏览器验收（编译产物 + 真实后端，`scripts/run-subagent-panel-e2e.mjs`）

在 1440×900 下，按真实操作走完：

| 看了什么 | 结果 |
| --- | --- |
| `PANEL_START` 后的主会话 | 三个 agent 工具卡都在，每个下面一行入口：Reader（Completed）、Runner（Running）、Approval（Running）。审批浮层照常显示。入口行（测试附件已清理） |
| 点 Reader 的入口 | 右侧栏展开到 Subagents，详情标题 Reader、状态 Completed，定位到这次派遣（`From parent` 在顶部）。焦点在详情标题上。审批浮层还在，主会话没有被设为 `inert`，没有旧浮层。入口打开右侧栏（测试附件已清理） |
| `PANEL_SEND_READER` 续跑 | 对空闲 Reader 的 send 启动了第二次执行，新入口标题是 “Reader”，不是写死的 “Subagent task” |
| 两个 Reader 入口各点一次 | 点第二个：续跑那次的 `From parent` 出现在顶部附近（偏移 81px）；再点第一个：第一次派遣出现在顶部（偏移 12px）。详情一直开着，也能重新定位 |
| 从入口打开 Runner 并停止 | Running → Interrupted，停止按钮消失 |
| `PANEL_CLOSE_READER` | Reader 的两条入口都撤下，两张工具卡还在；Runner、Approval 的入口照常。关闭后入口撤下（测试附件已清理） |
| **对抗性复查（04 §4.2 第 5 条）：** 刷新页面 | Reader 不出现在入口里，不出现在列表里，页面上也找不到它的任务说明 |
| 新会话 `PANEL_OTHER_SESSION` | 只显示 Other reader 的入口和列表行，不带出上一个会话的实例 |
| 脚本的 `finish` | `backend-pass`：Reader 两轮完成后关闭，Runner 被停止，Approval 完成，sentinel 正确，Other reader 属于另一个主会话。`cleanup-pass` 和 `verified: true` |

### 验收项

| 项 | 证据 | 结论 |
| --- | --- | --- |
| I4-01 | `DelegationRow.unit.test.ts`：工具卡保留、入口打开到这次执行、关闭或未启动时撤下、`delegationNotStarted` 读元数据、运行中的 send 只是普通工具卡；浏览器里 spawn、续跑 send 都有入口 | 通过。满额和失败只有单元测试，场景脚本里没有触发 |
| I4-02 | `SubagentsPage.integration.test.tsx`：按链接的执行打开并定位、再点再定位、从列表进入不重新读取、链接到另一个实例时切换过去；`SidePanel.unit.test.tsx` 的 revealPage；`App.unit.test.tsx` 从入口打开右侧栏并按 `exec` 定位；浏览器走查 | 通过 |
| I4-03 | App 测试：没有 `.ohb-subagent-view`，审批面板还在，主会话没有 `inert`；浏览器走查 | 通过 |
| I4-04 | App 测试“快照里没有就撤下，读取失败就保留”；浏览器里 close 后撤下，刷新后也不回来 | 通过 |
| I4-05 | 历史 `subagent_run` 的 `DelegationRow` 测试保留并通过；改动只在 `apps/ohbaby-web` 和文档，CLI、TUI、SDK、agent 包都没动；审批布局的测试通过 | 通过。全仓测试结果见下 |

### 两份子代理审查与处理

规范审查和代码审查都没有必须修的问题。下面这些已经改了：

- **锚点状态：** 原来存在 ref 里，渲染时读不到最新值，改成 state，处理过的请求一定会触发重新渲染。
- **目录依赖：** 快照 hook 从 `side-panel/` 挪到 `shared/`，避免 `session/` 和 `side-panel/` 互相依赖。
- **死代码：** 删掉只读输入框、`ApprovalPanel.visible`、`.ohb-delegation-row:disabled`；`subagentStatusLabel` 不再导出；测试替身里多余的参数也删了。
- **重复和接口：** `SubagentsPage` 改为复用 `isClosedInstance`；`openSubagent` 的 `executionId` 改成必填。
- **标题：** send 的标题退回 `message`。
- **补测试：** 关闭后撤下、读取失败保留、按 `exec` 定位、链接到另一个实例。
- **过时文档：** Web 设计文档 03、04、05、README（D35）；生命周期 README（分支、进度）；improve-3/05、improve-1/05 的后续说明。

没改的：

- **新 spawn 的入口晚一点出现：** 执行记录每秒轮询一次；实例快照收到失效事件就刷新。如果快照还没刷新到新实例，入口会晚一点出现，但不会闪烁，也不会误撤。这是“快照读取失败不算关闭”的代价，可以接受。
- **锚点留在 Tab 状态里：** 切走这个 Tab 再切回来，会重新定位到那次派遣，而不是保留阅读位置。和第一次打开的行为一致，没改。
- **reader 的写法：** 在 `useMemo` 里创建、在 effect 里销毁，和现有写法一致；Web 没开 StrictMode。

### 转给后端（Codex）

- **B4 三项照旧：** `selectInstance`、SDK reader 处理重连、stop 回执的 409。落地后，前端删掉 improve-3/02 §2.7 的三处兜底。
- **`getSubagentWaitState`（`composition.ts`）：** 一直返回 `false`，原本只服务旧浮层的等待状态。浮层已删，Web 不再依赖它，请在 B4 里一起清理（improve-1/05 第 115 行的后续）。

### 检查结果

| 检查 | 结果 |
| --- | --- |
| Web 测试 | 70 个文件、828 项通过 |
| `tsc -b apps/ohbaby-web`、eslint（Web） | 通过，0 个错误、0 个警告 |
| `pnpm build` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 0 个错误，109 个警告（和改动前一样） |
| `pnpm test` | 642 个文件通过、6 个跳过；7505 项通过、17 项跳过，0 失败 |
| 编译后的 Web E01–E05 | 通过，退出码 0。浏览器里刷新前后最终回复各 1 条，会话不变，没有运行时标记；UI、后端、清理、诊断都是 PASS |
| `pnpm test:smoke` | 没跑：它的用例依赖真实模型服务，这一批只改了 Web |
