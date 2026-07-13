# TodoList 优化方案与改动面

## 1. 目标结构

```text
Agent tool call
  ├─ todo_read  ───────────────┐
  └─ todo_write ── validate ───┤
                               v
                    Session TodoService
                    ├─ runtime projection
                    ├─ lazy history recovery
                    └─ change notification
                               |
                               v
              UI state projection + todo.updated
                    ├─ UiSnapshot resync
                    ├─ Web TodoDock
                    └─ TUI TodoPanel
```

底层消息历史保存成功工具事务，承担恢复事实源；UI snapshot/event 保存当前可渲染投影。二者职责不同，前端不读取前者。

## 2. 分阶段实施方案

### Phase 1：收缩领域契约与工具行为

对应问题：P-01、P-02。

- 将 `TodoStatus` 收缩为 `pending | in_progress | completed`。
- 将 `TodoItem` 收缩为 `content/status`，删除 `id/priority`。
- 保留 `todo_read` 与 `todo_write` 名称、分类和整体替换语义。
- 加入 10 项和单项 100 Unicode 字符硬限制。
- 确保解析完成后才写入，非法输入保持旧列表不变。
- 允许多个 `in_progress`。
- 相同数组写入成功；完整 UI 投影也未变化时不发重复事件。

主要改动：

- `packages/ohbaby-agent/src/tools/todo.ts`
- `packages/ohbaby-agent/src/tools/todo.unit.test.ts`
- 内置工具 schema/registry 契约测试

### Phase 2：引入稳定 TodoService 与恢复能力

对应问题：P-03、P-04。

- 由 UI runtime composition 创建并持有单一 TodoService，再注入工具集合。
- 服务按 `sessionId + contextScopeId` 隔离列表；共享 child session 的多个子 Agent 仍互不覆盖。
- 为 session 建立 `unloaded` / `loaded` 两态，`loaded + []` 不再触发历史回扫。
- 首次读写或 resume 入口按项目消息模型从后向前匹配 `todo_write` call 与成功 result。
- 跳过失败、拒绝、取消、不完整或参数不合法的候选，命中最后一次成功写后停止。
- 恢复只更新运行时投影，不伪造新的工具消息。

主要改动预计涉及：

