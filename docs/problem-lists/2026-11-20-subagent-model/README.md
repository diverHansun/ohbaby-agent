# 子代理模型设置

本议题于 2026-11-20 开启，有两个目标。一是讲清楚 Settings 里 Default 模型是做什么的，并在界面上补一句简洁的说明。二是让用户在 Settings 的 Models 里给子代理单独指定模型和思考档位，让子代理和主代理可以用不同的模型。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-11-20 | 首轮 | Default 说明和全局子代理模型设置 | 后端完成，Web 和 TUI 界面待实施 |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | D1 至 D13、本轮不做 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | Default 的实际用途、子代理怎么拿到模型、模型库与接口、Web 和 TUI 的 Models 面板 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表、Stage 1 至 4、接口与兼容、风险 |
| [03 参考项目](improve-1/03-reference-projects.md) | codex、kimi-code、claude-code、opencode、pi 的子代理模型做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | 关键场景、回归清单、发布门、对抗性审查 |
| [05 实施与验收](improve-1/05-implementation-acceptance.md) | 后端验收、真实请求和前端对接 |

## 实施契约

- 02 是实施依据，04 是验收依据。后端和前端共用本地 `codex/subagent-model` 分支。
- 02 不列关键改动清单（用户 2026-11-20 确认），改动面写到包和模块一级。
- 改动不大，也不推翻原有设计，所以不另建模块级 `improve-N/` 文档。需要同步的权威文档见 02 §2.5.5。

## 相关文档

- [会话级模型选择](../2026-10-25-session-model/README.md)：定下了 Default 的语义（D1、D9）和“子代理继承父会话这一轮的模型”（D14）。本议题沿用 D1、D9、D10、D11；D14 变成“子代理模型设为跟随会话时”的行为；D13 计划的 Default 说明行由本议题补上。
