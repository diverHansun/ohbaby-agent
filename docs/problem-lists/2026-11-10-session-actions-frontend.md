# 会话操作前端设计：side chat、fork、撤销重发

2026-11-10 · 三个议题的后端已合入 main（`ebb56858`），本文写前端的界面和交互。

## 本文的位置

- **实现契约仍是各议题 02 的 Stage 2（Web）和 Stage 3（TUI）**，验收依据是各议题的 04：[side chat](2026-11-04-side-chat/improve-1/02-optimization-plan-and-change-scope.md)、[fork](2026-11-04-session-fork/improve-1/02-optimization-plan-and-change-scope.md)、[撤销重发](2026-11-04-conversation-undo/improve-1/02-optimization-plan-and-change-scope.md)。
- **本文补的是视觉、文案和交互细节。** 02 已经写到的接口、数据流和状态处理，这里不重复。两边对不上时，行为以 02 为准，样式和文案以本文为准。本文有两处改了 02 的写法，见第八节，已经同步到 02。
- **决定来源**：各议题 00 第 6 节 2026-11-10 的记录，以及用户给的 Claude app、Codex app、Cursor 截图。参考实现来自 `code-cli/` 下的 ZCode、deepseek-harness（下称 dsh）、kimi-code 和 codex。

## 一、设计原则

对标 OpenAI、Anthropic、Tesla、Apple 的克制路线：**界面让位给内容**。不新增颜色和阴影，只用现有的 `W/ui/styles/tokens.css`。

| 原则 | 做法 | 对应的 token |
|---|---|---|
| 一种强调色 | 强调色只给“发送”这类主操作，其余按钮一律是灰色的 ghost 按钮 | `--accent`、`--text-muted`、`--text-dim` |
| 靠底色和细线分层，少用阴影 | 阴影只留给浮层，比如选中文字后出现的按钮 | `--border`、`--border-strong`、`--shadow-menu` |
| 焦点清楚 | 获得焦点时加一圈很淡的光晕 | `--border-focus`、`--ring-soft` |
| 留白给内容 | 操作按钮平时藏起来，悬停才出现。空状态只写一句话，不放插图 | — |
| 动效快而轻 | 只做淡入，加不超过 4px 的位移，时长 120 到 200ms。`prefers-reduced-motion` 下去掉位移 | `--duration-fast`、`--duration`、`--ease` |
| 沿用现有尺寸 | 圆角、按钮尺寸、图标大小都和现有组件一致，不另起一套 | `--radius-*` |

## 二、共用部件

### 2.1 消息操作栏 `MessageActions`

已经落地。fork 按钮和 Edit 按钮都挂在这里，规则沿用现状：

- 按钮是 28px 见方的 ghost 按钮，图标 14px，和复制按钮一致；按钮间距 2px。
- 最新一条回答下的操作栏常驻。更早的回答，鼠标悬停或按钮获得焦点时才淡入。触屏上一直显示。
- 提示沿用 `IconButton` 现有的原生 `title`。需要说明的按钮，在标题和说明之间加一个换行，浏览器会显示成两行。

| 按钮 | 位置 | 图标（lucide） | 提示 |
|---|---|---|---|
| Copy | 用户消息、AI 回答 | 已有 | 已有 |
| Fork | AI 回答，紧挨 Copy | `Split`，最接近 Claude 截图里的分叉箭头 | `Fork from here` + 换行 + `Starts a new session from this point. This one stays as it is.` |
| Edit | 用户消息，紧挨 Copy。steer 消息和没有对应 prompt 的消息不显示 | `Pencil` | `Edit` |

side chat 面板（`variant: "side-chat"`）和子代理对话里只有 Copy。

### 2.2 右侧面板标签

side chat 标签沿用现有的 `.ohb-side-panel-tab`，和 Subagents、Files、终端标签同排，样式一致。标签上依次是图标、标题和 ×。等审批时，标题右侧显示一个 6px 的 `--warning` 圆点，悬停显示“Waiting for approval”。

## 三、side chat

### 3.1 Web

