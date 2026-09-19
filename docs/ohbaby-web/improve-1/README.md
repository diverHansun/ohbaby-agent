# 审批恢复所需的最小客户端接线：模块改造路线

> 2026-09-19 规划，尚未实施。属于[执行可靠性四轮路线](../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 展示全部 pending 的稳定列表来源，具体单卡排序不影响后端独立回答。
- 移除 Cancel run；显示实际主/子来源和等待审批；他页回答/撤销后同步收口。
- 切项目会话时隔离 generation；刷新重读 pending，not-pending 正常同步。

## 不承担的职责

- 第一轮不制作完整子代理侧栏、子页或工具阶段面板。
- HTTP 应答成功不等于工具已经执行；不自行生成权限规则或推断 request 所属 run。

## 后续轮次

第三轮子会话只读展示输入输出和状态，禁止用户 prompt，审批回根主会话；第二轮先补准确工具阶段。

## 接口与验收的唯一落点

字段、决议顺序、投影 fence、快照水位和兼容规则统一见[improve-1 方案](../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-1，对应跨模块议题的 improve-1；模块编号与跨模块轮次编号各自独立，本次恰好同为 1。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
