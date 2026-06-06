# 02 — 实施计划（主文档）

日期: 2026-06-05

本文档给出架构分层、目录结构、依赖、范围与实施顺序。
配色细节见 [02a-theme-and-colors.md](02a-theme-and-colors.md)，
render 层与组件层细节见 [02b-render-and-components.md](02b-render-and-components.md)。

## 1. 架构分层

四层，下层不知上层；组件只引语义 token，不写死颜色。

```
应用层    app.tsx ── 订阅 store、装配布局、全局键盘            （保留，瘦身）
  │
组件层    components/ ── Ink 骨架：Box / 缩进 / 对齐 / <Static> / 边框
  │       header · message · tool · prompt(editor) · status · dialogs
  │
原语层    render/ ── pi 风格"行渲染器"，吃数据吐 ANSI string[]
  │       markdown · highlight · wrap   （diff 延后）
  │
主题层    theme/ ── 语义 token + 终端亮暗检测；所有颜色的唯一来源
  │
（不动）  store/ · slash-commands/ · ohbaby-sdk 类型
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
  theme/
    colors.ts                  调色板 raw palette（唯一改色入口）
    tokens.ts                  语义 token（Theme 接口 + dark/light 两套）
    detect.ts                  终端亮暗检测，默认回退暗色
    index.ts                   ThemeProvider / useTheme
  render/                      纯函数，数据 → string[](ANSI)
    markdown.ts                marked 解析 → ANSI 行（借鉴 pi）
    highlight.ts               cli-highlight 包装
    wrap.ts                    可见宽度感知换行/截断（处理 ANSI）
    diff.ts                    [延后] old/new → 着色 diff 行
  components/
    header.tsx  logo.tsx  status-bar.tsx
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

## 3. 新增依赖

| 包 | 用途 |
|---|---|
| `marked` | markdown token 解析（kimi/pi 同款） |
| `cli-highlight` | 代码块语法高亮（kimi 同款）。见下方维护风险 |
| `string-width` | 可见宽度计算（Ink 已间接带，显式声明） |
| `diff` | **延后**，做 diff 渲染时再加 |

> **cli-highlight 维护风险（FYI，本批次不处理）**：`cli-highlight` 基于 highlight.js，最后大幅更新约 2021 年，新语言支持可能滞后。第一版够用。为隔离风险，语法高亮统一封装在 `render/highlight.ts` 单一接口 `highlightCode()` 之后——将来若换 `shiki` 或直接引更活跃的 hljs 封装，只改这一个文件，不影响 markdown/组件层。

## 4. 第一版范围

### 做
1. theme 三件套（colors / tokens / detect），暗亮两套，默认暗。
2. `render/`：markdown + highlight + wrap。
3. 消息渲染：去角色头文字、主题驱动装饰、markdown 正文、reasoning 暗色。
4. 工具渲染：注册表 + 每工具单行 `header()`，折叠不展开。
5. 多行编辑器：reducer + 视图。
6. 状态行重做（左信息 + 右 token 槽位预留）。
7. spinner + 消息视觉层次（间距/缩进节奏）。
8. dialogs 套主题。
9. app 装配 + `useGlobalKeys` 抽离。

### 延后（不在本批次）
- `render/diff.ts` + 工具体 `Ctrl+O` 展开。
- 状态行 token/cost（依赖后端，见 problem-lists）。
- 编辑器跳词移动、Delete 键。
- 自定义主题文件 / 主题热切换。
- **应用内交互式滚动 / viewport 窗口**。第一版历史走 `<Static>` 烧入终端 scrollback，由终端自身滚动；不实现 PgUp/PgDn 应用内滚动。

## 5. 实施顺序（建议分阶段，每阶段可独立测试）

1. **theme 层**：colors / tokens / detect / ThemeProvider。先单测 detect 回退逻辑与 token 解析。
2. **render/wrap**：可见宽度换行/截断（地基，TDD）。
3. **render/markdown + highlight**：TDD「输入文本 → 期望行」。
4. **message-block + parts**：接 render，主题驱动装饰；契约测试 AI/用户/reasoning 渲染。
5. **工具渲染器注册表 + renderers**：每工具 header 单测。
6. **editor-reducer**：状态机 TDD（光标/多行/历史草稿/粘贴）。
7. **editor.tsx + prompt 装配**：契约测试按键 → 视图。
8. **status-bar 重做 + 删 footer**。
9. **dialogs 套主题**。
10. **app.tsx 装配 + useGlobalKeys**：契约测试保持现有行为等价。
11. **验收**：`/run` 真实 PowerShell 跑关键场景（见 04）。

## 6. 不变量（重做必须保持）

- app 的事件订阅、退出、catalog 刷新、快照拉取行为等价（01 文档末列举）。
- 全局键 `Shift+Tab` / `Ctrl+C` 语义不变。
- slash 补全交互（↑/↓ 选候选、Tab 补全、Enter 提交）不回退。
- store / SDK 类型零改动。
