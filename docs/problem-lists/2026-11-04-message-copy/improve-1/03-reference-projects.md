# 3. 参考项目

> 2026-11-04 由子代理只读调研，主代理汇总。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| deepseek-harness（下称 dsh） | 剪贴板工具、消息图标操作栏、代码块复制 |
| ZCode | 用户消息与助手回答的复制按钮、代码块复制 |
| kimi-code | Web 与 VS Code 的复制按钮 |
| opencode | Web 的消息菜单与回答复制 |

## 3.2 可借鉴点

| 项目 | 做法 | 本项目取舍 |
|---|---|---|
| dsh | `packages/client/ui-primitives/src/clipboard.ts:11` 的 `writeClipboard` 先用 `navigator.clipboard`，失败退回 `execCommand`，返回布尔值；失败时不显示“已复制”。`use-clipboard-copy.ts` 显示 1 秒的“已复制”，写入期间忽略重复点击 | **采用**：剪贴板函数的形态照搬 |
| dsh | 助手消息只复制 `text` 块（`ui-chat/src/client/chat/turn-assistant.ts:8`）；用户、steer、助手气泡共用一个图标操作栏（`MessageIconActions.tsx`） | **采用**：只复制正文；一个操作栏组件给多种消息用 |
| kimi-code | VS Code 端助手消息只复制最后一步的文本（`apps/vscode/webview-ui/src/components/ChatMessage.tsx:248-259`），勾号显示 2 秒 | **采用**：“最后一步”与本项目的“最终答案”一致 |
| ZCode | 操作栏悬停时显示，移动端常显（`packages/ui/src/v4/ConversationRowView.tsx:1437`）；代码块复制按钮来自 Vercel ai-elements（`components/ai-elements/code-block.tsx:448-495`） | **采用**：悬停显示、触屏常显 |
| opencode | 用户消息有“Copy message”，回答下面有“Copy response”（`opencode/packages/session-ui/src/message/message-content.tsx:495-546, 1201-1240`） | 参考按钮位置 |

## 3.3 明确不借鉴

- **复制整轮所有文本**（ZCode 把一轮里所有文本段用空行拼起来，`ConversationRowView.tsx:1800-1806`）：中间的过渡文字算执行过程，用户已确认不复制。
- **TUI `/copy`**（kimi-code、claude-code、pi 都有）：用户确认本批只做 Web。

## 3.4 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 剪贴板返回布尔值、`execCommand` 降级 | dsh |
| 只复制正文、只复制最终答案 | dsh、kimi-code |
| 一个操作栏组件给多种消息用 | dsh |
| 悬停显示、触屏常显 | ZCode |
