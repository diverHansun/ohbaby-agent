# 1. 问题基线与当前实施状态

> 时间口径：2026-11-23，基线 commit 为 `ae76ecae`（v0.1.20）。本文只记录现状，方案见 [02](02-optimization-plan-and-change-scope.md)。代码行号是分析时的快照，定位时以文件和符号为准。

## 1.1 问题陈述

后端已经能存下多个 `in_progress`，也不限制任务的推进顺序。真正的缺口在 agent 规则和 Web 展示上。

| ID | 问题 | 用户看到的现象 | 技术原因 |
|---|---|---|---|
| P1 | 提示词没有讲清列表顺序的含义 | agent 倾向于严格从上往下做 | `base.md` 只写了保留 “execution order”，没有说列表不是严格队列 |
| P2 | 条目调整规则不完整 | 任务状态变化时，条目可能被挪动或删掉 | 工具描述和提示词都没有规定完成项留在原位，也没有说明列表满了怎么办 |
| P3 | 折叠摘要丢失并行任务 | 两个任务同时进行时，折叠后只能看到一个 | `selectTodoDockPreview` 只取第一个 `in_progress` |
| P4 | 进行中的任务可能在可视区外 | 10 条任务时，正在做的任务可能被滚出列表 | 列表限高 176px，大约显示 6 行半，没有跟随逻辑 |
| P5 | 面板视觉偏机械 | 边框托盘贴在输入框上，进行中的状态点是黑色 | 面板使用实色底和边框；输入区的不透明渐变也会盖住面板背后的内容 |
| P6 | 设计文档和目标行为冲突 | 后续开发可能按旧描述改回去 | todo 文档写“数组顺序就是执行顺序”，Web 设计文档写 Todo 用“不带边框的行” |
| P7 | Goal 停止后，进行中的任务还显示着 | run 已经空闲，面板仍显示正在进行 | Goal 在一轮结束后才变为 `paused` 或 `blocked`，这次状态变化没有更新 todo 的 `visible` |

## 1.2 已确认的分界

已确认的决定见 [00](00-discussion.md)。数据结构不变，并行约束只放在提示词里，Web 只改展示，TUI 界面不改。P7 是现有投影的缺陷，需要在 adapter 里修一处。

```text
agent 提示词 ──> todo_write ──> TodoService ──> adapter 投影 ──> todo.updated ──> Web TodoDock
   本轮修改        描述修改        不改          修停止态显示      结构不改         本轮修改
                                                                     └──────> TUI TodoPanel（界面不改）
```

## 1.3 Agent 行为现状

### 1.3.1 目标与职责

`docs/tools/todo-list/goals-duty.md` 规定了 `todo_read`、`todo_write` 两个工具，每项只有 `content` 和 `status`，并允许多个 `in_progress`。代码与这部分一致。

同一文档第 19 行写“数组顺序就是执行顺序和隐式优先级”。这和本议题确认的“计划顺序，不是严格队列”冲突。

### 1.3.2 架构

工具定义在 `packages/ohbaby-agent/src/tools/todo.ts`。它负责校验字段、状态和数量上限，不校验顺序，也不校验 `in_progress` 的数量。工具看不到运行时状态，所以无法判断一个任务是否真的在执行。

### 1.3.3 数据模型

条目结构是 `{ content, status }`，状态为 `pending`、`in_progress`、`completed`，列表最多 10 条，每条最多 100 个 Unicode 字符。写入是整表替换，历史恢复读取最近一次成功的 `todo_write`。

### 1.3.4 数据流与接口

模型依据三处信息维护列表：

| 来源 | 位置 | 当前内容 |
|---|---|---|
| 工具描述 | `packages/ohbaby-agent/src/tools/todo.ts:562` | “complete ordered list”，没有说明条目位置规则 |
| 系统提示词 | `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md:57-58` | 保留 “execution order”；真实并行时可以有多个 `in_progress` |
| 提醒 | `packages/ohbaby-agent/src/services/reminder/todo.ts` 的 `reminderText` | 未完成项按进行中优先排列，并提示用 `todo_read` 读取完整列表 |

提醒里的顺序和列表的计划顺序不同。它只用来提醒模型当前工作，本轮不改，但新提示词需要要求模型修改前先读完整列表。

### 1.3.5 用例

| 用例 | 现状 |
|---|---|
| 同时推进第 2、4 项 | 工具接受，但提示词没有明确鼓励不相邻的并行 |
| 先做靠后的任务 | 工具接受，但 “execution order” 容易让模型理解为严格顺序 |
| 完成后保留原位 | 没有规则 |
| 列表已满还要加任务 | 没有规则 |

### 1.3.6 非功能约束

