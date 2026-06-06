# TUI Improve 1 — 总览

日期: 2026-06-05
更新: 2026-06-06
范围: `packages/ohbaby-cli/src/tui`、`packages/ohbaby-sdk/src`、
`packages/ohbaby-agent/src`
状态: A+C 方案已收口，待维护者审核文档后实施

## 目标

把 ohbaby TUI 从"直接输出文本"的原始渲染，升级为有**主题系统 + 富文本渲染 + 工具富渲染 + 多行输入编辑器**的产品级终端界面，作为 MVP 的收尾。

2026-06-06 修订后，本批次采用 **A+C**：Contract-first + AppShell 增量重构
+ 部分 viewport/scroll shell 重写。底层事件溯源模型继续保留，但允许对
`ohbaby-sdk`、`ohbaby-agent`、TUI store/selectors 做有边界的契约升级，用于
context window usage 和 message lifecycle。

## 核心决策（讨论结论）

| 维度 | 决策 |
|---|---|
| 渲染框架 | **保留 Ink + React 19**。`pi/` 仅作源码参考，不作运行时依赖 |
| 总体路线 | **A+C**：Contract-first + AppShell 增量重构 + 有边界的 viewport/scroll shell 重写。详见 [05-a-c-contract-appshell-viewport-plan.md](05-a-c-contract-appshell-viewport-plan.md) |
| 布局形态 | opencode 式 `AppShell`。统一 `contentWidth`、prompt dock、message flow、status panel 与 empty state。历史仍使用 Ink `<Static>` + 终端原生 scrollback，但组件抽象命名为 `MessageFlow` |
| 渲染管线 | **混合式**：Ink 管骨架布局（Box/缩进/`<Static>`），pi 风格"行渲染器"管富文本块内部（产 ANSI 字符串） |
| 主题 | 暗/亮两套，**默认暗色**（PowerShell 黑底）；**配色对齐 logo**（金 primary / 紫 accent / 天蓝 info 暖调）；`colors.ts` 集中维护色值。running spinner = 金紫交替（呼应 logo）。**禁渲染 you/ohbaby 文字角色头** |
| 消息样式 | 不出现 you/ohbaby 文字。历史用户消息只有左竖线；assistant 直接 markdown；当前 prompt 使用背景块突出 |
| 工具渲染 | 每工具单独渲染器，第一版只单行折叠。运行中左侧 spinner，完成后只留工具名与摘要，**不使用 `✓` / `✗`** |
| 输入 | 多行编辑器（reducer 可测）：Home/End+←→、Shift+Enter 换行/Enter 提交、Backspace、Ctrl+U、↑/↓ 历史（保留草稿）、批量粘贴 |
| 模式显示 | UI 只显示 `auto` / `plan`，不显示 `ask` / `build`；模型不常驻显示，只在 `/status` 中查看 |
| 状态行 | 左 `mode·permission·session_id`，右当前 session context window usage，例如 `38.4K / 1M (4%)`；无数据留空 |
| `/status` | 新增轻边框多行 panel，包含 runtime、session、model、tools、context window 等 |
| Context window | 本批次完整纳入。TUI 只消费后端字段，不自行估算 token；不做费用 |
| Reasoning | 默认灰色可见；对应 assistant message 完成后折叠为一行 `Thought`，基于 message lifecycle 字段判断 |
| footer 提示行 | **删除** |

## 第一版范围 / 明确延后

**做**: SDK/agent context window 契约、message lifecycle、AppShell/MessageFlow、
theme 三件套、markdown+语法高亮、工具单行折叠渲染、多行编辑器、spinner、
reasoning 折叠、status panel、OHBABY ANSI logo、dialogs 套主题。

**延后（YAGNI）**:
- `render/diff.ts` 与工具体展开（`Ctrl+O`）—— 工具第一版不渲染体。
- 费用统计。
- 草稿输入 token 显示。
- 编辑器跳词移动（Alt+←→）、Delete 键。
- 用户自定义主题文件 / 主题热切换命令。
- 完整应用内虚拟滚动、滚动条、历史搜索、overlay stack。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-code-status.md](01-code-status.md) | 代码现状：技术栈、目录、各模块职责、问题清单、数据契约 |
| [02-implementation-plan.md](02-implementation-plan.md) | 实施计划主文档：架构分层、目录结构、实施顺序、依赖、范围 |
| [02a-theme-and-colors.md](02a-theme-and-colors.md) | 配色方案：colors.ts 调色板 + 两套主题语义 token（**便于单独调色**） |
| [02b-render-and-components.md](02b-render-and-components.md) | render 层 + 组件层 + 编辑器 + 工具渲染器 详细设计 |
| [03-references.md](03-references.md) | opencode / kimi-code / pi-tui 借鉴与取舍 |
| [04-test-and-acceptance.md](04-test-and-acceptance.md) | 测试分层、各模块测试点、验收场景、子代理审核 |
| [05-a-c-contract-appshell-viewport-plan.md](05-a-c-contract-appshell-viewport-plan.md) | A+C 最终方案：SDK/agent 契约、AppShell、viewport/scroll shell、实施阶段 |

## 实施后

完成实施后用**子代理**做测试审核（运行测试 + 代码审查 + 真实 PowerShell 验收）。
