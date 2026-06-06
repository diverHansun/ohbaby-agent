# 02b — render 层与组件层详细设计

日期: 2026-06-05
更新: 2026-06-06

> 2026-06-06 修订：组件层以
> [05-a-c-contract-appshell-viewport-plan.md](05-a-c-contract-appshell-viewport-plan.md)
> 为准。本文保留 render/editor 的细节，但更新 AppShell、tool、reasoning、status
> 与 prompt 的最终口径。

## A. render/ 原语层（纯函数）

所有模块：输入数据 + `{ theme, width }`，输出**已折行的 ANSI `string[]`**。零 React。

### wrap.ts（地基）

```ts
visibleWidth(line: string): number           // 跳过 ANSI 转义算可见宽度
wrapAnsi(line: string, width: number): string[]   // 按可见宽度折行，保留 ANSI
truncateAnsi(line: string, width: number): string // 超宽加 …
```
用 `string-width` 计宽。所有其它 render 模块依赖它。

### markdown.ts

借鉴 pi-tui `marked` token 思路（见 `pi/packages/tui/src/components/markdown.ts`），但只产 ANSI 行：

```ts
mdToAnsi(text: string, opts: { theme: Theme; width: number }): string[]
```

支持：标题、加粗、斜体、行内码、代码块、有序/无序列表、引用、链接、分隔线。
- 标题：主体着 `theme.text.heading`（纯金），`#` 标记符 / H1 下划线着 `theme.text.headingAccent`（轻微蓝点缀）。
- 代码块：委托 `highlight.ts`；**简洁风**——```` ``` ```` 围栏线 + 每行缩进 2 空格 + 高亮，**无边框/背景**（学 kimi/opencode）。
- 自己 wrap 到 `width` 后交给组件，组件不再二次折行。

不要在 v1 为未来能力预建复杂抽象。`marked` token 有二十多种，第一版只覆盖上面列出的
正文能力；表格、HTML、图片、嵌套块等保持普通文本或降级渲染。

### highlight.ts

```ts
highlightCode(code: string, lang: string | undefined, theme: Theme): string[]
```
`cli-highlight` 薄包装，按语言高亮；未知语言回退 `theme.text.normal`。syntax token → 调色板映射见 02a。

### diff.ts（延后）

```ts
renderDiff(oldStr, newStr, { theme, width, context }): string[]
```
`diff` 库 `diffLines`，`+`/`-`/上下文按 `theme.diff.*` 着色，带行号。本批次不实现（工具体不渲染）。

---

## B. 组件层

### layout/app-shell.tsx + layout/metrics.ts

AppShell 是本批次新增的页面壳，统一终端宽高、`contentWidth`、左右 padding 与
compact 判断。Logo、message flow、prompt dock、slash completion、status panel
必须使用同一组 metrics。

建议规则：

- `isCompact = columns < 80`。
- compact 下 `horizontalPadding = 2`。
- 非 compact 下 `horizontalPadding = 4`。
- `contentWidth = min(132, max(24, columns - horizontalPadding * 2))`。

本批次仍使用 Ink `<Static>` 和终端原生 scrollback，不实现完整虚拟滚动、滚动条或
历史搜索。

`AppShell` 是唯一读取 `useStdout().stdout.columns` 的布局入口。它计算 metrics 后
通过 layout context 传给子组件；`markdown-part.tsx` 等渲染组件只接收扣除 gutter、
padding、indent 后的 `partWidth`。

### message-flow.tsx

通过 `MessageFlow` 封装 `<Static items={messages}>` 流式渲染，每条交给
`message-block`。notices / command outputs / status panel 也归入同一历史流。
组件名避免承诺自定义滚动；真正的 scrollback 仍由终端提供。

### message-block.tsx

单条消息。**不输出 you/ohbaby 文字角色头**，改主题驱动装饰：

- `role === "user"`：读 `theme.message`。
  - 历史用户消息只显示左竖线 `▎` 或同等轻量 gutter。
  - 不使用背景块；当前 prompt 才使用背景块。
- `role === "assistant"`：
  - 无角色头，正文 markdown。
- parts 派发：
  - `text` → `markdown-part`
  - `reasoning` → `reasoning-part`（streaming 时灰色展开，completed/error 后折叠为一行 `Thought`）
  - `tool-call` / `tool-result` → `tool-part`

缩进：parts 相对消息左边距缩进 2。

### parts/markdown-part.tsx

```tsx
const t = useTheme();
const lines = mdToAnsi(part.text, { theme: t, width: partWidth });
return <Text>{lines.join("\n")}</Text>;
```
`partWidth` 来自 AppShell layout metrics，等于 `contentWidth` 扣掉当前消息 gutter、
padding 与 part 缩进后的宽度。`render/` 已经把行折到 `partWidth` 内，组件不依赖 Ink
再做换行。

必须补 contract 测试：ANSI 字符串进入 Ink `Text` 后不被二次折行破坏 ANSI 序列；
若发现 Ink 对某类 ANSI 行仍会错误折行，优先调整 `wrap.ts` 或改为逐行渲染，不在
markdown 组件里临时补空格。

### parts/reasoning-part.tsx

`theme.reasoning`（灰 `textMuted`，克制不抢正文）渲染。

折叠规则：

- owning `UiMessage.status === "streaming"` 时默认展开。
- owning `UiMessage.completedAt` 存在，或 `status === "completed" | "error"` 时折叠为
  一行 `Thought`。
- 旧消息没有 lifecycle 字段时按 completed 处理，默认折叠。
- 禁止使用全局 runtime `running/idle` 判断 reasoning 是否完成。

### parts/tool-part.tsx + tool/registry.ts

替换 `"result hidden"`。注册表按工具名查渲染器，未知回退 `default`：

```ts
interface ToolRenderer {
  // 第一版只实现 header：leading slot + 名 + 主参摘要
  header(call: UiToolCall, theme: Theme): string;
}
```

第一版不在 `ToolRenderer` 接口中保留 `body`。将来若实现 `Ctrl+O` 或工具 body 展开，
再新增明确的 deferred 接口，避免当前接口承诺未实现能力。

**关键：`tool-call` 与 `tool-result` 是两个独立 message part，先后到达**（`UiToolResult.callId` 指回 `UiToolCall.id`）。`tool-part.tsx` 必须维护 `callId → result` 的匹配，不能假设两者同步出现：

- **第一版 header 的 leading slot 只读 `call.status`**（`pending`/`running`/`completed`/`failed`），不依赖 result 是否到达 —— 状态语义已在 call 上，避免耦合到达顺序。
- failed 短错误摘要可读取匹配到的 `tool-result.error`；成功 result 不显示 body。
- 建议匹配逻辑下沉到一个 selector（如 `selectToolResult(callId)`），保持组件无状态、可测；不要在渲染期做线性扫描丢关联。

**第一版 header 行格式**：`<spinner-or-space> <name>  <arg-summary>`
- running/pending：左侧 leading slot 显示 running spinner。
- completed：leading slot 保留同宽空白，不保留图标，只显示工具名与摘要。
- failed：不使用失败图标，追加短错误摘要。
- 主参摘要按工具取 `call.input` 已知字段：
  - read/write → `file_path`（相对化）
  - edit → `file_path`
  - bash → `command`（截断）
  - grep → `pattern`
  - glob → `pattern`
  - todo/task → 简短标题
  - default → 工具名 + `input` 键摘要
- **不显示** 参数全文 / 输出 / diff（避免刷屏）。

每个 renderer 是纯函数（取 input 字段 → 格式化字符串），可单测。参数抽取可以用
小 helper，例如 `extractPrimaryArg(call)`，但不要引入 `BaseToolRenderer` 这类基类。
如果三个以上工具共享同一字段提取规则，再抽公共函数；否则保持各工具 renderer 简单直写。

示例：

```text
⠙ Bash    pnpm test
  Bash    pnpm test
  Edit    src/foo.ts  permission denied
