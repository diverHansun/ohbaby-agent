# 03 布局与视觉（简写）

视觉沿用现有 TUI：`useTheme()` 的语义色、`dimColor` 表达次要信息、选中行用 `›` 加强调色（和子代理浏览器一致）。本文档只补原则、终端线框、文案和宽度规则。

## 1. 设计原则

| 原则 | 截图上看什么 | 反例 |
|---|---|---|
| 安静：任务是给 agent 用的 | 列表里只有失败和超时用红色字样，其余是默认色和灰色；没有色块、徽标 | 每行一个彩色状态标签 `[RUNNING]` |
| 状态不只靠颜色 | 失败行有 `Failed` 字样；NO_COLOR 下仍能分清 | 只把失败行的标题染红 |
| 一行一件事 | 每个任务一行，字段从左到右固定顺序，超宽从说明处截断 | 一个任务折成三行、字段位置不固定 |
| 键位就地可见 | 底部键位行只列当前视图能用的键 | 列出全部键位，或者把键位写进标题 |
| 操作反馈留在面板里 | 取消失败等说明出现在面板内，按任意键清除 | 用对话区的错误横幅报取消失败 |

## 2. 视觉方向与来源

- 结构照 ohbaby 子代理浏览器（整屏、列表/详情、`›` 选中、灰色键位行）。
- 操作反馈和“往上滚就冻结”学 pi-background-tasks；取消确认和 `Terminal too small` 学 kimi-code。
- 不学 pi-background-tasks 的圆角外框、浅蓝底标题和写死的颜色：ohbaby 现有面板都不加框，颜色走主题。

标志性特征（走查时逐条核对）：

1. 没有外框，标题行加粗，下面直接是内容。
2. 选中行行首 `›`，整行强调色；其余行行首两个空格。
3. 时长右对齐，等宽数字，走动时不挤动左边的文字。
4. 底部一行灰色键位行，随视图变化。
5. 详情页的命令和输出之间是一条灰色细线。

## 3. 颜色

只用主题里已有的语义：

| 用途 | 用法 |
|---|---|
| 标题 | `bold` |
| 选中行 | 主题强调色（和子代理浏览器的 `cyan` 一致，实现时取主题值） |
| 命令、组标题、时长、说明、提示行、键位行 | `dimColor` |
| 失败、超时字样，错误说明 | 主题的 error 色 |
| 取消确认那一行 | 主题的 warning 色 |

不新增颜色。NO_COLOR 或 `FORCE_COLOR=0` 时 Ink 不输出颜色，状态靠文字区分（原则 2）。

## 4. 线框

以下按内容宽（`contentWidth`，终端列数减去左右留白）72 列画，约等于 80 列终端。本文档所有宽度都指内容宽。

### 4.1 对话区顶部提示行

```
Ctrl+G subagents · 5 executions · /bg background · 2 running
```

没有任务在跑时只剩 `Ctrl+G subagents · 5 executions`。客户端不支持子代理时只显示 `/bg background · 2 running`。

### 4.2 列表

下图是子代理也有任务、筛选为 All 时的样子；只有主代理任务时标题没有筛选字样，键位行没有 `f filter`，行尾也没有启动者。

```
Background tasks · All                                          ← 标题，加粗；筛选只在子代理有任务时显示
Running 2                                                        ← 组标题，灰色
› Dev server  pnpm --filter ohbaby-web exec vite…           2h  ← 选中：› + 强调色
  Lint changed files  pnpm eslint apps/…  code-reviewer     2m  ← 筛选为 Subagents/All 时带启动者
Done 3
  Unit tests  pnpm test --run                               5m
  Build  pnpm build                                     Failed  ← 只有失败/超时是红色字样
  Type check  pnpm tsc --noEmit --watch                     2m
↑/↓ select · Enter open · c cancel · f filter · Esc close        ← 键位行，灰色
```

- 每行：`›` 或两个空格、说明（默认色）、两个空格、命令（灰色）、启动者（灰色，按需）、右对齐的尾列。
- 尾列固定 11 列宽，按最长的 `Cancelling…` 算，时长、`Failed`、`Timed out`、`Unknown`、`Unconfirmed`（Windows D14）都在这一列里右对齐。尾列定宽，时长走动时左边的文字才不会移动。
- 宽度不够时依次截断：先截命令，再截说明（末尾 `…`）；尾列永远完整。命令列的显示规则见 §5。
- `Cancelling…` 显示在行尾时长的位置（灰色），替代时长。
- 键位行按 04 §1.3 只列当前能用的键。
- 列表超过可用高度时随选中行滚动，第一屏之外的行不渲染。

