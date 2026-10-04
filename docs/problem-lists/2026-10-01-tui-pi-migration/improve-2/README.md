# improve-2：输入、草稿与审批

> 2026-10-03 接续：[improve-3](../improve-3/README.md) 已获准提前规划 Markdown、工具内联输出和 Ctrl+O；同时将本轮原保留的 Ctrl+R 改为自动恢复。improve-2 的草稿、原请求身份、审批与 Tasks 契约不变，相关 UI 集成仍须先通过前轮基线。自动恢复可独立先行；已经落地后，本轮后续集成不得按旧文案重新加入 Ctrl+R。

2026-10-02 开启。**范围已确认；本目录是设计与实施计划，尚未实施、尚未验收。**用户明确要求在 improve-1 实施前提前规划本轮。improve-1 的 00–04 已存在，05 尚不存在，不能把上一轮目标当成代码现状。

本轮承接 [总路线 C](../plan/01-stage-roadmap.md)：保留 React/Ink，修复输入字素、保护草稿和异步操作归属，改善审批，配套小修 Tasks。2026-10-02 新增讨论：运行中默认展开，停止后隐藏的建议稿见 [Tasks 交互](frontend/04-interaction-and-states.md#4-tasks-生命周期与手动查看)。**不以安装 pi-tui 为前置，不接入 pi Editor；Markdown 与完整工具详情留给后续。**

## 阅读入口

| 文档                                                        | 用途                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [00 讨论结论](00-discussion.md)                             | 已确认范围、用户原话与本轮开启依据                                                      |
| [01 现状与问题](01-problem-analysis-and-current-state.md)   | 源码事实、已验证问题和待验证风险                                                        |
| [02 方案与改动面](02-optimization-plan-and-change-scope.md) | Stage 0–4、关键文件、兼容与回滚                                                         |
| [03 pi 源码取舍](03-reference-projects.md)                  | 为什么这轮不接 Editor，哪些能力值得以后复用                                             |
| [04 测试与验收](04-test-and-acceptance.md)                  | I2-T01–T16、阶段门及真机要求                                                            |
| [前端设计索引](frontend/00-goal-duty.md)                    | 00 目标 → 01 用例 → 02 架构 → 03 线框 → 04 状态 → 05 组件 → 06 数据 → 07 质量 → 08 验收 |

`05-implementation-acceptance.md` 留给实施后的独立验收，本次不创建。前端验收结果可作为该文件的分节统一记录；不提前创建前端 09 或用文档审查冒充产品验收。

前端文档：[00 目标](frontend/00-goal-duty.md) · [01 用例](frontend/01-use-cases-and-user-flows.md) · [02 架构](frontend/02-frontend-architecture.md) · [03 线框](frontend/03-ui-layout-and-style.md) · [04 状态](frontend/04-interaction-and-states.md) · [05 组件](frontend/05-components.md) · [06 数据](frontend/06-data-api-and-state.md) · [07 质量](frontend/07-quality-constraints.md) · [08 验收](frontend/08-test-and-acceptance.md)。

## 与前后阶段的关系

| 阶段            | 负责什么                                                       | 本轮如何衔接                                                         |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| improve-1 / A+B | 原生回滚、完整动态区预算、来源过滤、活动提示、轻边界和两行底栏 | Stage 0 核对其实际实现与验收；本轮消费同一个布局预算，不另造输出系统 |
| improve-2 / C   | 字素编辑、草稿、提交/队列归属、审批和 Tasks 小修               | 每个 Stage 交付可验证行为，不先做大规模业务拆分                      |
| 后续 D          | Markdown、工具摘要/diff/完整详情与必要数据                     | pi 文本能力在实际消费者出现时验证；本轮审批翻页不扩成工具详情平台    |
| E               | 跨场景与维护验收                                               | 各轮先自验，E 只补组合验证，不能替前面的质量门兜底                   |

## 文档权威与当前状态

00 记录用户已确认的范围；02 管范围、工程顺序和数据边界；前端 03/04 管本轮新增布局与交互提案；04 与前端 08 管验证。新增按键后果和线框为本次提交审阅的具体方案，**不伪称用户逐项确认过**。用户后续修订优先于所有提案。

实施先读 [02 §2.3](02-optimization-plan-and-change-scope.md#23-阶段与完成定义) 与 [前端 03 §8](frontend/03-ui-layout-and-style.md#8-实现约束摘要)。improve-1 未闭环时可准备纯函数反馈环，不能绕过它另定 MainScreen 输出方案或声称本轮已经具备整体验收条件。