```

### prompt/editor-reducer.ts（编辑器状态机）

```ts
interface EditorState {
  lines: string[];          // 多行缓冲
  cursor: { row: number; col: number };
  history: string[];        // 已提交输入
  historyIndex: number;     // 浏览位置；=length 表示在草稿
  draft: string | null;     // 进入历史浏览前的未发送草稿
}
type EditorKey = …;         // 抽象按键
editorReducer(state, key): EditorState   // 纯函数
```

键位映射（第一版）：
- `←/→`：列移动；`Home/End`：行首/尾。
- `Shift+Enter`：当前光标插入换行；`Enter`：提交（由上层处理提交，reducer 返回 `submit` 意图 + 清空）。
- `Backspace`：删除光标前字符（跨行合并）。
- `Ctrl+U`：清空当前行。
- `↑/↓`：历史浏览。进入历史前把当前未发送内容存 `draft`；`↓` 回到末尾恢复 `draft`（**不丢草稿**）。slash 补全激活时 ↑/↓ 让位补全（由 prompt/index 协调，不进 reducer）。
- 批量输入（粘贴）：useInput 一次给整段 → reducer 一次性插入，不逐字。终端右键/触控板粘贴本质是 stdin 批量字符，天然走此路径，无需鼠标捕获。

**不做**：跳词 Alt+←→、Delete 键。

### prompt/editor.tsx（视图）

把 `EditorState` 画出来：多行 buffer，按 `width` 折行，光标格用 `theme.cursor` 反显。把 Ink 按键翻译成 `EditorKey` 喂 reducer。

### prompt/index.tsx

装配 editor + PromptDock 状态行 + completion。协调：slash 补全激活时拦截 ↑/↓；
提交时区分 slash 命令 vs 普通 prompt（保留现有 `submitInput` 逻辑）。

PromptDock 视觉：

```text
> ask anything...

