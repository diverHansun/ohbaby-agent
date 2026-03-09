# Components 组件层概述

## 一、定位

组件层提供 UI 模块中所有可复用的渲染单元，使用 React + Ink 构建。组件层不包含业务逻辑，只负责接收数据并渲染；交互事件通过回调或 Context 传递给上层处理。

对应职责追溯：goals-duty.md G5（组件化与性能）、G4（职责分离）。

## 二、组件分类

```
components/
├── message/               # 消息组件（类型路由模式）
│   ├── MessageList        # 虚拟化消息列表
│   ├── HistoryItemDisplay # 消息类型路由器
│   ├── UserMessage        # 用户消息
│   ├── AssistantMessage   # AI 消息（内部按 Part 类型路由）
│   └── SystemMessage      # 系统消息（按 kind 分发）
│
├── prompt/                # 输入组件
│   ├── Prompt             # 主输入框（基于 Ink TextInput）
│   └── Completion         # Inline 自动补全建议
│
├── dialogs/               # 弹窗组件（队列管理模式）
│   ├── DialogManager      # 弹窗队列管理器 + 类型路由分发
│   ├── PermissionDialog   # 权限确认弹窗
│   ├── ModelDialog        # 模型选择弹窗
│   ├── SessionDialog      # 会话选择弹窗
│   └── ConfirmDialog      # 通用确认弹窗
│
├── shared/                # 通用基础组件
│   ├── VirtualizedList    # 虚拟化列表（核心渲染引擎）
│   ├── ScrollableList     # 可滚动选择列表（弹窗内使用）
│   ├── Collapsible        # 可折叠容器
│   ├── MaxSizedBox        # 高度限制容器
│   ├── Spinner            # 加载旋转动画（braille dots）
│   ├── LoadingIndicator   # 加载指示器（Spinner + 剑图标）
│   ├── TipsBlock          # 首页引导提示块
│   ├── Typewriter         # 打字机逐字效果
│   └── DiffRenderer       # 文件差异渲染器
│
├── StatusBar.tsx          # 状态栏（底部固定）
└── Logo.tsx               # Logo 展示
```

## 三、设计模式

组件层使用以下核心设计模式，每种模式在特定子目录中应用：

| 设计模式 | 应用位置 | 解决的问题 |
|---------|---------|-----------|
| 类型路由 | message/ | 按消息角色和 Part 类型分发到独立组件 |
| 队列管理 | dialogs/ | 多弹窗按顺序显示，避免叠加错位 |
| 虚拟化 | shared/VirtualizedList | 长列表只渲染可见区域，保证性能 |
| 复合组件 | dialogs/ | 共享弹窗基础结构，内容各异 |

## 四、组件间依赖关系

```
StatusBar ← ConfigContext, SessionContext
Prompt ← useInput, useHistory, useKeypress
DialogManager ← AppStateContext, AppActionsContext
MessageList ← SessionContext, shared/VirtualizedList
LoadingIndicator ← AppStateContext, shared/Spinner
```

依赖方向始终为：业务组件 --> 通用组件（shared/），不允许反向依赖。

## 五、文档索引

| 子目录/文件 | 文档 | 说明 |
|------------|------|------|
| message/ | [message/index.md](./message/index.md) | 消息组件，类型路由模式 |
| prompt/ | [prompt/index.md](./prompt/index.md) | 输入框组件 |
| dialogs/ | [dialogs/index.md](./dialogs/index.md) | 弹窗组件，队列管理模式 |
| shared/ | [shared/index.md](./shared/index.md) | 通用基础组件 |
| StatusBar | [status-bar.md](./status-bar.md) | 底部状态栏 |

## 六、设计原则

1. **渲染与逻辑分离**：组件只负责数据渲染和用户交互收集，业务逻辑封装在 hooks 中
2. **单向数据流**：数据从 Context 流向组件，事件通过回调向上传递
3. **最小化 Context 依赖**：每个组件只读取自身需要的 Context 字段
4. **shared 组件零 Context**：通用基础组件不依赖任何业务 Context，通过 Props 接收数据

## 七、文档自检

- [x] 组件分类完整，覆盖 architecture.md 中定义的所有组件
- [x] 设计模式与 architecture.md 一致（类型路由、队列管理、虚拟化、复合组件）
- [x] 组件间依赖关系清晰，无循环依赖
- [x] shared 组件的零 Context 原则已声明
- [x] 各子目录职责边界明确
