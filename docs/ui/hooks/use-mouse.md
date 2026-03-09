# useMouse 鼠标订阅 Hook

本文档定义 useMouse 的接口和使用规范。

useMouse 是底层 Hook，封装 [MouseContext](../contexts/mouse-context.md) 的 Pub/Sub 订阅逻辑，支持条件激活。与 [useKeypress](./use-keypress.md) 对称设计。

---

## 一、职责

- 封装 MouseContext 的 subscribe / unsubscribe 调用
- 管理订阅生命周期（isActive 变化时自动注册/注销）
- 组件卸载时自动清理订阅

---

## 二、签名

```typescript
function useMouse(
  handler: MouseHandler,
  options: { isActive: boolean }
): void

type MouseHandler = (event: MouseEvent) => void

interface MouseEvent {
  type: 'click' | 'scroll' | 'move'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  direction?: 'up' | 'down'
}
```

**参数**：
- `handler`：鼠标事件回调函数
- `options.isActive`：是否激活订阅

**返回值**：无。

---

## 三、实现

与 useKeypress 完全对称：

```typescript
function useMouse(
  handler: MouseHandler,
  options: { isActive: boolean }
): void {
  const { subscribe, unsubscribe } = useContext(MouseContext)

  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const stableHandler = useCallback((event: MouseEvent) => {
    handlerRef.current(event)
  }, [])

  useEffect(() => {
    if (!options.isActive) return

    subscribe(stableHandler)
    return () => unsubscribe(stableHandler)
  }, [options.isActive, subscribe, unsubscribe, stableHandler])
}
```

---

## 四、调用位置

| 调用者 | isActive 条件 | 处理的事件 |
|--------|-------------|-----------|
| ScrollableList / MessageList | 组件可见时 | scroll（滚轮滚动） |
| Dialog 弹窗组件 | 弹窗可见时 | click（点击选择选项） |
| Prompt 输入框 | Prompt 聚焦时 | click（点击定位光标） |

---

## 五、文档自检

- [x] 签名完整（参数 + 返回值 + 类型定义）
- [x] 与 useKeypress 的对称性已说明
- [x] 实现要点有代码示例
- [x] 调用位置已列举
