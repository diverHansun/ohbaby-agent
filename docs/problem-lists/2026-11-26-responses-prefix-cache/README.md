# Responses 如何复用基础指令

2026-11-26 第一轮。GPT-6.2 的 Responses 请求可以正常回答，但 ohbaby 把每轮相同的基础指令放在了缓存读不到的位置。这里记录旧行为、修复边界和三种接口的实测结果。

| 文档 | 用途 |
| --- | --- |
| [讨论](improve-1/00-discussion.md) | 用户要解决什么 |
| [现状](improve-1/01-problem-analysis-and-current-state.md) | 旧请求和对照实验 |
| [方案](improve-1/02-optimization-plan-and-change-scope.md) | 请求布局与兼容边界 |
| [参考](improve-1/03-reference-projects.md) | 官方规则和相邻项目 |
| [测试](improve-1/04-test-and-acceptance.md) | 如何验证命中与回归 |
| [验收](improve-1/05-implementation-acceptance.md) | 实施后记录逐组结果 |
