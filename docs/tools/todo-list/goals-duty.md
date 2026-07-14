# todo-list 模块 goals-duty.md

本文档定义 `todo-list` 子模块的设计目标与职责边界。

**当前代码入口**：`packages/ohbaby-agent/src/tools/todo.ts`

**模块定位**：为 Agent 提供轻量、可恢复、按 session/context/workload scope 隔离的执行清单，并通过正式 UI 投影在 Web/TUI 中显示当前进度。

## 一、Design Goals（设计目标）

### G1：让 Agent 显式表达多步骤工作的当前进度

Agent 可用三态有序列表表达正在做、等待做和已经完成的步骤。Todo 是短期执行上下文，不是长期任务管理系统。

### G2：保持模型契约最小且稳定

- 保留 `todo_read` 和 `todo_write` 两个 snake_case 工具。
- 每项只有 `content` 和 `status`。
- 数组顺序就是执行顺序和隐式优先级。
- 允许多个 `in_progress`，不要求 Agent 维护无业务价值的 id。

### G3：让 Web/TUI 低延迟且一致地显示

后端通过 `UiSnapshot` 与 `todo.updated` 提供正式投影。两个客户端不扫描消息历史，也不各自发明恢复规则。

### G4：不新增 Todo 专用持久化

运行时使用内存投影；跨 resume 的事实源是消息历史中最后一次成功完成的 `todo_write`。不新增文件、数据库表或浏览器本地存储。

### G5：让进度可见但不污染对话

Todo 只通过 Web TodoDock/TUI TodoPanel 呈现。`todo_read`、`todo_write` 的调用和结果不进入正常 transcript。

### G6：让 Agent 在合适的任务中使用 Todo

primary system prompt 负责定义启用时机、维护节奏和完成/清空生命周期：复杂多阶段任务使用，简单问答和一步任务跳过；先理解范围再创建；只在真实里程碑或范围变化时更新；完成必须经过相关验证；run 结束不等于清空。

### G7：让 Goal 与普通工作共享 session 而不共享清单

Goal 的 Todo 使用内部 `goal:<goalId>` workload scope，跨 continuation 保留；Goal pause 后的普通工作仍使用 ordinary scope，resume 后重新选择原 Goal scope。workload scope 不进入模型工具参数、SDK/UI 事件或客户端选择器。

## 二、Duties（职责）

### D1：提供双工具

- `todo_write` 接收完整 `todos` 数组并原子替换当前 scope 列表；`[]` 表示显式清空。
- `todo_read` 无参数，只读返回当前 scope 列表，不产生更新事件。

### D2：校验最小领域契约

- 状态仅允许 `pending`、`in_progress`、`completed`。
- 每个 `content` 去除首尾空白后非空，最多 100 个 Unicode 字符。
- 单列表最多 10 项。
- 任一项非法则整次写入失败，旧状态不变。

### D3：维护按 scope 隔离的运行时投影

每个主 session 的 ordinary/Goal workload、每个子 Agent session/context 独立保存当前完整列表。主 session 不读取或汇总子 Agent Todo；子 Agent context 也不继承 parent Goal workload scope。

### D4：从成功工具事务恢复

首次加载或 resume 时，从后向前查找 workload scope 匹配且最后一次已成功完成的 `todo_write`，忽略失败、拒绝、取消或不完整调用。成功的空数组也是有效恢复结果。旧历史中没有内部 workload metadata 的写入只属于 ordinary，不猜测迁移到 Goal。

### D5：投影 snapshot、事件和显示生命周期

- 成功且内容发生变化的写入发布完整替换 `todo.updated`。
- `UiSnapshot` 可重建各 session 当前 Todo 和可见性。
- ordinary run 内非空列表可见，run 结束隐藏但不清空；新 ordinary run 仅在存在未完成项时重新显示。
- active Goal 的非空列表跨 continuation 持续可见，包括 complete 前待模型对账的全 completed 列表；Goal pause/cancel/complete 或 identity 替换后切走旧投影。

### D6：从正常 transcript 隐藏 Todo 工具

UI message projection 与客户端渲染都不得展示 Todo call/result、JSON 或更新摘要；底层消息仍保留给 Agent、恢复和诊断使用。

### D7：保持 Prompt 与工具契约分工

- `primary/base.md` 保存跨调用的 Todo 使用策略。
- `todo_read` / `todo_write` description 只说明接口语义；字段、状态和 10/100 边界由 JSON schema 表达。
- Plan Agent 同时允许 `todo_read` 与 `todo_write`，使共享 primary base 指令可执行。

## 三、Non-Duties（非职责）

### N1：不提供任务管理扩展字段

不提供 `id`、`priority`、`cancelled`、owner、blocker、时间戳或依赖图。

### N2：不支持 UI 直接编辑

Web/TUI 为只读视图。用户通过自然语言要求调整，由 Agent 调用 `todo_write`。

### N3：不跨 session 聚合

主 TodoDock 只显示当前主 session。子 Agent Todo 不进入主列表。

### N4：不替代 Goal 系统

Goal 管理长期目标、驱动状态和预算；Todo 仅描述当前执行步骤。Goal complete 不读取 TodoStore、不设运行时硬门禁，complete 前对账属于模型行为契约。

### N5：不保存历史版本

模块只维护当前完整列表，不提供 Todo 版本、统计报表或审计 UI。历史工具事务仍属于现有消息系统。

### N6：不让客户端推导权威状态

Web/TUI 不扫描 transcript、tool parts 或本地缓存来重建 Todo。

## 四、与其他模块的关系

| 模块 | 关系 | 责任 |
|------|------|------|
| ToolScheduler | 调用方 | 按现有 readonly/write 分类调度两个工具 |
| session/message | 恢复来源 | 保存底层成功/失败工具事务 |
| UI runtime/state | 投影方 | 维护 snapshot、发布事件、统一生命周期可见性 |
| ohbaby-sdk | 契约 | 定义 Todo snapshot/event 类型 |
| ohbaby-web | 消费方 | OpenCode 风格 TodoDock，全量最多 10 项、限高滚动 |
| ohbaby-cli | 消费方 | Kimi 风格 TodoPanel，紧凑 5 项、Ctrl+T 展开 |
| goals | 平行模块 | 提供 run owner + goalId 供 adapter 选择内部 scope；不读取 Todo 内容、不把 Todo 变为 Goal 状态权威 |
| system-prompt | 使用策略 | 在 primary base 定义 Todo 触发、更新与生命周期 |

## 五、完成后的自检

- [x] 双工具、最小字段、10/100 限制和多 `in_progress` 已明确。
- [x] 运行时投影与消息历史恢复事实源已区分。
- [x] 主/子 session 隔离和 transcript 静默已明确。
- [x] 没有引入 Todo 专用持久化或任务管理扩展。
- [x] primary Prompt、Plan Agent 工具权限与 Todo 工具契约保持一致。
