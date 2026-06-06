# TUI Status Bar Token Estimation Deferred Problem

日期: 2026-06-05

## 背景

TUI 收尾批次重做状态行（`status-bar.tsx`）。状态行布局约定：

- **左侧**: 模式（mode）· 权限（permission level）· session_id。
- **右侧**: token 估算（如 `37.8K (4%) · $0.07`，参考 opencode）。

左侧信息已经在 `UiSnapshot` 中可用（`permission.mode`、`permission.level`、`activeSessionId`）。

**右侧 token 估算当前没有数据来源**，因此 TUI 收尾批次只渲染左侧信息，并在状态行右侧**预留位置**，暂不显示 token/cost。

## 延后问题

### Snapshot 缺少 token / cost 字段

当前 `UiSnapshot` / `UiSession` / `UiRun`（`packages/ohbaby-sdk/src/snapshot.ts`）没有以下字段：

- 当前会话累计 token 用量（prompt + completion）。
- 上下文窗口占用百分比（需要知道当前模型的 context window 上限）。
- 估算费用（需要 token 用量 + 模型单价）。

TUI 无法凭空计算这些值，需要后端在 snapshot 或事件流中提供。

### 需要后端补充的契约（用户在 TUI 实施前接上）

由 **用户本人** 在 TUI 状态行实施前补齐后端数据，建议形态（待后端设计确认）：

- 在 `UiSession`（或活动 `UiRun`）上增加用量字段，例如：
  - `usage: { promptTokens; completionTokens; totalTokens }`
  - `contextWindow: number`（当前模型上限，用于算占用百分比）
  - `estimatedCostUsd?: number`
- 或通过独立事件（如 `usage.updated`）推送，由 store 累积进 snapshot。

### TUI 侧预留

- `status-bar.tsx` 右侧区域预留 token 估算槽位。
- 数据未提供时右侧留空（不显示占位文本）。
- 一旦后端字段到位，状态行只需读取并按 `theme.text.muted` 渲染，无需改动布局结构。
