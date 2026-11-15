# 01 用例与用户流程

## 1. 信息架构

### 1.1 屏幕结构

TUI 没有路由。和子代理浏览器一样，面板打开时替换对话区，输入框隐藏。

```
TUI 主屏
├── 对话区
│   └── bash 工具标签 “Bash <命令> · background”   ← 只提示，不能跳转
├── 对话区顶部提示行
│   └── “Ctrl+G subagents · … · /bg background · 2 running”  ← T-04
└── /bg 打开的整屏面板（Background tasks）
    ├── 列表                                        ← T-01、T-03
    └── 详情（同一面板内切换）                       ← T-02、T-03
```

### 1.2 入口表

| 入口 | 主要任务 | 前置条件 | 核心 |
|---|---|---|---|
| `/bg` 命令 | 打开面板（T-01） | 有一个打开的会话；会话有过后台任务才打开面板 | 是 |
| 提示行运行数 | T-04 | 当前有任务在跑 | 否 |
| 面板列表 | T-01、T-03 | 面板已打开 | 是 |
| 面板详情 | T-02、T-03 | 在列表里按 Enter | 是 |

“会话有过后台任务”的判断和 Web 相同：带 `mode: "background-or-unconfirmed"` 分别查主代理和子代理，`statusCounts` 之和大于 0。普通前台命令不算（Web D12），清理未确认、尚未放弃追踪的前台命令算（[Windows 兼容 improve-1 · D14](../../shell/2026-11-15-windows-compatibility/improve-1/00-discussion.md)）。

### 1.3 权限

单角色。不能取消的两种情况和 Web 01 §1.3 相同：任务已结束；任务运行中但由别的 ohbaby 后端管理（例如在 Web 里启动）。后一种在列表里不提供 `c`，详情里一行说明。

### 1.4 术语

| 概念 | 界面用词 | 不用 |
|---|---|---|
| 后台任务 | Background tasks / background | Tasks（已指 todo）、jobs、bg tasks |
| 取消 | Cancel / Cancelling… | Stop、Kill、Pause |
| 主代理 / 子代理 | Main agent / Subagents | primary、child |
| 分组 | Running、Done | Active、History |

## 2. 用户流程

### 2.1 打开与查看（T-01、T-02）

```
用户在输入框输入 /bg 回车
├── 没有打开的会话 → 对话区 info 级本地通知：“Open a chat to see its background tasks.”
├── 会话从没有后台任务 → 对话区 info 级本地通知：“No background tasks in this chat.”，不打开面板
├── 探测还没回来 → 先打开面板，显示 Loading…（超过 300ms）
↓ 面板打开，对话区被替换，输入框隐藏
↓ 列表：Running 组在上，Done 组在下，第一行选中
├── 加载失败 → 一行原因 · r retry；之前有数据就保留旧列表
↓ ↑/↓ 选择；选到列表底部且还有下一页 → 自动加载
↓ Enter → 详情
├── 运行中 → 输出贴底跟随，每 2 秒刷新
├── 往上滚 → 冻结，不再跟着新输出跳；End 或滚回底部恢复跟随
├── 输出拉取失败 → 一行原因 · r retry，已有输出保留
└── 任务已不存在 → “This task is no longer available.” · Esc back
↓ Esc → 回到列表，选中刚才那一行
↓ 再按 Esc → 关闭面板，回到对话，输入框恢复，草稿不丢
```

### 2.2 取消（T-03）

```
列表或详情里，选中的任务正在运行且可以取消
↓ 按 c
↓ 面板底部的键位行变成 “Cancel Dev server? y confirm · any key back”
├── 5 秒内没按 y → 键位行恢复，什么都不做
├── 按了其他任意键 → 键位行恢复，这个键不再触发别的操作
↓ 按 y
↓ 这一行（或详情标题）右侧显示 “Cancelling…”
├── 后端停下 → 行移到 Done，显示时长，不标红
├── 已经结束 → 刷新，行自然移到 Done
├── 别的后端管理 → 刷新后出现说明
├── 后端正在清理 → 面板内一行 “ohbaby is already cleaning up this task.”
└── 网络或其他错误 → 面板内一行原因；再按 c 可以重试
```

取消失败的说明留在面板里，按下一个键清除，参考 pi-background-tasks。加载类错误一直保留到重试成功。

### 2.3 提示行（T-04）

```
会话里有后台任务在跑
↓ 对话区顶部提示行末尾出现 “/bg background · 2 running”
↓ 全部结束 → 这一段消失
```

提示行原本只在客户端支持子代理时显示 `Ctrl+G subagents · N executions`。不支持子代理时，后台任务这一段单独成行。有待审批时现有逻辑整行不渲染，运行数也随之不显示，审批处理完恢复。

