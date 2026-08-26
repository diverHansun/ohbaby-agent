# 1c. TUI 现状：状态栏粗占用与 `/status` 面板

> 时间口径：2026-08-26。诊断 TUI 占用展示。00 已确认：TUI 不用环、不用 hover/click。

## 1.1 问题陈述

1. Prompt 底栏显示 `38K / 1M (4%)`，信息密度低但稳定、适合常驻区域。
2. `/status` 已有 ASCII 框，Context 仍是同一套总量格式；本轮已确认不扩展七类。
3. 没有 cache 行。

## 1.2 已确认分界（引用 00）

TUI 状态栏与 `/status` 本轮都保留总占用文本，不增加七类、ASCII 条、环或 hover/click。Cache 行下一轮可独立加入 `/status`（设计见 00 §2.4），不依赖七类 TUI 先落地。

## 1.3 现状

### architecture

- 活动 session 占用：`packages/ohbaby-cli/src/tui/app.tsx` L120–122 `formatContextWindowUsage(activeContextWindowUsage)`，经 `Prompt` 的 `contextWindowUsage` 传入（L673）。
- 格式化：`tui/render/usage.ts` `formatContextWindowUsage` L3–16 → `{amount} / {amount} ({percent})`。
- `/status`：`tui/render/status-panel.ts` `renderStatusPanel` L16–48，Context 行 L36 调 `formatContextWindow` L54–58，与底栏同一 formatter。
- 命令面板也会格式化占用：`tui/components/dialog/command-panel-manager.tsx` ~L567。

`docs/ui/components/status-bar.md` 写的段布局（目录 | 模型 | Agent 模式 | 1.2k (10%)）与现 Ink Prompt 底栏 **不一致**，以代码为准。

### data-model

TUI store 合并 `UiContextWindowUsage`（`tui/store/events.ts` / `snapshot.ts`）。没有 composition、没有 cache 类型。

`/status` 的 `data.tools` 是 source **计数**（`status-panel.ts` formatTools）。本轮不增加 token 分类，因此继续维持 `Context` 总量与 `Tools` 个数两种既有语义。

### dfd-interface

```text
context.window.updated → TUI store contextWindowUsages
  → app.tsx 选中活动 session
  → Prompt 底栏字符串

/status → renderStatusPanel(data)
  → Context 行 = 同一字符串
```

无指针点击占用标签的交互契约（00：不做）。

### use-case

| 场景 | 现在 |
|------|------|
| 底栏扫一眼 | 可以 |
| 点底栏看七类 | 不做（00） |
| `/status` 看七类 | 本轮明确延期；面板继续显示总量 |
| `/status` 看下一轮 cache | 可在独立 Cache 行展示，不画进 Context |

### test

`usage.unit.test.ts` 锁粗格式；`status-panel.unit.test.ts` 锁有 Context 行、缺失时 `Context unavailable`。这两项正是本轮 TUI 回归门，不新增分类渲染测试。

## 1.4 本轮影响面

- TUI 生产代码原则上不改；SDK 新增 optional composition 时，旧读取路径继续忽略未知字段。
- `tui/render/usage.ts`、`status-panel.ts` 的总量格式保持现有契约。
- 只需用现有/最小回归测试证明底栏与 `/status` 没被 SDK 扩展破坏。
- 下一轮 Cache 行是独立议题；未来若要七类，基于 Web 实际反馈重新选择“七行纯文本”或独立 `/context`，不在本轮预建抽象。