```
┌ 顶栏 ───────────────────────────────── [上下文用量] [▯] ┬─────────────────────────────────────┐
│                                                         │ [Terminal 1] [◌ Side chat 1 ×] [+]  │
│  …                                                      │─────────────────────────────────────│
│  选中文字 ──► ┌──────────────────┐                      │                                     │
│               │ Ask in side chat │                      │           No messages yet           │
│               └──────────────────┘                      │    Sees this chat up to now.        │
│                                                         │    The main chat won't see it.      │
│                                                         │                                     │
│ ┌ 主输入框 ──────────────────────────────────────────┐  │ ┌ Ask a quick question       ⏎ ─┐   │
└─────────────────────────────────────────────────────────┴─────────────────────────────────────┘
```

- **放在哪**：右侧面板里一个 side chat 一个标签，标题是“Side chat N”。Claude 和 Codex 都这么做，ZCode 也是右侧标签。
- **图标**：lucide 的 `MessageCircleQuestion`。Claude 用的是对话气泡加放大镜，lucide 0.468 里没有这个图标，就选了意思最接近的这个。入口页、“Add page”菜单和标签都用这个图标。
- **入口**：
  - **快捷键 `⌘;`**（Windows 和 Linux 上是 `Ctrl+;`）。顶栏不放 side chat 按钮（2026-11-11 用户走查后确认去掉：它紧挨上下文用量，没有必要）。
  - **右侧面板入口页**：加一张卡片，标题“Side chat”，说明“Ask about this chat without changing it”，和现有的 Subagents、Files、Terminal 并列，跟 Codex 的 Tools 页一样。
  - **标签排末尾的 +**：它打开的是现有的“Add page”菜单，菜单里加一项“Side chat”。
  - **选中主对话里的文字后出现的悬浮按钮**。
- **入口不可用时**：主会话还没开始过，入口全部变灰，悬停显示“Send a message first”。
- **选中文字后的悬浮按钮**：只有“Ask in side chat”一项。白底，细边框，阴影用 `--shadow-menu`，圆角 8px，出现在选区上方 8px 处，120ms 淡入。ZCode 的浮条有两项，我们只要这一项（00 已定）。点击后的行为照 02 的 Stage 2 第 5 步。
- **面板内容**：
  - side chat 自己不做“放大”和“弹出成独立窗口”（2026-11-10 用户确认）。右侧面板现有的“Expand side panel”按钮保留不动。
  - 面板和主对话一样是白底，消息、气泡、代码块的样式完全沿用主对话，不为 side chat 单独改色。和主对话的区分靠两样：标签的标题；空状态里那句“The main chat won't see it”。
  - 空状态：居中一行“No messages yet”（`--text-muted`），下面一行小字“Sees this chat up to now. The main chat won't see it.”（`--text-dim`）。
  - 输入框：占位文字“Ask a quick question”，只有发送和停止两个按钮。没有模型、权限、goal 控件，也没有斜杠命令。
  - 审批：在面板里弹出，样式和主对话的审批面板一样。
- **关闭**：点 × 直接关闭并删除，不弹确认。

### 3.2 TUI `/btw`

参照 codex：面板替换主视图。kimi-code 是把面板叠在主视图上，在小终端里会挤掉对话记录，所以不采用。

```
 Side chat · Esc to close                    Main session needs approval · Esc to return
 ───────────────────────────────────────────────────────────────────────────
  （只显示边界之后的消息）
 ───────────────────────────────────────────────────────────────────────────
 › （现有输入框）
```

- 标题栏左边写“Side chat · Esc to close”，用主题的 `status.accent` 加粗。side chat 正在回答时改成“Side chat · Esc to stop”：这时输入框为空按 Esc 或按 Ctrl+C 是停止这一轮，停下后再按 Esc 才关闭。只有主会话在等审批时，右边才显示“Main session needs approval · Esc to return”，用 `status.warning`。
- 输入框复用现有的 `Prompt`，不开命令面板。
- 输入框为空时按 Esc，关闭并删除这个 side chat。
- 不可用时，按 02 的 Stage 3 给出对应的提示文字，有两种情况：主会话还没开始过；TUI 连着远程 daemon。

## 四、fork

### 4.1 Web