提示词由 `base.md` 生成 `templates.generated.ts`，`packages/ohbaby-agent` 的构建会先跑 `prompt:check`。只改 `base.md` 不重新生成，构建会失败。

### 1.3.7 测试

旧文案被 3 个测试文件的 4 处断言锁定：

- `packages/ohbaby-agent/src/core/system-prompt/__tests__/prompt-assets.unit.test.ts`：2 处。
- `packages/ohbaby-agent/src/tools/todo.unit.test.ts:379`：工具描述。
- `packages/ohbaby-agent/src/goals/goal-completion.real.e2e.test.ts:76`：工具描述夹具。

`todo.unit.test.ts` 没有找到针对“多个不相邻 `in_progress`”的用例，这是本轮要补的缺口。

## 1.4 Web 面板现状

### 1.4.1 目标与职责

`apps/ohbaby-web/src/ui/conversation/TodoDock.tsx` 显示当前主会话的列表，支持展开和折叠。它只接收 `todoList`，不接收运行状态。

### 1.4.2 架构

`SessionScreen` 通过 Composer 的 `topContent` 插入错误 Banner、命令通知和 TodoDock。Composer 内部从上到下的顺序是：

```text
错误 Banner
命令通知（CommandNoticeList）
TodoDock
未消费插话恢复区（.ohb-steer-recovery）
排队消息（.ohb-prompt-queue）
Goal 状态条（.ohb-goal-strip）
需要处理的 Banner
输入框
```

`.ohb-composer-content` 使用 `display: contents`，所以这些元素直接参与 Composer 的布局。Goal 模式下，TodoDock 的 8px 间距是到 Goal 状态条，不是到输入框。

### 1.4.3 数据模型

Web 直接消费 `UiSessionTodoList { sessionId, todos, visible }`，完成数和折叠摘要都在组件内派生，不需要增加协议字段。

### 1.4.4 渲染与样式

| 位置 | 现状 | 对应问题 |
|---|---|---|
| `TodoDock.tsx` 的 `selectTodoDockPreview` | 依次取第一个进行中、第一个待办、最后一项 | P3 |
| `TodoDock.tsx` 的 `todoStatusMarker` | 使用文字 `○●✓` | P5 |
| `session.css:13-21` | `.ohb-composer` 的不透明渐变占高度的 70% | P5 |
| `session.css:262-273` | 实色底、边框、上圆角，向下贴住输入框 | P5 |
| `session.css:324`、`372` | 截断和划线都依赖 `span:last-child` | 增加 `+N` 后会失效 |
| `session.css:330-338` | 列表最高 176px，内部滚动 | P4 |
| `session.css:380-399` | 有 todo 时，消息流底部留白写死为 350px / 370px，没有算上 Goal 状态条（约少 18px） | 面板尺寸变化后要同步 |
| `composer.css:3,97,505` | 排队消息、Goal 状态条、插话恢复区使用 3% 透明的 `--bg-subtle` | 去掉大渐变后，消息文字会从它们背后透出来 |

### 1.4.5 用例

| 用例 | 现状 |
|---|---|
| 折叠时有两个进行中的任务 | 只显示第一个，没有数量提示 |
| 10 条任务，第 9 条在进行中 | 需要手动滚动才能看到 |
| 面板背后有消息内容 | 大部分被输入区渐变盖住，加了玻璃也看不出效果 |

### 1.4.6 非功能约束

- `apps/ohbaby-web/src/ui/styles.unit.test.ts` 要求字面量颜色只能写在 `tokens.css`。现有 `--accent` 是黑色，没有可用的进行中蓝色。
- `--bg-glass` 已有不支持 `backdrop-filter` 时的实色回退。
- 玻璃底上的文字要按最不利背景核对。原型在 `rgb(223, 223, 223)` 背景上测得：`--text` 13.29，`--text-muted` 5.8，`--text-dim` 3.63，进行中蓝色 `--progress`（spinner 的弧）3.31，`--success` 1.9。

### 1.4.7 测试

`apps/ohbaby-web/src/ui/App.unit.test.tsx` 第 952-955 行锁定了 `✓●○` 文字，第 979-981 行锁定了折叠内容 `●task 2`。这些断言测的是实现字符，换图标后要改成检查状态和文本。现有测试没有覆盖多个进行中的折叠摘要和自动滚动。

## 1.5 跨模块一致性

“任务停了，蓝色还亮着”这个风险在 Goal 流程里真实存在：

