# HomeView 首页视图

## 一、职责

HomeView 是应用启动时的首屏视图，负责展示品牌标识和操作引导信息。它是用户看到的第一个界面，引导用户快速了解基本操作并开始对话。

对应职责追溯：goals-duty.md D2（视图管理 - HomeView）。

## 二、视觉结构

```
+-------------------------------------+
|                                     |
|                                     |
|         [ASCII Logo]                |
|                                     |
|         Your AI coding assistant    |
|                                     |
|         Tips:                       |
|         /help       Show commands   |
|         Shift+Tab   Cycle mode      |
|         Ctrl+C x2   Interrupt       |
|                                     |
|                                     |
+-------------------------------------+
|  (LoadingIndicator)                 |  -- DefaultLayout 提供
+-------------------------------------+
|  > _                                |  -- DefaultLayout 提供
+-------------------------------------+
|  StatusBar                          |  -- DefaultLayout 提供
+-------------------------------------+
```

HomeView 仅负责虚线框上方的内容区域。Prompt、StatusBar、LoadingIndicator 由 DefaultLayout 提供。

## 三、内容组成

### 3.1 Logo

ASCII 艺术字形式的品牌标识，居中显示。Logo 作为独立组件（`components/shared/Logo`），便于复用和独立替换。

### 3.2 副标题

Logo 下方显示一行简短的产品描述文字，使用弱化颜色（dimColor），不喧宾夺主。

### 3.3 Tips 引导

展示 3-5 条最常用的操作提示，帮助新用户快速上手：

| 提示项 | 说明 |
|--------|------|
| `/help` | 查看完整命令和快捷键列表 |
| `Shift+Tab` | 切换模式（ask/plan/agent） |
| `Ctrl+C x2` | 中断当前执行 |

Tips 作为独立组件（`components/shared/TipsBlock`），内容硬编码，不依赖外部数据。

## 四、组件组合

HomeView 由以下子组件组成：

| 组件 | 来源 | 数据依赖 |
|------|------|---------|
| Logo | `components/shared/Logo` | 无 |
| 副标题文本 | 内联 | 无 |
| TipsBlock | `components/shared/TipsBlock` | 无 |

整体使用纵向 Flex 布局，垂直和水平居中对齐。

## 五、设计特征

### 5.1 纯展示组件

HomeView 不读取任何 Context，不持有内部状态，不调用任何 hook。每次渲染的输出完全相同，不会因外部数据变化而重渲染。

### 5.2 不提供输入框

输入框由 DefaultLayout 中的 Prompt 组件提供，对所有视图通用。HomeView 不需要单独处理输入逻辑。

### 5.3 不展示会话列表

MVP 阶段不在首屏展示历史会话。会话管理通过 `/session` 命令完成。如果未来需要首屏会话列表，可以在 HomeView 中新增组件而不影响其他视图。

## 六、视图生命周期

```
应用启动 --> HomeView 渲染
                |
        用户提交输入（useInput）
                |
        navigateTo('chat') --> 切换到 ChatView
```

- HomeView 在用户首次提交输入后被切换走
- 如果应用带 `--resume` 参数启动，会跳过 HomeView 直接进入 ChatView
- 从 ChatView 或 HelpView 通过 `goBack()` 可以回到 HomeView（当 HomeView 是 previous 时）

## 七、文档自检

- [x] HomeView 的存在理由清晰（品牌展示 + 新手引导）
- [x] 职责边界明确：不处理输入、不管理会话、不包含业务逻辑
- [x] 零 Context 依赖，纯展示
- [x] 子组件拆分合理（Logo、TipsBlock 可复用）
- [x] 参考设计来源：gemini-cli 首屏风格
