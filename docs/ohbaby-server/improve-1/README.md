# 同后端多页审批与一致恢复：模块改造路线

> 2026-09-19 规划，2026-09-21 按讨论修订，尚未实施。属于[执行可靠性四轮路线](../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 保留认证、client 注册和 canonical workspace 路由；去掉 permission 的发起连接独占。
- snapshot、requested、resolved、REST/RPC respond 按同一 root 规则隔离。
- 审批独立查询与连续 root 版本；注册/根选择只依赖轻量元数据，返回绑定范围，不能等待完整聊天快照。
- SSE 先订阅再 hello；隔离投递故障并令受影响连接重新同步，连接消失不撤销 pending。REST/RPC 使用一致的认证、注册及根范围规则。

## 不承担的职责

- 不成为第二个审批真相源，不删除 command/interaction 的独立 ownership。
- 不把 TUI 改成 daemon，不承诺跨运行进程审批。

## 后续轮次

第一轮修恢复闭环；第三轮提供只读子会话与根控制入口；第四轮再核验进程重启与 owner 恢复。

## 接口与验收的唯一落点

字段、决议顺序、同步关键提交、审批独立恢复和兼容规则统一见[improve-1 方案](../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-1，对应跨模块议题的 improve-1；模块编号与跨模块轮次编号各自独立，本次恰好同为 1。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
