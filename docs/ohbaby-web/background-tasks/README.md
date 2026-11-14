# Web 后台任务面板设计

2026-11-14 开始讨论。本组文档用 plan-frontend-design 的精简模式撰写，规划阶段不写代码。同日完成初稿、自查和一轮子代理审查；审查提出的 15 条问题已逐条核对并修订（主要是“别的后端管理”的判定、失效事件节流、探测未知时不闪、输出截断字段、遗漏的 `CLEANUP_BUSY` 错误码）。

后台任务（background task，后端叫 ShellJob）的后端已经在 [后台任务议题](../../tools/2026-11-13-background-tasks/README.md) 的 improve-1～3 完成并合并到 `main`，起点提交是 `0ae131a4`。当时按 improve-1 D05 把前端暂缓。本组文档只补 Web 前端：右侧栏的 Background tasks 页面、bash 工具卡下的入口行，以及主会话里对任务结果消息的处理。产品规则（六种状态、停止原因、归属、额度）以后端议题为准，这里不重复定义。

TUI 另开议题，放在 `docs/ohbaby-cli/background-tasks/`，做法照 pi-background-tasks 和 kimi-code 的 TUI，不在本组文档范围内。

## 已确认的决策

| # | 决策 | 确认日期 |
|---|---|---|
| D1 | 只在会话有过后台任务时出现：没有任务的会话，`[+]` 菜单和右侧栏入口页里都没有 Background tasks；已经打开的 Background tasks 页在这类会话里隐藏。不在主区顶栏加图标，入口只有 `[+]` 菜单和 bash 工具卡下的入口行。参考 Claude 桌面端 | 2026-11-14 |
| D2 | 用户可以取消单个运行中的任务。后台任务只能取消（kill），没有暂停和继续。按钮是 `Cancel` 文字按钮，点击后变为 `Cancelling…`，不弹确认框。这兑现 improve-1 D02 的“用户逐个停止”。“放弃追踪”本轮不做 | 2026-11-14 |
| D3 | 不做卡片，不用胶囊包裹文字的按钮，不加琥珀点等多余的状态点。列表里少显示状态：运行中只显示时长，结束后只有失败和超时用红字标出 | 2026-11-14 |
| D4 | 列表按 Running / Done 分组，分组就是状态筛选，不再另做状态筛选。另提供按启动者筛选：Main agent / Subagents / All，放在面板右上角的筛选菜单里，一项一行，不用“·”连成一串 | 2026-11-14 |
| D5 | 不做按启动时间筛选，沿用后端的“需要关注的在前，其余最新在前”排序 | 2026-11-14 |
| D6 | 主会话不显示任务结束通知：`background-task-result` 消息和子代理结果一样隐藏，只交给模型。bash 工具卡下的入口行是固定链接，不随任务状态变化。理由：任务是给 agent 用的，用户不需要被告知结束 | 2026-11-14 |
| D7 | bash 工具卡下加一行入口，照 Subagents 的委派入口行（redesign-2026-10 D35），点击后在右侧栏打开该任务的详情 | 2026-11-14 |
| D8 | 视觉原则：简约大气、轻量、高级感、操作负担轻；样式不单调，借鉴 OpenAI、Apple、Anthropic、Tesla 的做法。沿用 redesign-2026-10 的 token 和右侧栏结构 | 2026-11-14 |
| D9 | 文档按端分开放：Web 放本目录，TUI 放 `docs/ohbaby-cli/background-tasks/` | 2026-11-14 |
| D10 | Cancel 只给运行中的任务显示。后端对“已结束但清理未确认”的任务也允许再停一次（实际是重试清理），本轮不提供入口，只显示说明（00 §4）。审查时补充，用户确认 | 2026-11-14 |
| D11 | 列表不用 `Show more` 按钮，也不在底部显示上限说明：滚动到接近底部时自动加载下一页（06 §3.4）。用户在审查后调整 | 2026-11-14 |
| D12 | 前台 bash 不进入后台任务列表，也不让入口出现。判断标准是记录的 `mode` 为 `background`，自动转后台的任务会改成这个值，所以照常显示。前台命令的清理异常只留给模型的 `task` 工具。实现上给后端列表加了可选参数 `mode=background`（06 §1、§7），模型的列表不变。用户在审查时提出 | 2026-11-14 |

Subagents 页的停止按钮改成暂停/继续图标、输入框发送/停止按钮换颜色，用户希望以后做，但不属于本议题。另外，用户现在不能手动让子代理继续（只有主代理可以 `agent send`），需要后端先补能力。这两件事已作为单独议题提出。

## 实施状态

2026-11-14 在 `tmp/web-background-tasks` 完成实施与浏览器验收，并纳入本地 main。详见 [09 实施验收](09-implementation-acceptance.md)。实施时对文档做了三处小调整，已回写：列表读取器在详情页也保留（06 §3.1）；被唤醒轮次保留 `Background task update` 小标签（04 §2.5）；运行中的行把时长和 Cancel 放在标题那一行的右侧（03 §4.1 线框本来如此，实现照此对齐）。审查时按 D12 补了前台命令过滤，后端 `listShellJobs` 新增可选参数 `mode=background`。

## 文档地图

精简模式：写 00、01、03（简写）、04、06、08。省略的三份：

- 02：完全沿用 [redesign-2026-10 的 02](../redesign-2026-10/02-frontend-architecture.md) 的分层和状态分类，不新增技术选型。
- 05：新增组件只有几个，契约并入 04 §1 和 06 §2。
- 07：沿用 [redesign-2026-10 的 07](../redesign-2026-10/07-quality-constraints.md)，本功能特有的无障碍和性能要求写在 04 §3 和 06 §3。

| 文件 | 内容 | 状态 |
|---|---|---|
| [00-goal-duty.md](00-goal-duty.md) | 目标、任务、前后端分界、Non-goals | 已确认（2026-11-14） |
| [01-use-cases-and-user-flows.md](01-use-cases-and-user-flows.md) | 入口、流程、用例 | 已确认（2026-11-14） |
| [03-ui-layout-and-style.md](03-ui-layout-and-style.md) | 设计原则、线框、文案、视觉验收口径 | 已确认（2026-11-14） |
| [04-interaction-and-states.md](04-interaction-and-states.md) | 组件状态、页面状态矩阵、交互规则 | 已确认（2026-11-14） |
| [06-data-api-and-state.md](06-data-api-and-state.md) | 接口映射、ViewModel、刷新策略、错误映射、Mock | 已确认（2026-11-14） |
| [08-test-and-acceptance.md](08-test-and-acceptance.md) | 验收标准、测试分层、视觉验收清单 | 已确认（2026-11-14） |
| [09-implementation-acceptance.md](09-implementation-acceptance.md) | 实际浏览器、真实 API 和回归结果 | 已验收（2026-11-14） |

## 相关文档

- 后端契约：[shell-job.ts](../../../packages/ohbaby-sdk/src/contract/shell-job.ts)、[HTTP 路由](../../../packages/ohbaby-server/src/protocols/web/routes/shell-jobs.ts)、[improve-1 状态模型](../../tools/2026-11-13-background-tasks/improve-1/00-discussion.md#3-状态模型d06)。
- 右侧栏结构和视觉：[redesign-2026-10 03 §4.9](../redesign-2026-10/03-ui-layout-and-style.md)。
- 参考项目对照见 [00 附录](00-goal-duty.md#附录参考项目对照)。
