# Contexts 状态管理

本文档描述 ui 模块的 Context 架构设计，定义全局状态的管理策略和 Provider 组织方式。

---

## 一、概述

ui 模块使用 React Context 进行全局状态管理。通过将状态拆分为多个独立 Context，实现细粒度的渲染控制，避免无关组件因不相关的状态变化而重渲染。

共 6 个 Context，分为三类：

| 类别 | Context | 模式 |
|------|---------|------|
| 应用状态 | AppStateContext, AppActionsContext | State/Action 分离 |
| 业务数据 | ConfigContext, SessionContext | 只读 / useRef+版本号 |
| 输入设施 | KeypressContext, MouseContext | Pub/Sub |

---

## 二、设计原则

### 2.1 State/Action 分离

AppContext 拆分为 AppStateContext（只读状态）和 AppActionsContext（行为动作）。

**问题**：如果状态和动作放在同一个 Context 中，action 函数引用变化会导致所有只读消费者不必要地重渲染。例如 LoadingState 在流式响应时频繁更新，会导致 DialogManager 和 View 路由器无意义重渲染。

**方案**：分离后，只读消费者只订阅 AppStateContext，不受 action 引用变化影响。AppActionsContext 中的 action 引用通过 useMemo 稳定化。

**参考**：gemini-cli 的 UIStateContext + UIActionsContext 分离模式。

### 2.2 Pub/Sub 输入模型

键盘输入（KeypressContext）和鼠标输入（MouseContext）采用 Pub/Sub 模式：

- Provider 负责读取 stdin、解析事件、广播给所有订阅者
- 消费者通过 `subscribe` / `unsubscribe` 注册回调
- 消费侧 hook（useKeypress / useMouse）支持 `isActive` 参数控制条件激活

**为什么不直接用 Ink 的 useInput**：
- Ink 的 useInput 不支持多组件同时监听同一按键
- 无法处理复杂序列解析（如鼠标 SGR 协议）
- 缺少焦点/弹窗遮挡时的条件激活机制

**参考**：gemini-cli 的 KeypressProvider Pub/Sub 设计。

### 2.3 useRef + 版本号消息缓存

SessionContext 中的消息列表使用 `useRef` 存储（不触发重渲染），配合 `messageVersion` 递增计数器通知消费者刷新。

**问题**：流式响应期间 `Message.Event.PartUpdated` 事件每秒可达数十次。若使用 React 不可变更新模式（`setMessages(prev => [...])`) ，每次都创建新数组引用，导致 MessageList 及所有子组件全量重渲染。

**方案**：
- `messagesRef.current` 始终持有最新消息，读取不触发重渲染
- `messageVersion` 只在消息数量变化等关键节点递增
- 流式 Part 增量更新通过 Bus 事件直接传给对应 Part 组件，绕过 Context

### 2.4 按变化频率分层

| Context | 变化频率 | 典型触发场景 |
|---------|---------|------------|
| ConfigContext | 极低 | 用户手动切换模型或模式 |
| AppStateContext | 中等 | 视图切换、弹窗开关、加载状态变更 |
| SessionContext | 高 | 流式响应、消息增删 |
| KeypressContext | 极高 | 每次按键 |
| MouseContext | 极高 | 每次鼠标操作 |

频率越低的 Context 放越外层，状态变化时影响范围越小。

---

## 三、Context 列表

| Context | 文档 | 职责 |
|---------|------|------|
| AppStateContext | [app-state-context.md](./app-state-context.md) | 应用只读状态：视图、弹窗队列、加载阶段 |
| AppActionsContext | [app-actions-context.md](./app-actions-context.md) | 应用状态变更：导航、弹窗操作、加载控制 |
| ConfigContext | [config-context.md](./config-context.md) | 配置只读状态：模型、模式、Agent 状态 |
| SessionContext | [session-context.md](./session-context.md) | 会话状态：消息缓存、token 用量 |
| KeypressContext | [keypress-context.md](./keypress-context.md) | 键盘输入 Pub/Sub 分发 |
| MouseContext | [mouse-context.md](./mouse-context.md) | 鼠标输入 Pub/Sub 分发 |

---

## 四、Provider 嵌套顺序

```tsx
<ConfigProvider config={config}>
  <KeypressProvider>
    <MouseProvider>
      <AppStateProvider>
        <SessionProvider>
          <AppActionsProvider>
            {children}
          </AppActionsProvider>
        </SessionProvider>
      </AppStateProvider>
    </MouseProvider>
  </KeypressProvider>
</ConfigProvider>
```

### 嵌套原则

**被依赖者在外，依赖者在内。**

| Provider | 层级 | 依赖 | 被依赖 |
|----------|------|------|--------|
| ConfigProvider | 1（最外） | 无 | SessionProvider, AppActionsProvider |
| KeypressProvider | 2 | 无 | useKeyboard, useInput |
| MouseProvider | 3 | 无 | useMouse（ScrollableList, Dialog, Prompt） |
| AppStateProvider | 4 | 无 | AppActionsProvider, Router, StatusBar |
| SessionProvider | 5 | ConfigContext | useStream, MessageList, StatusBar |
| AppActionsProvider | 6（最内） | AppStateContext, SessionContext | useInput, useKeyboard, usePermission |

### 依赖关系图

```
ConfigProvider        KeypressProvider     MouseProvider
     |                      |                    |
     v                      v                    v
SessionProvider       AppStateProvider       (无依赖)
     |                      |
     +----------+-----------+
                |
                v
         AppActionsProvider
                |
                v
          DefaultLayout
```

---

## 五、与其他模块的关系

| 外部模块 | 交互方式 | 说明 |
|----------|---------|------|
| Bus | 事件订阅 | useStream 订阅 Bus 事件，同步到 SessionContext 和 AppStateContext |
| config | 数据注入 | cli 层初始化时将配置传入 ConfigProvider |
| message | 类型引用 | SessionContext 引用 message 模块的 Message、Part 等类型 |
| permission | 事件订阅 | usePermission 订阅权限事件，通过 AppActionsContext 入队弹窗 |
| lifecycle | 间接依赖 | useInput 调用 lifecycle.execute()，通过 Bus 事件间接更新 Context |

---

## 六、文档自检

- [x] 每个 Context 的存在都有明确理由
- [x] State/Action 分离原则已说明并有参考来源
- [x] Provider 嵌套顺序有依赖分析支撑
- [x] 输入 Context 的 Pub/Sub 模式已说明
- [x] 消息缓存策略（useRef + 版本号）已说明
- [x] 各 Context 变化频率已分析
