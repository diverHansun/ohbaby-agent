# 08 测试与验收

TUI 测试沿用现有约定：组件用 `ink-testing-library` 写 `*.unit.test.tsx`（参照 `components/subagent-browser.unit.test.tsx`），跨组件和整屏行为写 `*.contract.test.tsx`（参照 `fullscreen-panels.contract.test.tsx`、`layout/fullscreen-shell.contract.test.tsx`）。测试数据见 [06 §6](06-data-api-and-state.md#6-测试数据)。

## 1. 验收标准

### UC-TBG-01 打开面板查看任务

- [ ] 会话只有前台记录时，`/bg` 在对话区出一条 info 级通知 `No background tasks in this chat.`，命令返回 completed，面板不打开。
- [ ] 没有打开的会话时，`/bg` 出一条 info 级通知 `Open a chat to see its background tasks.`。
- [ ] `/help` 里能看到 `/bg`。
- [ ] “一般”场景：`/bg` 打开整屏面板，输入框隐藏；标题 `Background tasks · Main agent`；组标题 `Running 2`、`Done 3`；第一行带 `›`。
- [ ] 运行中行的时长每秒变化，左侧文字位置不变；只有失败行显示 `Failed`，lost 行显示灰色 `Unknown`。
- [ ] 列表里没有普通前台命令；清理未确认的前台命令会列出，原后端已退出的那条可按 `u`、`y` 放弃追踪（Windows D14）。
- [ ] 加载失败显示原因和 ` · r retry`；按 `↓` 等其他键后提示仍在；按 `r` 重新加载；已有列表时失败不清空。
- [ ] “大量”场景：选择移到最后一行时自动加载下一页，组标题数量始终是 250。
- [ ] 列表 `Esc` 关闭面板，回到对话；关闭前输入框里的草稿仍在。
- [ ] 面板打开时按 `Ctrl+G`、`Ctrl+C`、`Ctrl+O`、`Shift+Tab` 都不生效。
- [ ] 当前会话变化时面板自动关闭，确认状态被丢弃。

### UC-TBG-02 筛选启动者

- [ ] “一般”场景：键位行没有 `f filter`，按 `f` 无反应。
- [ ] “子代理”场景：按 `f` 依次变成 Subagents、All、Main agent，标题跟着变；Subagents 和 All 下子代理任务行带启动者名字。
- [ ] “只有子代理”场景：打开时标题为 `Background tasks · All`。

### UC-TBG-03 查看详情和输出

- [ ] `Enter` 进入详情：标题、状态行、完整命令（折行）、细线、输出。
- [ ] 运行中每 2 秒刷新输出并显示最后一屏；`↑` 后不再跟随，键位行出现 `End follow`；`End`、`Shift+End`、或用 `↓` 滚到底都会恢复。
- [ ] 不带 `Shift` 的 `PgUp`/`PgDn` 和带 `Shift` 的版本都能翻页（终端拦下时以带 `Shift` 的为准，实测记录）。
- [ ] 一条 heredoc 长命令在 10 行高的终端里只显示前 3 行加 `…`，输出区仍可见。
- [ ] 任务进入终态但 `resultReadyAt` 为空时继续拉取；结果就绪后不再请求输出。
- [ ] `Esc` 回到列表，选中刚才那一行。
- [ ] “特殊”场景：各说明行文案与 Web 03 §5.3 一致；别的后端管理的任务没有 `c cancel`；输出超 32KiB 时显示 `Showing the last 32 KB.` 和 `Log: <path>`。
- [ ] 输出拉取失败显示原因和 ` · r retry`，按 `r` 恢复轮询。
- [ ] 输出里含 ANSI 控制序列时，面板之外的屏幕内容不变。

### UC-TBG-04 取消运行中的任务

- [ ] 选中运行中任务按 `c`：键位行变为 `Cancel Watch tests? y confirm · any key back`。
- [ ] 不按键等 5 秒：键位行恢复，没有发出请求。
- [ ] 确认状态下按 `↓`：只退出确认，选择不移动。
- [ ] `Ctrl+C` 不进入取消确认；确认状态下 `Ctrl+Y` 只退出确认，不发停止请求。
- [ ] 按 `y`：只发出 1 个 `stopShellJob` 请求；行尾显示 `Cancelling…`；键位行不再列 `c cancel`，再按 `c` 无反应。
- [ ] 后端停下后行移到 Done，显示时长、不标红；详情状态行 `Cancelled by you · …`。
- [ ] 取消请求 10 秒没有回应时恢复入口并提示，可重新确认取消；若已观察到停止生效则不误报。
- [ ] 详情接口返回任务不存在时，旧列表行不能遮住不可用提示，也不能保留取消入口。
- [ ] “取消错误”场景：`OTHER_BACKEND` 不提示，刷新后出现说明行；`CLEANUP_BUSY` 显示 `ohbaby is already cleaning up this task.`；网络错误显示原因；下一次按键清除说明。

### UC-TBG-05 提示行运行数

- [ ] 有任务在跑：提示行末尾 `/bg background · 2 running`。
- [ ] 取消一个后变为 `1 running`；全部结束后这一段消失。
- [ ] 客户端不支持子代理时，这一段单独成行。
- [ ] “待审批”场景：主屏提示行整行不显示（运行数一起消失），审批处理完恢复。

### UC-TBG-06 对话里的后台任务痕迹

- [ ] 启动后台任务的 bash 标签末尾有 `· background`；前台 bash 没有；命令长到占满两行时 `· background` 仍可见。
- [ ] `background-task-result` 消息不出现在对话里；被唤醒的那一轮结尾有 `Background task update`。

### UC-TBG-07 删除翻页提示与翻页键（T11）

- [ ] 往上翻看历史时，输入框上方仍是分隔线，没有 `History` 字样。
- [ ] `Ctrl+B`、`Ctrl+F`、`Ctrl+Y` 不再改变滚动位置。
- [ ] 鼠标滚轮、`Shift+PgUp/PgDn` 能翻页，`Shift+End` 回到最新，`Shift+Home` 跳到最早。

### 终端兼容

- [ ] 内容宽 72、60、44（约 80、68、48 列终端）下列表没有折乱的行，尾列完整；60 时命令被截短，44 时不显示命令列。
- [ ] 内容宽小于 40 或终端不足 10 行时只显示 `Terminal too small`；放大后恢复原来的视图和选中行。
- [ ] `NO_COLOR=1` 下失败任务仍能靠 `Failed` 字样分辨。
- [ ] 有待审批时面板顶部显示 `Approval pending · Close this panel to review`。

## 2. 测试分层

| 层 | 工具 | 覆盖 | 不覆盖 |
|---|---|---|---|
| 单元（SDK） | Vitest | 挪进 SDK 的视图函数（原 Web 测试搬家）；`taskRowText` 截断规则 | 渲染 |
| 组件（TUI） | `ink-testing-library` | 列表、详情、键位表、确认超时、提示行文案、宽度降级 | 真实后端 |
| 契约（TUI） | 现有 contract 测试方式 | `/bg` 打开关闭、`/help` 列出、面板替换对话区、全局按键让路、会话变化关闭、草稿保留、翻页键删除、对话过滤与标签 | 视觉细节 |
| Web 回归 | 现有 Web 测试 | 视图函数挪到 SDK 后 Web 行为不变 | — |
| 终端走查 | 真实终端截图 + 模型判断 | 03 §7 口径 | 像素比对 |

真实 daemon 手动走一遍：让 agent 起 `sleep 120 && echo done` 和一个 dev server，`/bg` 查看、取消、确认行移到 Done。

## 3. 关键场景

| 场景 | 来源 | 验证层 |
|---|---|---|
| 只有普通前台命令时 `/bg` 不打开 | Web D12、UC-TBG-01 | 契约 |
| 取消必须 `y` 确认，误按只退出确认 | T6、UC-TBG-04 | 组件 |
| 确认后只发一个请求 | UC-TBG-04 | 组件 |
| 离开详情或任务结束后不再轮询 | 06 §3.2 | 组件 |
| 结果消息不进对话 | UC-TBG-06 | 契约 |
| 翻页键删除后其他翻页方式仍可用 | T11 | 契约 |
| 视图函数挪到 SDK 后 Web 不变 | T10 | Web 回归 |

## 4. 终端走查清单

| 视图 | 场景 | 尺寸 | 检查点 |
|---|---|---|---|
| 列表 | 一般 | 100×30 | 03 §4.2 结构（无筛选字样、无 `f filter`、无启动者）；只有失败是红色字样；尾列右对齐 |
| 列表 | 子代理，筛选 All | 100×30 | 与 03 §4.2 线框一致：启动者位置、标题筛选字样、`f filter` |
| 列表 | 一般 | 48×12 | 不显示命令列，尾列完整 |
| 详情 | 一般，运行中任务 | 100×30 | 03 §4.3 结构；细线；跟随 |
| 详情 | 特殊 | 100×30 | 说明行灰色、不抢眼 |
| 提示行 | 一般 | 100×30 | `/bg background · 2 running` 接在 `Ctrl+G` 段之后 |
| 确认 | 一般 | 100×30 | 提示行 warning 色、文案 |
| 太小 | 任意 | 40×8 | 只有一行 `Terminal too small` |
