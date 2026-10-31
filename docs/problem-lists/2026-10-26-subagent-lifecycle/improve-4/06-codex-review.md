# 6. Codex 复审：improve-3 R1–R3、improve-4 与 B4

日期：2026-10-30。审查者：Codex；另有独立 Standards、Spec 和 B4 子代理审查。

## 结论与范围

**复审通过，可以一起合入本地 main，不 push。** 初审发现一个前端 P2（R4），B4 独立审查发现两个 SDK P2，均已修复并通过独立复核；无剩余 P1/P2。用户明确授权了 R4 的最小前端修复。最终全仓测试、构建和两套编译版浏览器验收通过；真实模型 smoke 的跳过情况单独列明。

- 前端固定范围：`4f7d5ef5..ac54f952`，包括 `3b4e747f`、`e7d6584e`、`7270fe05`、`ac54f952`。
- 整体待合并范围：`main(4b2a9646)..subagent/improve-4`。
- B4 是本轮用户另外授权的后端 / SDK 改动，首批提交 `001ca361`，审查修复提交 `90a9081d`。它不改变前端三处兜底，交接见下文。
- 不操作 `.claude/worktrees/subagent-frontend`，不 push。合并前的 main 为 `4b2a9646`。

审查依据：improve-3/05 第二轮、improve-4/02 §2.7（D53）、04 的 I4-01..05 和 §4.2、05 的取舍和后端交接，以及 Web 设计 03 §4.3/4.9、04 §2.7、05 的 SidePanel / SubagentsPage / DelegationRow、README D35。文档中的实施方自检属于待核实的证据，不作为已通过结论。

## Standards

独立初审发现一个 P2：**R4，Tab 的身份没有成为 reader 的生命周期边界（已修复）。**

- 修前 `apps/ohbaby-web/src/ui/shell/AppController.tsx:355` 的 `renderPage` 没有按 `tab.id` 设置 key。
- `ui/side-panel/SidePanelPage.tsx:31` 只按 `rootSessionId` 给 `SubagentsPage` 设置 key。
- `SubagentsPage.tsx:59–67` 的 reader 只随 client / rootSessionId 改变或组件卸载而销毁。

修前，同一会话的两个 Subagents Tab 虽然状态独立，React 仍复用一个 `SubagentsPage`。这不是“同时创建两个 watch”的问题：最多一个 reader 的结构约束成立，但旧 Tab 的 watch 会被新 Tab 继续持有。

**复现步骤：**

1. 在同一会话打开 Subagents Tab B，停留在列表。
2. 再通过 Add page 打开 Subagents Tab A，进入 Runner 详情。
3. 关闭 A，让 B 的列表成为当前页。
4. UI 已没有详情，但 A 的 `unwatchSubagentConversation` 没调用。

独立审查者用真实 `SidePanel` / `SidePanelPage` / `SubagentsPage` 与 SDK reader，在临时 jsdom 驱动中观察到：详情打开时 `watches=1, unwatches=0, tabs=2`；关闭详情 Tab 后 `watches=1, unwatches=0, detail=false`；整个树卸载时才 `unwatches=1`。这会继续保留已经关闭的页面订阅，并接收无可见详情消费的更新。

**修复建议：** 以 `tab.id` 隔离页面组件生命周期，保留同一个 Tab 内“详情返回列表”所需的 reader 复用。补一个真实页面切换 / 关闭测试，断言旧 watch 释放、任务继续运行、新 Tab 不接收旧详情事件。无需恢复已删除的订阅协调器。

**R4 修复（用户授权后，`609bf7a1`）：** `AppController` 给 `SidePanelPage` 增加 `key={tab.id}`，生产代码仅这一行。通过真实 `OhbabyWebApp → AppController → SidePanelPage` 的两项回归测试，分别覆盖切走详情 Tab 和关闭详情 Tab；修前两项都在“unwatch 应为 1，实际 0”处失败，修后通过。测试还确认同 Tab 返回列表 / 再进入不重建 reader、不重读历史，释放的是旧 watchId，关闭非当前 Tab 不额外创建或释放 watch，剩余 Tab 能重新进入详情，且不会调用 stop。相关 3 个文件、34 项测试通过。

独立复核固定范围 `387e4293..609bf7a1`：R4 已解决，未发现 P1/P2；另行运行 SubagentsPage 集成测试 13/13 通过。Standards、Spec 两轴的原始发现均已关闭。

## Spec

独立审查也发现 **R4（P2）**。improve-3/02 §2.5 与 Web 05 要求关 Tab 卸载页面并释放读取；修前只改变 props，没有卸载旧 Tab 的 reader，因此不符合这项约定。两个审查轴各有一个发现，指向同一个问题，不重复计数。

其他疑点已区分为事实与未证实的问题：

- `started:false` 的投影路径并非全部直接透传该字段，但真实运行中 send 没有新 execution 可供匹配，满额 / 失败也没有新 execution。浏览器实测没有错误入口，不能仅凭字段缺失判定功能失败。
- 加载早期历史后再点击同一派遣入口，实测会重新定位；未复现旧锚点吞掉新请求。
- 前台 pending 工具卡的入口、满额与失败场景，实施方原来缺少浏览器证据，本轮已补。

