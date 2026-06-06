# 02 — 实施计划（主文档）

日期: 2026-06-05
更新: 2026-06-06

本文档给出架构分层、目录结构、依赖、范围与实施顺序。
配色细节见 [02a-theme-and-colors.md](02a-theme-and-colors.md)，
render 层与组件层细节见 [02b-render-and-components.md](02b-render-and-components.md)。
2026-06-06 后的最终实施口径以
[05-a-c-contract-appshell-viewport-plan.md](05-a-c-contract-appshell-viewport-plan.md)
为准。

## 1. 架构分层

六层，下层不知上层；组件只引语义 token，不写死颜色。

```
契约层    ohbaby-sdk ── UiContextWindowUsage / message lifecycle / CoreAPI query
  │
后端层    ohbaby-agent ── context window usage 服务、memory cache、runtime event
  │
应用层    app.tsx ── 订阅 store、装配 AppShell、全局键盘
  │
Shell层   layout/ ── AppShell / viewport metrics / ContentColumn / MessageFlow
  │
组件层    components/ ── Ink 骨架：Box / 缩进 / 对齐 / <Static> / 边框
  │       header · message · tool · prompt(editor) · status · dialogs
  │
原语层    render/ ── pi 风格"行渲染器"，吃数据吐 ANSI string[]
  │       markdown · highlight · wrap · usage   （diff 延后）
  │
主题层    theme/ ── 语义 token + 终端亮暗检测；所有颜色的唯一来源
  │
保留层    slash-commands/ ── 行为保持；store/ selectors 有边界扩展
```

**混合式渲染管线的边界**：
- `render/` = 纯函数，输入数据 + theme + width，输出**已折行的 ANSI 字符串数组**。零 React，可脱离 Ink 单测。
- `components/` = Ink 组件，负责布局/缩进/`<Static>`/把 `render/` 产出塞进单个 `<Text>`。
- 约定：富文本块由 `render/` 自己 wrap 到 `width`，交给 Ink 的 `<Text wrap="end">`，避免 Ink 二次折行破坏对齐。

## 2. 目标目录结构

```
tui/
  app.tsx                      装配 + ThemeProvider；逻辑下沉
  hooks/
    use-global-keys.ts         Shift+Tab / Ctrl+C 全局键（从 app 抽出，可测）
  layout/
    metrics.ts                 终端宽高 → contentWidth / padding / compact
    app-shell.tsx              opencode 式整体页面壳
    content-column.tsx         统一内容宽度与左右 padding
    message-flow.tsx           <Static> 封装，统一历史流宽度与缩进
  theme/
    colors.ts                  调色板 raw palette（唯一改色入口）
    tokens.ts                  语义 token（Theme 接口 + dark/light 两套）
    detect.ts                  终端亮暗检测，默认回退暗色
    index.ts                   ThemeProvider / useTheme
  render/                      纯函数，数据 → string[](ANSI)
    markdown.ts                marked 解析 → ANSI 行（借鉴 pi）
    highlight.ts               cli-highlight 包装
    wrap.ts                    可见宽度感知换行/截断（处理 ANSI）
    usage.ts                   context window usage 格式化
    diff.ts                    [延后] old/new → 着色 diff 行
  components/
    header.tsx  logo.tsx  status-bar.tsx
    command/
      status-panel.tsx         /status 轻边框多行 panel
    message/
      message-list.tsx         <Static> 流式
      message-block.tsx        单条消息：主题驱动装饰 + parts
      parts/
        markdown-part.tsx
        reasoning-part.tsx
        tool-part.tsx          调工具渲染器注册表
      tool/
        registry.ts            工具名 → 渲染器
        renderers/
          read.ts write.ts edit.ts bash.ts grep.ts glob.ts
          todo.ts task.ts default.ts
    prompt/
      index.tsx                装配 editor + 状态行
      editor.tsx               多行编辑器（Ink 视图）
      editor-reducer.ts        编辑器状态机（纯函数，可测）
      completion.tsx           保留，套主题
    spinner.tsx                运行中动画
  dialogs/                     保留逻辑，套主题 token
  store/  slash-commands/      不动
```

删除: `components/footer.tsx`（提示行不再需要）。

SDK/agent 侧新增建议:

```
packages/ohbaby-sdk/src/context-window.ts
packages/ohbaby-agent/src/core/context/context-window-usage.ts
```

## 3. 新增依赖

