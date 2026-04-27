# MouseContext 鼠标输入

本文档定义 MouseContext 的 Pub/Sub 接口与实现规范。

MouseContext 是底层输入设施，负责从 stdin 读取鼠标事件并广播给所有订阅者。与 [KeypressContext](./keypress-context.md) 对称设计，消费者通过 [useMouse](../hooks/use-mouse.md) hook 订阅。

---

## 一、职责

- 启用终端鼠标事件报告模式（SGR 协议）
- 读取 stdin 中的鼠标 ANSI 转义序列
- 将原始序列解析为结构化的 MouseEvent 对象
- 通过 Pub/Sub 模式广播给所有活跃订阅者
- 程序退出时恢复终端鼠标模式

---

## 二、接口定义

```typescript
interface MouseContextValue {
  subscribe: (handler: MouseHandler) => void
  unsubscribe: (handler: MouseHandler) => void
}

type MouseHandler = (event: MouseEvent) => void

interface MouseEvent {
  type: 'click' | 'scroll' | 'move'
  x: number                               // 列坐标（0-based）
  y: number                               // 行坐标（0-based）
  button?: 'left' | 'right' | 'middle'    // click 时的按钮
  direction?: 'up' | 'down'               // scroll 时的方向
}
```

---

## 三、支持的交互场景

| 场景 | 事件类型 | 消费者 | 用途 |
|------|---------|--------|------|
| 滚轮滚动 | `scroll` | ScrollableList / MessageList | 滚动查看历史消息 |
| 点击选择 | `click` | ModelDialog / SessionDialog | 选择列表项 |
| 点击定位 | `click` | Prompt | 移动输入框光标位置 |

---

## 四、终端鼠标协议

### 4.1 SGR 扩展模式

ohbaby-code 使用 SGR 扩展模式报告鼠标事件，相比基础模式支持更大的坐标范围。

**启用**：写入 `\x1b[?1000h\x1b[?1006h` 到 stdout
**禁用**：写入 `\x1b[?1000l\x1b[?1006l` 到 stdout

### 4.2 事件序列格式

SGR 模式的鼠标事件格式：`\x1b[<Cb;Cx;CyM` 或 `\x1b[<Cb;Cx;Cym`

- `Cb`：按钮/修饰位编码
- `Cx`：列坐标（1-based，解析后转为 0-based）
- `Cy`：行坐标（1-based，解析后转为 0-based）
- `M`：按下，`m`：释放

### 4.3 解析映射

| Cb 值 | 事件类型 | 含义 |
|-------|---------|------|
| 0 | click (left) | 左键按下 |
| 1 | click (middle) | 中键按下 |
| 2 | click (right) | 右键按下 |
| 64 | scroll (up) | 滚轮向上 |
| 65 | scroll (down) | 滚轮向下 |
| 32+ | move | 按住移动（按钮值 + 32） |

---

## 五、Pub/Sub 机制

与 KeypressContext 对称设计：

- 内部使用 `Set<MouseHandler>` 管理订阅者
- 订阅者按注册顺序调用，不保证执行顺序
- 单个订阅者异常不影响其他订阅者（错误隔离）
- 条件激活由消费侧 [useMouse](../hooks/use-mouse.md) hook 的 `isActive` 参数控制

---

## 六、Provider 实现要点

```tsx
export function MouseProvider({ children }: { children: React.ReactNode }) {
  const handlers = useRef(new Set<MouseHandler>())

  const contextValue = useMemo<MouseContextValue>(() => ({
    subscribe: (handler) => { handlers.current.add(handler) },
    unsubscribe: (handler) => { handlers.current.delete(handler) },
  }), [])

  useEffect(() => {
    // 启用 SGR 鼠标模式
    process.stdout.write('\x1b[?1000h\x1b[?1006h')

    const onData = (data: Buffer) => {
      const mouseEvent = parseMouseInput(data)
      if (!mouseEvent) return  // 非鼠标事件，忽略

      for (const handler of handlers.current) {
        try {
          handler(mouseEvent)
        } catch (err) {
          Log.error('Mouse handler error', err)
        }
      }
    }

    process.stdin.on('data', onData)

    return () => {
      process.stdin.off('data', onData)
      // 恢复终端鼠标模式
      process.stdout.write('\x1b[?1000l\x1b[?1006l')
    }
  }, [])

  return (
    <MouseContext.Provider value={contextValue}>
      {children}
    </MouseContext.Provider>
  )
}
```

**关键**：
- 挂载时启用 SGR 鼠标模式，卸载时恢复
- `parseMouseInput` 是纯函数，解析 ANSI 序列，非鼠标数据返回 null
- 与 KeypressProvider 共享 stdin 数据源，两者需要协调数据分流（鼠标序列 vs 键盘序列）

### stdin 数据分流

KeypressProvider 和 MouseProvider 都监听 `process.stdin`。需要在底层区分：
- 以 `\x1b[<` 开头的序列 → 鼠标事件 → MouseProvider 处理
- 其他数据 → 键盘事件 → KeypressProvider 处理

实现方式：共享一个底层 stdin 监听器，在解析层分流。具体实现可以是一个内部的 `InputDemuxer` 工具，或者在 Provider 层各自过滤。

---

## 七、与 KeypressContext 的对称设计

| 方面 | KeypressContext | MouseContext |
|------|----------------|-------------|
| 数据源 | stdin 键盘序列 | stdin 鼠标序列（SGR） |
| 接口 | subscribe / unsubscribe | subscribe / unsubscribe |
| 消费 hook | useKeypress | useMouse |
| 条件激活 | isActive 参数 | isActive 参数 |
| 错误隔离 | 捕获异常 | 捕获异常 |
| 状态存储 | Set (useRef) | Set (useRef) |

---

## 八、设计理由

### 为什么 MVP 需要鼠标支持？

- **滚轮滚动**：没有鼠标滚轮，用户无法回看长对话历史
- **点击选择**：弹窗中的模型/会话选择，纯键盘操作体验差
- **光标定位**：输入框中编辑长文本时，键盘移动光标效率低

### 为什么用 SGR 而不是基础鼠标模式？

基础模式（X10）坐标限制在 223 以内（编码为单字节），无法处理大终端窗口。SGR 模式使用十进制数字编码坐标，无上限。

### 为什么不合并到 KeypressContext？

职责分离。键盘和鼠标是两种不同的输入设备，事件结构不同（KeyInfo vs MouseEvent），消费者不同。合并会导致 Context 臃肿，消费者需要过滤不相关的事件。

---

## 九、文档自检

- [x] 接口定义完整（subscribe/unsubscribe/MouseEvent）
- [x] 支持的交互场景已列举
- [x] 终端鼠标协议（SGR）已说明
- [x] stdin 数据分流问题已提出方案
- [x] 与 KeypressContext 的对称设计已对比
- [x] Provider 生命周期（启用/恢复鼠标模式）已说明
- [x] 设计理由已解释
