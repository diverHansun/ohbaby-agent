# KeypressContext 键盘输入

本文档定义 KeypressContext 的 Pub/Sub 接口与实现规范。

KeypressContext 是底层输入设施，负责从 stdin 读取键盘事件并广播给所有订阅者。消费者通过 [useKeypress](../hooks/use-keypress.md) hook 订阅。

---

## 一、职责

- 读取 stdin 中的键盘输入
- 将原始输入解析为结构化的 KeyInfo 对象
- 通过 Pub/Sub 模式广播给所有活跃订阅者
- 管理订阅者注册和注销

---

## 二、接口定义

```typescript
interface KeypressContextValue {
  subscribe: (handler: KeypressHandler) => void
  unsubscribe: (handler: KeypressHandler) => void
}

type KeypressHandler = (key: KeyInfo) => void

interface KeyInfo {
  name: string           // 键名（如 'a', 'return', 'escape', 'up', 'tab'）
  ctrl: boolean          // Ctrl 修饰键
  shift: boolean         // Shift 修饰键
  alt: boolean           // Alt 修饰键
  meta: boolean          // Meta 修饰键
  sequence?: string      // 原始 ANSI 转义序列（调试用）
}
```

---

## 三、Pub/Sub 机制

### 3.1 工作流程

```
stdin 输入
    |
    v
KeypressProvider 内部监听 stdin
    |
    v
解析为 KeyInfo 对象
    |
    v
遍历所有已注册的 handler，逐一调用
    |
    +-- handler_1(keyInfo)   // useKeyboard 全局快捷键
    +-- handler_2(keyInfo)   // useInput Prompt 输入处理
    +-- handler_3(keyInfo)   // useHistory 历史导航
    ...
```

### 3.2 订阅者管理

- 订阅者通过 `subscribe(handler)` 注册，`unsubscribe(handler)` 注销
- 内部使用 `Set<KeypressHandler>` 存储，保证同一 handler 不重复注册
- 订阅者按注册顺序调用，但不应依赖执行顺序
- 单个订阅者抛出异常不影响其他订阅者（错误隔离）

### 3.3 条件激活（通过消费侧 hook 实现）

`isActive` 机制不在 KeypressContext 内部实现，而由消费侧 [useKeypress](../hooks/use-keypress.md) hook 负责：

```typescript
// useKeypress hook 内部逻辑
function useKeypress(handler: KeypressHandler, options: { isActive: boolean }) {
  useEffect(() => {
    if (!options.isActive) return
    keypressContext.subscribe(handler)
    return () => keypressContext.unsubscribe(handler)
  }, [options.isActive, handler])
}
```

当 `isActive` 为 false 时，hook 不注册订阅，实现条件激活。这用于：
- 弹窗打开时，Prompt 的输入处理暂停
- 非当前视图的组件不响应按键

---

## 四、键名映射表

| 用户操作 | KeyInfo.name | 修饰键 |
|----------|-------------|--------|
| 字母/数字 | `'a'`, `'1'` 等 | 无 |
| Enter | `'return'` | 无 |
| Esc | `'escape'` | 无 |
| Tab | `'tab'` | 无 |
| Shift+Tab | `'tab'` | `shift: true` |
| Ctrl+C | `'c'` | `ctrl: true` |
| 上箭头 | `'up'` | 无 |
| 下箭头 | `'down'` | 无 |
| 左箭头 | `'left'` | 无 |
| 右箭头 | `'right'` | 无 |
| Backspace | `'backspace'` | 无 |
| Delete | `'delete'` | 无 |

---

## 五、与 Ink useInput 的关系

Ink 框架提供了内置的 `useInput` hook。KeypressContext 替代而非封装它：

| 能力 | Ink useInput | KeypressContext |
|------|-------------|----------------|
| 多组件同时监听 | 各组件独立调用 | 统一 Pub/Sub 广播 |
| 条件激活 | `isActive` 参数 | 通过 useKeypress hook 实现 |
| 修饰键解析 | 有限支持 | 完整支持 |
| ANSI 序列访问 | 不暴露 | `sequence` 字段 |
| 自定义解析 | 不支持 | 可扩展解析逻辑 |

**规约**：在 ohbaby-code 中，组件和 hook 不应直接使用 Ink 的 `useInput`，统一使用 KeypressContext / useKeypress。

---

## 六、Provider 实现要点

```tsx
export function KeypressProvider({ children }: { children: React.ReactNode }) {
  const handlers = useRef(new Set<KeypressHandler>())

  const contextValue = useMemo<KeypressContextValue>(() => ({
    subscribe: (handler) => { handlers.current.add(handler) },
    unsubscribe: (handler) => { handlers.current.delete(handler) },
  }), [])

  useEffect(() => {
    // 监听 Ink 的 stdin 输入
    const onData = (data: Buffer) => {
      const keyInfo = parseKeyInput(data)  // 解析 ANSI 序列为 KeyInfo
      for (const handler of handlers.current) {
        try {
          handler(keyInfo)
        } catch (err) {
          // 错误隔离：记录日志，不中断其他订阅者
          Log.error('Keypress handler error', err)
        }
      }
    }

    process.stdin.on('data', onData)
    return () => { process.stdin.off('data', onData) }
  }, [])

  return (
    <KeypressContext.Provider value={contextValue}>
      {children}
    </KeypressContext.Provider>
  )
}
```

**关键**：
- `contextValue` 通过 `useMemo([])` 稳定化，引用永不变
- `handlers` 使用 `useRef(Set)` 避免触发重渲染
- 错误隔离：单个 handler 异常不影响其他 handler
- 解析函数 `parseKeyInput` 是纯函数，可独立测试

---

## 七、设计理由

### 为什么用 Pub/Sub 而不是 React 状态？

如果把 lastKey 放在 React 状态中：
- 每次按键都触发 Context 更新，所有消费者重渲染
- 多个消费者读同一个 lastKey，存在竞争（谁先处理？处理后要清除吗？）

Pub/Sub 模式下，按键事件直接调用回调函数，不经过 React 渲染周期：
- 无重渲染开销
- 每个订阅者独立处理，无竞争
- 响应延迟更低

### 为什么不直接用 Ink 的 useInput？

Ink 的 useInput 在每个组件中独立监听，无法协调多组件间的按键处理。例如弹窗打开时需要某些组件停止响应按键，Ink 原生机制无法优雅实现这一点。KeypressContext 的 Pub/Sub + useKeypress 的 `isActive` 参数解决了这个问题。

---

## 八、文档自检

- [x] 接口定义完整（subscribe/unsubscribe/KeyInfo）
- [x] Pub/Sub 工作流程已说明
- [x] 条件激活机制已说明
- [x] 键名映射表已提供
- [x] 与 Ink useInput 的差异已对比
- [x] Provider 实现要点已说明
- [x] 错误隔离策略已说明
- [x] 设计理由已解释
