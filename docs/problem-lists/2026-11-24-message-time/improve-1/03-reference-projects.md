# 3. 参考项目借鉴

> 本文记录 2026-11-24 对 `code-cli/` 下三个项目的核查结果，只记事实和借鉴点。

## 3.1 侧边栏时间

三个项目的侧边栏都保留了相对时间，排序都按最近活动时间（`updatedAt`）。ohbaby 删掉侧边栏时间，是有意和它们不同：ohbaby Web 追求少元素，时间改由消息承担。

## 3.2 消息时间

| 项目 | 哪些消息有时间 | 位置 | 显隐 | 格式 |
|---|---|---|---|---|
| kimi-code | 用户消息和回答 | 回答：复制、Fork 之后；用户消息：复制、撤销之后 | 常显 | 今天 `14:32`，昨天 `昨天 14:32`，今年 `11-22 14:32`，往年 `2025-11-22 14:32` |
| dsh | 用户消息和回答 | 和复制、分支按钮同一行。用户消息时间在图标前，回答时间在图标后 | 最新一条常显，其他 hover 显示 | 今天 `14:05`，今年 `11/24 14:05`，往年带年份 |
| ZCode | 只有回答 | 和复制、Fork 同一行，在按钮之后 | hover 显示 | 今天只写时间，昨天 `Yesterday`，今年月日加时间，往年年月日加时间 |

出处：

- kimi-code：`packages/app-core/src/lib/formatMessageTime.ts`；`packages/app-components/src/chat/ChatPane.vue:1434-1469`（用户消息）、`:1559-1582`（回答，取 `endedAt`）。
- dsh：`packages/client/ui-chat/src/client/chat/MessageIconActions.tsx`、`message-chrome.ts:86-100`、`TurnTailNodeView.tsx:36-77`。
- ZCode：`packages/ui/src/v4/ConversationRowView.tsx:1325-1509`、`v4/messageTimeLabel.ts:75-118`。

## 3.3 借鉴点

- 位置和显隐采用 dsh 的做法，它和 ohbaby 现有的 `MessageActions` 最接近：时间放进操作行，跟着操作行显隐。用户消息的时间放在图标外侧，回答的时间放在最后。
- 回答取完成时间，和 kimi-code 的 `endedAt` 一致。
- 格式按用户要求固定为"年 → 月日 → 时间"的纯数字顺序，不用 kimi-code 和 ZCode 的"昨天/Yesterday"。
