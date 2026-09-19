# 审批取消与执行调度边界：模块改造路线

> 2026-09-19 规划，尚未实施。属于[执行可靠性四轮路线](../../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 传递真实 runId，将 call controller.signal 传到每次 permission ask。
- 批准返回后继续核对取消；工具结束/取消不留下可批准请求。
- 保留既有类别并发、wave 和执行超时规则。

## 不承担的职责

- 第一轮不改批次预检查次序、不做全部工具阶段 UI，也不把显示排序当执行排序。
- 不读取会话数据库、不解析 root、不拥有客户端连接。

## 后续轮次

第一轮补生命周期接线；第二轮负责阶段、逐项结果和批次阻塞；第四轮核验不合作工具与后台任务停止。

## 接口与验收的唯一落点

字段、决议顺序、投影 fence、快照水位和兼容规则统一见[improve-1 方案](../../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-2，对应跨模块议题的 improve-1；编号各自独立，不意味着整项改造进入第 2 轮。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
