# useKeyboard 全局快捷键 Hook

本文档定义 useKeyboard 的职责、快捷键表和处理逻辑。

useKeyboard 处理全局键盘快捷键，不论焦点在哪个组件都生效。通过 [useKeypress](./use-keypress.md) 订阅键盘事件。

---

## 一、职责

- 注册全局键盘快捷键处理
- 根据当前应用状态（视图、弹窗）决定快捷键行为
- 调用 AppActionsContext 执行对应操作

---

## 二、签名

```typescript
function useKeyboard(): void
```

无参数，无返回值。纯副作用 Hook，在 App.tsx 中调用一次。

---

## 三、调用位置

**App.tsx**（全局唯一）

```tsx
function App() {
  useStream()
  useKeyboard()   // 全局快捷键

  return (
    <DefaultLayout>
      <Router />
    </DefaultLayout>
  )
}
```

---

## 四、快捷键表

| 快捷键 | 功能 | 条件 |
|--------|------|------|
| `Ctrl+C` (双击, 500ms 内) | 中断当前执行 | 正在执行时（loading.phase !== 'idle'） |
| `Ctrl+C` (单击) | 清空当前输入 / 无操作 | 未在执行时 |
| `Shift+Tab` | 切换模式 (ask -> plan -> agent) | 无弹窗时 |
| `Esc` | 关闭弹窗 / 返回上一视图 | 有弹窗时关闭弹窗，否则返回上一视图 |

---

## 五、处理逻辑

```typescript
function useKeyboard(): void {
  const appState = useContext(AppStateContext)
  const { closeCurrentDialog, goBack, setLoading } = useContext(AppActionsContext)

  const lastCtrlCTime = useRef(0)

  const handler = useCallback((key: KeyInfo) => {
    // Ctrl+C 双击中断
    if (key.ctrl && key.name === 'c') {
      const now = Date.now()
      if (now - lastCtrlCTime.current < 500 && appState.loading.isLoading) {
        // 双击 Ctrl+C：中断执行
        lifecycle.cancel()
        setLoading({ phase: 'idle' })
      }
      lastCtrlCTime.current = now
      return
    }

    // Esc：关闭弹窗或返回
    if (key.name === 'escape') {
      if (appState.dialog.current) {
        closeCurrentDialog()
      } else if (appState.view.previous) {
        goBack()
      }
      return
    }

    // Shift+Tab：切换模式
    if (key.name === 'tab' && key.shift && !appState.dialog.current) {
      // 调用 commands 模块切换模式
      commands.cycleMode()
      return
    }
  }, [appState, closeCurrentDialog, goBack, setLoading])

  useKeypress(handler, { isActive: true })  // 始终激活
}
```

---

## 六、Ctrl+C 双击检测

中断操作需要双击 Ctrl+C（500ms 内），这是为了：
- 防止误触导致长时间执行被中断
- 单击 Ctrl+C 可用于清空当前输入（常见终端习惯）
- 参考 gemini-cli 和其他 CLI 工具的交互惯例

```
第一次 Ctrl+C                     第二次 Ctrl+C
    |                                 |
    |<---------- 500ms ------------->|
    |                                 |
    v                                 v
  记录时间戳                        检查时间差 < 500ms
  如果未在执行中：清空输入             如果在执行中：调用 lifecycle.cancel()
```

---

## 七、焦点分区

useKeyboard 只处理 **全局快捷键**。以下按键不在 useKeyboard 中处理：

| 按键 | 负责的 Hook | 理由 |
|------|-----------|------|
| Enter | useInput | Prompt 聚焦时的提交操作 |
| 上/下箭头 | useHistory | Prompt 聚焦时的历史导航 |
| Tab（无 Shift） | useInput | Prompt 聚焦时的自动补全 |
| 字符输入 | Prompt 组件自身 | 文本编辑 |

这些按键仅在 Prompt 聚焦时有意义，由对应的 Hook 通过 `useKeypress({ isActive: promptFocused })` 处理。

---

## 八、依赖的 Context

| Context | 读/写 | 用途 |
|---------|------|------|
| AppStateContext | 读 | 检查弹窗状态、视图状态、加载状态 |
| AppActionsContext | 写 | closeCurrentDialog, goBack, setLoading |

---

## 九、文档自检

- [x] 签名完整
- [x] 调用位置已明确（App.tsx，全局唯一）
- [x] 完整快捷键表已提供
- [x] Ctrl+C 双击检测逻辑已说明
- [x] 焦点分区边界已明确
- [x] 依赖的 Context 已列举
- [x] 处理逻辑有代码示例