| 场景 | 当前面板行为 | 结论 | 依据 |
|---|---|---|---|
| 普通 run 结束 | 隐藏，不删除列表 | 正常 | `ui-inprocess.ts` 的 `hideTodoAfterRun` |
| 新 run 或恢复 | 有未完成项才显示 | 正常；上次遗留的 `in_progress` 会显示到模型改写为止 | `ui-inprocess.ts` 的 `showTodoForRun` |
| Goal 继续中 | 保持显示 | 正常 | `ui-inprocess.ts` 的 `shouldKeepTodoVisibleAfterRun` |
| Goal 被用户停止 | Goal 为 `paused`，run 空闲，仍是 `visible: true` | **P7，已复现** | 临时复现测试 |
| 模型请求失败 | Goal 为 `paused`，run 空闲，仍是 `visible: true` | **P7，已复现** | 临时复现测试 |
| 轮次预算耗尽 | Goal 为 `blocked`，run 空闲，仍是 `visible: true` | **P7，已复现** | 临时复现测试 |
| 时间上限；等待后台子任务时 `/goal pause` 或 `/goal cancel` | 没有活跃 prompt，也不会更新 todo 投影 | 按代码路径判断同属 P7 | `goals/driver.ts`、`publishGoalUpdated` |

根因是时序。run 的 `finally` 调用 `refreshTodoProjectionAfterRun` 时，Goal 还是 `active`，所以面板保持显示。随后 `GoalDriver` 才把 Goal 改为 `paused` 或 `blocked`，而 `publishGoalUpdated` 只发 `goal.updated`，不更新 todo 投影。

目标语义已经写在 `docs/goals/dfd-interface.md` 的流 E 和 `ui-inprocess.contract.test.ts` 的暂停用例里：暂停的 Goal 保留清单，但不显示。TUI 也依赖这个语义，`visible: false` 时隐藏面板，用户仍可用 Ctrl+T 查看 “Stopped x/y completed”。

因此 TodoDock 不需要新增运行状态，修正 adapter 的投影即可。网络断开时列表可能停留在最后一次快照，这属于连接状态的显示范围，本轮不处理。

## 1.6 改动影响面

| 范围 | 影响 |
|---|---|
| `packages/ohbaby-agent` | 工具描述、系统提示词、生成模板、Goal 停止时的 todo 投影和相关测试 |
| `apps/ohbaby-web` | TodoDock、会话样式、设计 token 和相关测试 |
| `packages/ohbaby-sdk`、服务端协议 | 不改 |
| `packages/ohbaby-cli` | 不改界面，运行时自动使用新提示词；Goal 停止后的残留面板会随共享投影一起修复 |
| 持久化数据 | 不改，不需要迁移 |

## 1.7 SWE 原则审视

- **简单性**：问题主要是规则表达和展示缺口，不需要新增状态或调度能力。
- **信息隐藏**：工具看不到运行时，所以“是否真的并行”由 agent 判断，不放进工具校验。
- **内聚**：折叠摘要和列表滚动都只属于 TodoDock，不需要外移到共享组件。
- **脆弱测试**：Web 测试锁定状态字符，换图标时会产生无意义失败，应改为测试用户可见语义。
- **可逆性**：提示词和样式都能直接回退，没有单向门。

## 1.8 与既有文档的关系

| 文档 | 文档说 | 代码或新结论 | 处理 |
|---|---|---|---|
| `docs/tools/todo-list/goals-duty.md:19` | 数组顺序是执行顺序和隐式优先级 | 改为计划顺序，不是严格队列 | 实施时更新 |
| `docs/tools/architecture.md:319` | 数组顺序表达执行顺序和隐式优先级 | 改为计划顺序，不是严格队列 | 实施时更新 |
| `docs/tools/data-model.md:228` | 数组顺序即执行顺序 | 改为计划顺序，不是严格队列 | 实施时更新 |
| `docs/tools/todo-list/data-model.md:35` | 数组位置表达执行顺序和隐式优先级 | 改为计划顺序，不是严格队列 | 实施时更新 |
| `docs/tools/todo-list/goals-duty.md:115` | Web 是 OpenCode 风格 TodoDock | 改为悬浮玻璃面板 | 实施时更新 |
| `docs/tools/todo-list/use-case.md:80` | Web 全量显示，限高滚动 | 补充折叠 `+N` 和跟随进行中 | 实施时更新 |
| `docs/tools/todo-list/test.md` CS9、CS11 | 没有并行摘要和滚动场景 | 补充 | 实施时更新 |
| `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md:182` | Todo 放在卡片上方，用不带边框的行 | 改为悬浮玻璃面板 | 实施时更新 |
| `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md:32` | 玻璃只用于菜单、通知、输入框卡片和审批浮层 | 增加 Todo 面板 | 实施时更新 |
| `docs/ohbaby-web/redesign-2026-10/README.md` D21、D30 | 列出了可使用玻璃的浮起元素 | 增加 Todo 面板 | 实施时更新 |
| `docs/ohbaby-web/dfd-interface.md:99` | TodoDock 通过 `topContent` 插入 | 不变 | 不改 |