## R1–R3 与 I4 验收

| 项目 | 本轮证据 | 结论 |
| --- | --- | --- |
| R1 / 单一详情读取路径 | 旧浮层和它的 reader 已删除；当前只有 SubagentsPage 创建详情 reader；右侧栏只渲染当前页；R4 补上 Tab 身份边界 | 通过 |
| R2 / 列表进入保留阅读位置 | 第一次派遣详情滚到 `scrollTop=2180`，返回列表再进入 Reader，仍是 `2180`；没有重新锚定 | 通过 |
| R3 / Add page 键盘行为 | 820 px 宽度打开菜单，焦点在 Subagents menuitem；Escape 关闭并将焦点交还 Add page | 通过 |
| I4-01 / 真正启动才有入口 | spawn、空闲 Reader send 有入口；运行中 send 返回 `started:false`，Runner 入口数量仍为 1；失败 send 只留错误工具卡；7 个 spawn 中 6 个启动，只有 6 个入口，第 7 个拒绝没有入口 | 通过 |
| I4-01 / 前台入口 | `PANEL_FOREGROUND` 的工具仍运行、没有结果时已有入口；打开详情后 Stop，随后才补齐工具结果 | 通过 |
| I4-02 / 复用 Tab 和定位 | Reader / Runner / Approval 入口使用同一个 Tab；Reader 两次执行分别定位；第二次入口加载早期历史并向上滚到 `8387.5` 后再点，重新显示第二次派遣；跨 Tab 生命周期的 R4 已修 | 通过 |
| I4-03 / 输入和审批 | 读详情时审批仍显示；Allow once 执行真实 bash 并产生隔离 sentinel；详情打开时可向主会话发送后续命令；旧浮层、Composer.readOnly、ApprovalPanel.visible 已删除 | 通过 |
| I4-04 / 关闭与旧历史 | close Reader 后两条入口消失、工具卡仍在；正在显示的详情返回列表；刷新后列表和主会话均没有 Reader 入口 | 通过 |
| 读取失败不等于关闭 | 现有 App / 快照 hook 回归测试覆盖未加载和失败；后端关闭读取 / 重订阅返回 `SUBAGENT_CLOSED`，旧 execution 不能复活实例 | 通过 |
| I4-05 / 历史与 CLI | 历史 `subagent_run` 的入口回归测试保留；CLI reader 保留 `select(execution)`；共用审批测试保留 | 见下方测试汇总；真实模型 smoke 未执行 |

### 浏览器证据

使用编译后的 CLI / Web、真实 SDK、REST / SSE、SQLite 和工具执行；模型响应由场景脚本提供，不使用线上模型。第一轮同时走了负面场景和窄屏；完整验收随后在独立环境重跑。

第一轮误用全局 New chat，进入默认工作区，Other reader 找不到 fixture.txt，脚本提供方断言失败。该轮以 `quit` 清理，`verified:false`，不能作为完整通过证据。第二轮使用 **New chat in workspace**，正确完成全部主场景，终端输入 `finish` 后得到 `backend-pass`、`cleanup-pass`、`verified:true`，`failures=[]`。原始结果见 完整场景日志（测试附件已清理）。

- Reader 与仍可操作的审批（测试附件已清理）
- 前台工具未结束时的详情入口（测试附件已清理）
- 关闭后刷新，工具卡保留、入口撤下（测试附件已清理）
- 满额拒绝不生成入口（测试附件已清理）
- 390×844 的 Runner 详情（测试附件已清理）
- 新会话只显示 Other reader（测试附件已清理）
- 通用 Web 刷新后无重复回复（测试附件已清理），最终 E01–E05 日志（测试附件已清理）

R4 修复后再次构建并复验：同 Tab 返回列表的 `scrollTop=2180` 不变；创建列表 Tab B 和 Runner 详情 Tab A，关闭 A 后剩一个 Tab、零详情，Runner 仍 Running。此时从脚本输入 `tick`，一个后台流收到 `PANEL_STREAM_TICK_1`；在 B 重开 Runner，能看到该标记，再用 UI Stop 停止。之后完成 Reader 续跑、关闭、刷新和新会话隔离，`finish` 再次得到 `backend-pass`、`cleanup-pass`、`verified:true`、`failures=[]`。见 关详情 Tab 后的列表（测试附件已清理）、重开后仍在运行并读到新内容（测试附件已清理）、最终场景日志（测试附件已清理）。最终浏览器控制台没有 error / warn。

默认宽屏为 1280×720；另走查 820×800 和 390×844。窄屏侧栏全宽展示，正文正常换行；关闭聊天抽屉后可操作列表与详情。验收结束恢复默认视口。

## 两个已知取舍

