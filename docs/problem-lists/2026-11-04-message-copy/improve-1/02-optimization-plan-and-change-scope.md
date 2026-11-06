# 2. 方案与改动面

> 本文是给实施会话的执行契约。决策来源见 [00](00-discussion.md)，现状证据见 [01](01-problem-analysis-and-current-state.md)，验收见 [04](04-test-and-acceptance.md)。`W/` 表示 `apps/ohbaby-web/src/`。

## 2.1 方案总览

在 `ui/shared/` 新建剪贴板工具和公共复制按钮；在 `ui/conversation/` 新建消息操作栏，挂在用户消息和每轮最终答案下面；给 Markdown 渲染器加代码块复制按钮。全部改动都在 Web。

```
用户消息气泡            ──► MessageActions [复制] [以后：Edit]
每轮最终答案（answerId） ──► MessageActions [复制] [以后：fork]
Markdown 里的 <pre>     ──► 渲染器写入按钮，容器统一处理点击
                                  │
                        writeClipboard(text) → true / false
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| 剪贴板 | `navigator.clipboard`，失败时退回 `execCommand("copy")`，返回布尔值 | 非安全上下文也能用；失败可感知 | 只用 `navigator.clipboard` | 多一个降级分支 |
| 取正文 | 新函数只取 `text` 片段，片段之间空一行 | 符合“只复制正文” | 复用 `visibleMessageText`（含思考过程） | 多一个小函数 |
| 复制哪条回答 | `projectRunProcesses` 算出的 `answerId` | 与折叠后显示的一致 | 复制整轮所有文本（ZCode 的做法） | 没有最终答案的轮次没有复制按钮 |
| 操作栏显示 | 悬停或获得焦点时显示，触屏常显 | 长对话不杂乱；触屏能用 | 常显 | 键盘用户要靠焦点触发，需要保证按钮可以用 Tab 选中 |
| 代码块按钮 | 渲染器写入按钮，容器做事件委托 | 不改现有的 HTML 渲染方式 | 改成 React 组件树渲染 Markdown（改动太大） | 依赖 DOMPurify 保留按钮，T7 验证 |

## 2.3 分阶段实施

两个 Stage 都属于 improve-1。每个 Stage 结束时 `pnpm typecheck`、`pnpm lint` 和相关测试保持通过。

### Stage 1：剪贴板、消息操作栏、消息复制

**目标**：用户消息和每轮最终答案都能复制。

**改动**：

1. 新建 `W/ui/shared/clipboard.ts`：`writeClipboard(text): Promise<boolean>`。先试 `navigator.clipboard.writeText`，失败或不可用时用隐藏的 `textarea` 加 `document.execCommand("copy")`，都失败返回 `false`。
2. 新建 `W/ui/shared/CopyButton.tsx`：从 `W/ui/settings/AboutSection.tsx:45-74` 抽出来，改用 `writeClipboard`，只有返回 `true` 才显示勾号；失败时短暂显示“Copy failed”。现在有两份私有实现：`AboutSection.tsx:45` 和 Files 页预览的 `W/ui/side-panel/files/FilePreview.tsx:109`（2026-11-05 新增），两处都改用这个公共组件。
3. 新建 `W/ui/conversation/message-text.ts`：`messageBodyText(message)` 只取 `text` 片段，多个片段之间用空行连接。`MessageRow.tsx` 里的 `visibleMessageText` 保持原样。
4. 新建 `W/ui/conversation/MessageActions.tsx`：
   - 接收要显示的按钮列表，本议题只传复制按钮。组件本身不关心有哪些按钮，撤销重发和 fork 议题往里加按钮即可。
   - 桌面端在消息悬停或操作栏内有焦点时显示；`@media (pointer: coarse)` 下常显。按钮都能用 Tab 选中。
5. 修改 `W/ui/conversation/ConversationStream.tsx` / `MessageRow.tsx`：
   - 用户消息（包括 steer 消息）气泡下面挂操作栏，复制 `messageBodyText`。
   - `RunProcess.answerId` 指向的消息下面挂操作栏，复制它的 `messageBodyText`。没有最终答案的轮次、流式输出中的消息不挂。
   - 样式放进 `messages.css`。

**完成定义**：04 的 T1 至 T6 通过。

### Stage 2：代码块复制与文档

**目标**：每个代码块都能单独复制。

**改动**：

1. 修改 `W/ui/shared/MarkdownBlock.tsx`：
   - 现在用的是全局的 `marked`（`MarkdownBlock.tsx:2, 6`）。改为模块内 `new Marked(...)`，只给这个实例配代码块渲染器，不影响别处。
   - 代码块渲染器先调用默认渲染得到 `<pre><code>…</code></pre>`，再在 `<pre>` 开头插入按钮，不自己拼 `<code>`，免得自己处理转义。
   - 按钮是一段 HTML 字符串，用不了 lucide 图标组件，内容用文字：`<button type="button" class="ohb-code-copy" data-code-copy aria-label="Copy code">Copy</button>`。
   - 在外层容器上用一个 `onClick` 做事件委托，点到这个按钮时取同一个 `<pre>` 里 `<code>` 的 `textContent`，调 `writeClipboard`。成功时按钮文字短暂变成“Copied”，失败时变成“Copy failed”，1.5 秒后恢复。
   - `MarkdownBlock` 也用在命令结果弹窗里（`W/ui/commands/CommandResultModal.tsx:6`）和右侧面板 Files 页的 Markdown 预览里（`W/ui/side-panel/files/FilePreview.tsx`），这两处的代码块同样会出现复制按钮，这是预期行为。
2. 流式输出时走的是 `<pre>` 原文显示，不经过 `MarkdownBlock`，自然没有按钮，不需要特殊处理。
3. 同步 `docs/ohbaby-web/` 中描述会话界面的文档：消息操作栏的位置、显示规则、复制范围。

**完成定义**：04 的 T7、T8 通过。

## 2.4 按包的改动面

| 包 / 目录 | 新增 | 修改 |
|---|---|---|
| `apps/ohbaby-web` | `ui/shared/{clipboard.ts,CopyButton.tsx}`、`ui/conversation/{MessageActions.tsx,message-text.ts}` | `ui/shared/MarkdownBlock.tsx`、`ui/conversation/{ConversationStream,MessageRow}.tsx`、`ui/settings/AboutSection.tsx`、`ui/side-panel/files/FilePreview.tsx`、`messages.css` |

后端、SDK、TUI 都不动。

## 2.5 接口与兼容

没有新的接口、协议或迁移。`MessageActions` 的入参（按钮列表）是给后续议题用的组件契约，实施时保持简单，例如 `{ actions: ReadonlyArray<{ key; node }> }` 一类的形式即可，不为将来可能的需求预留参数。

## 2.6 风险与回滚

| 风险 | 影响 | 应对 |
|---|---|---|
| DOMPurify 配置以后被收紧 | 代码块按钮消失 | T7 用真实的 DOMPurify 跑，配置变了测试会失败 |
| `execCommand` 将来被浏览器移除 | 非安全上下文下复制失败 | 返回 `false` 并提示失败，不会误报成功 |
| 操作栏影响现有布局 | 气泡或折叠区错位 | T9、T10 回归 |

回滚：删掉操作栏的挂载点即可，其余是新增文件。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 只复制正文 | Stage 1 第 3 步 |
| 用户消息复制原文 | Stage 1 第 5 步 |
| 只复制最终答案 | Stage 1 第 5 步、决策表第 3 行 |
| 代码块单独复制 | Stage 2 |
| 只做 Web | 2.4 |
| P1 至 P6 | 决策表与 Stage 1、2 |

## 2.8 不在本轮

| 项 | 去向 |
|---|---|
| TUI 复制命令 | 不做 |
| 复制表格为 Markdown、复制整个会话 | 不做 |
| Edit、fork 按钮 | 由撤销重发和会话 fork 议题加到本议题的操作栏里 |
