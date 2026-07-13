# TodoList 参考项目分析

## 1. 参考基线

本次分析使用本地源码快照：

| 项目 | 本地 commit | 重点文件 |
|------|-------------|----------|
| Kimi Code | `19c5aa64` | `todo-panel.ts`、`custom-editor.ts`、Web `TodoCard.vue` / `ChatDock.vue` |
| OpenCode | `34e580905` | `session-todo-dock.tsx`、`session-composer-state.ts`、`message-part.tsx` |
| Claude Code | `75e2b3b9` | `TaskListV2.tsx`、`TodoWriteTool.ts`、`defaultBindings.ts` |

这些项目用于验证成熟交互模式，不作为字段或架构的整包复制来源。

## 2. Kimi Code

### 可采用

- TUI `MAX_VISIBLE = 5`，在紧凑终端中有清晰空间上限。
- `Ctrl+T` 只在有溢出时切换展开状态，避免抢占无意义按键。
- 紧凑选择优先进行中任务，再补未开始任务，并在有空间时保留最近完成任务；最终仍按原顺序输出。
- Web 通过容器最大高度和滚动展示列表，而不是把数据硬截断为 5 项。

### 需要调整

- Kimi Web 的 `latestTodos` 从聊天历史推导 Todo。OhBaby 同时维护 Web/TUI 且已有正式 SDK 事件体系，因此改为消费 `UiSnapshot + todo.updated`。
- Kimi 的 transcript 成功调用仍可能保留工具标题。OhBaby 的确认要求更严格：Todo read/write call/result 都不进入正常 transcript。

## 3. OpenCode

### 可采用

- TodoDock 位于 composer 工作区而不是 transcript 内，信息层级正确。
- 完整列表使用固定最大高度和 `overflow-y-auto`，解决 3、5、10 项等不同规模，不需要人为定义“只显示几项”。
- session composer state 对 run 周期的打开、关闭和清理有明确处理，可作为生命周期组织参考。
- `todowrite` 在 message part/turn 渲染层被隐藏，证明“工具仍执行、UI 不显示工具消息”是成熟模式。

### 需要调整

- OhBaby 保留 `todo_read` 和 `todo_write` 两个工具，隐藏集合需同时覆盖两者。
- OhBaby 不采用 OpenCode 的 priority/cancelled 等更重任务模型，也不引入其数据库持久化方案。

## 4. Claude Code

### 可采用

- Todo 状态保持 `pending/in_progress/completed`，验证了三态足以支撑 Agent 高频重写。
- TodoWrite 不提供普通 tool use/result renderer，进度通过专用任务列表呈现。
- 默认键位中使用 `Ctrl+T` 切换 Todo 可见内容，与 Kimi 的终端习惯一致。

### 不采用

- `TaskListV2` 根据终端高度动态选择 3–10 项并引入更复杂的近期/状态排序。OhBaby v1 采用固定紧凑上限 5 与展开上限 10，规则更容易测试和解释。
- 不采用 owner、blocker、activeForm、时间戳等任务编排字段。

## 5. 设计结论

| 设计面 | 决策 | 来源 |
|--------|------|------|
| Web 布局 | composer 上方 TodoDock、全量列表、限高滚动 | 主要借鉴 OpenCode，Kimi Web 佐证 |
| TUI 布局 | Prompt 上方、紧凑 5 项、Ctrl+T 展开 | 主要借鉴 Kimi，Claude 键位佐证 |
| 工具 transcript | read/write 全部静默 | OpenCode、Claude 的隐藏策略，按 OhBaby 要求加强 |
| 状态模型 | 三态，无 id/priority | Claude 的简洁状态 + OhBaby 讨论结论 |
| 数据来源 | 后端 snapshot/event | 拒绝 Kimi Web 历史推导，适配 OhBaby 现有事件架构 |
| 持久化 | 消息历史恢复 + 内存投影 | 保持 OhBaby 当前约束，不复制 OpenCode DB |

## 6. 避免的“参考项目驱动过度设计”

- 不因为 Claude 有 TaskV2 就一次性实现依赖图或多 Agent 任务汇总。
- 不因为 OpenCode 有数据库就新增 Todo 表。
- 不因为 Kimi 有历史 selector 就让两个客户端重复解析消息协议。
- 不为了复制视觉细节而改变 OhBaby 现有 composer/Prompt 信息架构。
