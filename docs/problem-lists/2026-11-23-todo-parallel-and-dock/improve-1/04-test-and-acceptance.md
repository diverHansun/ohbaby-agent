# 4. 测试与验收标准

> 基线：2026-11-23，`ae76ecae`。`todo.unit`、`prompt-assets.unit`、`styles.unit`、`App.unit` 共 260 个测试通过，`ui-inprocess` 和 TUI 契约测试共 360 个通过，`prompt:check` 通过。

## 4.1 测试范围

| 类型 | 覆盖内容 |
|---|---|
| 单元测试 | 工具描述、提示词文案、多个 `in_progress`、折叠摘要、滚动触发、样式约束 |
| 契约测试 | run 结束，Goal 停止、失败、阻塞、暂停和恢复时的显示规则 |
| 真实浏览器 | 玻璃效果、对比度、窄屏、高输入框、消息遮挡 |
| 真实模型 | agent 是否保留计划顺序、是否按真实并行标记状态 |

## 4.2 关键场景与用例

### Stage 1：agent 规则

| ID | 场景 | 类型 | 验证点 | 对应问题 |
|---|---|---|---|---|
| A1 | 工具描述 | 单元 | `todo_write` 描述与 00 §3 完全一致 | P1、P2 |
| A2 | 系统提示词 | 单元 | 包含计划顺序、不是严格队列、完成项留原位、满 10 条移除最早完成项、不相邻并行 | P1、P2 |
| A3 | 生成模板 | 命令 | `prompt:check` 通过，旧文案不再出现在 `templates.generated.ts` | P1 |
| A4 | 不相邻并行 | 单元 | 第 2、4 项同时 `in_progress` 时，写入和读取后顺序、状态不变 | P1 |
| A5 | 真实模型行为 | 手工 | 给出可并行的 5 步任务，至少一次出现不相邻的进行中项；完成项不移动；修改列表时不按提醒顺序重排 | P1、P2 |
| A6 | 旧描述清理 | 命令 | `git grep -n "complete ordered list" -- packages` 没有结果，包括默认不跑的 e2e 夹具 | P1 |

### Stage 2：停止态投影

| ID | 场景 | 类型 | 验证点 | 对应问题 |
|---|---|---|---|---|
| S1 | 用户停止 Goal | 契约 | Goal 为 `paused`，run 空闲，`visible: false`，列表内容保留 | P7 |
| S2 | 模型请求失败 | 契约 | Goal 为 `paused`，run 空闲，`visible: false`，列表内容保留 | P7 |
| S3 | 轮次预算耗尽 | 契约 | Goal 为 `blocked`，run 空闲，`visible: false`，列表内容保留 | P7 |
| S4 | 没有活跃 prompt 时暂停或取消 | 契约 | `/goal pause`、`/goal cancel` 后面板隐藏 | P7 |
| S5 | 暂停时有普通 prompt 在跑 | 契约 | Goal 状态变化不提前隐藏普通 run 的面板 | P7 |
| S6 | 恢复 Goal | 契约 | `/goal resume` 后回到原列表并显示 | P7 |

### Stage 3：Web 面板

| ID | 场景 | 类型 | 验证点 | 对应问题 |
|---|---|---|---|---|
| W1 | 三种状态 | 单元 | 行上有对应状态 class，进行中的行含 `.ohb-spinner`，文本只含任务内容，不含 `○●✓` | P5 |
| W2 | 折叠显示并行 | 单元 | 第 2、4 项进行中时，显示第 2 项和 `+1`，`aria-label` 含 `1 more in progress` | P3 |
| W3 | 单个进行中 | 单元 | 不显示 `+N` | P3 |
| W4 | 摘要回退 | 单元 | 没有进行中时显示第一个待办；全部完成时显示最后一项，都不显示 `+N` | P3 |
| W5 | 跟随进行中 | 单元 | 模拟行在视野外，第一个进行中的索引变化后，列表 `scrollTop` 变化 | P4 |
| W6 | 不抢手动滚动 | 单元 | 第一个进行中的索引不变，只更新其他状态时，`scrollTop` 不变 | P4 |
| W7 | 不带动外层 | 单元 | 不调用 `scrollIntoView`，外层容器 `scrollTop` 不变 | P4 |
| W8 | 列表显隐 | 单元 | 直接渲染同一个不带 `key` 的 `<TodoDock>`，`todoList` 依次为空、有值、空，没有 React Hook 顺序错误 | P3、P4 |
| B1 | 桌面展开 | 浏览器 | 面板悬浮、无边框、16px 圆角、与下方元素间隔 8px，背后内容隐约可见；进行中的行左侧是转动的淡蓝 spinner，行本身没有蓝底；普通模式和 Goal 模式都检查 | P5 |
| B2 | 窄屏 | 浏览器 | 375px 宽度下无横向滚动，长任务换行，图标对齐首行 | P5 |
| B3 | 高输入框 | 浏览器 | 输入框达到最大高度时，面板和输入框不重叠，周围没有错位文字 | P5 |
| B4 | 夹层提示 | 浏览器 | 出现未消费插话、排队消息、Goal 状态条或 Banner 时，各层不重叠，背后的消息文字不会穿透 | P5 |
| B5 | 消息遮挡 | 浏览器 | 10 条任务展开且 Goal 状态条、排队消息可见时，滚到底部后最后一条消息完整可见 | P5 |
| B6 | 深色内容背后 | 浏览器 | 面板压在深色代码块上时，任务文字和状态图标仍能辨认 | P5 |