| 包 | 用途 |
|---|---|
| `marked` | markdown token 解析（kimi/pi 同款） |
| `cli-highlight` | 代码块语法高亮（kimi 同款）。见下方维护风险 |
| `string-width` | 可见宽度计算（Ink 已间接带，显式声明） |
| `diff` | **延后**，做 diff 渲染时再加 |

> **cli-highlight 维护风险（FYI，本批次不处理）**：`cli-highlight` 基于 highlight.js，最后大幅更新约 2021 年，新语言支持可能滞后。第一版够用。为隔离风险，语法高亮统一封装在 `render/highlight.ts` 单一接口 `highlightCode()` 之后——将来若换 `shiki` 或直接引更活跃的 hljs 封装，只改这一个文件，不影响 markdown/组件层。

`figlet` 不作为运行时依赖。如需要，只能作为开发期/生成期工具，用来更新静态
OHBABY ANSI logo 文本。

## 4. 第一版范围

### 做
1. SDK 契约：`UiContextWindowUsage`、message lifecycle、
   `CoreAPI.getContextWindowUsage`、`context.window.updated`。
2. agent context window usage 服务：完整模型 context window 口径、session memory cache、
   runtime event mapping、`/status` 数据字段。
3. TUI store/selectors：active session usage、refresh 失败保留旧缓存、warning notice。
4. theme 三件套（colors / tokens / detect），暗亮两套，默认暗。
5. `layout/`：AppShell、viewport metrics、ContentColumn、MessageFlow。
6. `render/`：markdown + highlight + wrap + usage formatter。
7. 消息渲染：去角色头文字、历史用户左竖线、assistant markdown、reasoning 完成后折叠。
8. 工具渲染：注册表 + 每工具单行 `header()`，running spinner，完成后无图标。
9. 多行编辑器：reducer + 视图。
10. PromptDock：当前输入背景块，`>` 光标感符号，mode 只显示 `auto/plan`。
11. 状态行右侧显示当前 session context window usage；无数据留空。
12. `/status` 轻边框 panel。
13. OHBABY 静态 ASCII/ANSI logo。
14. dialogs 套主题。
15. app 装配 + `useGlobalKeys` 抽离。

### 延后（不在本批次）
- `render/diff.ts` + 工具体 `Ctrl+O` 展开。
- 费用/cost 展示。
- 草稿输入 token 展示。
- 编辑器跳词移动、Delete 键。
- 自定义主题文件 / 主题热切换。
- 完整应用内虚拟滚动、滚动条、历史搜索、overlay stack。

## 5. 实施顺序（建议分阶段，每阶段可独立测试）

1. **临时分支与基线**：使用 `codex/tui-improve-1-a-c`，跑现有测试并记录基线。
2. **SDK contract**：新增 DTO、事件、query API、message lifecycle。
3. **agent context window**：新增 usage service、memory cache、runtime event mapping、
   `/status` 字段。
4. **real-session mapping gate**：用真实 session 验证
   `ContextUsage -> UiContextWindowUsage`，确认完整 context window 口径正确。
5. **TUI data layer**：store、snapshot normalize、selector、`render/usage.ts`。
6. **theme 层**：colors / tokens / detect / ThemeProvider。
7. **layout shell**：metrics / AppShell / ContentColumn / MessageFlow。
8. **render/wrap**：可见宽度换行/截断（地基，TDD）。
9. **render/markdown + highlight**：TDD「输入文本 → 期望行」。
10. **message-block + parts**：用户竖线、assistant markdown、reasoning lifecycle 折叠。
11. **工具渲染器注册表 + renderers**：running spinner，完成后无图标且保留 leading slot。
12. **editor-reducer**：状态机 TDD（光标/多行/历史草稿/粘贴）。
13. **editor.tsx + PromptDock 装配**：契约测试按键 → 视图。
14. **status-bar + StatusPanel + 删 footer**。
15. **OHBABY logo + empty state**。
16. **dialogs 套主题**。
17. **app.tsx 装配 + useGlobalKeys**：契约测试保持现有行为等价。
18. **验收**：unit、contract、integration、真实 API e2e、子代理审查。

## 6. 不变量（重做必须保持）

- app 的事件订阅、退出、catalog 刷新、快照拉取行为等价（01 文档末列举）。
- 全局键 `Shift+Tab` / `Ctrl+C` 语义不变。
- slash 补全交互（↑/↓ 选候选、Tab 补全、Enter 提交）不回退。
- SDK/agent/store 只做本文档定义的契约扩展，不做额外语义漂移。
- TUI 不自行实现 token 估算。
- context window 百分比使用完整模型 context window 作为分母，不使用 input budget ratio。