### 4.3 详情

```
Dev server                                    Running · 2h 0m 40s   ← 标题加粗；状态行右对齐，灰色
pnpm --filter ohbaby-web exec vite --port 5173                       ← 完整命令，灰色，折行
Started by code-reviewer                                             ← 只在子代理启动时
Started from another ohbaby window. Cancel it there.                 ← 说明行，0–2 行，灰色
──────────────────────────────────────────────────────────────────  ← 灰色细线
  VITE v5.4.21  ready in 312 ms
  ➜  Local:   http://localhost:5173/
  …（输出尾部，折行，占满剩余高度）
↑/↓ scroll · End follow · c cancel · Esc back                        ← 键位行
```

- 失败、超时时状态行用 error 色。
- 头部有上限：命令最多 3 行，超出时第 3 行末尾 `…`（完整命令可在 Log 或任务说明里找到）；说明行最多 2 行。这样 10 行高的终端也能留出输出区。
- 输出超过 32KiB：细线下第一行灰字 `Showing the last 32 KB.`，有日志路径时第二行 `Log: <path>`。
- 跟随中时键位行不显示 `End follow`。

### 4.4 取消确认（替换键位行）

```
Cancel Dev server? y confirm · any key back                          ← warning 色
```

### 4.5 太小

```
Terminal too small
```

## 5. 宽度、高度与终端兼容

| 情况 | 行为 |
|---|---|
| 内容宽 ≥ 60 | 按 4.2 显示，命令按剩余宽度截短 |
| 40–59 | 不显示命令列，只留说明、启动者（按需）和尾列 |
| < 40 或终端行数 < 10 | 只显示 4.5，键位只响应 `Esc` |
| 高度 | 标题、键位行、详情的头部固定；列表和输出占剩余高度 |
| 宽字符 | 用现有 `visibleWidth` / `wrapAnsi` 计算，中日韩字符按两列算 |
| 输出里的 ANSI 序列 | 复用子代理浏览器的清洗和折行，不能把终端控制序列原样输出 |
| 按键 | 方向键、Enter、Esc、普通字母在各终端都能收到；`End`、`PgUp`、`PgDn` 不带 `Shift` 时有的终端会自己拦下，所以同时接受带 `Shift` 的版本，并保证只用方向键也能完成所有操作（04 §1.1） |

## 6. 内容与文案

术语见 01 §1.4。状态行、说明行、时长、空态与错误文案**全部复用 Web**（Web 03 §5.2–§5.4），由共用视图函数生成（T10）。终端特有的文案：

| 场景 | 文案 |
|---|---|
| 提示行一段 | `/bg background · N running` |
| 没有会话时 `/bg`（info 级本地通知） | `Open a chat to see its background tasks.` |
| 没有后台任务时 `/bg`（info 级本地通知） | `No background tasks in this chat.` |
| 子代理启动的任务（详情） | `Started by <启动者名>` |
| 取消确认 | `Cancel <说明>? y confirm · any key back` |
| 日志路径 | `Log: <path>` |
| 审批等待 | `Approval pending · Close this panel to review` |
| 太小 | `Terminal too small` |
| 重试提示 | 错误说明后接 ` · r retry` |

## 7. 视觉验收口径

硬指标：

- 失败和超时有文字，不只靠颜色；设 `NO_COLOR=1` 截图仍能分辨。
- 时长使用等宽对齐，每秒变化时左侧文字不移动。
- 内容宽 72、60、44 三种宽度下没有折乱的行，尾列完整；44 时不显示命令列。
- 输出里的 ANSI 控制序列不会改变面板外的屏幕内容。

方向性判断（终端截图 + 模型判断）：

- 对照 §4 线框：标题、分组、键位行位置一致。
- 对照 §1 原则观察点和 §2 五个标志性特征。
- 文案符合 §6 和 Web 03 §5。

## 8. 实现约束摘要

| 必须遵守 | 初值可调 | 自由发挥 |
|---|---|---|
| 整屏面板结构；只用 `/bg` 入口；名字 Background tasks；取消需 `y` 确认；只用主题语义色；失败要有文字；文案与 Web 共用；尾列定宽；只用方向键也能完成全部操作 | 命令列显示阈值（初值内容宽 60）、最小尺寸（初值内容宽 40 × 终端 10 行）、命令最多 3 行、列表一屏行数 | 键位行的排列顺序、强调色的具体取值 |

冲突时：本节“必须遵守”和用户明确要求 > Web D1–D12 > 参考项目 > 实现者判断。