## 4.3 集成边界

- `todo_write` 到 `todo.updated`：schema 和事件结构不变。
- `UiSessionTodoList` 到 TodoDock：不新增字段。
- `SessionScreen` 通过 `key` 重建 TodoDock：切换 session 或重新显示时，展开状态按现有规则重置。
- Composer 的 `topContent`：不改变 DOM 顺序，审批弹窗隐藏 Composer 时继续保留 TodoDock 身份和展开状态。

## 4.4 回归清单

- 普通 run 结束后面板隐藏，列表不被删除。
- 新 run 只有存在未完成项时才显示面板。
- Goal 继续时面板保持显示；Goal 暂停、失败或阻塞后隐藏，恢复后回到原列表。
- 子 agent 的 todo 不进入主面板。
- 审批弹窗出现时，草稿、焦点和 TodoDock 状态不丢失。
- TUI 界面和快捷键不变；Goal 停止后面板隐藏，Ctrl+T 仍能查看 “Stopped x/y completed”。
- `tokens.css` 之外没有新增字面量颜色。

## 4.5 验收标准

| 项 | 标准 | 如何验证 |
|---|---|---|
| 提示词生成 | 通过 | `pnpm --filter ohbaby-agent run prompt:check` |
| 相关单测 | 全部通过 | `pnpm exec vitest run packages/ohbaby-agent/src/tools/todo.unit.test.ts packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts apps/ohbaby-web/src/ui/styles.unit.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx` |
| Todo 契约 | 全部通过，含 S1-S6 | `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-cli/src/tui/app.contract.test.tsx` |
| 旧描述清理 | 没有结果 | `git grep -n "complete ordered list" -- packages` |
| 类型检查 | 通过 | `pnpm typecheck` |
| 代码检查 | 通过 | `pnpm lint` |
| 浏览器验收 | B1-B6 全部通过 | 启动真实 Web 或 mock 页面，保留桌面和窄屏截图作为证据 |
| 真实模型 | A5 通过 | 记录任务、todo 变化和结论，写入 05 |
| 文档同步（P6） | 1.8 标记“实施时更新”的文档全部完成 | 对照 diff 检查 |

## 4.6 对抗性审查要点

| 攻击面 | 可能出错 | 防御 | 残余风险 |
|---|---|---|---|
| CSS 选择器 | 新增 `+N` 后，`span:last-child` 让截断和划线落到错误元素 | 改用 `.ohb-todo-text`，W2、W4 覆盖 | 低 |
| Hook 位置 | 滚动 Hook 放在提前返回之后，列表显隐时崩溃 | Hook 放在提前返回之前，W8 覆盖 | 低 |
| 渐变覆盖 | 选择器漏掉 hero，或高输入框时露出文字 | 使用 `:not(.ohb-composer-hero)`，B3 验证 | 中，需要真实页面确认 |
| 滚动 | 频繁更新时抢走用户滚动 | 只依赖展开状态和第一个进行中的索引，W6 覆盖 | 低 |
| 提示词 | 模型把提醒顺序当成计划顺序 | 提示词要求保留原顺序，A5 观察 | 中，模型行为无法靠单测保证 |
| 对比度 | 玻璃压在深色内容上时文字变弱 | 使用 `--text-muted` 和 `--success-ink`，B6 验证 | 低 |
| 停止态 | Goal 已停止，蓝色行还显示 | Goal 状态变化时更新投影，S1-S4 覆盖 | 低 |
| 误隐藏 | 普通任务运行时被 Goal 状态变化隐藏 | 有活跃 prompt 时跳过，S5 覆盖 | 低 |
| 旧状态重现 | 停止后开新 run，旧 `in_progress` 显示到模型改写 | 接受，不增加清理逻辑 | 低 |
| 夹层透字 | 去掉大渐变后，消息从 Goal 条或排队消息背后透出 | 这些层改用玻璃，B4 验证 | 中，需要真实页面确认 |
