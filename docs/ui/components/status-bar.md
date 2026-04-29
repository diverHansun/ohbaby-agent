# StatusBar 状态栏组件

## 一、职责

StatusBar 在终端底部固定显示系统运行状态的摘要信息，提供用户对当前环境的持续感知。它是只读展示组件，不包含任何交互逻辑。

对应职责追溯：goals-duty.md D5（状态栏显示）。

## 二、视觉结构

```
~/projects/myapp | claude-sonnet | Agent (auto) | 1.2k (10%) | main-session
```

状态栏为单行水平排列，各段之间以分隔符 `|` 间隔。当终端宽度不足时，优先保留左侧信息，右侧信息按优先级截断。

### 信息段定义

| 段 | 显示内容 | 优先级 | 示例 |
|----|---------|--------|------|
| 工作目录 | 项目根目录（缩写） | 高 | `~/projects/myapp` |
| 模型名称 | 当前 LLM 模型 | 高 | `claude-sonnet` |
| 运行模式 | 模式 + Agent 子状态 | 中 | `Agent (auto)` |
| Token 用量 | 已消耗 + 占比 | 中 | `1.2k (10%)` |
| 会话名称 | 当前会话标识 | 低 | `main-session` |

### 运行模式显示规则

| mode | agentState | 显示 |
|------|-----------|------|
| `ask` | -- | `Ask` |
| `plan` | -- | `Plan` |
| `agent` | `ask-before-edit` | `Agent (ask)` |
| `agent` | `edit-automatically` | `Agent (auto)` |

## 三、数据来源

StatusBar 从 TuiStore 的 `useRuntime()` selector 获取只读运行视图状态。它不再读取 ConfigContext 或 SessionContext。

| 字段 | 类型 | 说明 | 上游事件 |
|------|------|------|---------|
| `workingDirectory` | string | 项目根目录 | `runtime.updated` |
| `model` | UiModelSummary | 当前 provider/model | `runtime.updated` |
| `mode` | string | 运行模式 | `runtime.updated` |
| `agentState` | string | Agent 子状态 | `runtime.updated` |
| `context` | UiContextUsage | token 用量和 context window 占比 | `runtime.updated` |
| `activeSession` | UiSessionSummary 或 null | 当前会话摘要 | `runtime.updated` / `session.updated` |

### 3.3 Token 显示

Token 显示直接来自 runtime view state：

1. **已消耗 token 数**：`runtime.context.usedTokens`，显示格式为缩写数字（如 `1.2k`、`15.3k`）。
2. **Context 窗口占比**：`runtime.context.percentUsed`，表示当前会话占模型 context window 的百分比。

组合显示格式：`{consumed} ({percent}%)`，例如 `1.2k (10%)`

## 四、样式规则

| 元素 | 颜色 | 说明 |
|------|------|------|
| 工作目录 | dimColor | 辅助信息 |
| 模型名称 | accent（强调色） | 视觉焦点 |
| 运行模式 | 默认文本色 | -- |
| Token 用量 | 默认文本色 | -- |
| 分隔符 `\|` | dimColor | 弱化 |
| 会话名称 | dimColor | 辅助信息 |

## 五、宽度适配

终端宽度可能不足以显示所有信息段。StatusBar 采用优先级截断策略：

1. 计算所有段的总宽度（含分隔符）
2. 如果超出终端宽度，从最低优先级的段开始移除
3. 截断顺序：会话名称 --> Token 用量 --> 运行模式
4. 工作目录和模型名称始终保留（必要时截断路径为 `...` 后缀）

宽度信息从 Ink 的 `useStdout().columns` 获取。

## 六、设计约束

1. **纯展示，无交互**：StatusBar 不响应键盘或鼠标事件
2. **单行限制**：始终占据终端底部一行，不换行
3. **不显示警告**：context 模块在 85% 阈值时自动触发压缩，StatusBar 只显示当前占比
4. **更新频率控制**：runtime 更新由 TuiStore selector 控制，只在 runtime 切片引用变化时重渲染

## 七、文档自检

- [x] 5 个信息段全部定义，含优先级
- [x] 数据来源追溯到 TuiStore runtime selector
- [x] Token 双源显示逻辑已说明（consumed + percentUsed）
- [x] 宽度适配策略已定义
- [x] 运行模式的组合显示规则完整
