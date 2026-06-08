# Reference Research

## 目标

本文件记录 improve-4 前的参考项目调查。结论不是照搬实现，而是提炼行为模型：

- 展示型命令不进入 transcript 历史。
- 弹层有明确焦点、关闭键和生命周期。
- 长列表有自己的滚动状态。
- 流式输出和 terminal scrollback 需要单独建模。

## opencode

参考文件：

- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\ui\dialog.tsx`
- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\ui\dialog-select.tsx`
- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\component\dialog-command.tsx`
- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\component\dialog-status.tsx`
- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\ui\dialog-help.tsx`
- `D:\Projects\Code-cli\opencode\packages\opencode\src\cli\cmd\tui\app.tsx`

观察：

- `DialogProvider` 维护 dialog stack，`dialog.replace()` 用新弹层替换当前弹层。
- 弹层是全屏 overlay：半透明背景、居中 panel、固定 zIndex。
- Esc/Ctrl-C 关闭弹层，关闭后恢复之前焦点。
- `/status`、`/help`、`/models`、`/mcp` 等命令通过 `dialog.replace()` 打开面板，不把内容写入 transcript。
- `DialogSelect` 自带搜索、上下移动、PageUp/PageDown、Home/End，以及选中项滚动到可见区域。
- command registry 把 slash command 的展示、快捷键和执行动作统一注册，prompt autocomplete 从 registry 获取 slash 列表。

对 ohbaby 的启发：

- `/status`、`/help`、`/mcps`、`/models` 应成为 command panel，而不是 command notice 或 transcript message。
- 第一版可以只实现单弹层 `activePanel`，暂不实现完整 stack。
- 需要把“执行命令”和“展示命令 UI”分开：展示型命令打开 panel，动作型命令继续走命令执行链路。
- Ink 没有 opencode 所用 `@opentui/solid` 的 absolute overlay 能力，ohbaby 应模拟同等 UX，而不是复制布局 API。

## kimi-code

参考文件：

- `D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\components\dialogs\help-panel.ts`
- `D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\components\dialogs\model-selector.ts`
- `D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\components\chrome\footer.ts`
- `D:\Projects\Code-cli\kimi-code\apps\kimi-code\src\tui\components\chrome\gutter-container.ts`

观察：

- HelpPanel 是独立 focusable 组件，由宿主挂载到 editor container。
- Esc、Enter、q 关闭；Up/Down/PageUp/PageDown 控制面板内部滚动。
- 面板自己做 `scrollTop` 和可见窗口裁剪，边框始终保持可见。
- footer/status 与 transcript 分离，状态不混入消息流。
- gutter container 显式管理左右留白，避免随内容长度漂移。

对 ohbaby 的启发：

- 面板内部滚动可以先用简单 `scrollTop + slice`，不必第一版就做完整虚拟列表。
- `/help` 这类静态长内容适合先实现 internal scroll。
- PromptDock/footer 仍应独立于 transcript 和 command panel。

## gemini-cli

参考文件：

- `D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\MainContent.tsx`
- `D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\shared\ScrollableList.tsx`
- `D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\shared\VirtualizedList.tsx`
- `D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\hooks\useAlternateBuffer.ts`
- `D:\Projects\Code-cli\gemini-cli\packages\cli\src\ui\components\ToastDisplay.tsx`

观察：

- MainContent 有两条路径：普通模式使用 `<Static>` 输出历史；alternate/terminal buffer 模式使用 `ScrollableList`。
- `VirtualizedList` 维护 `scrollAnchor`、`isStickingToBottom`、item heights、scrollbar 和 static item。
- `ScrollableList` 捕获 scroll keybindings：Up/Down、PageUp/PageDown、Home/End，并把滚动状态集中到一个 ref。
- `overflowToBackbuffer`、`renderStatic`、`stableScrollback` 等设计说明：terminal buffer 管理是单独工程，不应混在普通消息组件内。
- transient toast 与 history 分离，避免状态提示污染 transcript。

对 ohbaby 的启发：

- improve-4 的滚动管理应是独立 `TranscriptBufferViewport` 路径，而不是继续在 `CommittedTranscript` 里补局部 patch。
- 流式输出时默认 stick-to-bottom；用户主动 PageUp/滚轮/上翻后暂停 auto-scroll，直到 End 或新手动操作恢复。
- 可以先设计 feature flag，避免一次替换全部渲染路径。

## claude-code

本地可观察界面和截图更像“slash command 进入可聚焦设置页/状态页”的交互：命令结果不应长期作为普通 assistant 输出存在。由于本地没有等价源码可直接引用，本设计只把它作为 UX 参照，不作为技术实现依据。

## 归纳结论

- improve-3 只清理短生命周期 command notice，避免它污染下一轮输出。
- improve-4 用 OverlayCard 承接展示型 slash command。
- improve-4 用 terminal buffer / virtual scroll 承接“流式输出时仍能自由滚动”的问题。
- 不应把 `/status`、`/help`、`/mcps`、`/models` 输出继续塞进 transcript；那会制造时间线、滚动和清理三类债务。
