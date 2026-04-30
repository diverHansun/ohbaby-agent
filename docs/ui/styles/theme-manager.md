# ThemeManager 主题管理器

## 一、职责

ThemeManager 是样式系统的出口层。它持有当前主题的语义 tokens，并通过 getter 代理对象对外导出，使组件可以透明地访问当前主题的颜色。

MVP 阶段只支持单一暗色主题。ThemeManager 的 getter 代理设计为未来多主题切换预留了扩展点——切换主题只需替换内部 tokens 映射，不改组件代码。

---

## 二、ThemeManager 类

```typescript
import { SemanticTokens, darkTokens } from './tokens'

class ThemeManager {
  private currentTokens: SemanticTokens = darkTokens

  /** 获取当前主题的语义 tokens */
  getTokens(): SemanticTokens {
    return this.currentTokens
  }

  /** 切换主题（预留，MVP 不使用） */
  setTheme(tokens: SemanticTokens): void {
    this.currentTokens = tokens
  }
}

// 模块级单例
export const themeManager = new ThemeManager()
```

### 为什么用 class 而非纯对象？

- `setTheme()` 需要内部状态（currentTokens）的可变引用
- 未来可能加入缓存、验证等逻辑
- 但保持精简——MVP 只有 `getTokens()` 和 `setTheme()` 两个方法

---

## 三、Getter 代理对象

对外导出的 `theme` 对象是组件消费颜色的唯一入口：

```typescript
export const theme: SemanticTokens = {
  get text()    { return themeManager.getTokens().text },
  get tool()    { return themeManager.getTokens().tool },
  get diff()    { return themeManager.getTokens().diff },
  get ui()      { return themeManager.getTokens().ui },
  get status()  { return themeManager.getTokens().status },
  get message() { return themeManager.getTokens().message },
  get dialog()  { return themeManager.getTokens().dialog },
}
```

### 为什么用 getter 而非直接导出 darkTokens？

直接导出 `darkTokens` 对象在 MVP 阶段也能工作，但 getter 代理的价值在于**为主题切换预留**：

```
直接导出：
  import { darkTokens } from './tokens'
  export const theme = darkTokens
  → 所有组件持有 darkTokens 的直接引用
  → 切换主题需要触发所有组件重新导入，不可行

getter 代理：
  theme.text.primary → themeManager.getTokens().text.primary
  → 每次访问都从 themeManager 取最新值
  → themeManager.setTheme(lightTokens) 后，所有组件自动获取新主题
```

这是参考 gemini-cli 的 `semantic-colors.ts` 设计。用极小的代码量（7 个 getter）换取未来的主题切换能力。

---

## 四、组件消费方式

```tsx
import { theme } from '../styles'

// StatusBar
<Text color={theme.text.accent}>{modelName}</Text>
<Text color={theme.text.secondary}>{workingDirectory}</Text>
<Text color={theme.ui.dimmed}>|</Text>

// ToolPart
const statusColor = {
  pending:   theme.tool.pending,
  running:   theme.tool.running,
  completed: theme.tool.completed,
  error:     theme.tool.error,
  aborted:   theme.tool.aborted,
}[state.status]

<Text color={statusColor}>{icon} {toolName}</Text>

// DiffRenderer
<Text color={theme.diff.added}>+ {line}</Text>
<Text color={theme.diff.removed}>- {line}</Text>
```

### 消费约定

1. 组件只导入 `theme` 对象，不导入 `palette` 或 `darkTokens`
2. 使用语义路径（`theme.tool.running`）而非色值（`'#00BFFF'`）
3. 颜色值直接作为 Ink `<Text>` 组件的 `color` prop

---

## 五、初始化

ThemeManager 无需显式初始化。模块加载时自动创建单例，默认使用 darkTokens：

```
模块加载 → new ThemeManager() → currentTokens = darkTokens → 就绪
```

不依赖任何 Context 或 Bus 事件。组件在任意时刻导入 `theme` 都可以安全使用。

---

## 六、未来扩展路径

以下是预留的扩展方向，MVP 不实现：

### 多主题支持

```typescript
// 新增 lightTokens 映射
export const lightTokens: SemanticTokens = {
  text: { primary: palette.black, ... },
  ...
}

// 切换
themeManager.setTheme(lightTokens)
```

### 终端背景检测

参考 gemini-cli 的 OSC 11 查询，自动检测终端背景明暗，选择合适主题。

### 用户自定义主题

从配置文件加载用户自定义的 SemanticTokens 覆盖。

### NO_COLOR 支持

检测 `process.env.NO_COLOR`，提供无色 tokens（所有色值为空字符串）。

---

## 七、与 gemini-cli 的对比

| 维度 | gemini-cli | ohbaby-agent (MVP) |
|------|-----------|-----------------|
| 架构层数 | 3 层（ColorsTheme → SemanticColors → getter） | 3 层（palette → tokens → getter） |
| 内置主题 | 16 个 | 1 个（darkTokens） |
| 自定义主题 | 支持（配置文件 + 扩展） | 不支持（预留接口） |
| 终端检测 | OSC 11 背景色 + 自动明暗切换 | 不实现 |
| 语法高亮色 | 集成 highlight.js 映射 | 不涉及（Markdown 渲染由 TextPart 处理） |
| 核心代码量 | ~1500 行 | ~50 行（预估） |

ohbaby-agent 借鉴了 gemini-cli 的分层思路和 getter 代理模式，但去掉了所有 MVP 不需要的复杂度。

---

## 八、文档自检

- [x] ThemeManager 类定义完整（getTokens + setTheme）
- [x] getter 代理对象定义完整（7 个分组，含 dialog）
- [x] getter vs 直接导出的设计理由已说明
- [x] 组件消费方式有具体代码示例
- [x] 初始化流程已说明（无需显式初始化）
- [x] 未来扩展路径已列出但明确标注 MVP 不实现
- [x] 与 gemini-cli 的对比已提供
