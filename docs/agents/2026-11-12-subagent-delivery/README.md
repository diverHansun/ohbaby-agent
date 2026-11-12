# 父子代理可靠投递与自动续跑

2026-11-12。状态：已实施并完成本轮验收，等待用户审查。规划基线为 `d5625248ea877cee107ee73cec23b146f50be1b5`；实施从当时本地 main `d70ce643` 新建 `codex/subagent-delivery-20261112`。main 尚未合并本轮。

用户在端到端测试中发现：子代理全部结束，主代理却没有继续。调查确认自动运行曾启动，但在模型请求前因消息 ID 冲突失败；一次性唤醒标记阻止再次处理，界面又隐藏了没有输出的失败轮次。

本轮复用现有 execution、runtime input 和 run/request 记录，整理内部投递模块，补齐故障通知、恢复与反馈。不增加信箱表、消息中间件或任意代理通信系统。

## 轮次

| 轮次 | 开启日期 | 范围 | 状态 |
| --- | --- | --- | --- |
| improve-1 | 2026-11-12 | 父子代理投递、结果续跑、故障恢复和必要反馈 | 已实施；828 项相关回归及真实 API 验收通过，等待用户审查 |

这是独立的投递改进议题，继承 [2026-10-26 lifecycle](../../problem-lists/2026-10-26-subagent-lifecycle/README.md) 的产品契约，不改写其已结束的四轮验收。主代理 Stop 不停止后台子代理，新的后台结果仍可唤醒主代理。服务故障导致子代理中断也通知主代理，是本轮明确补充的行为。

## 文档

| 文档 | 用途 |
| --- | --- |
| [00 讨论记录](improve-1/00-discussion.md) | 已确认规则和用户原话 |
| [01 现状与问题](improve-1/01-problem-analysis-and-current-state.md) | 真实故障、历史提交、现有能力 |
| [02 改造方案](improve-1/02-optimization-plan-and-change-scope.md) | 实施步骤、兼容要求和关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | 本地源码依据与采用范围 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 风险场景、测试入口和验收条件 |
| [模块目标](improve-1/design/goals-duty.md) | 目标、职责和非职责 |
| [模块架构](improve-1/design/architecture.md) | 模块关系及取舍 |
| [数据含义](improve-1/design/data-model.md) | 身份、消费确认、唤醒机会和原因 |
| [数据流与接口](improve-1/design/dfd-interface.md) | 接收、交付、确认、恢复的接口边界 |
| [模块测试](improve-1/design/test.md) | 模块职责与 04 验收项对应 |
| [05 实施与验收](improve-1/05-implementation-acceptance.md) | 实际改动、测试、真实 API 证据、审查取舍和交付边界 |

模块用例归入数据流文档，可靠性约束归入架构和数据含义文档，不再单独建立 `use-case.md`、`non-functional.md`。改造文档负责实施契约，design 负责模块设计；测试场景只在 04 维护一份。

## 阅读与实施约定

先读 00、01，再读 design 和 02，按 04 验证。00 的产品选择优先于工程建议；02 与 design 冲突时先修正文档，不由实施者自行选择其一。所有阶段属于本轮，不预建下一轮。

本轮遵循 `plan-code-improvement`、`plan-module-design`、SWE 原则和 humanizer。2026-11-12 已完成 Pi 三轮只读设计审查和文档修订，最终结论为通过、无阻断项。按用户指定使用 Copilot Opus 5.5、thinking high；本机模型登记 ID 为 `magpie/copilot/claude-opus-5.5`。参考项目由主代理本机源码核查，Pi 因其沙箱边界未能独立读取这些目录。审查没有运行测试，不代表代码已经修复。

实现阶段新增 Pi 与子代理审查、真实 SQLite 回归及真实 API 验收，结果见 05；上面的设计审查结论保留为规划历史。
