# 03 — 项目借鉴（opencode / kimi-code / pi-tui）

日期: 2026-06-05

记录我们从两个参考项目和 pi-tui 借鉴了什么、如何取舍。原则：**借鉴设计思路，不引入运行时依赖**（不依赖 pi-tui，保留 Ink）。

参考路径：
- `D:/Projects/Code-cli/kimi-code`
- `D:/Projects/Code-cli/opencode`
- `pi/`（vendore 进本仓的 pi-tui 源码，仅读不依赖）

---

## kimi-code

技术栈：`@earendil-works/pi-tui`（非 React）+ `cli-highlight` + `chalk`。

### 借鉴

1. **主题两层结构**（`apps/kimi-code/src/tui/theme/colors.ts`）：
   - private raw palette（`gray50/blue400/...`，裸 hex 常量）
   - exported 语义 `ColorPalette`（`text/textMuted/success/diffAdded/roleUser/...`）
   - → 直接对应我们的 `colors.ts`（raw）+ `tokens.ts`（语义）。
2. **亮暗双主题 + WCAG 对比度调参**（light 值对 `#FFFFFF` ≥ 4.5:1）。→ 我们做暗/亮两套。
3. **角色语义化**：`roleUser / roleAssistant / roleThinking / roleTool` 用颜色而非边框区分。→ 我们去掉文字角色头、用颜色/装饰。
4. **theme 目录划分**：`colors / styles / detect / index`。→ 我们 `colors / tokens / detect / index`。
5. **markdown 用 `marked` + `cli-highlight`**，不自己写解析器。→ 同。

### 不采用
- pi-tui 运行时（differential rendering 框架）。我们留在 Ink。
- kimi 的 reverse-rpc / native 模块（与渲染无关）。

---

## opencode

TUI 在 **SolidJS + @opentui**（自研终端渲染引擎；`packages/opencode/src/cli/cmd/tui/`，`.tsx` + `@opentui/core` / `@opentui/solid` / `opentui-spinner` / `solid-js`）。
渲染框架与我们不同（我们留在 Ink），但其**主题体系**（JSON，`packages/opencode/src/cli/cmd/tui/context/theme/*.json`）值得借鉴。

### 借鉴

1. **step 色阶**（`darkStep1..12` 从 `#0a0a0a` 到 `#eeeeee`）+ 语义映射（`primary/secondary/accent/error/warning/success/info/text/textMuted/...`）。→ 启发我们的语义 token 命名与降级层级。
2. **One Dark 系 syntax 配色** + **橙色 primary `#fab283`**：启发我们用暖色品牌主色。→ 但我们最终**品牌色对齐自家 logo**（金 `#D4A24F` / 紫 `#B9A3E3` / 天蓝 `#6E9FCE` 暖调，暗色金蓝已降亮护眼），syntax token 仍参考 One Dark 思路。见 02a。
3. **消息样式**：用户消息左竖线 + 背景块，AI 消息无装饰直接渲染（截图参考）。→ 我们暗色主题采用此风。
4. **状态栏 token/cost 展示**（`37.8K (4%) · $0.07`）。→ 我们预留右侧槽位，数据待后端（problem-lists）。
5. **多内置主题**（catppuccin/dracula/gruvbox/...）的可扩展结构。→ 我们第一版只做暗/亮两套，但 token 结构为将来留口。

### 不采用
- SolidJS / @opentui 运行时。
- 第一版不做多主题切换 / 用户自定义主题文件。

---

## pi-tui（pi/packages/tui）

差分渲染 TUI 库，自带组件。**只读源码借鉴算法，不依赖**。

### 借鉴

1. **markdown 组件**（`src/components/markdown.ts`）：`marked` token → ANSI 行的完整实现（标题/列表/引用/代码块/表格/链接、`MarkdownTheme` 函数式着色、`highlightCode` 钩子、`codeBlockIndent`）。→ 我们的 `render/markdown.ts` 直接参照其 token 处理与 wrap 策略。
2. **wrap 算法**（`src/utils.ts` 的 `visibleWidth / wrapTextWithAnsi`）：ANSI 感知折行。→ 我们的 `render/wrap.ts`。
3. **editor 组件**（`src/components/editor.ts` / `editor-component.ts`）：多行、光标、kill-ring、undo-stack 思路。→ 启发 `editor-reducer.ts`（我们第一版只取光标/多行/历史子集）。
4. **autocomplete / select-list**：补全与选择列表交互。→ 对照我们现有 slash 补全，保持不回退。

### 不采用
- 整个 pi-tui 渲染运行时、native 模块。
- 第一版不做 image / kill-ring / undo-stack（YAGNI）。

---

## 取舍总览

| 能力 | 借鉴来源 | 我们的实现 |
|---|---|---|
| 主题两层 | kimi colors.ts | `colors.ts` + `tokens.ts` |
| 色值 | opencode One Dark 启发 + **logo 对齐** | `colors.ts` 金/紫/蓝暖调 |
| 暗亮双主题 + detect | kimi theme/ | `detect.ts` 默认暗 |
| markdown→ANSI | pi markdown.ts | `render/markdown.ts` |
| ANSI wrap | pi utils.ts | `render/wrap.ts` |
| 语法高亮 | kimi cli-highlight | `render/highlight.ts` |
| 消息样式 | opencode(暗)/claude-code(亮) | 主题驱动装饰 |
| 多行编辑器 | pi editor | `editor-reducer.ts` |
| 状态栏 token | opencode | 预留槽位（后端待补） |
| 渲染运行时 | — | **保留 Ink，不引 pi-tui** |