- `packages/ohbaby-agent/src/tools/todo.ts`，必要时拆成同目录小文件
- `packages/ohbaby-agent/src/tools/builtin.ts`
- `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- session/message 历史读取适配点及相邻契约测试

拆文件只在职责确实分离时进行，不预先建立深层目录。

### Phase 3：建立 SDK、snapshot 与事件投影

对应问题：P-05、P-09。

- 在 `ohbaby-sdk` 定义共享 `UiTodoItem`、`UiSessionTodoList` 和 `UiTodoUpdatedEvent`。
- `UiSessionTodoList` 包含 `sessionId`、完整 `todos` 和后端统一计算的 `visible`；`visible` 是临时 UI 投影，不进入工具参数和消息恢复事实。
- `UiSnapshot.todos` 作为可选数组加入协议，兼容旧快照。
- `todo.updated` 直接携带单 session 的 `sessionId/todos/visible` 完整替换投影，不传增量 patch。
- run 开始、结束、显式清空和当前 run 内完成全部任务时，由后端 projection 统一更新 `visible`：
  - 当前 run 写入非空列表：`visible = true`；
  - run 结束或写入空数组：`visible = false`；
  - 新 run 开始：只有存在未完成项目才设为 true。
- snapshot 始终可重建当前投影，事件断线后以 snapshot 为准。

主要改动预计涉及：

- `packages/ohbaby-sdk/src/snapshot.ts`
- `packages/ohbaby-sdk/src/events.ts` 及导出文件
- `packages/ohbaby-agent/src/adapters/ui-state/`
- `packages/ohbaby-agent/src/adapters/ui-runtime/`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 及相邻契约测试

### Phase 4：在投影边界隐藏 Todo 工具 transcript

对应问题：P-06。

- 定义集中式隐藏工具集合，至少包含 `todo_read`、`todo_write`。
- 正常 UI message projection 不生成这两类 tool call/result part；流式事件也不得短暂显示后再消失。
- 工具事务继续存在于核心消息历史，Agent 仍能收到结果/错误，恢复仍能读取。
- Web/TUI 再加防御性过滤，避免旧持久 snapshot 中已有 Todo parts 时重新显示。

主要改动预计涉及：

- `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`
- `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts`
- Web/TUI transcript 选择或渲染边界
- 对应 projection、持久化和 UI contract tests

### Phase 5：实现 Web TodoDock

对应问题：P-07、P-09。

- selector 只选当前 active main session 的 Todo 投影。
- 在 composer stack 上方渲染只读 TodoDock，不插入 transcript。
- 显示后端允许的全部最多 10 项，容器限制最大高度并 `overflow-y: auto`。
- 默认展开并支持用户折叠；头部显示 `completed/total` 摘要，折叠态预览首个进行中、否则首个待处理、最后回退到最近完成项。
- 用状态图标、文字样式表达完成度，DOM 顺序严格跟随数组顺序。
- `visible=false`、空数组、无 active session 或 run 结束时隐藏。
- 重连/`snapshot.replaced` 后完全按 snapshot 恢复。

主要改动预计涉及：

- `apps/ohbaby-web/src/api/daemon/eventReducer.ts`
- `apps/ohbaby-web/src/ui/selectors.ts`
- `apps/ohbaby-web/src/ui/App.tsx`（可按现有组织提取组件）
- `apps/ohbaby-web/src/ui/styles.css`
- 相邻 unit/integration tests

### Phase 6：实现 TUI TodoPanel

对应问题：P-08、P-09。

- 把 Todo 投影加入 TUI store 和 `todo.updated` reducer。
- 在 Prompt 上方渲染只读面板。
- 紧凑态最多 5 项，按已确认的 Kimi 选择策略取样，再按原数组顺序输出。
- 仅存在溢出时消费 `Ctrl+T`；展开态展示最多 10 项，再次按键收起。
- session 切换、run 结束、清空或面板隐藏时重置本地展开态。
- Todo 工具不进入 committed/live transcript。

主要改动预计涉及：

- `packages/ohbaby-cli/src/tui/store/snapshot.ts`
- `packages/ohbaby-cli/src/tui/store/events.ts`
- `packages/ohbaby-cli/src/tui/app.tsx`
- `packages/ohbaby-cli/src/tui/components/` 下 Todo 组件与键盘处理
- 相邻 unit/contract/integration tests

### Phase 7：全链路验证、审查与收尾

对应问题：P-10。

- 执行 Todo 相关单元、契约、集成测试，再执行仓库 typecheck/lint/preflight 中与改动相称的检查。
- 启动真实 Web 服务，通过浏览器控制完成 E2E。
- 构建并启动真实 TUI 进程，通过 PTY 输入完成生命周期和 `Ctrl+T` 验收。
- 测试通过后使用子代理审查：至少覆盖后端/恢复/契约一组，以及 Web/TUI/测试一组。
- 主代理核对审查意见、修复有效问题、重跑受影响测试。

## 3. 决策追踪矩阵

| 讨论决策 | 实施阶段 | 主要验收 |
|----------|----------|----------|
| D-01 双工具 | Phase 1 | A-01、D-01、D-02 |
| D-02 最小模型 | Phase 1 | A-01、A-02、A-08 |
| D-03 10/100 与原子写 | Phase 1 | A-04–A-09 |
| D-04 事实源与恢复 | Phase 2 | B-01–B-07 |
| D-05 正式 UI 契约 | Phase 3 | C-01–C-04 |
| D-06 显示生命周期 | Phase 3、5、6 | C-05–C-09、E-05、F-05 |
| D-07 Web/TUI 呈现 | Phase 5、6 | E-01–E-06、F-01–F-06 |
| D-08 Transcript 静默 | Phase 4 | D-01–D-05 |
| D-09 session/子 Agent 隔离 | Phase 2、3、5、6 | A-10、C-02、E-04、F-05 |

## 4. 变更边界

### 必须修改

- Todo 工具与运行时服务
- SDK snapshot/event 契约
- 后端 UI 投影和 transcript 过滤
- Web reducer/selector/component/style
- TUI store/component/keybinding
- 各层自动化测试和使用文档

### 原则上不修改

- Goal 领域模型和 goal driver
- ToolScheduler 的并发分类规则（沿用现有 read/write 分类）
- session 的独立持久化格式，除非恢复适配确需读取现有字段
- 子 Agent 管理与主界面信息架构
- 数据库 schema

## 5. 临时分支与分批提交

文档获批后的实施阶段：

1. 在当前工作树创建临时分支 `codex/todo-list`。
2. 先提交已确认文档：`docs(todo): align todo-list contracts and plan`。
3. 后续建议按可验证边界提交：
   - `refactor(todo): simplify tool contract and add recovery`
   - `feat(todo): project session todos through sdk events`
   - `feat(web): add todo dock`
   - `feat(tui): add compact todo panel`
   - `test(todo): cover browser and terminal workflows`
4. 若测试或审查修复跨越单一边界，可增加独立 `fix(todo): ...`，不把所有改动压成一次提交。
5. 不在本任务中 merge；不主动 push 或开 PR，除非用户后续授权。

提交标题可根据最终实际改动微调，但每个提交必须独立可解释且不夹带无关工作树内容。

## 6. 回滚策略

- 工具契约、SDK 投影、Web 和 TUI 分批提交，可按层回滚。
- `UiSnapshot.todos` 为可选字段，前端能把缺失字段视为空，减少协议升级的锁步风险。
- 若 UI 实现需要撤回，后端双工具和恢复逻辑仍可独立工作。
- 不引入数据库迁移，因此没有不可逆数据回滚步骤。
