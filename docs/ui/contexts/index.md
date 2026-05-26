# Contexts & Store — 状态管理架构

本文档描述 `ohbaby-cli` 的状态管理分层设计。

---

## 一、概述

状态管理分为三层：

| 层 | 职责 | 技术方案 |
|---|---|---|
| **TuiStore** | SDK 数据的唯一本地投影 | `useSyncExternalStore` + reducer + selector hooks |
| **LocalUiMemory** | UI 私有的本地记忆（recent 等，与 SDK 无关） | 模块级单例 + `useSyncExternalStore` + 最小 push/get API |
| **UI Context** | 纯 UI 控制状态和输入设施 | React Context（4 个） |

组件通过 selector hooks 读取 SDK 数据，通过 Context 读取 UI 控制状态，通过 LocalUiMemory hooks 读取 UI 私有记忆。三层之间互不写入。

**TuiStore 与 LocalUiMemory 的边界**：TuiStore 只放 SDK 投影；LocalUiMemory 只放 UI 私有的 recent / 偏好。dialog 等消费者可以**同时读两边并组合呈现**，但 TuiStore 不读 LocalUiMemory，LocalUiMemory 不读 TuiStore；LocalUiMemory 的内容**永远不能扩大** SDK 在 `request.options` 中提供的候选集合。详见 [local-ui-memory.md](./local-ui-memory.md)。

---

## 二、架构图

```
UiBackendClient                       (UI 自身动作)
   │                                       │
   │ getSnapshot / listCommands /          │ pushRecentModel /
   │ subscribeEvents                       │ pushRecentSession
   ▼                                       ▼
┌──────────────────────────────┐  ┌─────────────────────────┐
│ TuiStore（SDK 数据投影）       │  │ LocalUiMemory           │
│  runtime · sessions · ...     │  │  recentModelChoiceIds    │
│  catalog · permissions · ...  │  │  recentSessionChoiceIds  │
└──────────────┬───────────────┘  └─────────────┬───────────┘
               │ selector hooks                  │ hooks
               │ useRuntime / useMessages / ...  │ useRecentModels / ...
               ▼                                  ▼
┌─────────────────────────────────────────────────────┐
│ 4 个 UI Context                                      │
│  AppStateContext: view / dialog queue / loading       │
│  AppActionsContext: navigateTo / enqueueDialog / ...  │
│  KeypressContext: 键盘 Pub/Sub                       │
│  MouseContext: 鼠标 Pub/Sub                          │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
                      组件树（Ink）
```

TuiStore 与 LocalUiMemory 在图中并列：两边都向组件树暴露 hooks，但**不互相依赖**。

---

## 三、文档索引

| 文档 | 职责 |
|------|------|
| [tui-store.md](./tui-store.md) | Store 形状、reducer 映射、part-delta emitter、gap reconcile |
| [local-ui-memory.md](./local-ui-memory.md) | UI 私有本地记忆（recent 等），与 TuiStore 平级、不互访 |
| [selectors.md](./selectors.md) | 对外 selector hooks 签名与消费者 |
| [app-state-context.md](./app-state-context.md) | 视图状态、dialog 队列、loading phase（只读） |
| [app-actions-context.md](./app-actions-context.md) | UI 控制动作（写入 AppState） |
| [keypress-context.md](./keypress-context.md) | 键盘输入 Pub/Sub |
| [mouse-context.md](./mouse-context.md) | 鼠标输入 Pub/Sub |

---

## 四、设计原则

### 4.1 SDK 数据走 Store，UI 状态走 Context，UI 私有记忆走 LocalUiMemory

SDK 投影数据（runtime/messages/catalog/permissions/pending）变化频率高且来源单一（SDK 事件），适合 external store + selector 模式。

UI 控制状态（view/dialog/loading）由多个 hooks 协作写入，且与 React 渲染周期紧密耦合，适合 Context + setState。

UI 私有记忆（recent / 后续偏好）跨弹窗保留、与 SDK 无关、由用户动作写入，独立成一个模块级单例 LocalUiMemory，避免污染 TuiStore 的"投影一致性"。

### 4.2 不再保留 ConfigContext、SessionContext 和 AppContext

原 ConfigContext（model/mode/cwd）和 SessionContext（messages/tokenUsage）的数据来源都是 SDK 事件。它们已收编到 TuiStore，组件通过 `useRuntime()` 和 `useMessages()` 访问。

原 AppContext 已拆分为 AppStateContext 与 AppActionsContext。退役文档不再保留，避免后续读者误把它们当成可用模块。

### 4.3 按变化频率分层

| 层 | 变化频率 |
|---|---|
| KeypressContext / MouseContext | 极高（每次按键/鼠标） |
| TuiStore messages/runs | 高（流式响应期间） |
| AppStateContext loading | 中（run 开始/结束） |
| TuiStore runtime/catalog | 低（用户切换模型/模式） |
| AppStateContext view | 极低（视图切换） |

高频数据使用 selector 精确订阅，避免波及无关组件。

### 4.4 Provider 嵌套顺序

```tsx
<KeypressProvider>
  <MouseProvider>
    <AppStateProvider>
      <AppActionsProvider>
        {children}
      </AppActionsProvider>
    </AppStateProvider>
  </MouseProvider>
</KeypressProvider>
```

TuiStore 与 LocalUiMemory 都不是 Provider，不参与嵌套。它们在 App 初始化时创建，通过模块级引用供各自的 hooks 访问。

---

## 五、迁移说明

| 旧模块 | 迁移去向 |
|---|---|
| AppContext | AppStateContext + AppActionsContext |
| ConfigContext | `useRuntime()` selector |
| SessionContext | `useMessages()` + `useSessionSummaries()` + `useActiveSessionId()` + `useRuntime()` |

旧文档 `app-context.md`、`config-context.md`、`session-context.md` 已删除，不再作为活跃设计参考。

---

## 六、文档自检

- [x] 三层分工清晰：TuiStore = SDK 投影，LocalUiMemory = UI 私有记忆，Context = UI 控制。
- [x] TuiStore 与 LocalUiMemory 互不读写，且 LocalUiMemory 不可扩大候选集合。
- [x] 不存在 SDK 数据绕过 Store 直接进 Context 的路径。
- [x] AppContext/ConfigContext/SessionContext 已明确标注为退役或收编。
- [x] Provider 嵌套顺序有依赖分析支撑。
