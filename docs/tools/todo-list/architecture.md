# todo-list 模块 architecture.md

本文档描述 `todo-list` 的内部结构、集成方式与关键权衡。

**前置文档**：`goals-duty.md`

## 一、Architecture Overview（总体架构）

### 1. Tool Facade

对 Agent 暴露 `todo_read` 与 `todo_write`，负责 schema、输入校验、Agent 可读输出和 ToolScheduler 分类。工具不直接处理 UI。

### 2. Session TodoService

按 `sessionId + contextScopeId` 维护当前不可变 Todo 数组，并提供读取、原子替换、懒恢复和变化订阅。主 context 的 `contextScopeId` 为空；服务生命周期由 UI runtime composition 持有，不由每次工具创建临时 store。

### 3. History Recovery Adapter

读取现有 session/message 历史，从后向前匹配 `todo_write` call 与对应成功 result，只恢复最后一次成功完成的完整数组。

### 4. UI Projection Adapter

把领域列表和 run 生命周期转换为 `UiSessionTodoList`，写入 `UiSnapshot` 并发布 `todo.updated`。投影包含展示所需的 `visible`，但它不进入 Agent 工具 schema。

### 5. Read-only Clients

Web/TUI 只接收 snapshot/event，按 active main session 选择列表并渲染。客户端只拥有临时展开状态，不拥有 Todo 内容事实。

### 6. Prompt Policy Integration

primary `base.md` 定义 Todo 的稳定工作策略；工具 description 与 schema 定义调用接口。Plan Agent 与普通 primary Agent 都可读写 Todo，因此共享 base 不会产生“提示要求调用但工具不可用”的能力缺口。当前不新增 Todo 专用动态 prompt layer，也不在本批改动全局 `<tool_guidance>` 组装机制。

## 二、核心数据路径

```text
todo_write ── validate ──> TodoService.replace(sessionId, contextScopeId, todos)
                                  |
                                  ├─ return todosChanged
                                  └─ UI projection checks visibility too
                                             |
                                             ├─ projection unchanged: no event
                                             └─ projection changed: todo.updated

todo_read ─────────────────> TodoService.read(sessionId, contextScopeId)
                                  |
                                  └─ unloaded: recover once from messages

run lifecycle ─────────────> UI projection visibility
                                  |
                                  ├─ UiSnapshot
                                  └─ todo.updated
```

## 三、关键设计模式

### 1. Full Replacement

`todo_write` 每次提交完整数组。数组最多 10 项，整体比较和复制成本有限；相比增量 CRUD，它更适合模型重写，也避免缺少 id 后的寻址问题。

### 2. Persistent Fact + Runtime Projection

- 持久事实：最后一次成功 `todo_write` 工具事务。
- 运行时事实投影：TodoService 中按 session/context scope 保存的当前数组。
- UI 投影：完整数组加临时 `visible`。

该分层避免新增存储，同时保证客户端不依赖消息格式。

### 3. Lazy, Monotonic Loading State

每个 session 内部至少区分：

- `unloaded`：尚未尝试历史恢复；
- `loaded`：已经恢复或已写入，列表可以为空。

状态从 unloaded 单向进入 loaded。显式清空后仍为 loaded，不能再次回扫旧历史。

### 4. Atomic Validation

完整解析并验证所有项目后才替换 store。校验失败、恢复候选损坏或工具取消均不产生部分状态。

### 5. Evented Snapshot Projection

`todo.updated` 是某个 session 的完整替换事件；列表内容相同但 `visible` 发生变化时仍需发布。只有完整投影都相同时才抑制事件。`UiSnapshot` 是断线重连和乱序恢复基线，客户端 resync 后以 snapshot 为准。

## 四、代码组织建议

现有 `packages/ohbaby-agent/src/tools/todo.ts` 可先保留。只有当工具 facade、恢复和服务职责使单文件明显失焦时，才拆为同级小文件：

```text
packages/ohbaby-agent/src/tools/
├── todo.ts                 # 公共类型、工具工厂或兼容导出
├── todo-service.ts         # session 状态、loaded 标记、变化订阅
└── todo-recovery.ts        # message history 适配
```

不预先建立多层目录，也不复制 session/message 领域类型。

## 五、关键权衡

### 双工具而不是单工具

读写意图清楚，沿用现有 registry 和 ToolScheduler 分类；代价是多一个工具定义，但避免“省略参数代表读取”的歧义。

`todo_write` 在 ToolScheduler 中仍是 write，以保留写波次串行化；它只修改 session 内部清单，不触碰文件、命令或外部系统，因此权限分类按内部状态更新默认放行，避免每次进度更新阻塞 run。

### 无 id 的整体替换

UI key 不再拥有领域级稳定身份，但 Todo 是短列表且整体替换；渲染 key 属于客户端实现细节，不值得扩充 Agent 契约。

### 消息历史恢复而非专用持久化

避免数据库/文件双事实源；代价是首次 resume 需扫描历史，因此采用从后向前、命中即停和 loaded 缓存。

### 后端投影可见性

`visible` 不属于 TodoItem，而属于 UI projection。由后端统一维护可避免 Web/TUI 在重连后对 run 生命周期做不同猜测。

### Transcript 静默但保留底层事务

在 UI projection/渲染边界隐藏，不删除核心消息。这样同时满足安静界面、Agent 错误处理和历史恢复。

### 稳定策略放在 base 而不是工具 description

复杂任务启用、避免简单任务滥用、里程碑更新和 run 生命周期是跨 `todo_read` / `todo_write` 的 Agent 行为，集中在 primary base 能保持单一权威来源。description 只保留读、整体替换、10 项和空数组清除等接口信息，减少其经 `<tool_guidance>` 与原生工具定义重复进入上下文的成本。

## 六、完成后的自检

- [x] 每个组件均对应明确职责，没有新增独立持久化。
- [x] 事实源、内存投影和 UI 投影层次清楚。
- [x] 恢复、重复写、原子失败和 resync 均有确定行为。
- [x] 代码布局遵循按需拆分，不预设过度抽象。
