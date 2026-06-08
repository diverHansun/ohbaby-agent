# TUI Improve 4

状态：设计草案，等待审核后进入新临时分支实施。

Improve-4 关注两个 improve-3 刻意不展开的方向：

1. 展示型 slash command 卡片化：`/status`、`/help`、`/mcps`、`/models` 不再把结果直接打印到 transcript，而是打开居中的 OverlayCard，按 Esc 关闭。
2. terminal buffer / virtual scroll 级别的滚动管理：流式输出期间允许用户稳定查看历史，不因每个输出帧强制跳回底部或破坏终端滚动体验。

本阶段文档只做设计对齐，不修改源码。建议后续分支名：

```text
codex/tui-improve-4-overlay-viewport
```

## 文档

- `01-reference-research.md`：opencode、kimi-code、gemini-cli 的参考调查。
- `02-design.md`：OverlayCard 与滚动管理设计。
- `03-tests-and-acceptance.md`：测试、E2E 和人工验收。
- `04-implementation-plan.md`：实施草案，审核后再执行。
