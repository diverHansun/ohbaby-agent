# useInput — 输入处理 Hook

本文档定义 useInput 的职责、接口和命令分流逻辑。

useInput 处理用户在 Prompt 组件中提交的输入，通过 SDK parser/resolver 分流到 slash command 或普通 prompt 路径。

---

## 一、职责

- 接收用户提交的文本输入。
- 使用 SDK `parseSlashInput()` 判断是否为 slash command。
- 使用 SDK `resolveCommand()` 基于 TuiStore catalog 做 exact match。
- 匹配成功时调用 `client.executeCommand(invocation)`。
- 普通文本时调用 `client.submitPrompt(text, { sessionId })`。
- 提供 Tab 自动补全建议（基于 SDK `filterCommandCatalog()`）。

**不做的事**：
- 不主动设置 loading 状态（由 useStream 根据 SDK 事件派生）。
- 不直接调用 lifecycle、commands 或 cli/commands 模块。
- 不维护 command catalog（由 useCatalog 负责）。

---

## 二、签名

```typescript
function useInput(client: UiBackendClient): {
  handleSubmit: (text: string) => Promise<void>
  getCompletions: (prefix: string) => CompletionResult | null
  getHints: (prefix: string) => HintResult | null
}
```

**返回值**：
- `handleSubmit`：处理用户提交的输入。
- `getCompletions`：获取 Tab 自动补全建议（Inline 模式）。
- `getHints`：获取当前输入的子命令/参数提示。

---

## 三、调用位置

**Prompt 组件**（唯一调用位置）

---

## 四、命令分流逻辑

```typescript
const catalog = useCommandCatalog()
const activeSessionId = useActiveSessionId()

async function handleSubmit(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return

  const parsed = parseSlashInput(trimmed)

  if (parsed) {
    if (!catalog) {
      showLocalError('命令目录尚未加载')
      return
    }

    const outcome = resolveCommand(parsed, catalog.commands, {
      surface: 'tui',
      mode: 'strict',
    })

    switch (outcome.kind) {
      case 'resolved':
        client.executeCommand(outcome.invocation)
        addToHistory(trimmed)
        break
      case 'not-found':
        showLocalError(
          `未知命令: /${parsed.rawPath}`,
          outcome.suggestion ? `是否想输入: /${outcome.suggestion}` : undefined
        )
        break
      case 'ambiguous':
        showLocalError(`命令不明确: ${outcome.candidates.join(', ')}`)
        break
    }
  } else {
    if (viewState.current === 'home') navigateTo('chat')
    client.submitPrompt(trimmed, { sessionId: activeSessionId })
    addToHistory(trimmed)
  }
}
```

### 分流规则

| 输入格式 | 处理路径 |
|---|---|
| 以 `/` 开头且 resolve 成功 | `client.executeCommand(invocation)` |
| 以 `/` 开头但 resolve 失败 | 本地显示错误 + suggestion |
| 其他非空文本 | `client.submitPrompt(text)` |
| 空或纯空白 | 忽略 |

### Loading 状态说明

useInput 提交 prompt/command 后**不主动调用 setLoading**。Loading 状态由 useStream 在收到 `run.updated` 或 `command.started` 事件后派生。这避免了"提交后立刻显示 loading，但 backend 还没开始执行"的闪烁问题。

---

## 五、Tab 自动补全

采用 Inline 内联模式：在光标后显示单个灰色建议，按 Tab 接受。

```typescript
function getCompletions(prefix: string): CompletionResult | null {
  if (!prefix.startsWith('/')) return null

  if (!catalog) return null

  const candidates = filterCommandCatalog(catalog.commands, {
    prefix: prefix.slice(1),
    surface: 'tui',
    includeHidden: false,
  })

  if (candidates.length === 0) return null

  const best = candidates[0]
  const fullText = '/' + best.path.join(' ')
  const remaining = fullText.slice(prefix.length)

  if (!remaining) return null

  return {
    text: fullText,
    displayText: remaining,
  }
}
```

**交互流程**：
1. 用户输入 `/mod`。
2. `getCompletions` 返回 `{ text: '/model', displayText: 'el' }`。
3. Prompt 在光标后显示灰色的 `el`。
4. 用户按 Tab → 输入框内容变为 `/model`。
5. 用户继续输入其他字符 → 灰色建议消失。

---

## 六、输入 Hints

当用户输入 `/model` 但尚未 Enter 时，显示子命令和参数提示：

```typescript
function getHints(prefix: string): HintResult | null {
  if (!prefix.startsWith('/')) return null

  if (!catalog) return null

  const parsed = parseSlashInput(prefix)
  if (!parsed) return null

  const candidates = filterCommandCatalog(catalog.commands, {
    prefix: parsed.rawPath,
    surface: 'tui',
  })

  if (candidates.length === 0) return null

  return {
    subCommands: candidates.map(c => ({
      name: c.path.join(' '),
      description: c.description,
      argsHint: c.argsHint,
    })),
  }
}
```

Hints 不调用 backend，纯本地 catalog 查询。

---

## 七、依赖

| 依赖 | 类型 | 用途 |
|---|---|---|
| `UiBackendClient` | 参数 | `submitPrompt()`, `executeCommand()` |
| `parseSlashInput` | SDK 函数 | 词法解析 |
| `resolveCommand` | SDK 函数 | catalog exact match |
| `filterCommandCatalog` | SDK 函数 | 补全和 hints |
| `useCommandCatalog` selector | TuiStore | 读取当前 catalog |
| `useActiveSessionId` selector | TuiStore | 读取 activeSessionId |
| AppStateContext | 读 | 检查当前视图 |
| AppActionsContext | 写 | `navigateTo('chat')` |
| useHistory | 同级 | 提交时调用 `addToHistory` |

---

## 八、与其他 Hook 的关系

| Hook | 关系 |
|---|---|
| useHistory | 同级，同在 Prompt 中。useInput 提交时调用 addToHistory |
| useStream | 间接。useInput 触发 submitPrompt/executeCommand，结果通过 SDK 事件回流到 useStream |
| useCatalog | useInput 读取 catalog，useCatalog 负责加载和刷新 |
| useKeyboard | 互不调用。useKeyboard 处理全局快捷键，useInput 处理 Prompt 输入 |

---

## 九、文档自检

- [x] 不直接调用 lifecycle、commands 或 cli/commands 模块。
- [x] slash 流程使用 SDK parser/resolver。
- [x] loading 状态不由本 hook 主动设置。
- [x] 补全和 hints 基于 SDK `filterCommandCatalog`。
- [x] 依赖清单完整，无 backend 内部 import。
