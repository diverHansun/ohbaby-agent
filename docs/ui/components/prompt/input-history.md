# InputHistory 输入历史

## 一、职责

InputHistory 描述 Prompt 组件的输入历史功能设计。历史记录的核心逻辑由 `useHistory` hook 实现，本文档定义数据结构和交互行为。

## 二、与 useHistory hook 的关系

| 关注点 | 所在位置 |
|--------|---------|
| 历史记录的存储和导航逻辑 | hooks/useHistory |
| 历史数据持久化（跨会话保留） | hooks/useHistory |
| 历史导航的键盘交互定义 | 本文档 |
| 历史数据结构定义 | 本文档 |

Prompt 组件通过 `useHistory` hook 获取历史导航能力：

```typescript
const { historyValue, navigateUp, navigateDown, addToHistory } = useHistory()
```

Prompt 不独立实现 InputHistory 组件。历史功能通过 hook 集成到 Prompt 中。

## 三、数据结构

```typescript
interface HistoryItem {
  text: string                   // 输入内容
  timestamp: number              // 提交时间戳
}
```

历史记录以数组形式存储，按时间顺序排列（旧 --> 新）。索引 0 为最早的记录，末尾为最新的记录。

## 四、导航行为

### 4.1 基本规则

| 按键 | 行为 |
|------|------|
| Up | historyIndex- -，显示更旧的记录 |
| Down | historyIndex++，显示更新的记录 |

### 4.2 边界处理

- **historyIndex = -1**（初始状态）：显示当前输入内容
- **按 Up 进入历史**：historyIndex 设为最后一条记录的索引，当前输入暂存
- **按 Up 到最旧记录**：停在首项，不循环
- **按 Down 回到 -1**：恢复暂存的当前输入

### 4.3 暂存机制

当用户正在输入但按了 Up 键进入历史，当前输入内容被暂存。当用户按 Down 键回到 historyIndex = -1 时，恢复暂存内容。这样历史导航不会丢失用户正在编辑的文本。

## 五、历史记录管理

### 5.1 添加

用户提交输入后（Enter），`useHistory.addToHistory(text)` 将文本追加到历史记录末尾。空白输入不记录。

### 5.2 去重

连续两次提交相同内容时，不重复记录（只保留最新一条）。

### 5.3 容量限制

历史记录保留最近 100 条。超出时移除最旧的记录。

### 5.4 持久化

历史记录通过 session 模块的存储机制持久化到磁盘，跨会话保留。具体持久化实现由 useHistory hook 内部调用 session 模块完成。

## 六、设计约束

1. **无独立组件**：历史功能通过 useHistory hook 集成到 Prompt，不是独立的 React 组件
2. **线性导航，不循环**：到达首尾边界时停止
3. **暂存保护**：历史导航不丢失当前输入
4. **持久化由 hook 负责**：Prompt 不感知存储细节

## 七、文档自检

- [x] 与 useHistory hook 的分工已明确
- [x] 导航行为完整（含边界处理和暂存机制）
- [x] 数据结构已定义
- [x] 历史管理规则已说明（添加、去重、容量、持久化）
