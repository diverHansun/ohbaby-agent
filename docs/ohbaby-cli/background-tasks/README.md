# TUI 后台任务面板设计

2026-11-15 开始讨论。本组文档用 plan-frontend-design 的精简模式撰写，规划阶段不写代码。同日完成初稿和一轮子代理审查，审查的 12 条意见已核对并修订（主要是面板打开时全局按键必须让路、`End/PgUp/PgDn` 在部分终端收不到时的退路、宽度统一按内容宽、`· background` 的落点和 `/help` 列出 `/bg`）。

Web 版已经实施并合并到 `main`（`4b2598bc`、`03d2bb52`），设计见 [Web 后台任务面板](../../ohbaby-web/background-tasks/README.md)。产品规则沿用 Web 的 D1–D12：只能取消、前台命令不进列表、对话里不显示任务结束、少显示状态、按启动者筛选、自动加载、Running/Done 分组。本组文档只写终端特有的部分：入口、整屏面板、键位、折行与窄终端、确认方式。

后端契约见 [shell-job.ts](../../../packages/ohbaby-sdk/src/contract/shell-job.ts)。TUI 通过进程内客户端调用 `listShellJobs`、`getShellJobOutput`、`stopShellJob`，列表一律带 `mode: "background"`（Web D12）。

## 已确认的决策

| # | 决策 | 确认日期 |
|---|---|---|
| T1 | 文档放 `docs/ohbaby-cli/background-tasks/`，精简模式写 00、01、03、04、06、08；产品规则引用 Web D1–D12，不重复定义 | 2026-11-15 |
| T2 | 形态照现有 `Ctrl+G` 子代理浏览器：整屏替换对话区，列表和详情两级。不学 pi-background-tasks 的底部浮层，因为 ohbaby TUI 用 Ink，没有浮层合成，而整屏面板已有两处先例（子代理浏览器、Side chat） | 2026-11-15 |
| T3 | 界面统一叫 “Background tasks”。“Tasks” 在 TUI 里已经指 todo 清单（`Ctrl+T`），不能混用 | 2026-11-15 |
| T4 | 入口只有 `/bg` 命令，不加快捷键。讨论时 `Ctrl+B` 被翻页占用（T11 之后会空出来，但用户选择不加快捷键），`Shift+↓` 在不少终端里收不到，`Ctrl+K` 违背“删到行尾”的习惯。`/bg` 照 `/btw`、`/rewind` 的做法：后端命令目录登记为仅 tui，由 TUI 本地处理 | 2026-11-15 |
| T5 | 有任务在跑时，在对话区顶部现有提示行 `Ctrl+G subagents · …` 后面接一段 `/bg background · 2 running`；没有任务在跑时不显示这一段。会话从没有后台任务时，`/bg` 只在对话区出一条 info 级本地通知，不打开面板。有待审批时现有提示行整行不显示，运行数也随之不显示 | 2026-11-15 |
| T6 | 取消要确认：按 `c` 后面板底部的键位行变成 `Cancel <说明>? y confirm · any key back`，5 秒内不按 `y` 自动退出确认。理由：Web 是点一个写着 Cancel 的按钮，TUI 是单个字母键，误触的代价更高。参考 kimi-code | 2026-11-15 |
| T7 | 筛选按 `f` 在 Main agent → Subagents → All 之间循环，标题行显示当前筛选；只有子代理也有任务时才生效、才出现在提示里 | 2026-11-15 |
| T8 | 详情页每 2 秒拉一次输出尾部；长行折行（和子代理浏览器一致）；往上滚就冻结，`End`、`Shift+End` 或用方向键滚到底都会恢复跟随；内容宽小于 40 或终端不足 10 行只显示 `Terminal too small`。列表的选择移到底部时自动加载下一页（Web D11） | 2026-11-15 |
| T9 | 对话里不做跳转。启动了后台任务的 bash 工具标签后加灰字 `· background`，任务结束也不变（Web D6）。`background-task-result` 加进 TUI 的隐藏列表 | 2026-11-15 |
| T10 | Web 的视图转换纯函数（标题、状态行、说明行、时长、分组计数）挪到 `ohbaby-sdk`，Web 和 TUI 共用，避免两边文案走样 | 2026-11-15 |
| T11 | 顺带改动：删掉往上翻历史时出现的 `History · Ctrl+B up · Ctrl+F down · Ctrl+Y latest` 提示，那个位置始终显示分隔线；`Ctrl+B`、`Ctrl+F`、`Ctrl+Y` 三个翻页快捷键也一起删掉。翻页保留鼠标滚轮、`Shift+PgUp/PgDn`，`Shift+Home/End` 跳到最早/最新。用户认为这是冗余设计 | 2026-11-15 |

