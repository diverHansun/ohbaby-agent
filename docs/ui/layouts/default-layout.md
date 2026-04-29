# DefaultLayout 默认布局

## 一、职责

DefaultLayout 是应用的唯一布局组件，负责将终端屏幕划分为四个区域并管理它们的空间分配。它不关心内容区域渲染的是哪个视图，只保证区域结构稳定。

对应职责追溯：goals-duty.md D1（布局管理）、G6（布局与内容分离）。

## 二、区域结构

```
+-------------------------------------+
|                                     |
|           {children}                |  区域 1: 内容区
|        (Router 输出的 View)          |  flexGrow: 1, overflow: hidden
|                                     |
+-------------------------------------+
|  弹窗 / 加载指示器（互斥）            |  区域 2: 弹窗优先，否则加载指示器
+-------------------------------------+
|  > user input here                  |  区域 3: 输入框（固定）
+-------------------------------------+
|  /project | claude | agent | 1.2k   |  区域 4: 状态栏（固定）
+-------------------------------------+
```

### 区域说明

| 区域 | 组件 | 定位方式 | 说明 |
|------|------|---------|------|
| 内容区 | `{children}` | flexGrow: 1 | 占据所有剩余空间，内部可滚动 |
| 弹窗/加载 | DialogManager / LoadingIndicator | 条件渲染 | 有弹窗时显示弹窗，否则显示加载指示器 |
| 输入框 | Prompt | 固定高度 | 始终可见，钉在底部 |
| 状态栏 | StatusBar | 固定高度 | 始终可见，位于最底行 |

## 三、固定底部策略

DefaultLayout 采用 Flex 纵向布局（`flexDirection: column`），整体高度占满终端（`height: 100%`）。

- 内容区设置 `flexGrow: 1` 和 `flexShrink: 1`，自适应填充 Prompt 和 StatusBar 之外的所有空间
- 内容区设置 `overflow: hidden`，防止内容溢出将底部组件推出屏幕
- Prompt 和 StatusBar 不设置 flexGrow，保持自身内容高度
- 加载指示器在 Prompt 正上方条件渲染，不占用固定空间

**效果**：无论内容区有多少内容（空白或长对话），Prompt 和 StatusBar 始终固定在终端窗口底部。

## 四、加载指示器

### 4.1 品牌标识

加载指示器使用剑图标（sword）作为品牌标识元素，左侧配合 braille dots spinner 实现旋转效果。

### 4.2 显示规则

加载指示器由 `AppStateContext.loading` 驱动：

| 条件 | 显示内容 |
|------|---------|
| `loading.phase = 'idle'` | 不渲染（隐藏） |
| `loading.phase = 'thinking'` | `[spinner] [sword] Thinking...` |
| `loading.phase = 'executing'` | `[spinner] [sword] Executing: {toolName}` |
| `loading.phase = 'streaming'` | `[spinner] [sword] Responding...` |

### 4.3 状态驱动

加载状态由 SDK events 驱动，useStream hook 负责监听并更新 AppStateContext：

- `run.updated(status: running)` -- 设置 `phase = 'thinking'`
- `run.updated` 携带 tool execution 信息 -- 设置 `phase = 'executing', toolName`
- `message.part.delta` -- 设置 `phase = 'streaming'`
- `run.updated(status: completed/failed/cancelled)` -- 设置 `phase = 'idle'`

注意：useInput 提交 prompt 或 command 后不主动设置 loading；必须等 SDK 事件回流后由 useStream 派生。

## 五、子组件引用

DefaultLayout 引用以下组件，均来自 `components/` 目录：

| 组件 | 来源 | 说明 |
|------|------|------|
| DialogManager | `components/dialogs/DialogManager` | 弹窗队列管理器，与 LoadingIndicator 互斥 |
| LoadingIndicator | `components/shared/LoadingIndicator` | 加载指示器，含 Spinner + 剑图标 |
| Prompt | `components/prompt/Prompt` | 输入框组件 |
| StatusBar | `components/StatusBar` | 状态栏组件 |

DefaultLayout 不导入任何 View 组件，视图内容通过 `children` 传入。

## 六、Context 依赖

| Context | 读取字段 | 用途 |
|---------|---------|------|
| AppStateContext | `loading.isLoading`, `loading.phase`, `loading.toolName` | 条件渲染加载指示器 |
| AppStateContext | `dialog.current` | 条件渲染弹窗（弹窗优先于加载指示器） |

DefaultLayout 仅读取 AppStateContext 中的 loading 和 dialog 相关字段。不读取视图状态、会话数据、配置数据。

## 七、设计约束

1. **不嵌套其他 Layout**：DefaultLayout 是最外层布局，不支持布局嵌套
2. **不处理键盘事件**：键盘事件由 useKeyboard hook 在 App 层处理，布局层不监听
3. **弹窗内联渲染**：DialogManager 在 DefaultLayout 内部渲染，位于 Prompt 上方，与 LoadingIndicator 互斥显示（有弹窗时隐藏加载指示器）
4. **不感知当前视图**：布局组件不读取 `view.current`，不根据视图类型调整结构

## 八、文档自检

- [x] 每个区域存在的理由可以用一句话说明
- [x] 固定底部策略的实现方式清晰
- [x] 加载指示器的显示规则完整，状态驱动链路可追溯到 SDK events
- [x] Context 依赖最小化，读取 loading 和 dialog 字段
- [x] DialogManager 在 DefaultLayout 内部渲染，与 LoadingIndicator 互斥
- [x] LoadingState 使用 phase + toolName，避免 backend 内部事件泄漏
