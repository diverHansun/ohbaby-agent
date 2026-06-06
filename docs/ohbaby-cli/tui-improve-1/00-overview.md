# TUI Improve 1 — 总览

日期: 2026-06-05
范围: `packages/ohbaby-cli/src/tui`
状态: 设计已与维护者确认，待实施

## 目标

把 ohbaby TUI 从"直接输出文本"的原始渲染，升级为有**主题系统 + 富文本渲染 + 工具富渲染 + 多行输入编辑器**的产品级终端界面，作为 MVP 的收尾。

底层 `store / selectors / events / slash-commands` 事件溯源管线**保持不动**，本批次只重做渲染层。

## 核心决策（讨论结论）

| 维度 | 决策 |
|---|---|
| 渲染框架 | **保留 Ink + React 19**。`pi/` 仅作源码参考，不作运行时依赖 |
| 布局形态 | **流式追加**：历史用 Ink `<Static>` 一次性"烧入"终端 scrollback（不重绘），输入框/状态行在末尾动态区。**第一版依赖终端自身 scrollback 滚动，不做应用内交互式滚动**；viewport 窗口方案日后再议 |
| 渲染管线 | **混合式**：Ink 管骨架布局（Box/缩进/`<Static>`），pi 风格"行渲染器"管富文本块内部（产 ANSI 字符串） |
| 主题 | 暗/亮两套，**默认暗色**（PowerShell 黑底）；**配色对齐 logo**（金 primary / 紫 accent / 天蓝 info 暖调）；`colors.ts` 集中维护色值。running spinner = 金紫交替（呼应 logo）。**禁渲染 you/ohbaby 文字角色头** |
| 消息样式 | 不出现 you/ohbaby 文字。**主题驱动**装饰：暗色 opencode 风（用户左竖线、AI 无装饰）；亮色 claude-code 风（用户亮块+icon、AI 圆点） |
| 工具渲染 | 每工具单独渲染器，**第一版只单行折叠**（图标+名+主参），不暴露内部详情；`Ctrl+O` 展开留接口、第一版不实现 |
| 输入 | 多行编辑器（reducer 可测）：Home/End+←→、Shift+Enter 换行/Enter 提交、Backspace、Ctrl+U、↑/↓ 历史（保留草稿）、批量粘贴 |
| 状态行 | 左 `mode·permission·session_id`，右 token 估算槽位（数据缺，已记问题清单） |
| footer 提示行 | **删除** |

## 第一版范围 / 明确延后

**做**: theme 三件套、markdown+语法高亮、工具单行折叠渲染、多行编辑器、spinner、消息视觉层次、dialogs 套主题。

**延后（YAGNI）**:
- `render/diff.ts` 与工具体展开（`Ctrl+O`）—— 工具第一版不渲染体。
- 状态行 token/费用统计 —— 依赖后端补字段，见 `docs/problem-lists/2026-06-05-tui-status-bar-token-estimation.md`。
- 编辑器跳词移动（Alt+←→）、Delete 键。
- 用户自定义主题文件 / 主题热切换命令。
- 应用内交互式滚动 / viewport 窗口（第一版依赖终端 scrollback）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [01-code-status.md](01-code-status.md) | 代码现状：技术栈、目录、各模块职责、问题清单、数据契约 |
| [02-implementation-plan.md](02-implementation-plan.md) | 实施计划主文档：架构分层、目录结构、实施顺序、依赖、范围 |
| [02a-theme-and-colors.md](02a-theme-and-colors.md) | 配色方案：colors.ts 调色板 + 两套主题语义 token（**便于单独调色**） |
| [02b-render-and-components.md](02b-render-and-components.md) | render 层 + 组件层 + 编辑器 + 工具渲染器 详细设计 |
| [03-references.md](03-references.md) | opencode / kimi-code / pi-tui 借鉴与取舍 |
| [04-test-and-acceptance.md](04-test-and-acceptance.md) | 测试分层、各模块测试点、验收场景、子代理审核 |

## 实施后

完成实施后用**子代理**做测试审核（运行测试 + 代码审查 + 真实 PowerShell 验收）。
