# useInput 输入处理 Hook

本文档定义 useInput 的职责、接口和命令分流逻辑。

useInput 处理用户在 Prompt 组件中提交的输入，根据输入内容分流到不同的执行路径。

---

## 一、职责

- 接收用户提交的文本输入
- 判断输入类型并分流（slash 命令 vs 普通对话）
- 调用 lifecycle 或 cli/commands 执行业务逻辑
- 更新应用状态（视图切换、加载状态）
- 提供 Tab 自动补全建议

---

## 二、签名

```typescript
function useInput(): {
  handleSubmit: (text: string) => Promise<void>
  getCompletions: (prefix: string) => InlineCompletion | null
}
```

**返回值**：
- `handleSubmit`：处理用户提交的输入
- `getCompletions`：获取 Tab 自动补全建议（Inline 模式，单个建议）

---

## 三、调用位置

**Prompt 组件**（唯一调用位置）

```tsx
function Prompt() {
  const { handleSubmit, getCompletions } = useInput()

  // Prompt 组件使用 handleSubmit 处理 Enter 提交
  // 使用 getCompletions 显示 Tab 补全建议
}
```

---

## 四、命令分流逻辑

```typescript
async function handleSubmit(text: string): Promise<void> {
  const trimmed = text.trim()
  if (!trimmed) return                    // 空输入，忽略

  if (trimmed.startsWith('/')) {
    // Slash 命令 -> cli/commands 模块
    await executeSlashCommand(trimmed)
  } else {
    // 普通对话 -> lifecycle 模块
    navigateTo('chat')                    // 如果在 HomeView，切换到 ChatView
    setLoading({ phase: 'thinking' })     // 设置加载状态
    await lifecycle.execute(trimmed)       // 执行对话（异步，结果通过 Bus 事件回传）
  }
}
```

### 分流规则

| 输入格式 | 目标 | 示例 |
|---------|------|------|
| 以 `/` 开头 | cli/commands.executeSlashCommand() | `/help`, `/model gpt-4` |
| 其他非空文本 | lifecycle.execute() | `"explain this code"` |
| 空或纯空白 | 忽略，不执行 | `""`, `"   "` |

---

## 五、Tab 自动补全

采用 **Inline 内联模式**：在光标后显示单个灰色建议，按 Tab 接受。

```typescript
function getCompletions(prefix: string): InlineCompletion | null {
  if (!prefix.startsWith('/')) return null   // 只补全 slash 命令

  const commands = cli.commands.getAvailableCommands()
  const match = commands.find(cmd => cmd.name.startsWith(prefix.slice(1)))

  if (!match) return null

  return {
    text: '/' + match.name,                  // 完整命令文本
    displayText: match.name.slice(prefix.length - 1),  // 光标后补全部分（灰色显示）
  }
}
```

**类型定义**：

```typescript
interface InlineCompletion {
  text: string            // 接受补全后的完整文本
  displayText: string     // 显示在光标后的灰色文本
}
```

**交互流程**：
1. 用户输入 `/he`
2. getCompletions 返回 `{ text: '/help', displayText: 'lp' }`
3. Prompt 在光标后显示灰色的 `lp`
4. 用户按 Tab -> 输入框内容变为 `/help`
5. 用户继续输入其他字符 -> 灰色建议消失

---

## 六、依赖的 Context

| Context | 读/写 | 用途 |
|---------|------|------|
| AppStateContext | 读 | 检查当前视图（决定是否需要 navigateTo） |
| AppActionsContext | 写 | navigateTo('chat'), setLoading() |
| ConfigContext | 读 | 可能需要模式信息 |

---

## 七、与其他 Hook 的关系

| 相关 Hook | 关系 | 说明 |
|-----------|------|------|
| useHistory | 同级，同在 Prompt 中 | useHistory 管理历史记录，useInput 在提交时调用 addToHistory |
| useKeyboard | 互不调用 | useKeyboard 处理全局快捷键，useInput 处理 Prompt 输入 |
| useStream | 间接关系 | useInput 触发 lifecycle.execute()，useStream 接收执行结果 |

**注意**：useInput 和 useHistory 虽然都在 Prompt 中调用，但职责不同：
- useInput：处理提交逻辑和补全
- useHistory：管理历史导航

Prompt 组件负责协调两者：提交时调用 `handleSubmit` 并 `addToHistory`。

---

## 八、文档自检

- [x] 签名完整（参数 + 返回值）
- [x] 调用位置已明确（Prompt，唯一）
- [x] 命令分流规则已说明
- [x] Tab 自动补全的 Inline 模式已说明
- [x] 补全类型定义和交互流程已描述
- [x] 依赖的 Context 已列举
- [x] 与其他 Hook 的关系已说明
