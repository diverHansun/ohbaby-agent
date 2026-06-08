# Implementation Plan Draft

本文件是 improve-4 草案。只有在用户审核通过并新建临时分支后执行。

## Step 1: 分支与基线

- 从 improve-3 收尾后的分支创建：

```powershell
git switch -c codex/tui-improve-4-overlay-viewport
```

- 跑基线测试并记录：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

## Step 2: Command panel 状态

文件落点建议：

- `packages/ohbaby-cli/src/tui/store/panels.ts`
- `packages/ohbaby-cli/src/tui/store/events.ts`
- `packages/ohbaby-cli/src/tui/store/selectors/panels.ts`

任务：

- 增加 `CommandPanelState`。
- 增加 open/close panel actions。
- session 切换时关闭 panel。
- 保持 PromptDock 输入状态不被 panel state 污染。

## Step 3: OverlayCard 与 Panel 组件

文件落点建议：

- `packages/ohbaby-cli/src/tui/components/dialog/overlay-card.tsx`
- `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx`
- `packages/ohbaby-cli/src/tui/components/dialog/status-panel.tsx`
- `packages/ohbaby-cli/src/tui/components/dialog/help-panel.tsx`
- `packages/ohbaby-cli/src/tui/components/dialog/mcps-panel.tsx`
- `packages/ohbaby-cli/src/tui/components/dialog/models-panel.tsx`

任务：

- 实现轻边框居中卡片。
- Esc 关闭。
- 长内容内部滚动。
- 标题右侧显示 `esc`。
- 不写 transcript。

## Step 4: Slash command 路由

文件落点建议：

- `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- `packages/ohbaby-cli/src/tui/commands/` 或现有 command helper

任务：

- 识别 `/status`、`/help`、`/mcps`、`/models`。
- 打开对应 panel。
- 不调用后端 print output 路径。
- 保留动作型命令现状。

## Step 5: Terminal buffer viewport

文件落点建议：

- `packages/ohbaby-cli/src/tui/components/transcript/transcript-buffer-viewport.tsx`
- `packages/ohbaby-cli/src/tui/components/transcript/scroll-state.ts`
- `packages/ohbaby-cli/src/tui/store/selectors/transcript.ts`

任务：

- 在 feature flag 下启用 `TranscriptBufferViewport`。
- 实现 scroll state：`scrollTop`、`stickToBottom`、`viewportHeight`、`contentHeight`。
- 捕获 PageUp/PageDown/Home/End。
- streaming delta 到来时尊重 `stickToBottom`。
- session 切换和 `/new` 重置 scroll state。

## Step 6: 验证与子代理审查

命令：

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm lint
```

人工验收：

- PowerShell terminal：OverlayCard、Esc 关闭、streaming 上翻不跳底。
- VS Code terminal：同样场景。

子代理审查：

- OverlayCard 是否真正脱离 transcript。
- terminal buffer viewport 是否有回退路径。
- display/action command 边界是否清楚。
- PowerShell 闪烁和滚动风险是否降低。
