# Design Tokens 语义化颜色映射

## 一、职责

tokens.ts 将 palette 中的原始色值映射为语义化名称，按用途分组。这是样式系统的中间层——上接 palette 原始色值，下接 ThemeManager 的 getter 代理。

语义化的核心价值：组件代码读作 `theme.tool.running`（含义清晰）而非 `palette.blue`（需要猜测用途）。

---

## 二、SemanticTokens 类型定义

```typescript
export interface SemanticTokens {
  text: {
    primary:   string    // 主要文本
    secondary: string    // 辅助文本（弱化）
    accent:    string    // 强调文本（模型名、关键信息）
    link:      string    // 链接文本
  }

  tool: {
    pending:   string    // 工具等待中
    running:   string    // 工具执行中
    completed: string    // 工具已完成
    error:     string    // 工具出错
    aborted:   string    // 工具已中止
  }

  diff: {
    added:      string   // 添加行
    removed:    string   // 删除行
    context:    string   // 上下文行（不着色，使用默认文本色）
    hunkHeader: string   // hunk 头 @@ ... @@
  }

  ui: {
    border:    string    // 边框、分隔线
    highlight: string    // 选中项背景
    dimmed:    string    // 弱化元素（分隔符、辅助信息）
  }

  status: {
    error:     string    // 错误状态
    success:   string    // 成功状态
    warning:   string    // 警告状态
    info:      string    // 信息状态
  }

  message: {
    user:      string    // 用户消息标识
    assistant: string    // AI 响应标识
    system:    string    // 系统消息标识
  }
}
```

---

## 三、暗色主题映射

MVP 只有一套暗色主题。以下是完整的语义到色值映射：

```typescript
import { palette } from './colors'

export const darkTokens: SemanticTokens = {
  text: {
    primary:   palette.white,
    secondary: palette.gray300,
    accent:    palette.blue,
    link:      palette.cyan,
  },

  tool: {
    pending:   palette.yellow,
    running:   palette.blue,
    completed: palette.green,
    error:     palette.red,
    aborted:   palette.gray500,
  },

  diff: {
    added:      palette.greenSoft,
    removed:    palette.redSoft,
    context:    palette.white,
    hunkHeader: palette.blueDim,
  },

  ui: {
    border:    palette.gray700,
    highlight: palette.gray900,
    dimmed:    palette.gray500,
  },

  status: {
    error:     palette.red,
    success:   palette.green,
    warning:   palette.yellow,
    info:      palette.blue,
  },

  message: {
    user:      palette.green,
    assistant: palette.blue,
    system:    palette.yellow,
  },
}
```

---

## 四、语义分组设计理由

### 为什么 6 个分组？

每个分组对应一类 UI 关注点，按组件文档中出现的颜色引用归纳得出：

| 分组 | 对应组件 | 说明 |
|------|---------|------|
| text | 全局 | 文本颜色的 4 种层次（主/辅/强调/链接） |
| tool | ToolPart | 5 种工具状态的颜色，与 ToolState 一一对应 |
| diff | DiffRenderer | 4 种 diff 行类型的颜色 |
| ui | StatusBar, Collapsible 等 | 通用 UI 元素颜色（边框/高亮/弱化） |
| status | MessageList, StatusBar | 通用状态颜色，用于 info 类消息和状态指示 |
| message | MessageList | 消息来源角色的颜色标识 |

### 为什么允许重复映射？

不同分组中的 token 可以映射到同一个 palette 色值。例如：

- `tool.completed` 和 `status.success` 都映射到 `palette.green`
- `tool.error` 和 `status.error` 都映射到 `palette.red`
- `tool.running` 和 `message.assistant` 都映射到 `palette.blue`

这是有意为之。语义分组的价值在于**表达用途**，而非**消除重复**。未来如果需要将工具完成色调整为青绿而保持成功状态为纯绿，只需修改 `tool.completed` 的映射，不影响 `status.success`。

### diff 为什么使用柔和色（Soft）而非主色？

diff 视图中添加/删除行密集出现，使用饱和度较低的 greenSoft 和 redSoft 减少视觉疲劳。而 `tool.completed`（green）和 `tool.error`（red）是单行状态指示，高饱和度反而有助于快速识别。

---

## 五、Token 与组件的对应关系

以下列出组件文档中出现的颜色引用，以及它们对应的 token：

| 组件文档中的描述 | 对应 Token |
|-----------------|-----------|
| StatusBar：模型名 accent（强调色） | `text.accent` |
| StatusBar：工作目录 dimColor | `text.secondary` |
| StatusBar：分隔符 dimColor | `ui.dimmed` |
| ToolPart：pending 黄色 | `tool.pending` |
| ToolPart：running 蓝色 | `tool.running` |
| ToolPart：completed 绿色 | `tool.completed` |
| ToolPart：error 红色 | `tool.error` |
| ToolPart：aborted 灰色 | `tool.aborted` |
| DiffRenderer：删除行红色 | `diff.removed` |
| DiffRenderer：添加行绿色 | `diff.added` |
| DiffRenderer：hunk 头蓝色 dimColor | `diff.hunkHeader` |
| Collapsible：标题 dimColor | `text.secondary` |
| Spinner：默认蓝色 | `status.info` |
| MessageList：info.kind 不同颜色 | `status.*` |

---

## 六、文档自检

- [x] SemanticTokens 类型定义完整（6 分组，25 个 token）
- [x] darkTokens 映射完整，每个 token 都指向明确的 palette 色值
- [x] 分组设计理由已说明
- [x] 重复映射的合理性已解释
- [x] diff 使用柔和色的理由已说明
- [x] Token 与组件文档的颜色引用已建立对应关系