## 实施状态

2026-11-15 在临时分支 `tmp/tui-background-tasks` 实施并完成独立审查。按用户确认的范围修正了输出就绪、失效详情、取消超时和修饰键误触四项问题，验收证据见 [09 实施与验收](09-implementation-acceptance.md)。实施时和文档不一致的两处已回写：

- 提示行实际位于对话区顶部（`Ctrl+G subagents · …` 那一行），不在输入框正上方，各文档已改称“对话区顶部提示行”。
- bash 卡片下原有一行 “Started in background”，和 T9 的 `· background` 重复，已删除，只保留标题末尾的 `· background`；`Ctrl+O` 展开时多显示一行灰色 `Task <jobId>`。

面板照 pi-tui `render(width)` 的思路实现：`task-lines.ts` 先按内容宽算好每一行（截断、尾列定宽），Ink 组件只负责打印。端到端测试用 tmux 驱动真实 TUI 和真实模型完成，见 09 的真实终端记录。

## 文档地图

精简模式。省略的三份：

- 02：沿用现有 TUI 架构（Ink 组件、`app.tsx` 管面板、`useInput` 管键位），不新增技术选型。
- 05：新增组件只有面板、列表、详情三个，契约并入 04 §1 和 06 §2。
- 07：终端兼容（窄终端、颜色、按键）写在 03 §5 和 04 §3。

| 文件 | 内容 | 状态 |
|---|---|---|
| [00-goal-duty.md](00-goal-duty.md) | 目标、任务、职责边界、Non-goals | 已实施，验收见 09 |
| [01-use-cases-and-user-flows.md](01-use-cases-and-user-flows.md) | 入口、流程、用例 | 已实施，验收见 09 |
| [03-ui-layout-and-style.md](03-ui-layout-and-style.md) | 原则、终端线框、文案、宽度规则、验收口径 | 已实施，验收见 09 |
| [04-interaction-and-states.md](04-interaction-and-states.md) | 键位、组件状态、页面状态矩阵 | 已实施，验收见 09 |
| [06-data-api-and-state.md](06-data-api-and-state.md) | 接口、共用视图函数、刷新与错误映射 | 已实施，验收见 09 |
| [08-test-and-acceptance.md](08-test-and-acceptance.md) | 验收标准、测试分层、终端走查清单 | 已实施，验收见 09 |

[实施与验收记录](09-implementation-acceptance.md) 区分真实终端验证、受控接口测试和未覆盖环境。

## 参考

2026-11-15 子代理核实（路径省略）：

| | pi-background-tasks | kimi-code | ohbaby `Ctrl+G` 子代理浏览器 |
|---|---|---|---|
| 入口 | `Shift+↓`（可配置），`/tasks` | `/tasks`，页脚 `[N tasks running]` | `Ctrl+G`，对话区顶部提示行 |
| 形态 | 底部浮层，宽 96%，高 60% | 全屏三栏 | 整屏替换对话区，列表和详情两级 |
| 停止 | `k` 单停不确认，停全部需按两次 | `s` 后按 `Y` 确认，5 秒超时 | 不能停 |
| 输出 | 每 1 秒读尾部 128KiB，往上滚冻结 | 每 1 秒读尾部 4000 字符 | 只读详情 |
| 反馈 | `Stopping…` 在面板内，按任意键清除 | 提示行右侧闪 1.5 秒 | — |
| 终端兼容 | 快捷键可换，始终保留命令入口 | 小于 48×10 提示太小；遵守 NO_COLOR | — |

取舍：学 kimi 的确认和“太小”提示，学 pi 的“往上滚就冻结”和“操作反馈留在面板里、按键清除”，结构照 ohbaby 自己的子代理浏览器。
