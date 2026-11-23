# 3. 优秀项目借鉴

> 调研日期：2026-11-23。路径相对于上级目录 `code-cli/`。

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|---|---|---|
| opencode | `opencode/packages/core/src/tool/plugin/todo.ts`、`opencode/packages/app/src/session/composer/` | 工具模型、折叠摘要、列表滚动 |
| deepseek-harness（dsh） | `deepseek-harness/packages/todo/tool-todo/`、`deepseek-harness/packages/client/ui-conversation/src/client/skeleton/TodoPanel.tsx`、`deepseek-harness/.agents/notes/archived/feature/2026-07-26-todo-parallel-in-progress.md:45,51` | 并行策略、悬浮面板、摘要设计、数量截断和无障碍记录 |
| ZCode | `ZCode/packages/ui/src/TodoPanel.tsx`、`ZCode/packages/ui/src/ToolCallBlocks/renderers/todo.tsx` | 面板和状态显示。它的后端在打包后的 agent 中，这里只核对了协议适配和 UI |
| Codex | `codex/codex-rs/core/src/tools/handlers/plan_spec.rs` | 单任务进行中的反面对照 |

## 3.2 可借鉴点

| 项目 | 做法 | 为什么相关 | ohbaby 取舍 |
|---|---|---|---|
| opencode | `todowrite` 整表替换，不额外保存服务端状态 | 和 ohbaby 的列表模型一致 | **采用**现有模型，不增加字段 |
| opencode | 折叠摘要显示第一个进行中的任务，并统计其余任务 | 直接解决并行任务被隐藏的问题 | **采用** `+N` |
| opencode | 第一个进行中的索引变化时，把该行滚入视野 | 不会在每次更新时抢滚动 | **改造**：沿用触发条件，但只改列表 `scrollTop` |
| dsh | `allowParallelInProgress` 决定工具描述和校验 | 它明确指出工具无法观察运行时并发 | **改造**：ohbaby 默认允许并行，不增加配置 |
| dsh | 并行纪律写在工具描述里 | 约束模型比校验列表更合适 | **采用**提示词约束 |
| dsh | 输入框上方的悬浮面板：菜单表面、背景模糊、阴影、无边框 | 和目标样式接近 | **采用**结构，使用 ohbaby 自己的 token |
| dsh | 摘要名称和数量分成两个字段，避免数量被省略号截断 | ohbaby 的 `+N` 也有相同风险 | **采用**独立的 `+N` 元素 |
| dsh | 记录了数量缺少无障碍名称的问题 | 屏幕阅读器只读到 `+1` 没有含义 | **补上**：写入摘要行的 `aria-label` |
| ZCode | 用勾、箭头、圆圈区分状态，行样式扁平 | 证明状态图标可以很轻 | **改造**：使用勾、淡蓝 spinner、空心环 |
| ZCode | 任务停止后不再显示 loading 动画 | 提醒不能让过期状态继续“动” | **采用**：ohbaby 进行中也用 spinner，Goal 停止后由 adapter 把面板投影改为隐藏，spinner 随面板一起消失 |

## 3.3 明确不借鉴

| 项目 | 做法 | 不借鉴的理由 |
|---|---|---|
| opencode | `cancelled` 状态 | 用户确认放弃的任务直接移除，新增状态没有足够收益 |
| opencode | composer 胶囊和弹出菜单 | Web 设计要求避免胶囊式控件 |
| dsh | 下一轮开始时清空列表 | ohbaby 需要跨 Goal continuation 和历史恢复 |
| dsh | 每种状态分别计数的表头 | ohbaby 现有的 “x/y completed” 已够用，折叠态再显示 `+N` 即可 |
| ZCode | 展开态隐藏已完成项 | 用户确认完成项留在原位并划线 |
| Codex | 最多一个 `in_progress` | 和本议题的并行目标相反 |

## 3.4 对 02 方案的影响

| 02 决策 | 来源 |
|---|---|
| D1 并行约束放在提示词 | dsh 的工具边界分析 |
| D6 折叠显示 `+N` | opencode 的摘要、dsh 的截断和无障碍记录 |
| D7 按第一个进行中的索引滚动 | opencode，改为只滚动列表内部 |
| D9 悬浮玻璃面板 | dsh 的 TodoPanel，结合 ohbaby 的 D21 |
| D3、D5 的取舍 | 对照 ZCode 和 opencode 后，按用户确认的方向选择 |
| D10 停止后不显示进行中状态 | ZCode 的停止态处理，落到 ohbaby 现有的 `visible` 投影 |
