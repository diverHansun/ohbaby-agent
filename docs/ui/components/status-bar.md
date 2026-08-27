# Context 占用状态 UI（Web / TUI）

本文记录当前实现，不再使用旧版 `UiContextUsage`、`runtime.context.usedTokens` 或单行 `workingDirectory | model | ...` 草图。占用数据的权威契约是 SDK `UiContextWindowUsage`；Context 架构见 [architecture.md](../../core/context/architecture.md)，improve-6 交互细节见 [02-web-ui.md](../../core/context/improve-6/02-web-ui.md)。

## 一、共享事实

`UiContextWindowUsage` 按 session 保存：

- `currentTokens / contextWindowTokens / contextWindowRatio` 是窗口总占用；
- `composition?` 是七类可选估算，不参与压缩控制；
- 缓存命中率不是占用组成，本轮不显示；
- active session 没有 usage 时不借用其他 session（尤其 child）的数值。

## 二、Web 顶栏

实现：`apps/ohbaby-web/src/ui/App.tsx` 的 `StatusBar` 与同目录 `ContextUsage.tsx`。

```text
[OHBABY]  status  ·  model  ·  (context ring)  ·  optional goal
```

- 无 usage：不渲染空环，只保留 model。
- 有 usage：显示约 14px SVG 占用环；不再并排显示旧细条或 `used / window` 短标签。
- hover/focus：tooltip 显示 `{n}% context used` 与 `~used / window tokens`。
- click/Enter：打开轻量 popover；Escape、点外部或关闭按钮退出。
- popover 始终显示总量；只有 `composition` 存在时才显示堆叠条和七行，禁止把缺失 composition 伪装成七个 0。
- 七行固定为 System prompt、Built-in tools、MCP tools、Skills、Conversation、Summarized conversation、Subagent exchanges；0 值保留文字行但不画色段。
- 环按钮包含百分比与 used/window 的 `aria-label`，使用 `aria-expanded`、`aria-haspopup="dialog"`；详情不只靠颜色表达。

Web `/status` 使用同一个 `ContextUsageDetails`：有 composition 时替换旧 context 粗行，无 composition 时保留旧单行总量。本轮不得出现 Cache 行。

## 三、TUI

实现：

- 常驻 footer：`packages/ohbaby-cli/src/tui/app.tsx` + `render/usage.ts`；
- `/status`：`components/dialog/command-panel-manager.tsx` / `render/status-panel.ts`。

TUI 本轮锁定 total-only：

- 格式为 `38.4K / 1M (4%)`；非零且不足 1% 显示 `<1%`；
- optional composition 到达 SDK/store 后继续忽略，不增加七行或 ASCII 堆叠条；
- 缺 usage 时显示既有 unavailable 状态；
- 本轮不显示 Cache 行。

Web 的 `~` 是对解释性估算的诚实标注；TUI 沿用既有 formatter，不为了表面对齐改文案。

## 四、测试与变更边界

- Web：`ContextUsage.unit.test.tsx`、`App.unit.test.tsx`、`selectors.unit.test.ts`、`slashCommands.unit.test.ts`。
- TUI：`render/usage.unit.test.ts`、`render/status-panel.unit.test.ts`。
- compiled Web 与实际 TUI 进程仍需 smoke；完整发布门见 improve-6 [04-test-and-acceptance.md](../../core/context/improve-6/04-test-and-acceptance.md)。
- 下一轮若实施 cache，只能增加独立的 cache 数据通道与显示行，不得画进占用环/堆叠条。
