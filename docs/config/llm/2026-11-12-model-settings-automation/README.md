# 模型配置默认值与保存后自动探测

本议题解决三个配置体验问题：Max output 使用固定后端默认值、Context window 自动识别并允许覆盖、保存后自动发现 Reasoning Effort。

用户已确定 Max output 默认 **32768**，不随 effort 改变；Context window 兜底 **300000**。表单中的空值表示没有用户覆盖，不能用后端兜底数值冒充探测结果。

## 当前状态与轮次

| 轮次 | 开启日期 | 触发原因 | 状态 |
| --- | --- | --- | --- |
| improve-1 | 2026-11-12 | 用户报告输出上限与模型配置自动探测体验问题 | 实施与验收完成 |

用户在方案审查后授权实施。已完成默认值、可选覆盖、Save 自动发现、Responses max 和 Anthropic minimal 清理，以及 Web/TUI 集成；最终测试与真实页面证据记录在 [05 实施与验收](improve-1/05-implementation-acceptance.md)。原讨论和方案保留作为决策与行为契约，不用作实施进度日志。

## 文档地图

- [00 讨论与已确认要求](improve-1/00-discussion.md)
- [01 现状、证据与问题](improve-1/01-problem-analysis-and-current-state.md)
- [02 实施方案与前后端契约](improve-1/02-optimization-plan-and-change-scope.md)
- [03 dsh、kimi-code、ZCode 对照](improve-1/03-reference-projects.md)
- [04 测试与验收标准](improve-1/04-test-and-acceptance.md)
- [05 实施与验收记录](improve-1/05-implementation-acceptance.md)

02 是行为契约，04 是验收标准。后端由主代理承担；Web 前端主体由 Pi `anthropic/claude-opus-5-5`、`xhigh` 完成，主代理负责复核、后续精简和集成验收。具体分工及供应商 429 对续跑的影响见 05。

## 边界与关联

输出截断后的自动接续是前一轮调查发现的独立运行时问题，本方案不把“提高到 32K”等同于解决它，也不修改 `length → failed` 生命周期。该需求保留待后续讨论，没有被取消。

本目录隶属 [LLM 配置模块](../README.md)。现行实现说明仍以 [数据模型](../data-model.md) 和源码为准；本轮已同步其中默认值、字段来源和自动探测的说明。

基线：ohbaby `b8d5fc67a0bf61a62a398bcd511b2aef670c4621`。参考源码的独立提交与取舍见 03；本文不把参考项目的数字或策略当作 ohbaby 的要求。
