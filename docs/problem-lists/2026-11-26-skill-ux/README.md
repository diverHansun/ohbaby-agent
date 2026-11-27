# Skill 交互优化

2026-11-26 开启。用户用 `/技能名 原话` 调用 skill 后，气泡里只显示技能标记和原话，不再显示 SKILL.md 全文；长用户消息默认折叠；同时修好 slash 路径的信任登记和编辑重发。

## 范围

本轮要做的：

- 后端：消息拆成"隐藏的 skill 正文 + 可见的原话"两个 part；提交记录只存原样输入；排队期间 skill 被删就当普通文字发送；slash 路径补上信任登记；编辑重发可以再次用 slash 引用 skill。
- Web：气泡里的技能标记、用户气泡原样显示（不按 markdown 渲染）、长用户消息折叠、主输入框和编辑框里的技能标记；发送和停止按钮（包括旁聊页）改成亮蓝色。
- TUI：用户消息不显示 skill 原文；输入框里的 `/技能名` 用 accent 色显示。

本轮不做的：

- 旧会话迁移。旧消息按原样显示。
- 一条消息引用多个 skill。
- 禁止 ohbaby 修改 skill 文件的新规则。保持现有审批行为。
- 主输入框支持斜体等更多样式（富文本输入框）。另开议题。
- 其他用 `--accent` 的按钮和元素改色。
- TUI 的长消息折叠、标记整体删除，以及消息行里的 `/技能名` 上色。
- 用户气泡里的裸网址自动变链接（改成原样显示后的已知退化）。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 状态 |
|---|---|---|---|
| improve-1 | 2026-11-26 | 首轮 | 规划中 |

## 文档地图

问题清单这一套管后端和 TUI，`frontend/` 这一套管 Web。两边只在消息结构上交汇：字段由后端 02 定义，前端 06 引用，不重复写。

| 文档 | 用途 |
|---|---|
| [00 讨论记录](improve-1/00-discussion.md) | 已确认的决定，后续文档以它为准 |
| [01 现状与问题](improve-1/01-problem-analysis-and-current-state.md) | 后端、Web、TUI 现在怎么做，问题出在哪 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 后端和 TUI 的执行契约，含关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | 同类项目的做法对照 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 后端和 TUI 的测试与验收 |
| 05 实施验收 | 本轮实施完成后，由验收模式写入 `improve-1/05-implementation-acceptance.md` |
| [Web 前端设计](improve-1/frontend/00-goal-duty.md) | plan-frontend-design 精简模式，见下表 |

Web 前端设计文档（精简模式）：

| 文档 | 用途 |
|---|---|
| [00 目标与职责](improve-1/frontend/00-goal-duty.md) | 为什么做、不做什么 |
| [01 用例与流程](improve-1/frontend/01-use-cases-and-user-flows.md) | 用户任务和操作流程 |
| [03 布局与样式](improve-1/frontend/03-ui-layout-and-style.md) | 线框、视觉方向、文案、视觉验收口径 |
| [04 交互与状态](improve-1/frontend/04-interaction-and-states.md) | 状态矩阵和交互规则 |
| [05 组件](improve-1/frontend/05-components.md) | 技能标记组件和可折叠气泡的契约 |
| [06 数据与状态](improve-1/frontend/06-data-api-and-state.md) | 消息字段怎么变成界面状态 |
| [08 测试与验收](improve-1/frontend/08-test-and-acceptance.md) | Web 验收 |

前端 02（架构）和 07（质量）省略：这次不改 React 的工程结构；无障碍要点不多，直接写在 04 和 08 里。

## 实施契约

本目录是规划产物。实施在新会话里进行：后端和 TUI 按 02 和 04 做，Web 按 `frontend/` 的 03 到 08 做。实施中不回写 02 的关键改动清单。