### 2.4 跨会话、窄终端与异常

- 当前会话一变（例如被别的客户端切走、恢复流程换了会话）：立即关闭面板，丢弃确认和取消中状态。面板打开时输入框隐藏，用户不会在面板里输入切换命令。
- 有待处理的审批：和子代理浏览器一样，面板顶部一行 `Approval pending · Close this panel to review`，面板照常可用。
- 内容宽缩到 40 以下或终端不足 10 行：面板只显示 `Terminal too small`，放大后恢复原状态。
- 断线重连：面板保留，重新拉列表；详情重新拉输出。

## 3. 用例

### UC-TBG-01 打开面板查看任务

前置条件：有打开的会话，会话有过后台任务。

主流程：

1. 用户输入 `/bg` 回车。
2. 对话区被面板替换，标题行 `Background tasks · Main agent`。
3. 列表分 Running 和 Done，组标题后是数量，第一行选中（`›` 加强调色）。

异常流程：

- 会话没有后台任务 → 对话区 info 级本地通知，不打开面板。
- 加载失败 → 一行原因 · `r retry`，已有列表保留。
- 主代理没有任务、只有子代理有 → 打开时筛选为 All。
- 选到底部且还有下一页 → 自动加载，超过 300ms 显示 `Loading…`。

完成结果：

- 运行中的任务都在 Running 组，时长每秒走动；Done 组里失败和超时显示 `Failed` / `Timed out`（error 色），lost 显示灰色 `Unknown`，其余只显示灰色时长。
- 组标题数量来自后端统计。
- 列表里没有普通前台命令；清理未确认的前台命令会列出（Windows D14）。

### UC-TBG-02 筛选启动者

前置条件：子代理也启动过任务。

主流程：按 `f`，筛选在 Main agent → Subagents → All 之间循环，标题行跟着变，列表重新加载。

完成结果：Subagents 和 All 下，子代理的任务行尾带启动者名字。子代理没有任务时按 `f` 无反应，键位行也不出现 `f`。

### UC-TBG-03 查看详情和输出

前置条件：列表里选中一行，按 Enter。

主流程：

1. 标题行：说明（没有就用命令首行）和状态行，例如 `Running · 2h 0m 40s`。
2. 下面是完整命令（折行），需要时 0–2 行说明（文案和 Web 03 §5.3 相同）。
3. 分隔线下面是输出尾部，贴底跟随，每 2 秒刷新。

异常流程：

- 往上滚 → 冻结；键位行出现 `End follow`。滚回底部或按 `End` 恢复。
- 输出超过 32KiB → 输出区第一行 `Showing the last 32 KB.`，有日志路径时第二行给出路径（终端里不做复制按钮，用户自己选中复制）。
- 日志被截断 → 一行说明。
- 已结束且没有输出 → `No output.`；没有保存输出尾部 → `No output was saved for this task.`。
- 拉取失败 → 一行原因 · `r retry`，轮询暂停。

完成结果：任务结束后状态行在下次刷新时变化，轮询停止。

### UC-TBG-04 取消运行中的任务

前置条件：选中的任务 `status` 为 `running` 且 `canStop` 为 true。

主流程：按 `c` → 键位行确认 → 按 `y` → 行右侧 `Cancelling…` → 停下后移到 Done。

异常流程：见 §2.2。

完成结果：

- 一次确认只发一个取消请求；`Cancelling…` 期间再按 `c` 无反应，键位行也不列 `c cancel`。
- 被取消的任务不标红，详情状态行 `Cancelled by you · …`。

### UC-TBG-05 提示行运行数

前置条件：会话里有后台任务在跑。

完成结果：提示行末尾 `/bg background · N running`，数字随任务开始和结束变化；没有任务在跑时这一段不存在。

### UC-TBG-06 对话里的后台任务痕迹

完成结果：

- 启动了后台任务的 bash 标签末尾有灰字 `· background`，前台 bash 没有。
- 对话里看不到 `background-task-result` 的内容；被它唤醒的那一轮结尾照常显示 `Background task update`。

### UC-TBG-07 删除翻页提示（T11）

完成结果：

- 往上翻看历史时，输入框上方的位置仍是一条分隔线，不出现任何按键说明。
- `Ctrl+B`、`Ctrl+F`、`Ctrl+Y` 不再翻页（`Ctrl+B` 也不挪作他用，T4）。
- 鼠标滚轮、`Shift+PgUp/PgDn` 照常翻页，`Shift+End` 回到最新，`Shift+Home` 跳到最早。
