# TodoList 测试与验收标准

## 1. 测试原则

- 先验证领域契约，再验证 snapshot/event，最后验证真实用户界面。
- 自动化测试使用项目现有 Vitest 命名和目录习惯，不为了单一模块先引入新 E2E 框架。
- 浏览器和 TUI 最终验收必须运行真实进程，不能只用组件快照代替。
- 每个失败写入都要验证“旧状态不变、无成功事件”，不能只断言抛错。

## 2. 自动化测试矩阵

### A. 工具与 TodoService 单元测试

| 编号 | 场景 | 验收 |
|------|------|------|
| A-01 | `todo_write` 写入三态列表 | 保持数组顺序，`todo_read` 返回相同内容 |
| A-02 | 多个 `in_progress` | 写入成功，不做单进行中限制 |
| A-03 | 空数组清空 | 返回空列表，状态标记为已加载，旧列表不复活 |
| A-04 | 10 项边界 | 成功 |
| A-05 | 11 项 | 整次拒绝，旧状态与事件数不变 |
| A-06 | 内容 100 Unicode 字符 | 成功 |
| A-07 | 内容 101 Unicode 字符、空串、纯空白 | 整次拒绝，旧状态不变 |
| A-08 | `cancelled` 或额外 `id/priority` | schema/解析拒绝 |
| A-09 | 当前投影已可见时重复写相同完整列表 | 调用成功，不重复发 `todo.updated` |
| A-10 | 两个 session 或同一 child session 的不同 context scope | 相互隔离，不汇总 |
| A-11 | 返回 metadata 防御性复制 | 外部修改不污染 store |

Unicode 长度应以 JavaScript 可见码点为准，测试至少包含 emoji，避免仅用 UTF-16 code unit 造成明显误差；组合字素的进一步归一化不在 v1 范围。

### B. 历史恢复测试

| 编号 | 场景 | 验收 |
|------|------|------|
| B-01 | 多次成功 `todo_write` | 恢复最后一次成功完整列表 |
| B-02 | 最后一次调用失败，前一次成功 | 跳过失败调用，恢复前一次成功结果 |
| B-03 | pending/running/cancelled call 无成功 result | 不作为恢复点 |
| B-04 | 最后一次成功为 `[]` | 恢复空且标记 loaded |
| B-05 | 历史无 Todo | 返回空，不抛错 |
| B-06 | 候选参数损坏 | 跳过候选并记录 warning；session resume 不失败 |
| B-07 | 已加载空列表后再次读取 | 不重新扫描并复活旧数据 |

### C. SDK、projection 与 reducer 契约测试

| 编号 | 场景 | 验收 |
|------|------|------|
| C-01 | 旧 snapshot 缺少 `todos` | Web/TUI 视为空，兼容运行 |
| C-02 | snapshot 含多个 session Todo | selector 只返回 active main session |
| C-03 | `todo.updated` | 只整体替换目标 session，其他 session 不变 |
| C-04 | 事件先于 snapshot / 断线重连 | 不崩溃；resync 后 snapshot 成为最终状态 |
| C-05 | 当前 run 更新为全 completed | `visible` 保持 true 到 run 结束 |
| C-06 | run 结束 | `visible=false`，items 仍保留 |
| C-07 | 新 run + 全 completed 历史 | 保持隐藏 |
| C-08 | 新 run + 未完成历史 | 重新可见 |
| C-09 | `todo_write([])` | 立即替换为空并隐藏 |
| C-10 | 列表相同但 `visible` 改变 | 发布一次完整投影事件 |

### D. Transcript 测试

| 编号 | 场景 | 验收 |
|------|------|------|
| D-01 | streaming `todo_read` call/result | Web/TUI transcript 从未出现该工具 |
| D-02 | streaming `todo_write` call/result | Web/TUI transcript 从未出现该工具或摘要 |
| D-03 | Todo 工具失败 | Agent 获得错误，普通 transcript 仍无 Todo 工具项 |
| D-04 | 持久历史含 Todo tool parts | 新 UI snapshot/transcript projection 隐藏，但恢复仍读取 |
| D-05 | 相邻普通工具 | 仍按现有方式显示，过滤不扩大到其他工具 |

### E. Web 组件与集成测试

