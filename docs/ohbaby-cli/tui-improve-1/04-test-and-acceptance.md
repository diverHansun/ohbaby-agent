# 04 — 测试与验收方案

日期: 2026-06-05
更新: 2026-06-06

测试栈：`vitest 2` + `ink-testing-library 4`。命名沿用项目规范：
`*.unit.test.ts` / `*.contract.test.tsx` / `*.integration.test.ts`。

最终测试范围以
[05-a-c-contract-appshell-viewport-plan.md](05-a-c-contract-appshell-viewport-plan.md)
为准。本文件聚焦实施完成后的验证与验收。

## 1. 单元测试

### SDK / agent contract

- `UiContextWindowUsage` 类型导出与 snapshot normalize。
- `contextWindowRatio = currentTokens / contextWindowTokens`。
- 使用模型完整 context window 作为分母，不使用 input budget ratio。
- unknown model/window 返回 `null` 或不输出 usage。
- message lifecycle 字段兼容旧消息。

### render/usage

- `38400 / 1000000` 输出 `38.4K / 1M (4%)`。
- `0 < ratio < 1%` 输出 `<1%`。
- 缺失或非法 `contextWindowTokens` 输出空字符串。
- 不输出费用。

### render/wrap / markdown / highlight

- `visibleWidth` 忽略 ANSI 转义、正确处理 CJK 宽字符。
- `wrapAnsi` 不切断 ANSI 序列。
- markdown 标题、列表、引用、链接、代码块能按 `contentWidth` 折行。
- unknown language 代码块回退普通文本。
- ANSI 行满足 `visibleWidth(line) <= partWidth`。
- ANSI 字符串进入 Ink `Text` 后不会被二次折行破坏序列。

### tool renderers

- running/pending 左侧显示 spinner。
- completed 不保留图标，只显示工具名与主参摘要，但保留 leading slot 宽度。
- failed 不使用失败 icon，追加短错误摘要。
- 不泄漏输出 body、diff、完整 JSON 参数。
- `extractPrimaryArg(call)` 或等价 helper 覆盖 read/write/edit/bash/grep/glob/todo/default。

### editor reducer

- 光标、Home/End、Backspace、Ctrl+U、多行输入。
- Shift+Enter 插入换行；Enter 提交。
- 批量粘贴一次性进入。
- 历史浏览不丢未发送草稿。

### reasoning

- streaming message 默认展开 reasoning。
- completed/error message 自动折叠为 `Thought`。
- legacy message 无 lifecycle 字段时按 completed 处理。
- 不使用 runtime `running/idle` 判断折叠。

## 2. 组件契约测试

### AppShell / layout

- 宽屏和窄屏共用同一 `contentWidth` 口径。
- prompt dock、message flow、slash completion、status panel 同步缩放。
- 空会话显示 OHBABY ASCII/ANSI logo，不显示 tip，不显示模型。
- `AppShell` 是唯一读取 `useStdout().stdout.columns` 的布局入口。
- `markdown-part.tsx` 通过 layout context 获取 `partWidth`，不自行猜测终端宽度。

### message-block

- 用户历史消息有左竖线，无背景块。
- assistant 消息直接 markdown。
- 输出中不得出现 `you` / `ohbaby` / `assistant` / `tool` 角色文字头。
- reasoning 折叠/展开由 message lifecycle 决定。
- tool line 不出现成功/失败 icon。

### PromptDock

- 当前输入有背景块。
- prompt 符号只使用 `>`。
- mode 只显示 `auto` 或 `plan`，不得出现 `ask` / `build`。
- 不显示模型。
- 无 context window usage 时右侧留空。

### status-bar

- 只显示 active session 的 context window usage。
- session 切换不能显示其他 session 的旧 usage。
- 目标 session 有自己的缓存时可先显示自己的旧值。
- 目标 session 无缓存时留空。

### StatusPanel

- `/status` 渲染为轻边框多行 panel。
- 读取 `contextWindow` 字段。
- context 缺失时显示 `Context unavailable`。
- 不显示费用、severity、progress bar。

## 3. 集成测试

- `run.context.prepared` 能映射并 publish `context.window.updated`。
- `getContextWindowUsage({ sessionId })` 只接收 `sessionId`，成功返回当前 session usage。
- real-session mapping gate：真实 session 中
  `ContextUsage -> UiContextWindowUsage` 映射口径正确，分母为完整 context window。
- query 不 publish；TUI 成功后本地 dispatch。
- refresh 失败时当前 session 旧缓存保留，并发 warning notice。
- `/status` command data 包含 `contextWindow`，旧 `context` alias 可兼容一版。
- app 现有不变量保持：快照拉取、catalog 刷新、`app.exit`、`Shift+Tab`、`Ctrl+C`。

## 4. 真实 API E2E

使用根目录 `.env` 中的真实 API key，沿用项目现有真实 smoke 机制。

必须覆盖：

| # | 场景 | 期望 |
|---|---|---|
| 1 | 空会话启动 | OHBABY ANSI logo + PromptDock，无 tip、无模型 |
| 2 | 发送中文消息 | 历史用户消息左竖线，无 `you` 字样，CJK 不错位 |
| 3 | AI 返回 markdown | 标题/列表/加粗/代码块正确渲染 |
| 4 | reasoning | 运行中灰色展开，完成后折叠为 `Thought` |
| 5 | 工具调用 | 运行中 spinner，完成后只留工具名与摘要 |
| 6 | status bar | 右侧显示当前 session `38.4K / 1M (4%)` 同类格式 |
| 7 | `/status` | 轻边框 panel，包含 context window 行 |
| 8 | session 切换 | 不显示其他 session 的旧 usage |
| 9 | 多行输入 | Shift+Enter 换行，Enter 提交 |
| 10 | slash 命令 `/` | 补全列表正常，选择和提交不回退 |
| 11 | 权限弹窗 | dialog 主题统一，可选择 |
| 12 | 窄/宽终端 resize | 整体同步缩放，不溢出 |

任何项失败都回到对应模块修复并补测。

## 5. 子代理测试审核

实施完成后，使用子代理做独立审核：

1. 跑 unit、contract、integration、真实 API e2e。
2. 对照 05 文档检查 SDK/agent/CLI 字段语义一致性。
3. 检查 TUI 是否存在本地 token 估算、费用展示、成功/失败 icon、`ask/build`、
   `you/ohbaby` 等违背决策的残留。
4. 检查 viewport/contentWidth 是否统一，窄屏是否同步缩放。
5. 输出问题清单，修复后回归。

## 6. Definition of Done

- 05 文档第 2 节“做”全部完成。
- unit、contract、integration 测试通过。
- 真实 API e2e 通过，或失败原因已明确并经维护者接受。
- 子代理审查通过或问题已修复。
- TUI 不自行实现 token 估算。
- 新增组件不写硬编码颜色，全部走 theme token。
- 不显示费用、草稿 token、模型常驻 header/status、tip 行。
- 不出现被禁的角色头、`ask/build`、成功/失败 icon。
