# improve-3.1 子代理连续会话与 Web 阅读体验

开启日期：2026-09-28。调查基线：本地 `codex/improve-3`，`1a7018f1`。状态：**规划已确认，进入分批实施**。

本轮由用户在 improve-3 本地实施验收后提出：用主会话里的轻量任务行打开子会话浮层，替换顶部 Subagents 区域；子会话提供与主会话一致的流式阅读体验。沿用 [improve-3 的实际验收与限制](../improve-3/05-implementation-acceptance.md)，不重做执行调度、结果交付、审批或停止机制。improve-4 的职责不提前纳入。

**TUI 范围已确认：保留现有 Ctrl+G 内部详情及现有交互。** 本轮新增阅读体验仅用于 Web；共享协议变更须保持 TUI 兼容。

## 阅读入口

| 文档 | 内容 |
| --- | --- |
| [00 讨论与确认](00-discussion.md) | 用户已经确认的交互约束 |
| [01 现状与问题](01-problem-analysis-and-current-state.md) | 现有代码能做什么、缺少什么 |
| [02 总体方案与关键范围](02-optimization-plan-and-change-scope.md) | 身份、数据、阶段、兼容与回退 |
| [03 参考项目](03-reference-projects.md) | 截图、OpenCode、Kimi 的证据和适用边界 |
| [04 测试与验收](04-test-and-acceptance.md) | 单元、契约、集成、浏览器与真实模型验证 |
| [前端目标](frontend/00-goal-duty.md) / [用户流程](frontend/01-use-cases-and-user-flows.md) | 前端职责和用例 |
| [前端架构](frontend/02-frontend-architecture.md) / [布局与样式](frontend/03-ui-layout-and-style.md) | 组件组织、浮层、放大、CSS |
| [交互与状态](frontend/04-interaction-and-states.md) / [组件契约](frontend/05-components.md) | 状态切换、焦点、复用边界 |
| [数据映射](frontend/06-data-api-and-state.md) / [质量约束](frontend/07-quality-constraints.md) | 读取协议、同步、性能与无障碍 |
| [前端验收](frontend/08-test-and-acceptance.md) | 可直接演示的用户路径 |

`05-implementation-acceptance.md` 仅在本轮实施完成后创建。本文档不把规划审查视为代码验收。

总方案 02 是跨模块契约；frontend 03/04 是视觉和交互细则；04 与 frontend 08 是实施验收门。文档列出关键代码的粗略范围，不维护逐文件任务表、逐行清单或实施进度勾选。

本轮使用 plan-code-improvement、plan-frontend-design，并结合 SWE 原则审视。原生子代理调查数据接线，Pi `opencode/claude-opus-5-5` / medium 提供布局咨询；意见经代码核对后取舍，原始回复不作为规范复制入库。

规划审查：已完成原生子代理数据契约审查与 Pi 两轮咨询（设计建议、文档复审）。已补齐稳定分页总顺序和历史阅读时的实时基线，并按用户 KISS 要求精简图标与文案；该记录仅代表文档检查，不代表实施通过。
