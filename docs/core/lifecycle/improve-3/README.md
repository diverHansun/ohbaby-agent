# 执行身份与终态清理：模块改造路线

> 2026-09-19 规划，2026-09-21 按讨论修订，尚未实施。属于[执行可靠性四轮路线](../../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 从实际 RunContext 经 lifecycle 显式传真实 runId 到 ToolCallRequest，覆盖主/子真实执行入口；session/run/call 分别保留身份。core runner 已有 runId，实施重点是 RunWorker 到工具请求之间的断链。
- 主/子执行结束出口按 runId 撤销残留审批，不由 UI 快照推断。
- 确保旧 run 的清理不影响同会话后续 run。

## 不承担的职责

- 不新增审批策略或连接路由。
- 第一轮不改变整批工具结果返回时序，不宣称完整树 Stop。

## 后续轮次

第二轮处理逐项结果与模型回合边界；第四轮核对全部终态与迟到结果。

## 接口与验收的唯一落点

字段、决议顺序、同步关键提交、审批独立恢复和兼容规则统一见[improve-1 方案](../../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-3，对应跨模块议题的 improve-1；编号各自独立，不意味着整项改造进入第 3 轮。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
