# ToolPart 工具调用组件

## 一、职责

ToolPart 渲染工具调用的状态和结果。采用 Claude Code 风格的单行摘要设计，始终可见、不折叠，通过状态颜色区分执行进度。

对应职责追溯：goals-duty.md D3（消息渲染 - 工具调用状态显示）。

## 二、状态机

ToolPart 的渲染由 `state.status` 驱动，对应 message 模块定义的 5 种 ToolState：

| status | 含义 | 可用字段 |
|--------|------|---------|
| `pending` | 等待策略检查 | `input`, `raw` |
| `running` | 正在执行 | `input`, `title`（可选）, `time.start` |
| `completed` | 执行成功 | `input`, `output`, `title`, `time`, `attachments`（可选） |
| `error` | 执行失败 | `input`, `error`, `time` |
| `aborted` | 用户中断 | `input`, `error`（固定消息）, `time` |

## 三、视觉结构（单行摘要）

### 各状态显示

```
pending:
  [pending] read_file src/auth/index.ts

running:
  [spinner] read_file src/auth/index.ts

completed:
  [done] read_file
  [result] src/auth/index.ts (142 lines)

error:
  [error] read_file
  [result] Permission denied: src/auth/index.ts

aborted:
  [aborted] read_file
  [result] Cancelled by user
```

### 状态颜色

| status | 颜色 | 图标 |
|--------|------|------|
| `pending` | 黄色 | 时钟或等待符号 |
| `running` | 蓝色 | Spinner（旋转动画） |
| `completed` | 绿色 | 完成标记 |
| `error` | 红色 | 错误标记 |
| `aborted` | 灰色 | 中断标记 |

### 显示内容组合

- **第一行**：状态图标 + 工具名 + 关键参数摘要
- **第二行**（completed/error/aborted）：结果摘要或错误信息

关键参数摘要从 `state.input` 中提取最具辨识度的字段（如文件路径、命令内容）。如果工具提供了 `title` 字段，优先使用 `title` 作为显示文本。

## 四、结果摘要策略

`completed` 状态的 `output` 字段可能包含大量文本（如文件内容）。ToolPart 只显示摘要，不显示完整 output：

| 工具类型 | 摘要策略 |
|---------|---------|
| read_file | 文件路径 + 行数 |
| edit_file | 文件路径 + 修改概述 |
| bash | 命令 + 前几行输出（截断） |
| 其他 | output 首行（截断到终端宽度） |

摘要策略可以通过工具名匹配实现，未知工具使用通用截断。

## 五、流式状态更新

ToolPart 通过订阅 `Message.Event.PartUpdated` Bus 事件接收状态变化：

```
Part 创建（pending）
    ↓
Message.Event.PartUpdated（state: running）
    ↓ ToolPart 更新显示：spinner + 工具名
    ↓
Message.Event.PartUpdated（state: completed/error/aborted）
    ↓ ToolPart 更新显示：最终状态 + 结果摘要
```

ToolPart 组件在挂载时订阅 Bus 事件，通过 `partId` 匹配更新。

## 六、attachments 处理

`completed` 状态可以包含 `attachments: FilePart[]`，表示工具执行产生的文件附件。如果存在 attachments，在结果摘要下方额外渲染 FilePart 组件。

## 七、数据输入

| 字段 | 类型 | 来源 | 说明 |
|------|------|------|------|
| id | string | Part 基础字段 | 用于匹配 Bus 事件 |
| callId | string | ToolPart 字段 | 工具调用 ID |
| tool | string | ToolPart 字段 | 工具名称 |
| state | ToolState | ToolPart 字段 | 当前执行状态（含 status、input、output 等） |

## 八、设计约束

1. **单行摘要，不折叠**：始终可见，不提供展开查看完整 output 的交互
2. **不调用工具模块**：ToolPart 只渲染数据，不触发工具执行或重试
3. **摘要策略按工具名匹配**：不同工具的摘要格式可以不同，但都限制在 1-2 行
4. **running 状态使用 Spinner**：与 LoadingIndicator 的 Spinner 样式一致

## 九、文档自检

- [x] 5 种 ToolState 全部覆盖，每种状态的显示格式已定义
- [x] 状态颜色映射完整
- [x] 结果摘要策略已说明（按工具名匹配 + 通用截断）
- [x] 流式状态更新路径清晰（Bus 事件 → partId 匹配）
- [x] attachments 处理已提及
- [x] 数据字段与 message 模块 data-model 一致
