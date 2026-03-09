# useKeypress 键盘订阅 Hook

本文档定义 useKeypress 的接口和使用规范。

useKeypress 是底层 Hook，封装 [KeypressContext](../contexts/keypress-context.md) 的 Pub/Sub 订阅逻辑，支持条件激活。

---

## 一、职责

- 封装 KeypressContext 的 subscribe / unsubscribe 调用
- 管理订阅生命周期（isActive 变化时自动注册/注销）
- 组件卸载时自动清理订阅

---

## 二、签名

```typescript
function useKeypress(
  handler: KeypressHandler,
  options: { isActive: boolean }
): void

type KeypressHandler = (key: KeyInfo) => void
```

**参数**：
- `handler`：按键事件回调函数，接收解析后的 KeyInfo
- `options.isActive`：是否激活订阅。为 false 时不注册，已注册则注销

**返回值**：无。

---

## 三、条件激活机制

`isActive` 参数控制订阅的注册和注销：

| isActive 变化 | 行为 |
|-------------|------|
| false -> true | 调用 subscribe(handler) 注册 |
| true -> false | 调用 unsubscribe(handler) 注销 |
| 组件卸载 | 调用 unsubscribe(handler) 清理 |

**典型场景**：
- Prompt 输入处理：`isActive = !hasDialog`（弹窗打开时停止响应）
- 弹窗内按键处理：`isActive = isDialogVisible`（仅弹窗打开时响应）

---

## 四、实现

```typescript
function useKeypress(
  handler: KeypressHandler,
  options: { isActive: boolean }
): void {
  const { subscribe, unsubscribe } = useContext(KeypressContext)

  // 用 ref 持有最新 handler，避免频繁重新订阅
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const stableHandler = useCallback((key: KeyInfo) => {
    handlerRef.current(key)
  }, [])

  useEffect(() => {
    if (!options.isActive) return

    subscribe(stableHandler)
    return () => unsubscribe(stableHandler)
  }, [options.isActive, subscribe, unsubscribe, stableHandler])
}
```

**关键**：
- 使用 `handlerRef` 持有最新 handler，避免 handler 变化时频繁注册/注销
- `stableHandler` 通过 useCallback 稳定化，只注册一次
- isActive 变化时触发 useEffect，控制订阅状态

---

## 五、调用位置

useKeypress 是底层 Hook，可在多个组件/Hook 中调用：

| 调用者 | isActive 条件 | 处理的按键 |
|--------|-------------|-----------|
| useKeyboard（App.tsx） | 始终 true | Ctrl+C, Shift+Tab, Esc |
| useInput（Prompt） | 无弹窗且 Prompt 聚焦 | Enter, 字符输入, Tab |
| useHistory（Prompt） | 无弹窗且 Prompt 聚焦 | 上/下箭头 |
| 弹窗组件 | 弹窗可见时 | 弹窗内按键 |

---

## 六、与 useMouse 的对称设计

useKeypress 和 [useMouse](./use-mouse.md) 采用完全对称的接口：

| 方面 | useKeypress | useMouse |
|------|------------|---------|
| Context 来源 | KeypressContext | MouseContext |
| handler 类型 | KeypressHandler | MouseHandler |
| isActive 支持 | 是 | 是 |
| ref 稳定化 | 是 | 是 |

---

## 七、文档自检

- [x] 签名完整（参数 + 返回值）
- [x] 条件激活机制已说明
- [x] 实现要点有代码示例
- [x] handler ref 稳定化已说明
- [x] 调用位置和 isActive 条件已列举
