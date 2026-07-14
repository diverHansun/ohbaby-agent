# todo-list 模块 test.md

本文档定义 TodoList 的测试层级和关键验收。完整实施清单见 `improve-1/04-test-and-acceptance.md`。

**前置文档**：`goals-duty.md`、`architecture.md`、`data-model.md`、`dfd-interface.md`、`use-case.md`

## 一、测试范围

### 覆盖

- `todo_read` / `todo_write` schema、输出和读写分类。
- TodoService 的原子替换、session/context scope 隔离、重复写抑制和 loaded 状态。
- 从消息历史恢复最后一次成功 write transaction。
- `UiSnapshot.todos`、`todo.updated`、run 可见性投影和 reducer。
- Web TodoDock 与 TUI TodoPanel 的布局、顺序、容量和生命周期。
- 两个工具在 streaming、持久 snapshot 和失败路径中均不进入 transcript。
- 默认权限下 `todo_write` 直接执行，不产生权限弹窗；文件和命令写权限不受影响。
- primary base 包含 Todo 启用与生命周期策略；Plan Agent 同时具备 Todo 读写工具。
- Goal workload scope 与 ordinary/context scope 隔离；active Goal 跨 continuation 可见，pause→ordinary→resume 正确切换，complete 前只有 prompt 软对账而无 runtime gate。
- 真实浏览器和真实 TUI 进程验收。

### 不覆盖

- 跨模型、跨 Provider 的 Todo 主动调用率质量评测；本版本只做确定性的 Prompt 内容和工具可用性测试。
- Todo 专用持久化、跨 session 汇总或 UI 编辑，因为这些不属于本版本。
- 参考项目的像素级复刻。

## 二、关键场景

### CS1：最小双工具契约

- registry 同时存在 `todo_read` 和 `todo_write`。
- write 只接受 `content/status`；read 不接受参数。
- 多个 `in_progress` 合法。

### CS2：边界与原子性

- 10 项和 100 Unicode 字符成功。
- 11 项、101 字符、空白 content、非法 status 和额外字段失败。
- 任一失败后旧列表与事件计数保持不变。

### CS3：清空与幂等

- `todo_write([])` 进入 loaded + []，发布一次清空/隐藏投影。
- 当前投影不变时，相同列表重复写成功但不重复发布事件；若 `visible` 改变则仍发布。

### CS4：成功事务恢复

- 多次成功写入恢复最后一次。
- 最后一次失败/取消/未完成时跳过，恢复更早成功值。
- 最后一次成功 `[]` 恢复为空且不复活旧列表。

### CS5：session 隔离

- 主 session、另一主 session、同一 child session 的不同 context scope 分别维护列表。
- 同一主 session 的 ordinary、`goal:<goalId>` 和替换后的新 goalId 分别维护列表；子 Agent 不继承 parent Goal scope。

### CS5a：Goal 生命周期与 lease

- Goal run start 获取明确 goalId 对应的冻结 lease；缺少 goalId 显性失败，不降级 ordinary。
- active Goal 的非空列表跨 continuation 不闪烁；pause 后 ordinary 写入不污染 Goal，resume 恢复原列表。
- `CreateGoal({replace:true})` 中途换 identity 时当前 run 仍写旧 scope，下一 continuation 读新 scope。
- complete 前模型 prompt 要求 reconcile，但 GoalService 不读取 TodoStore、pending Todo 不阻止 complete。
- rebuild 同时存在 ordinary/Goal 历史时，按 `internalWorkScopeId` 选择；旧无 metadata 只恢复 ordinary。
- active main session selector 不聚合子 Agent Todo。

### CS6：snapshot/event 一致性

- 旧 snapshot 缺字段按空处理。
- `todo.updated` 只替换目标 session。
- 断线后 snapshot resync 得到最终状态。

### CS7：run 生命周期

- 当前 run 非空列表显示。
- 当前 run 更新为全 completed 后仍显示。
- run 结束隐藏但 items 保留。
- 新 run 仅在有 pending/in_progress 时重新显示。
- 显式清空立即隐藏。

### CS8：Transcript 静默

- 成功、失败、streaming、持久历史四条路径都不显示 Todo call/result/摘要。
- Agent 仍能收到 read/write 输出或参数错误。
- 普通工具显示行为不受影响。

### CS9：Web 行为

- 1、5、10 项均全量 DOM 渲染并保持数组顺序。
- 容器超高时内部滚动。
- session 切换、run 结束、清空和 snapshot replace 正确。

### CS10：TUI 行为

- 紧凑态最多 5 项，选择规则与原数组顺序正确。
- 有溢出时 `Ctrl+T` 展开/收起到最多 10 项。
- 隐藏、session 切换后展开态重置。

### CS11：Agent Prompt 与工具能力

- primary base 对复杂任务、简单任务、创建时机、更新节奏、多 `in_progress`、完成验证和清空生命周期有确定性断言。
- Plan Agent 同时注册 `todo_read` 与 `todo_write`。
- 两个工具 description 只包含接口语义；状态和字段边界由 schema 断言。

## 三、测试层级与位置

| 层级 | 现有基础 | Todo 增量 |
|------|----------|-----------|
| Unit | Vitest、`todo.unit.test.ts` | 字段/边界/原子/幂等/恢复 |
| SDK/Reducer contract | Web eventReducer、TUI events tests | snapshot/event 和生命周期 |
| UI contract | Web App tests、TUI `app.contract.test.tsx` | Dock/Panel、过滤、Ctrl+T |
| Integration | daemon/server-client、TUI integration | session 切换、resync、真实事件链 |
| Process/E2E | CLI fake SSE process 样板 | 真实浏览器 + PTY TUI |

## 四、真实验收

### Web

启动实际 daemon/Web，通过浏览器控制写入和更新 10 项 Todo，验证 Dock 位置、内部滚动、三态、多 in_progress、run 生命周期、重连和 transcript 静默；同时检查桌面与窄屏布局。

### TUI

构建并用 PTY 启动实际 CLI 进程，接入可控测试 provider，验证紧凑 5 项、`+N more`、`Ctrl+T`、全部 10 项、session/run 生命周期、scrollback 静默和正常退出。

## 五、通过标准

- 定向 unit/contract/integration tests 全部通过。
- 受影响 package typecheck 和 lint 通过；改动面允许时仓库 `preflight` 通过。
- 真实浏览器和 TUI 进程场景有明确通过记录。
- 子代理完成后端/契约与 UI/测试审查，有效问题已处理并重测。
- 实现分批 commit 并停留在临时分支，不 merge。

## 六、完成后的自检

- [x] D1–D7 均有测试场景。
- [x] 测试不再排除 Web/TUI 或真实 E2E。
- [x] 失败事务、空数组、重复写和重连均有明确断言。
- [x] 自动化测试与人工控制的真实进程验收边界清楚。
