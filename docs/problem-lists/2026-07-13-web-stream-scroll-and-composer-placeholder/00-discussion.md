# 讨论记录与已确认要点

> 2026-07-13 与用户讨论定稿（含同日增补的 Phase C IME）。正式方案见 01–04。

---

## 1. 背景与动机

Web 对话流式输出时页面不跟滚，阅读体验断裂；Composer 默认 `"Message ohbaby..."` 文案过时且无品牌动效。用户希望在实施前把问题与方案写成 problem-list，再在独立会话动手。

同日增补：中文键盘组字时，用 Enter 确认候选（例如在中文输入法下键入 `hello` 再 Enter 上屏）会被现有「Enter 即发送」逻辑抢走，属于真实用户输入习惯问题。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 议题 A：流式跟滚 | 默认随 agent 输出贴底滚动，便于阅读 |
| 议题 A：用户滚轮 | **不阻止**用户滚轮/触控板；用户上滚离开底部后停止自动跟滚 |
| 议题 A：恢复跟滚 | 用户再滚回底部附近后恢复 stick-to-bottom |
| 议题 B：占位触发条件 | **标准聚焦语义**：框空着且未聚焦时播放；一点进去或有字就停/隐藏 |
| 议题 B：非 idle 态 | `daemon unavailable` / `run in progress` 保持静态文案，不做打字机 |
| 议题 C：IME 组字 Enter | 组字中（`isComposing` / keyCode `229`）**不发送、不执行 slash、不 preventDefault 抢 IME** |
| 议题 C：非组字 Enter | 保持现有语义：Enter 发送；Shift+Enter 不走发送（与现码一致） |
| 落点 | `docs/problem-lists/2026-07-13-web-stream-scroll-and-composer-placeholder/` |
| 批次 | 单批；不分 `improve-N`；顺序 **A → B → C**（C 可与 B 同改 `onKeyDown`） |
| 改动边界 | 仅 `apps/ohbaby-web` 前端；不改 daemon / TUI |

## 3. 已确认：占位文案（实施默认值）

Idle 打字机轮播文案（已冻结，实施按此三句）：

1. `Ask Lychee anything…`
2. `Describe the change you want…`
3. `Plan the next step…`

打字机行为冻结：

- 逐字打出 → 短暂停顿 → 逐字删除 → 切换下一句 → 循环。
- 仅 `draft === ""` 且 textarea **未 focus** 时运行。
- focus 或 `draft` 非空时立即隐藏 overlay，并暂停动画计时器（避免后台空转）。
- 失焦且仍为空时从当前句重新播放（不必记住上次删到一半的位置）。

## 4. 已确认：IME Enter 守卫

| 状态 | Enter（无 Shift） | Slash 打开时的 Enter |
|------|-------------------|----------------------|
| **组字中** | 不发送；不 `preventDefault` | 不执行 slash；不 `preventDefault` |
| 未组字 | 发送（现行为） | 执行选中 slash（现行为） |

判定（实施必须同时覆盖）：

1. `event.nativeEvent.isComposing === true`
2. 遗留兜底：`event.keyCode === 229`（部分浏览器组字 keydown）

组字期间其它已绑定快捷键（如会 `preventDefault` 的 Arrow/Tab 用于 slash）若同样会打断 IME，应对 **会抢占默认行为的键** 一并在组字态 early-return；最低要求是 **Enter 发送/slash 路径** 必须守卫。

## 5. 已确认：边界（不做的事）

| 项 | 本批不做 |
|----|----------|
| 「有新内容」悬浮 Jump to latest 按钮 | **本批明确不做**；靠 stick + 回底恢复即可（后续可选） |
| 改 SSE / `message.part.delta` 协议 | 跟滚是 UI 问题，协议正确 |
| TUI 同步改造（含 TUI IME） | 另议题 |
| 虚拟列表 / 消息窗口化 | 另议题 |
| 多语言 i18n 框架 | 文案先硬编码英/产品现有风格 |
| 改变非组字时 Enter=发送 的产品约定 | 只修 IME 冲突 |

## 6. 已确认：跟滚参数默认值

| 参数 | 默认 | 说明 |
|------|------|------|
| near-bottom 阈值 | `80px` | `scrollHeight - scrollTop - clientHeight <= 80` 视为在底部 |
| 贴底时机 | `useLayoutEffect` + 内容区 `ResizeObserver` | 覆盖 delta 文本增长与 markdown 重排 |
| session 切换 | 重置 `stickToBottom = true` 并贴底 | 新会话应从底部读起 |
| 用户发送 prompt | 重置 stick 并贴底 | 发送后应看到自己的消息与后续输出 |

## 7. 与关联议题的关系

- 依赖已落地的 conversation stream 容器（`.ohb-stream`）与 composer dock 布局；不回退导航改造。
- 需与 pending prompt / thinking indicator / streaming message 共存：这些都会改变内容高度，必须触发贴底判定。
- Phase C 与 Phase B 同属 Composer 输入路径，实施时可同文件改 `onKeyDown`，但验收与 DoD 分开列。

## 8. 参考项目

ChatGPT / Claude.ai / Cursor Chat 的 stick-to-bottom、「空态未聚焦占位」、以及 chat 输入对 `isComposing` 的 Enter 守卫为行为参考；细节见 `03-reference-projects.md`。不像素级照搬。

## 9. 用户确认记录

- 用户确认占位触发为：**未聚焦（标准做法）**，不是 hover。
- 用户要求：详细分析 + 优化方案写入 `docs/problem-lists/`，随后自行开始实施。
- 2026-07-13 终审对齐：占位首句为 `Ask Lychee anything…`；**本批不做 Jump 按钮**。
- 2026-07-13 增补确认：**IME 组字时 Enter 不发送**，写入本目录为 Phase C，文档对齐后开始实施。
