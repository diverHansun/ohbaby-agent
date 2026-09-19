# 子代理身份、观察与控制：模块改造路线

> 2026-09-19 规划，尚未实施。属于[执行可靠性四轮路线](../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 第一轮复用 subagent sessionId/parentSessionId/currentRunId/contextScopeId；审批实际来源不可改成父会话。
- 将子执行 timeout/failed/interrupted 等收口接到精确审批撤销。
- 保留子代理实例和历史；中断不是 close。

## 不承担的职责

- 第一轮不制作子代理面板、不新增用户对子代理发 prompt。
- 不把主代理有空 status 查询当作用户审批可见性的前提。

## 后续轮次

第三轮做只读树、运行状态和输出、回根主会话审批及结果交付；第四轮做完整停止与恢复。

## 接口与验收的唯一落点

字段、决议顺序、投影 fence、快照水位和兼容规则统一见[improve-1 方案](../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-3，对应跨模块议题的 improve-1；编号各自独立，不意味着整项改造进入第 3 轮。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