auto · default · session_abc                    38.4K / 1M (4%)
```

- 当前输入有背景块。
- prompt 符号只使用 `>`。
- mode 只显示 `auto` 或 `plan`，不显示 `ask/build`。
- 不显示模型。
- 不显示 tip 行。

### prompt/completion.tsx

保留逻辑，配色换 `theme`（选中项品牌金 `gold` 加粗，其余 `text.muted`）。

### status-bar.tsx（重做）

一行：
```
<mode> · <permission> · <session_id>            [右对齐: context window usage]
```
左侧着 `theme.status.*`；右侧读取当前 session 的 `UiContextWindowUsage` 并格式化为
`38.4K / 1M (4%)`。无数据时留空，不显示占位文本。

### command/status-panel.tsx

`/status` command output 渲染为轻边框多行 panel，作为 scrollback 中的一条历史输出。

第一版包含 runtime、session、permission、model、tools、project、context window。
context window 缺失时显示 `Context unavailable`。不做 severity、progress bar 或费用。

### header.tsx / logo.tsx

空会话显示 **OHBABY** ASCII/ANSI logo。配色用紫金蓝三色（`brandTitle.primary`
金为主 + `brandTitle.secondary` 紫 + `brandTitle.tertiary` 蓝点缀）。不显示 tip，不显示
模型。

实现通过 `renderOhbabyLogo()` 生成静态 ANSI 行，不引入 `figlet` 运行时依赖。组件只
消费渲染结果，不在 JSX 中散落 print 字符串。如需要调整字体，可在开发期用外部工具
重新生成静态文本。

### spinner.tsx

运行中显示 `theme.spinner` 旋转帧，颜色在金/紫间逐帧交替。工具调用行 running 状态
复用该 spinner；完成后 spinner 消失。

### footer.tsx

**删除**。

---

## C. app.tsx 与 hooks

### hooks/use-global-keys.ts

把 `Shift+Tab`（切权限模式）、`Ctrl+C`（abort/exit）从 app.tsx 抽出为 hook，输入 `{ state, client, store, exit }`，便于单测。行为与现状等价。

### app.tsx

```tsx
<ThemeProvider value={detectTheme()}>   // 默认暗
  <AppShell>
    <Header/>
    <MessageFlow/>            // wraps <Static>
    <DialogManager/>
    <PromptDock/>             // editor + status + completion
  </AppShell>
</ThemeProvider>
```
事件订阅/退出/catalog/快照逻辑保留。

---

## D. dialogs/

逻辑不动，颜色换 `theme.*`：选中项品牌金 `gold`、边框 `border`、危险操作 `red`、标题 `text.strong`。`manager.tsx` 编排不变。
