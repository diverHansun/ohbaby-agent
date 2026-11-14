# 03 布局与视觉（简写）

视觉遵循 [redesign-2026-10 的 03](../redesign-2026-10/03-ui-layout-and-style.md)：纯白画布、中性灰（D30）、红色只用于错误（D32）、玻璃只用在浮起元素上（D21），右侧栏结构见其 §4.9。本文档只补这一页的原则、线框、文案和验收口径。

## 1. 设计原则

| 原则 | 截图上看什么 | 反例 |
|---|---|---|
| 安静：任务是给 agent 用的，界面不抢注意力 | 列表里除了失败和超时的红字，看不到彩色标记；没有徽标、圆点、色块 | 每行一个彩色状态胶囊，Running 绿、Done 灰、Cancelled 黄 |
| 文字和留白分层，不靠框 | 行与行之间没有边框和卡片底，靠字重、灰阶和间距区分；悬停才出现浅灰底 | 每个任务一张带阴影的卡片 |
| 操作说人话、看得见 | 取消是一个写着 `Cancel` 的文字按钮，没有边框和胶囊底 | 只有一个 ■ 图标，或者描边胶囊 `■ Stop` |
| 等宽字体只给机器文本 | 只有命令和输出用等宽字体，说明、分组标题、时长用界面字体 | 整行都是等宽字体，像终端 |
| 数字不跳 | 时长走动时，行宽和对齐不变 | 秒数变化时后面的文字左右抖动 |

## 2. 视觉方向与来源

方向：安静的工具感，以文字为主。借鉴：

- **Claude 桌面端的 Background tasks 面板**：小号灰色组标题 `Running 1`，一行一个任务，右侧是时长和操作，没有多余装饰。
- **Apple**：层级靠字重和灰阶，不靠线；详情进入时短促的横向滑入。
- **OpenAI（ChatGPT / Codex）**：输出区是一块无边框的浅底区域，等宽字体，顶部渐隐，表示上面还有内容。
- **Tesla**：数字用等宽数字（tabular figures），读数稳定，像仪表。

可以在截图上核对的标志性特征：

1. 组标题是小一号的灰字加数量，没有背景条。
2. 列表里没有边框线、卡片和胶囊；只有悬停底色。
3. 输出区无边框，用 `--bg-subtle` 一类的浅底，和面板背景只差一点；顶部有渐隐。
4. 运行时长使用等宽数字。
5. “回到底部”是唯一一个浮起元素，用轻玻璃（D21）。

图标：lucide 线性图标，描边和现有右侧栏一致。页面图标初值 `Timer`，实现时可换，但要和 Terminal 的 `SquareTerminal` 区分开。

## 3. Tokens

不新增语义色，只用现有 token：

| 用途 | token |
|---|---|
| 任务说明（主文字） | `--text` |
| 命令、组标题、时长、说明灰字 | `--text-dim`、`--text-muted` |
| 失败和超时的红字 | `--danger-ink` |
| 行悬停 | `--bg-hover` |
| 输出区底色 | `--bg-subtle`（初值，实现时可调） |
| 等宽字体 | `--font-mono` |
| 动效 | `--duration-fast`、`--ease` |
| “回到底部”按钮 | `--bg-glass`、`--shadow-menu` |

阶梯：间距、字号、圆角沿用现有阶梯，不写阶梯外的字面量。

## 4. 线框

右侧栏宽度初值 420px（可拖动，320–720px），以下按 420px 画。

### 4.1 列表

下图是筛选为 All 时的样子，所以有一行显示了启动者；默认的 Main agent 视图里没有这一行。