- **回答下的按钮**：见 2.1。点击后不弹确认，直接切到新会话。dsh、ZCode、Claude 都不弹确认。kimi-code 会弹，但 fork 不改原会话，确认框只会多打扰用户一次。
- **会话行菜单**：在 `SessionMenu` 里加“Fork”，图标也用 `Split`，不置灰。点击时不带 `runId`，从最近一轮有回答的地方 fork。
- **反馈**：成功后切到新会话，标题是“原标题 (n)”，不另外弹提示。侧栏不做改动（fork 02 Stage 2 第 4 步）。失败时用现有的通知条提示，文案见第七节。
- **请求进行中**：按钮显示加载状态，不能重复点。

### 4.2 TUI `/fork`

切到新会话，在状态行提示“Forked to <标题>”，失败时提示第七节的文案。kimi-code 的 `/fork` 不切过去，我们按 00 P10 切过去。

## 五、撤销重发

### 5.1 Web

```
                                   ┌──────────────────────────────────────┐
                                   │ 改过的文字……                          │  ← 气泡原地变成编辑框
                                   │                                      │
                                   │ File changes won't be undone ·       │  ← 小字灰字，随状态变化
                                   │ 2 later turns will be removed        │
                                   │                     [Cancel] [Send]  │
                                   └──────────────────────────────────────┘
```

- **入口**：用户消息悬停时，在 Copy 旁边出现 Edit 按钮（见 2.1），和 ZCode 一样。只有会话正在压缩时变灰，提示“Compacting…”。
- **编辑框**：
  - 原地替换气泡，靠右对齐，右边缘不动。宽度变成用户气泡的最大宽度（76%），留出输入空间。
  - 白底，1px 的 `--border-strong` 边框，圆角沿用气泡的 18px，获得焦点时加 `--ring-soft` 光晕。高度随内容增长，最多 12 行，超过就在框内滚动。
  - 进入编辑状态时，从气泡的灰底渐变到白底加边框，120ms。
- **按钮**：只有两个，Cancel 和 Send（2026-11-10 用户确认），靠右排列。
  - Cancel 是 ghost 按钮。
  - Send 用 `--accent` 实心的药丸形按钮。文字为空时变灰；请求进行中显示加载状态，包括后端等待当前任务停下来的那几秒。
  - Enter 发送，Shift+Enter 换行，Esc 等同 Cancel。
  - ZCode 还有第三个按钮“对话 + 文件重置”，我们没有恢复文件的功能，所以不要。
- **提示行**：写在编辑框里、按钮的上方，用“ · ”连接，随会话状态实时更新。点 Send 就算确认，不另外弹确认框。界面上一律是英文，02 的 Stage 2 第 3 步列的是中文意思，按下表翻译：

  | 什么时候显示 | 文案 |
  |---|---|
  | 一直显示 | File changes won't be undone |
  | 这条消息之后还有 N 轮（不含这一轮） | N later turns will be removed（N 为 1 时用 turn） |
  | 会话有 goal | Goal turns already used won't be refunded |
  | 会话正在运行 | The current task will stop first |
  | 有 N 条排队的消息 | N queued messages will be removed（N 为 1 时用 message） |
  | goal 处于运行中 | The goal will pause |

- **结果**：
  - 成功后退出编辑状态，新一轮照常出现。
  - 带 `sendError` 时，退出编辑状态，把改过的文字放进主输入框，并用通知条提示原因。主输入框为空时直接填入；已有草稿时接在草稿后面，中间空一行，不覆盖草稿。
  - 失败时保留编辑状态和改过的文字，在提示行的位置显示红字（`--danger-ink`），文案见第七节。
- **限制**：同一时间只能有一个气泡处于编辑状态。

### 5.2 TUI `/rewind`

参照 kimi-code 的 `/undo` 选择列表，排序按 02，最新的在最上面：

```
 Rewind to…                                   ↑↓ navigate · Enter select · Esc cancel
 ───────────────────────────────────────────────────────────────────────────
   最新的一条提问                                                      21:10
 › 再来试一下运行                                                      21:04
   来运行一个命令                                                      20:58
 ───────────────────────────────────────────────────────────────────────────
```