1. **新 spawn 入口稍晚于执行记录出现：可以接受。** 完整实例快照是关闭判断的依据，执行列表又有轮询周期；工具卡先出现，确认实例与执行后再展示入口，满足“真正启动才显示”。前台执行无需等工具结果，已实测。没有要求两路数据原子到达。
2. **切走 Tab 再回来重新定位那次派遣：可以接受。** Tab 保留显式锚点，回来重新定位是已有文档约定；列表普通打开仍须保留阅读位置。此取舍不意味着可以保留已关闭 Tab 的 watch，R4 已另行修复。

## B4 后端交接

本轮实现：

1. SDK conversation reader 新增 `selectInstance({ subagentId, anchorExecutionId? })`。不传锚点即按实例读取；同实例从列表重开保留窗口。实例身份始终读取 `state.selectedInstance`，零执行的 pending 实例也存在。`state.selected` 在无锚点时维护最新已知 execution，有显式锚点时保持该 execution；零执行或读取未完成时可为空。`select(execution)` 保留兼容。
2. 真正尚无 execution 的 pending 实例可以返回空历史 / 空 runs，不泄漏父会话正文；首次执行绑定后可自动重新绑定读取。关闭实例和不存在实例仍返回带 code 的错误。
3. instance reader 接到所属 root 或全局 `session.resync-required`，在连接恢复后自动刷新。刷新排队合并，同时兼容尚未删掉的 Web 显式刷新，避免取消彼此的请求。
4. stop 被接受后仅投影目标实例作为回执，不再依赖整份实例列表的 revision 重试。无关实例持续变化不会把已接受的 stop 变成 409。完整列表自身仍允许抛 `SUBAGENT_SNAPSHOT_CHANGED`，不会伪装成关闭。
5. close / stop 竞争返回 `SUBAGENT_CLOSED`；目标不存在或不属于请求 root 时返回 `SUBAGENT_NOT_FOUND`。请求 root 本身与 REST / RPC 客户端绑定不一致，仍是 `SESSION_SCOPE_CHANGED`（409），没有放宽会话隔离。SDK 导出 `UiSubagentSnapshotChangedError`。
6. 删除 composition、runtime 类型和适配器的 `getSubagentWaitState` 路径；旧 execution view 的 wire 字段 `waiting` / `approvalBlocked` 保留 false，兼容旧调用方。
7. 补真实控制集成测试：关闭运行中实例会取消；关闭后读取 / watch 拒绝；释放 watch 不停止子代理，子代理仍可完成。

独立 B4 审查另外找到两个 SDK P2：刷新中同实例重开丢掉较早页、`jumpToLatest()` 未同步更新 selected execution。两项已修：无锚点的同实例重开在 loading / error 状态也保留窗口，清除旧锚点；jump 从合并缓冲事件后的 baseline 更新 selected。回归用例先红后绿，并验证迟到的旧 refresh 不能覆盖新结果。独立审查还用 SDK / 后端事件桥验证 pending → 首次执行无需手动重读。对 `90a9081d` 的独立复核确认两项均解决，reader 30 项通过，无剩余重要回归。

**给 Claude：** B4 完成后，可以把按 latestExecutionId 先查询 execution 再 select 的适配路径改为 `selectInstance`，删除 Web 对 resync 的手动刷新。零 execution 的选中状态读取 `selectedInstance`。stop 的 `SUBAGENT_SNAPSHOT_CHANGED` 临时处理也可按用户本轮要求清理（improve-3/02 §2.7 的旧表格曾写“保留”，以本轮交接为准）；普通操作失败提示与列表刷新仍由前端维护。这些前端替换尚未在本轮代改。

## 测试与合并门槛

| 检查 | 本轮结果 |
| --- | --- |
| Web 全套 + SDK sync + 受影响后端 | 首批 80 个文件、971 项通过；SDK 审查修复后又通过完整仓库测试 |
| `pnpm test`（最终状态） | 642 个文件通过、6 个跳过；7523 项通过、17 项跳过，0 失败 |
| `pnpm typecheck` | 通过，包括 B4 和 R4 代码提交的 pre-commit 检查 |
| `pnpm lint` | 0 错误、109 个既有警告 |
| 改动文件 Prettier / `git diff --check` | 通过 |
| `pnpm test:smoke` | 命令退出 0，但 4 个文件、12 项全部跳过；没有启用真实模型环境，**不计作真实模型 smoke 通过** |
| 子代理编译场景 | `backend-pass`、`cleanup-pass`、`verified:true` |
| `pnpm build` / 编译 Web E01–E05 | R4 修复后重新构建通过；E01–E05 的 UI、后端、清理、诊断均 PASS，退出 0 |

全仓首轮有一个失败：已有 stop 测试按 `/not found/` 文案断言，与新增结构化错误不一致。已改为验证 `SUBAGENT_NOT_FOUND`，该文件 35 项及最终全仓测试均通过。没有改弱目标不存在 / 外会话隔离的业务断言。

合并结论：R4 和两项 SDK P2 已关闭，受影响行为已有自动化与真实后端浏览器证据，可以合入本地 main。真实模型 smoke 未覆盖，不把跳过写成通过；本次验收结论不延伸为线上模型兼容性认证。前端 B4 三处临时适配继续由 Claude 清理，不影响当前兼容路径。不会 push。
