# useKeyboard — 全局快捷键 Hook

本文档定义 useKeyboard 的职责、快捷键表和处理逻辑。

useKeyboard 处理全局快捷键，不论焦点在哪个组件都生效。通过 [useKeypress](./use-keypress.md) 订阅键盘事件。

---

## 一、职责

- 注册全局键盘快捷键处理。
- 根据当前应用状态（视图、弹窗、pending invocations）决定快捷键行为。
- 调用 AppActionsContext 或 `UiBackendClient` 执行对应操作。

---

## 二、签名

```typescript
function useKeyboard(client: UiBackendClient): void
```

无返回值。纯副作用 Hook，在 App.tsx 中调用一次。

---

## 三、快捷键表

| 快捷键 | 功能 | 条件 |
|---|---|---|
| `Ctrl+C`（双击，500ms 内） | 中断当前执行 | 有活跃 run 或 pending invocation |
| `Ctrl+C`（单击） | 清空当前输入 / 无操作 | 未在执行时 |
| `Shift+Tab` | 切换模式（ask → plan → agent） | 无弹窗且 catalog 中存在 `agents.mode` 时 |
| `Esc` | 关闭弹窗 / 返回上一视图 | 有弹窗时关闭弹窗，否则返回上一视图 |

---

## 四、处理逻辑

```typescript
function useKeyboard(client: UiBackendClient): void {
  const appState = useContext(AppStateContext)
  const { closeCurrentDialog, goBack } = useContext(AppActionsContext)
  const pendingInvocations = usePendingInvocations()
  const runs = useRuns()
  const runtime = useRuntime()
  const catalog = useCommandCatalog()
  const lastCtrlCTime = useRef(0)

  const handler = useCallback((key: KeyInfo) => {
    if (key.ctrl && key.name === 'c') {
      const now = Date.now()
      const isExecuting = pendingInvocations.size > 0 || runs.some(r => r.status.kind === 'running')

      if (now - lastCtrlCTime.current < 500 && isExecuting) {
        client.abortRun()
      }
      lastCtrlCTime.current = now
      return
    }

    if (key.name === 'escape') {
      if (appState.dialog.current) {
        closeCurrentDialog()
      } else if (appState.view.previous) {
        goBack()
      }
      return
    }

    if (key.name === 'tab' && key.shift && !appState.dialog.current && catalog) {
      const nextMode = getNextMode(runtime?.mode)
      client.executeCommand(buildInvocationFromCatalog({
        catalog,
        commandId: 'agents.mode',
        argv: [nextMode],
      }))
      return
    }
  }, [appState, closeCurrentDialog, goBack, pendingInvocations, runs, runtime, catalog, client])

  useKeypress(handler, { isActive: true })
}
```

- `Ctrl+C` 双击不再直接调用 `lifecycle.cancel()`，而是统一走 `client.abortRun()`。
- `Shift+Tab` 不直接调用 commands 模块，也不使用隐式 `cycle-mode` 规则；它只构造 catalog 中 exact match 的 `agents.mode` invocation，并显式传入下一个 mode。
- loading 状态不在本 hook 中直接设置，由 useStream 根据后续 SDK 事件派生。

---

## 五、Ctrl+C 双击检测

中断操作需要双击 Ctrl+C（500ms 内），避免误触中断。单击 Ctrl+C 可继续保留为清空输入或无操作，由 Prompt 组件决定。

---

## 六、焦点分区

useKeyboard 只处理全局快捷键。以下按键不在本 hook 中处理：

| 按键 | 负责的 Hook |
|---|---|
| Enter | useInput |
| 上/下箭头 | useHistory |
| Tab（无 Shift） | useInput |
| 字符输入 | Prompt 组件自身 |

---

## 七、依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| AppStateContext | 读 | 检查弹窗状态、视图状态 |
| AppActionsContext | 写 | closeCurrentDialog, goBack |
| `UiBackendClient` | 参数 | `abortRun()`, `executeCommand()` |
| `usePendingInvocations` | TuiStore selector | 判断是否有命令在执行 |
| `useRuns` | TuiStore selector | 判断是否有 run 在执行 |
| `useRuntime` | TuiStore selector | 读取当前 mode，计算下一个 mode |
| `useCommandCatalog` | TuiStore selector | 确认 `agents.mode` 存在并构造 canonical invocation |

---

## 八、文档自检

- [x] 不直接调用 backend 内部 lifecycle/commands。
- [x] Ctrl+C 双击通过 `client.abortRun()` 实现。
- [x] Shift+Tab 通过 catalog exact match 的 command invocation 路径切模式。
- [x] loading 状态不在本 hook 中直接设置。
- [x] 焦点分区边界清晰。