| 编号 | 场景 | 验收 |
|------|------|------|
| E-01 | 1、5、10 项 | 全部进入 DOM，顺序与数组一致 |
| E-02 | 超过容器高度 | TodoDock 内部纵向滚动，不推高整个 composer |
| E-03 | 三种状态 | 图标/样式语义清晰且文本可读 |
| E-04 | active session 切换 | 只显示目标 session Todo |
| E-05 | lifecycle | running 显示、run end 隐藏、清空立即隐藏 |
| E-06 | snapshot replacement | 重连后无须扫描 transcript 即恢复正确面板 |

### F. TUI 组件与集成测试

| 编号 | 场景 | 验收 |
|------|------|------|
| F-01 | 不超过 5 项 | 原顺序完整显示，无溢出提示，Ctrl+T 不被 Todo 消费 |
| F-02 | 超过 5 项 | 紧凑选择包含进行中优先项，显示 `+N more` |
| F-03 | Ctrl+T | 展开显示最多 10 项，再按一次收起 |
| F-04 | 多个进行中超过 5 | 取原数组中前 5 个进行中项目，顺序稳定 |
| F-05 | session/run/清空变化 | 面板隐藏或切换时展开态重置 |
| F-06 | transcript | Todo 工具调用与结果均不占终端历史行 |

## 3. 真实浏览器 E2E

实施阶段需启动编译后的 daemon/Web 应用，通过应用内浏览器控制完成以下流程：

1. 连接一个可控的 OpenAI-compatible 假服务或测试 provider，使 Agent 依次发出 Todo 写入、更新和清空调用。
2. 确认 TodoDock 位于 composer 上方而非 transcript 中。
3. 写入 10 项，确认全部可通过 Dock 内滚动访问，不是只渲染前 5 项。
4. 更新为多个 `in_progress` 和全部 `completed`，确认状态与顺序正确。
5. 确认全部完成后在当前 run 结束前仍可见，run 结束后隐藏。
6. 新 run 对全完成列表不重新显示；存在未完成项时重新显示。
7. 刷新/断开重连触发 snapshot resync，确认无需依赖 transcript 恢复。
8. 检查桌面宽度和窄屏宽度，Dock 不遮挡 composer，长内容不溢出容器。
9. 检查正常 transcript，确认不存在 `todo_read`、`todo_write`、原始 JSON 或完成摘要。

保存必要的浏览器截图或文字观察记录作为验收证据，但不把截图提交到仓库，除非用户要求。

## 4. 真实 TUI 进程验收

实施阶段需先构建相关 package，再用 PTY 启动真实 `ohbaby` CLI 进程。可复用 `tests/integration/cli/prompt-process.integration.test.ts` 的假 SSE 模型服务模式，验证：

1. TodoPanel 位于 Prompt 上方，正常输入仍可用。
2. 10 项列表初始仅展示选中的 5 项和 `+5 more · ctrl+t to expand`。
3. 向进程发送 `Ctrl+T` 后显示全部 10 项，再次发送后收起。
4. 多个 `in_progress` 能同时显示，且权威数组顺序没有被状态分组反转。
5. run 结束、显式清空和 session 切换时面板及展开态符合约定。
6. 终端 scrollback 中不存在 Todo 工具调用/结果/摘要。
7. 进程正常退出，无未处理异常或残留交互状态。

Ink 组件测试仍保留用于快速回归，但不能替代上述真实进程验收。

## 5. 执行顺序与命令门槛

具体命令以实施时的 package scripts 为准，至少按以下层级执行：

1. Todo/SDK/reducer/组件定向 Vitest。
2. 受影响 package 的 typecheck。
3. 相关 contract/integration suites。
4. 仓库 lint；改动面允许时执行 `pnpm preflight`。
5. 真实浏览器 E2E。
6. 真实 TUI 进程验收。
7. 子代理审查后重跑所有受影响检查。

## 6. 完成定义

只有同时满足以下条件才可宣布实现完成：

- 00 文档的 D-01 至 D-09 全部落实。
- A–F 自动化关键场景通过。
- 浏览器 E2E 与真实 TUI 进程验收通过并有结果记录。
- 没有 Todo 工具 transcript 泄漏。
- 子代理审查中的有效问题已修复或由用户明确接受。
- 变更已按独立边界分批 commit，工作停留在临时分支，未 merge。