```
+----------------------------------------------+
| (timer Background tasks x) [+]      [<>] [|] |  <- 右侧栏 Tab 条（已有）
+----------------------------------------------+
|                                    [filter]  |  <- 筛选图标；只有子代理也有任务时出现
| > Running 2                                  |  <- 可折叠组标题 + 数量，小号灰字
|   Dev server                 12m    Cancel   |  <- 说明；时长（等宽数字）；Cancel 文字按钮
|   pnpm dev                                   |  <- 命令，等宽、灰、单行省略
|   Watch tests                 45s   Cancel   |
|   pnpm vitest --watch                        |
|   Code reviewer                              |  <- 启动者，只在筛选为 Subagents/All 时显示
|                                              |
| > Done 3                                     |
|   Unit tests                          5m     |  <- 结束：只有灰色时长
|   pnpm test                                  |
|   Build                          Failed      |  <- 失败/超时：红字，替代时长
|   pnpm build                                 |
|   Type check                          2m     |  <- 被取消：和成功一样，只显示时长
|   pnpm tsc --noEmit                          |
|                                              |  <- 没有 Show more；滚到底部附近自动加载下一页
+----------------------------------------------+
```

- 每行两到三行文字，整行可点进入详情；Cancel 在行内单独响应，点它不会进入详情。
- 时长和 Cancel 右对齐。Cancel 一直可见（触屏没有悬停，不能只在悬停时出现）。
- 行之间没有分隔线，靠行内上下留白分开。
- 筛选菜单：一项一行，`Main agent`、`Subagents`、`All`，当前项右侧对勾。菜单样式沿用现有菜单（玻璃浮层）。
- 加载失败、取消失败等错误说明放在列表顶部、筛选图标下方，一行。

### 4.2 详情

```
+----------------------------------------------+
| (timer Background tasks x) [+]      [<>] [|] |
+----------------------------------------------+
| [<]  Dev server                     Cancel   |  <- 返回；说明（单行省略）；Cancel
|      Running · 12m 04s                       |  <- 状态和时长，小号灰字
|      pnpm dev --port 5173                    |  <- 完整命令，等宽，可换行，可选中复制
|      Started by Code reviewer                |  <- 只在非主代理时出现
|      Started from another ohbaby window.     |  <- 特殊情况说明，0–2 行，灰字
|      Cancel it there.                        |
|                                              |
|  ............ (顶部渐隐) ...............      |
|  VITE v5.4.0  ready in 312 ms                |  <- 输出区：浅底、无边框、等宽
|  ➜  Local:   http://localhost:5173/          |
|  ...                                          |
|                                      (v)     |  <- 回到底部，只在离开底部时出现
+----------------------------------------------+
```

- 输出区占满剩余高度，自己滚动；上面的标题和说明固定。
- 输出超过 32KiB 时，输出区第一行是灰字 `Showing the last 32 KB.`；有日志路径时后面跟一个复制路径的小图标。
- 日志本身被截断时，再加一行灰字 `The saved log is incomplete because the output was too large.`。
- 操作出错（取消失败、输出拉取失败）的说明放在标题区下方、输出区上方，一行。
- 结束的任务：顶部没有 Cancel；状态行例如 `Failed · exit 1 · 3m 12s`。

### 4.3 入口行（bash 工具卡下方）

```
  > Ran pnpm dev                                    <- 已有 bash 工具卡
    [timer] Background task  ›                      <- 入口行：小图标 + 文字 + 箭头，淡色
```

样式、缩进、悬停和 Subagents 委派入口行（`DelegationRow`）一致，但不带状态图标和时长。

### 4.4 `[+]` 菜单与入口页

有任务的会话，菜单和入口页多一项：`[timer] Background tasks`，说明 `See and cancel this chat's background tasks`。没有任务的会话不出现。

## 5. 内容与文案

界面文字用英文，和现有 Web 一致。

### 5.1 术语表

| 概念 | 界面用词 | 不用 |
|---|---|---|
| 后台任务 | Background task / Background tasks | job、shell job、bg task |
| 取消 | Cancel、Cancelling… | Stop、Kill、Pause |
| 主代理 | Main agent | primary、parent |
| 子代理 | Subagent（具体名字用 `ownerName`） | child |
| 分组 | Running、Done | Active、Finished |

### 5.2 状态行文案（只在详情页出现）

