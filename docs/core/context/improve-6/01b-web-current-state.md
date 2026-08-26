# 1b. Web 现状：顶栏占用与 `/status` 卡片

> 时间口径：2026-08-26。诊断 Web 占用展示，不写目标交互。

## 1.1 问题陈述

1. 顶栏只有单色细条 + `7.1k / 1m` 一类标签，不能 hover/click 看分类。
2. 没有占用环。
3. `/status` 已有卡片，但 context 仍是一行粗字符串，没有七类、没有 cache。

## 1.2 已确认分界（引用 00）

Web 本批：小环（hover 前）→ hover 粗信息 → click 彩条详情（无 cache）。`/status` 卡片本批给七类详细占用；Cache 行下一轮（设计见 00 §2.4）。

## 1.3 现状

### goals-duty / 职责

Web 只消费 SDK snapshot / command notice，不计量 token。职责正确。Gap 在契约字段不够，不在 Web 自己估 token。

### architecture

- 顶栏：`apps/ohbaby-web/src/ui/App.tsx` `StatusBar` L1273–1312，`.ohb-context` 内一根 `width: ratio%` 的条 + `header.contextLabel`。
- 选择器：`selectors.ts` `selectContextModel` L262–282、`selectContextUsage` L284–296，从 `snapshot.contextWindowUsages` 按 `sessionId` 取。
- `/status`：slash 成功 notice → `createCommandResultModel`（`slashCommands.ts` L114–128，`subject === "status"`）→ `CommandResultModal` → `StatusCommandResult`（`App.tsx` L1646–1663）。
- 卡片行：`statusRows`（`slashCommands.ts` L159–205）里 `label: "context"` 走 `formatContextWindow` 或回退 `header.contextLabel`。

### data-model

Web 看到的仍是 `UiContextWindowUsage` 六个标量字段。`HeaderModel` 只有 `contextLabel` + `contextRatio`（`selectors.ts` L19–31），没有七类 composition、没有 cache。

Command notice 的 `output.data.contextWindow` 与 snapshot usage 同形。`data.tools` 若存在也是 **个数**（builtin/module/skill/mcp count），不是 token。

### dfd-interface

```text
context.window.updated
  → eventReducer.ts case "context.window.updated" L389–397
  → snapshot.contextWindowUsages（ohbaby-sdk/src/snapshot.ts L52）
  → selectContextUsage → StatusBar

/status command
  → daemon notice output.data
  → statusRows → 一行 context 字符串
```

没有 click handler、没有 popover、没有 ring SVG。

### use-case

| 场景 | 现在 |
|------|------|
| 扫一眼占用 | 可以（条 + 标签） |
| hover 看 % 与 used/window | 不可以（无 tooltip） |
| click 看七类 | 不可以 |
| `/status` 看详情 + cache | 卡片在，内容不够 |

### non-functional

顶栏占用是只读摘要，刷新来自事件。联合回归已证明刷新后粗标签稳定。本批加环/面板时需避免每次 token 抖动导致环动画吵；详情数字用 `~`。

### test

`App.unit.test.tsx`、`selectors.unit.test.ts` 覆盖粗 `contextLabel` / ratio 与 `/status` 在 slash 目录里出现。没有 ring、popover、七类行、cache 行的测试。

`slashCommands.unit.test.ts` 认 `/status` 为 palette 命令。

## 1.4 文档 gap

`docs/ui/components/status-bar.md` 描述的是旧 TUI StatusBar（`UiContextUsage`、`useRuntime()`、`1.2k (10%)`），**不是**当前 Web `ohb-context` 条。不能当本批 Web 设计基线。

## 1.5 改动影响面

- `apps/ohbaby-web/src/ui/App.tsx`：StatusBar 环 + popover；`StatusCommandResult` 详情
- `apps/ohbaby-web/src/ui/selectors.ts`：HeaderModel 扩展或独立 occupancy view model
- `apps/ohbaby-web/src/ui/slashCommands.ts`：`statusRows` / 详情块
- 样式：`.ohb-context*`
- 单测：selectors、StatusBar 交互、`/status` 卡片
