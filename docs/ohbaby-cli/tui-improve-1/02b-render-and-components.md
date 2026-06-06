# 02b — render 层与组件层详细设计

日期: 2026-06-05

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

### message-list.tsx

`<Static items={messages}>` 流式渲染，每条交给 `message-block`。notices / commandNotices 也归入（套主题）。

### message-block.tsx

单条消息。**不输出 you/ohbaby 文字角色头**，改主题驱动装饰：

- `role === "user"`：读 `theme.message`。
  - 暗色：每行前置左竖线 `▎`（`message.userGutter` 中性色）。
  - 亮色：`message.userBlockBg` 亮块 + 首行 `message.userPrefix.icon`（`❯`）。
- `role === "assistant"`：
  - 暗色：无装饰，正文 markdown。
  - 亮色：首行 `message.assistantPrefix.icon`（`●`）。
- parts 派发：
  - `text` → `markdown-part`
  - `reasoning` → `reasoning-part`（`theme.reasoning` 灰，可加 `Thought: <ms>` 头）
  - `tool-call` / `tool-result` → `tool-part`

缩进：parts 相对消息左边距缩进 2。

### parts/markdown-part.tsx

```tsx
const t = useTheme();
const lines = mdToAnsi(part.text, { theme: t, width });   // width 来自 useStdout/measure
return <Text wrap="end">{lines.join("\n")}</Text>;
```
`width` 取终端列宽减去缩进；用 Ink `useStdout().stdout.columns` 或固定测量。

### parts/reasoning-part.tsx

`theme.reasoning`（灰 `textMuted`，克制不抢正文）渲染；可折叠（第一版直接显示，超长截断由 wrap 处理）。

### parts/tool-part.tsx + tool/registry.ts

替换 `"result hidden"`。注册表按工具名查渲染器，未知回退 `default`：

```ts
interface ToolRenderer {
  // 第一版只实现 header：图标 + 名 + 主参摘要
  header(call: UiToolCall, theme: Theme): string;
  // 预留给 Ctrl+O 展开，第一版不实现/不调用
  body?(call: UiToolCall, result: UiToolResult | undefined,
        opts: { theme: Theme; width: number }): string[];
}
```

**关键：`tool-call` 与 `tool-result` 是两个独立 message part，先后到达**（`UiToolResult.callId` 指回 `UiToolCall.id`）。`tool-part.tsx` 必须维护 `callId → result` 的匹配，不能假设两者同步出现：

- **第一版 header 的状态图标只读 `call.status`**（`pending`/`running`/`completed`/`failed`），不依赖 result 是否到达 —— 状态语义已在 call 上，避免耦合到达顺序。
- `body`（延后）才需要 `result`：tool-part 在同一消息（或 store 派生层）按 `callId` 把对应 `tool-result` 找出来传入；result 未到时传 `undefined`。
- 建议匹配逻辑下沉到一个 selector（如 `selectToolResult(callId)`），保持组件无状态、可测；不要在渲染期做线性扫描丢关联。

**第一版 header 行格式**：`<icon> <name>  <arg-summary>`
- 图标来自 `theme.tool`（`▸` running/pending、`✓` ok、`✗` failed）。
- 主参摘要按工具取 `call.input` 已知字段：
  - read/write → `file_path`（相对化）
  - edit → `file_path`
  - bash → `command`（截断）
  - grep → `pattern`
  - glob → `pattern`
  - todo/task → 简短标题
  - default → 工具名 + `input` 键摘要
- **不显示** 参数全文 / 输出 / diff（避免刷屏）。

每个 renderer 是纯函数（取 input 字段 → 格式化字符串），可单测。

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

装配 editor + 状态行 + completion。协调：slash 补全激活时拦截 ↑/↓；提交时区分 slash 命令 vs 普通 prompt（保留现有 `submitInput` 逻辑）。

### prompt/completion.tsx

保留逻辑，配色换 `theme`（选中项品牌金 `gold` 加粗，其余 `text.muted`）。

### status-bar.tsx（重做）

一行：
```
<mode> · <permission> · <session_id>            [右对齐: token 槽位(留空)]
```
左侧着 `theme.status.*`；右侧 token 估算**预留位置**，无数据时留空（见 problem-lists）。

### header.tsx / logo.tsx

空会话显示 Logo：**OHBABY** 品牌标题用紫金蓝三色（`brandTitle.primary` 金为主 + `brandTitle.secondary` 紫 + `brandTitle.tertiary` 蓝点缀，呼应 logo 金铠甲/紫襁褓/天蓝背景；如 `OH` 金 · `BA` 紫 · `BY` 蓝）。非空时极简一行。配色全取 `theme`，留作与 logo 美化对齐。

### spinner.tsx

运行中（`runtime.kind === "running"`）显示 `theme.spinner` 旋转帧，**颜色在金/紫间逐帧交替**（湖人紫金，呼应 logo）；工具 `▸` running 图标用 `tool.running`（紫），同色系。

### footer.tsx

**删除**。

---

## C. app.tsx 与 hooks

### hooks/use-global-keys.ts

把 `Shift+Tab`（切权限模式）、`Ctrl+C`（abort/exit）从 app.tsx 抽出为 hook，输入 `{ state, client, store, exit }`，便于单测。行为与现状等价。

### app.tsx

```tsx
<ThemeProvider value={detectTheme()}>   // 默认暗
  <Box flexDirection="column">
    <Header/>
    <MessageList/>            // <Static>
    <DialogManager/>
    <Prompt/>                 // editor + 状态行
  </Box>
</ThemeProvider>
```
事件订阅/退出/catalog/快照逻辑保留。

---

## D. dialogs/

逻辑不动，颜色换 `theme.*`：选中项品牌金 `gold`、边框 `border`、危险操作 `red`、标题 `text.strong`。`manager.tsx` 编排不变。