| 后端事实 | 文案 |
|---|---|
| `running` | `Running · 12m 04s` |
| `completed` | `Completed · exit 0 · 5m` |
| `failed`，有 exit code | `Failed · exit 1 · 3m 12s` |
| `failed`，被信号杀掉 | `Failed · SIGKILL · 3m` |
| `timed_out` | `Timed out · 24h` |
| `cancelled` + `user` | `Cancelled by you · 2m` |
| `cancelled` + `model` | `Cancelled by the agent · 2m` |
| `cancelled` + 其他原因 | `Cancelled · 2m`，原因见下方说明行 |
| `lost` | `Result unknown` |

列表里只用其中一部分：运行中显示时长；`failed` 显示红字 `Failed`；`timed_out` 显示红字 `Timed out`；`lost` 显示灰字 `Unknown`；其余显示灰色时长。

### 5.3 说明行文案（详情页，有才显示）

| 情况 | 文案 |
|---|---|
| 由别的后端管理 | `Started from another ohbaby window. Cancel it there.` |
| `cleanup` 为 `unconfirmed` | `ohbaby couldn't confirm the process stopped. It may still be running.` |
| `lost` | `ohbaby stopped unexpectedly while this task was running.` |
| 停止原因 `owner-ended` | `Stopped when its subagent finished.` |
| 停止原因 `rewound` | `Stopped when the chat was rewound.` |
| 停止原因 `output-limit` | `Stopped after writing too much output.` |
| 停止原因 `capacity-limit` | `Stopped because too many tasks were running.` |
| 停止原因 `shutdown`、`session-closed`、`internal-error` | `Stopped when ohbaby shut down.`、`Stopped when the chat was closed.`、`Stopped by an internal error.` |

“由别的后端管理”只在任务 `running` 时显示，判断见 01 §1.3。最多同时显示两行，按表中顺序取前两条。

### 5.4 空态和错误

- 筛选后没有任务：`No tasks from the main agent.` / `No tasks from subagents.`
- 任务不存在：`This task is no longer available.`
- 没有保存输出：`No output was saved for this task.`
- 任务已结束且没有任何输出：`No output.`
- 输出超过 32KiB：`Showing the last 32 KB.`
- 日志被截断：`The saved log is incomplete because the output was too large.`
- 取消时后端正在清理（`SHELL_JOB_CLEANUP_BUSY`）：`ohbaby is already cleaning up this task.`
- 网络和其他错误：沿用现有的 `readableError` 文案；加载类错误带 `Retry`，取消类错误不带（用户可以直接再点 Cancel）。

## 6. 视觉验收口径

硬指标：

- 样式只用 token，不写字面量色值和尺寸。
- Cancel 的可点区域不小于 24×24px；键盘能聚焦，焦点可见。
- 失败只靠红色不够：同时有 `Failed` 文字。
- 时长使用等宽数字。

方向性判断（浏览器截图 + 模型判断）：

- 对照 §4 线框：分组、行结构、Cancel 位置、详情的固定区和滚动区一致。
- 对照 §1 每条原则的观察点，逐条判断“符合 / 偏离”。
- 对照 §2 的五个标志性特征，逐条核对。
- 文案符合 §5。

允许方向内的调整，例如输出区底色深浅、渐隐高度、滑入时长；调整值回写本文档。拿不准时交给用户判断。

## 7. 实现约束摘要

| 必须遵守 | 初值可调 | 自由发挥 |
|---|---|---|
| §4 线框结构；不用卡片、胶囊、状态点；Cancel 是文字按钮；红色只给失败和超时；有任务才出现；§5 文案和术语；等宽字体只给命令和输出 | 页面图标（`Timer`）、输出区底色、行间距、渐隐高度 | 滑入动效时长和曲线、悬停细节、Cancelling 的过渡 |

冲突时的优先级：本节“必须遵守”和用户明确要求 > redesign-2026-10 的约定 > 参考产品 > 实现者自己的判断。
