# Views 视图层概述

## 一、定位

视图层（Views）负责填充 DefaultLayout 的内容区域。每个 View 对应一个独立的页面级场景，包含该场景所需的组件组合和数据绑定。

视图层与布局层的分工：布局决定"屏幕结构"，视图决定"内容区域显示什么"。Prompt、StatusBar、LoadingIndicator 均由布局管理，视图不需要关心。

对应职责追溯：goals-duty.md D2（视图管理）。

## 二、视图列表

| 视图 | 文档 | 场景 | Context 依赖 |
|------|------|------|-------------|
| HomeView | [home-view.md](./home-view.md) | 应用启动首屏 | 无 |
| ChatView | [chat-view.md](./chat-view.md) | 对话交互主界面 | TuiStore `useMessages()` |
| HelpView | [help-view.md](./help-view.md) | 快捷键与命令帮助 | TuiStore `useCommandCatalog()` |

## 三、Router 路由机制

### 3.1 路由组件

Router 是视图层的入口组件，位于 `views/Router.tsx`。它读取 `AppStateContext.view.current`，根据当前视图标识返回对应的 View 组件。

Router 是纯函数组件，不持有内部状态，完全由 AppStateContext 驱动。

### 3.2 视图切换触发

视图切换通过 `AppActionsContext` 提供的 `navigateTo()` 和 `goBack()` 方法实现：

| 场景 | 触发位置 | 动作 |
|------|---------|------|
| 应用启动 | 初始状态 | `view.current = 'home'` |
| 用户首次提交输入 | useInput hook | `navigateTo('chat')` |
| 打开帮助视图 | useKeyboard 或全局帮助入口 | `navigateTo('help')` |
| 带 `--resume` 参数启动 | App 初始化逻辑 | 直接设置 `view.current = 'chat'` |
| 按 Esc 返回 | useKeyboard hook | `goBack()`（回到 `view.previous`） |

### 3.3 路由规则

- `view.current` 决定当前渲染的视图
- `view.previous` 记录上一个视图，供 `goBack()` 使用
- `goBack()` 在 `previous` 为空时不执行任何操作
- 不支持任意跳转历史栈，仅保留一级回退

### 3.4 Router 的位置

Router 在 App.tsx 中作为 DefaultLayout 的 children 传入：

```
App.tsx
  └── ...Providers...
        └── DefaultLayout
              └── Router        ← children
                    ├── HomeView
                    ├── ChatView
                    └── HelpView
```

Router 不在 DefaultLayout 内部引用，而是通过 children 注入，保持布局与路由的解耦。

## 四、设计原则

### 4.1 视图职责单一

每个 View 只负责组合该场景所需的组件。视图不包含业务逻辑（由 hooks 处理），不管理输入（由 Prompt 处理），不控制弹窗（由 DialogManager 处理）。

### 4.2 视图不感知布局

视图组件不引用 DefaultLayout，不设置 Prompt、StatusBar 或 LoadingIndicator。视图只关心内容区域内的渲染。

### 4.3 最小 Context 依赖

- HomeView：零 Context 依赖，纯展示
- ChatView：仅依赖 TuiStore messages selector
- HelpView：仅依赖 TuiStore command catalog selector

视图不直接读取 AppActionsContext（动作由 hooks 触发），不读取 KeypressContext 或 MouseContext（输入由 hooks 处理）。

### 4.4 可扩展

新增视图只需三步：
1. 在 `views/` 目录新建 View 组件
2. 在 Router 中添加对应的 case 分支
3. 在 `data-model.md` 的 `ViewType` 中新增视图标识

不需要修改 DefaultLayout、Prompt、StatusBar 等组件。

## 五、文档自检

- [x] 视图层存在的理由可以用一句话说明
- [x] 与布局层的职责边界清晰
- [x] Router 路由机制完整，切换触发点已枚举
- [x] 每个视图的 Context 依赖已明确
- [x] 新增视图的扩展路径清晰
- [x] 设计原则可追溯到 goals-duty.md（D2、G4、G6）
