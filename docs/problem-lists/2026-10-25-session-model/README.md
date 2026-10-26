# 会话级模型选择

本议题于 2026-10-25 开启。目标是让每个会话可以用不同的模型：在会话里切换模型只影响这个会话，全局默认模型只决定还没选过模型的会话用什么。同时整理 Settings 里的模型管理和模型配置，看界面是否需要优化。

## 轮次地图

| 轮次 | 开启日期 | 触发 | 范围 | 状态 |
|---|---|---|---|---|
| [improve-1](improve-1/00-discussion.md) | 2026-10-25 | 首轮 | 会话级模型的后端、Web、TUI 适配，每模型生成参数，Settings 模型管理优化 | 后端实施中（Stage 1、2） |

## 本轮文档地图

| 文档 | 内容 |
|---|---|
| [00 讨论与已确认要点](improve-1/00-discussion.md) | D1 至 D20、本轮不做 |
| [01 现状与问题分析](improve-1/01-problem-analysis-and-current-state.md) | 模型库与配置加载、运行时、会话与提交记录、Web、TUI 的现状 |
| [02 方案与改动面](improve-1/02-optimization-plan-and-change-scope.md) | 决策表 P1 至 P16、Stage 1 至 5、接口与迁移、风险、关键改动清单 |
| [03 参考项目](improve-1/03-reference-projects.md) | opencode、pi、kimi-code、ZCode 的会话级模型做法与取舍 |
| [04 测试与验收](improve-1/04-test-and-acceptance.md) | T1 至 T27、回归清单、发布门、对抗性审查 |
| 05 实施与验收 | 本轮实施完成后由验收模式写入 |

## 实施契约

- 02 是实施依据，04 是验收依据。规划会话不写代码。
- 分工（2026-10-26 更新）：agent 实施 Stage 1、2（后端核心、SDK 与服务端），完成测试和子代理审查后交给用户检查；用户实施前端。Stage 4（TUI）在 Web 之后。全部完成后再合并到 main。
- 不另建模块级 `improve-N/` 文档；受影响的权威文档按 02 §2.9 的 D1 至 D4 同步。
- 不可逆点：新的 `model.json` 旧版本读不了，见 02 §2.6。

## 相关文档

- [无工作区会话与设置后端](../2026-10-20-workspaceless-sessions-and-settings/README.md)：improve-2 建好了多模型库和全局默认模型，并明确把“按会话保存模型”留到以后，本议题接着做。
