# Styles 样式系统

## 一、职责与非职责

### 1.1 模块定位

**一句话说明**：styles/ 是 UI 层的颜色真相源，定义"哪些颜色存在（palette）→ 它们各自用在哪里（tokens）→ 当前主题下如何取用（theme getter）"的三层映射，供所有组件统一引用。

如果没有这个模块：每个组件自己写 `'#00BFFF'`，颜色修改要全仓库搜索替换，无法安全切主题。

对应职责追溯：goals-duty.md G5（Surface-Owned Rendering — 视觉呈现由 UI 拥有）。

### 1.2 Duties（职责）

| 职责 | 说明 |
|---|---|
| **D1 定义 palette** | 集中声明全部原始色值（hex），是色值的唯一真相源 |
| **D2 定义 semantic tokens** | 将 palette 色值映射为语义名称，按组件用途分组 |
| **D3 提供 theme getter** | 通过 getter 代理对象对外暴露当前主题的语义颜色，支持未来切主题 |
| **D4 维护 dialog token 分组** | 为 SelectableList / dialog renderer 提供 tone 五值、焦点背景、current 标记颜色 |

### 1.3 Non-Duties（非职责）

| 非职责 | 说明 |
|---|---|
| **N1 不做运行时主题切换** | MVP 只有一套 darkTokens，ThemeManager.setTheme() 是预留接口，不在 MVP 暴露给用户 |
| **N2 不检测终端能力** | 不做 OSC 11 背景色检测、不自动切明暗主题；Ink 内置 256 色降级已足够 |
| **N3 不处理 NO_COLOR** | NO_COLOR 环境变量支持推迟到 v2，不是 MVP 约束 |
| **N4 不管布局** | 间距、宽度、flex 排列属于 Ink 的 Box props，不属于 styles/ |
| **N5 不参与 Context 或 TuiStore** | theme 对象是模块级单例，组件直接导入，无需 Provider 注入 |
| **N6 不向组件暴露 palette** | 组件只导入 `theme`，不导入 `palette`（特殊场景除外） |

---

## 二、架构

样式系统采用三层架构，参考 gemini-cli 的分层模式，但大幅精简：

```
colors.ts           原始色值（palette）
  ↓                   13 个 hex 色值，无语义
tokens.ts           语义映射（SemanticTokens）
  ↓                   7 个分组，30 个语义 token
theme-manager.ts    getter 代理（theme 对象）
  ↓                   组件消费的唯一入口
组件                 import { theme } from '../styles'
                    <Text color={theme.text.accent}>
```

### 各文件职责

| 文件 | 职责 | 稳定性 |
|------|------|--------|
| [colors.ts](./colors.md) | 定义 palette 原始色值 | 高（色值极少变动） |
| [tokens.ts](./tokens.md) | 将 palette 映射为语义 token（7 分组） | 高（映射关系稳定） |
| [theme-manager.ts](./theme-manager.md) | ThemeManager 单例 + getter 代理导出 | 高（接口稳定，内部实现可扩展） |
| index.ts | 统一导出 | 高 |
| [non-functional.md](./non-functional.md) | 工程约束：终端兼容、禁止硬编码、getter 性能、类型完整性 | 文档 |
| [test.md](./test.md) | 测试策略：编译期 tsc + 运行时 vitest 单元测试 | 文档 |

### 数据流向

```
palette (colors.ts)
  └──→ darkTokens (tokens.ts) 引用 palette 色值
         └──→ ThemeManager (theme-manager.ts) 持有 darkTokens
                └──→ theme 对象 (getter 代理) 导出给组件使用
```

单向依赖，无循环引用。

---

## 三、index.ts 导出

```typescript
// 组件消费的主入口
export { theme } from './theme-manager'

// 类型导出（供需要类型标注的场景）
export type { SemanticTokens } from './tokens'

// palette 导出（仅供特殊场景，组件正常不使用）
export { palette } from './colors'
```

组件的标准用法：

```typescript
import { theme } from '../styles'
```

---

## 四、设计原则

### 集中定义

所有颜色在 styles/ 中集中定义。组件代码中不出现硬编码色值（如 `'#00BFFF'`），只出现语义路径（如 `theme.text.accent`）。

### 语义化命名

颜色按用途命名（`tool.running`），不按色相命名（`blue`）。色相信息封装在 palette 层，组件层只看到语义。

### 三层分离

- **palette 层**：回答"有哪些颜色"
- **tokens 层**：回答"这个颜色用在哪里"
- **theme 层**：回答"当前主题下这个语义对应什么颜色"

MVP 阶段三层几乎是直通的（只有一套主题），但分层确保未来加主题时不改组件代码。

### 最小化

- 13 个原始色值，覆盖全部组件需求
- 30 个语义 token，不多不少
- ThemeManager 约 50 行代码（预估）
- 不实现色阶生成、终端检测、自定义主题加载等高级功能

---

## 五、语义 Token 分组总览

| 分组 | Token 数 | 说明 | 主要消费者 |
|------|---------|------|-----------|
| text | 4 | 文本颜色层次 | 全局 |
| tool | 5 | 工具状态颜色 | ToolPart |
| diff | 4 | diff 行类型颜色 | DiffRenderer |
| ui | 3 | 通用 UI 元素 | StatusBar, Collapsible 等 |
| status | 4 | 状态指示颜色 | MessageList, StatusBar |
| message | 3 | 消息角色颜色 | MessageList |
| dialog | 7 | SelectableList tone 五值 + 焦点背景 + current 标记 | SelectableList, ModelDialog, SessionDialog |

完整定义见 [tokens.md](./tokens.md)。

---

## 六、与其他模块的关系

### 被依赖方

styles/ 被 components/ 中的所有需要颜色的组件依赖。它不依赖 ui 模块内的任何其他子目录（contexts/、hooks/ 等），也不依赖 ui 模块外的任何模块。

```
styles/  ←── components/*（消费 theme 对象）
         ←── 无其他依赖
```

### 与 Context 的关系

styles/ 不使用 React Context。`theme` 对象是模块级单例的 getter 代理，组件直接导入使用，不通过 Provider 注入。

这是有意的设计选择：颜色是全局常量（MVP 阶段），不需要 React 的响应式机制。未来如果需要运行时主题切换触发 React 重渲染，可以在 ThemeManager 上层加一个 ThemeContext，但 MVP 不需要。

---

## 七、文档自检

- [x] Duties / Non-Duties 均已定义，边界清晰
- [x] 三层架构及数据流向已清晰描述
- [x] 各文件职责和稳定性已列出
- [x] index.ts 导出内容已定义
- [x] 设计原则已说明（集中/语义化/分离/最小化）
- [x] 语义 Token 分组总览已提供（7 分组 / 30 token）
- [x] 与其他模块的依赖关系已说明
- [x] 不使用 React Context 的理由已解释
- [x] NO_COLOR / 终端检测明确标注为 Non-Duty，推 v2