- 每行显示原文第一行和时间。
- 光标所在的行和它上方的行（更新的轮次）会被撤销，这些行用 `text.dim` 变暗。kimi-code 的列表是旧的在上，所以它变暗的是下方的行，我们方向相反。
- 选中后，底部显示一行确认文字。N 是会被撤销的轮数，**包含选中的这一轮**，和 Web 提示行里不含这一轮的“later turns”不同：

  `Rewind N turns. File changes won't be undone. Enter to confirm, Esc to cancel.`

  会话有 goal 时，在第二句后面插入“Goal turns already used won't be refunded.”。会话在运行、有排队或 goal 在跑时，按 5.1 的表追加对应的句子。N 为 1 时用 turn。
- 成功后把原文放回输入框。输入框里已有内容时，确认文字的最后加一句“Your draft will be replaced.”，按 Enter 就算同意替换，不另外弹一次确认。
- 确认期间列表变了（比如排队的提问开始运行，顶部多出一行），撤销的目标仍是用户选中的那条提问，N 按新的列表重新算。
- 审批或提问对话框弹出时，列表不响应按键，对话框处理完再继续。

## 六、实施分批

| 批次 | 分支 | 顺序 | 验收 |
|---|---|---|---|
| Web | `codex/session-actions-web` | side chat → fork → 撤销，每个议题单独提交 | 每完成一个议题，验收会话用内置浏览器按该议题 04 的 Web 场景走查，再对照本文核对样式和文案，结果追加到该议题的 05 |
| TUI | `codex/session-actions-tui` | 同样的顺序 | 手工走查各议题 04 的 TUI 场景 |

分支名沿用三个后端分支的 `codex/` 前缀。两批都通过后，用户做端到端验收，合入 main 并推送。先做 side chat，是因为它给 `ConversationStream` 加的 `variant` 开关，后面的 fork 和 Edit 按钮都要遵守。

## 七、错误文案

Web 的通知条、编辑框里的红字和 TUI 的状态行，都用同一套英文文案。表里没有列出的错误码，显示“Something went wrong:”加上后端返回的说明。

| 错误码 | fork | 撤销重发 |
|---|---|---|
| `FORK_TARGET_INVALID` | Nothing to fork yet | — |
| `REWIND_TARGET_INVALID` | — | This message can no longer be edited |
| `REWIND_BEFORE_COMPACTION` | — | This message was compacted and can't be edited |
| `SESSION_RUNNING` | — | The session is busy, try again in a moment |
| `SESSION_ARCHIVED` | Archived sessions can't be forked | Archived sessions can't be edited |
| `SESSION_MOVED` | This chat moved to another folder. Open it there to fork | This chat moved to another folder. Open it there to edit |
| `SESSION_NOT_FOUND` | This chat no longer exists | This chat no longer exists |

`SIDE_CHAT_UNSUPPORTED` 和 `SESSION_NOT_ROOT` 在界面上碰不到：side chat 和子代理对话里没有 fork 和 Edit 按钮。万一出现，按“表里没有的错误码”处理。side chat 打开失败的提示照 side chat 02，不在此表。

## 八、已同步到 02 的两处

1. **side chat 的入口**：02 写的是“主界面顶栏菜单加 Side chat”。现有顶栏没有菜单，顶栏也不另放按钮，入口改为：快捷键、右侧面板入口页、“Add page”菜单里的一项、选中文字。
2. **撤销提示行的文案**：02 Stage 2 第 3 步和 Stage 3 第 3 步写的是中文意思，界面上用第五节的英文文案。

## 九、走查清单（补充 04）

- 只用键盘就能走完三条主流程：打开 side chat 并提问；fork 一条回答；编辑一条消息并发送。焦点光晕清晰可见。
- 开启 `prefers-reduced-motion` 后，界面没有位移动画。
- 窗口宽度 1024px、右侧面板开着时，编辑框和操作栏都不溢出。
- 三个按钮的提示，以及第五、七节的文案，和本文一致，界面上没有中文硬编码。
- tokens 目前只有浅色主题，暗色不在本轮范围。
