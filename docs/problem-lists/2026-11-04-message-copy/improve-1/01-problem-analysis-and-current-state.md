# 1. 现状与问题分析

> 代码基线：2026-11-04，`main` 分支 `c9cbd475`。本议题开始前没有任何相关实施。`W/` 表示 `apps/ohbaby-web/src/`。

## 1.1 问题陈述

1. **没有复制入口。** Web 消息区没有任何复制按钮，代码块也没有。
2. **手动拖选会选多。** 一轮回答里夹着思考过程、工具卡片和时间标签，拖选时会一起选进去。
3. **“一次回答”不是一条消息。** 一轮回答在后端（`packages/ohbaby-agent`）里存成多条 assistant 消息，每个模型步骤一条。“复制回答”要先说清楚复制哪一条。
4. **现有剪贴板写法会静默失败。** 唯一的复制按钮在设置页，失败时什么都不提示，非安全上下文下根本不能用。

## 1.2 已确认的产品分界

见 [00 §2](00-discussion.md)：用户消息复制原文，AI 回答只复制每轮的最终答案，代码块单独复制，都只取正文；只做 Web。

## 1.3 现状

### 1.3.1 消息渲染

- `W/ui/conversation/ConversationStream.tsx` 把消息和 prompt 行排成时间线，并按 run 折叠执行过程（约 :100-200）。
- `W/ui/conversation/MessageRow.tsx` 渲染单条消息。用户消息用 `ohb-message-user-bubble`，助手消息用 `ohb-message-assistant-bare`（:41-45）。组件里只渲染内容，没有任何操作按钮；`messages.css` 里也没有操作栏的样式。
- 流式输出时，文本用 `<pre>` 直接显示原文（`MessageRow.tsx:218-223`），结束后才交给 Markdown 渲染。

### 1.3.2 最终答案的判定

`W/ui/conversation/run-process.ts` 的 `projectRunProcesses` 按 prompt 把消息分成轮（:19-36），并决定每轮的最终答案：取这一轮最后一条 assistant 消息，要求它不在流式输出、没出错、有非空文本、不含工具调用（:37-51）。不满足时 `answerId` 为空，这一轮就没有可折叠的“答案”。折叠后界面上显示的就是这条消息。

**结论**：复制按钮应该挂在 `answerId` 指向的消息上，规则现成，不需要另写。

### 1.3.3 取文本

`MessageRow.tsx:253-259` 的 `visibleMessageText` 把 `text` 和 `reasoning` 两种片段拼在一起。

**结论**：它含思考过程，不符合“只复制正文”，要新写一个只取 `text` 片段的函数。

### 1.3.4 剪贴板

整个 Web 只有 `W/ui/settings/AboutSection.tsx:45-74` 的 `CopyButton` 用到剪贴板：直接调 `navigator.clipboard.writeText`，失败时用 `.catch(() => undefined)` 吞掉。

| 问题 | 影响 |
|---|---|
| 没有降级 | 局域网用 `http://` 访问 daemon 时不是安全上下文，`navigator.clipboard` 为 `undefined`，按钮点了没反应 |
| 失败不反馈 | 用户以为复制成功了 |
| 组件是文件内私有的 | 消息区不能复用 |

### 1.3.5 Markdown 与代码块

`W/ui/shared/MarkdownBlock.tsx` 用 `marked` 把文本转成 HTML，经 `DOMPurify.sanitize` 后用 `dangerouslySetInnerHTML` 输出。代码块是这段 HTML 里的 `<pre><code>`，不是 React 组件，没法直接往里放一个带 `onClick` 的按钮。

DOMPurify 当前版本 3.4.11 默认保留 `<button>` 元素和 `data-*` 属性（`ALLOW_DATA_ATTR` 默认为 `true`），但会去掉内联事件属性。所以按钮可以由渲染器写进 HTML，点击要在外层容器上统一处理。

## 1.4 测试现状

- 测试与源码放在同一目录，按 `*.unit.test.ts(x)` 分类。
- `run-process.ts` 有现成测试，最终答案的判定已经被覆盖。
- 剪贴板、消息操作、代码块都没有测试。

## 1.5 改动影响面

只涉及 `apps/ohbaby-web`：新增剪贴板工具、复制按钮、消息操作栏，修改 `MessageRow`、`ConversationStream`、`MarkdownBlock`、`AboutSection` 和样式。不碰后端、SDK 和 TUI。

## 1.6 SWE 原则审视

- **复用现有判定**：最终答案用 `run-process.ts` 的结果，不另写规则，避免“折叠显示的是 A，复制出来的是 B”。
- **一处实现，多处使用**：剪贴板和复制按钮抽到 `ui/shared/`，设置页和消息区共用。
- **为后续议题留位置，但不提前实现**：操作栏只是一个容器，Edit 和 fork 按钮由各自的议题加。

## 1.7 与既有文档关系

| 文档 | 本议题之后 |
|---|---|
| `docs/ohbaby-web/` 的会话界面相关文档 | 补充消息操作栏的位置、显示规则和复制范围 |
