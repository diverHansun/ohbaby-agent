# Shared 通用组件概述

## 一、定位

shared/ 提供可复用的基础 UI 构建块，被 message/、dialogs/、prompt/ 等业务组件引用。所有 shared 组件遵循**零 Context 依赖**原则，仅通过 Props 接收数据和回调，不直接读取任何业务 Context。

对应职责追溯：goals-duty.md G5（组件化与性能）。

## 二、组件分类与索引

### 列表组件

| 组件 | 文档 | 职责 | 使用者 |
|------|------|------|--------|
| VirtualizedList | [virtualized-list.md](./virtualized-list.md) | 虚拟化渲染，只渲染可见区域 | MessageList |
| ScrollableList | [scrollable-list.md](./scrollable-list.md) | 固定高度可滚动列表的"焦点 + 滚动窗口"低层 primitive | SelectableList 内部使用 |
| SelectableList | [selectable-list.md](./selectable-list.md) | "select-one"场景的呈现 primitive：搜索 / 分组 / current 标记 / tone 着色 | ModelDialog, SessionDialog 等 select-one renderer |

### 容器组件

| 组件 | 文档 | 职责 | 使用者 |
|------|------|------|--------|
| Collapsible | [collapsible.md](./collapsible.md) | 可折叠/展开容器 | ReasoningPart |
| MaxSizedBox | [max-sized-box.md](./max-sized-box.md) | 限制最大高度，超出截断 | ToolPart 结果显示 |

### 动效组件

| 组件 | 文档 | 职责 | 使用者 |
|------|------|------|--------|
| Spinner | [spinner.md](./spinner.md) | Braille dots 旋转动画 | LoadingIndicator, ToolPart |
| Typewriter | [typewriter.md](./typewriter.md) | 文本逐字显示效果 | HomeView 欢迎文本 |

### 内容渲染组件

| 组件 | 文档 | 职责 | 使用者 |
|------|------|------|--------|
| DiffRenderer | [diff-renderer.md](./diff-renderer.md) | 文件差异渲染 | edit_file 工具结果 |

### 复合组件（无独立文档）

| 组件 | 职责 | 说明 |
|------|------|------|
| LoadingIndicator | Spinner + 剑图标 + 文案 | 由 DefaultLayout 使用，详见 layouts/default-layout.md |
| TipsBlock | 首页引导提示列表 | 由 HomeView 使用，详见 views/home-view.md |
| Logo | Logo 文本展示 | 纯静态组件，无需独立文档 |

## 三、设计原则

1. **零 Context 依赖**：所有 shared 组件通过 Props 接收数据，不 import 任何 Context
2. **纯展示或受控交互**：组件自身不管理业务状态，交互结果通过回调传出
3. **组合优于继承**：通过 children 和 renderItem 等 Props 实现组合
4. **终端环境适配**：所有组件基于 Ink 原语（Box, Text），不使用 Web DOM API

## 四、文档自检

- [x] 所有 shared 组件已索引，含使用者信息
- [x] 零 Context 原则已声明
- [x] 无独立文档的组件已说明原因和参考位置
- [x] 组件分类清晰（列表、容器、动效、内容渲染）
- [x] SelectableList 与 ScrollableList 的职责边界已在索引中标注
