# 父子关系作为展示归属依据：模块改造路线

> 2026-09-19 规划，尚未实施。属于[执行可靠性四轮路线](../../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 复用 Session.parentId 构建可信根关系；adapter 解析并检测循环、缺父和跨工作区。
- 会话历史关系与 run 身份分开，子代理一生可有多个 run。
- 删除/失效关系需让原请求撤销，不能改挂另一 root。

## 不承担的职责

- 不存审批 Promise，不承担客户端连接所有权。
- 第一轮不新增独立父子关系表、不重做 conversation 全模块。

## 后续轮次

第三轮提供树状只读浏览所需查询；第四轮维持会话与执行恢复状态一致。

## 接口与验收的唯一落点

字段、决议顺序、投影 fence、快照水位和兼容规则统一见[improve-1 方案](../../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-1，对应跨模块议题的 improve-1；模块编号与跨模块轮次编号各自独立，本次恰好同为 1。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
