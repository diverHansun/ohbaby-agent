# 独立审批请求与授权规则：模块改造路线

> 2026-09-19 规划，2026-09-21 按讨论修订，尚未实施。属于[执行可靠性四轮路线](../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- 用独立 pending registry 代替 manager 单 current/queue，显示顺序不限制回答。
- 精确保存 source session/run/call；request 绑定调用 signal，回答和撤销一次生效。
- 始终允许仅真实 session；拒绝单请求；规则仍按既有内存生命周期保存。
- 通过 composition 注入的同步关键提交端口明确传播内部失败；普通通知与业务决定分离。严重故障按可信 root 冻结并直接结束等待，不依赖损坏投影清理，不让单连接错误清空 pending。

## 不承担的职责

- 不认识 Web clientId，不负责根会话页面选择和 UI 排序。
- 不承担模型工具调度、跨进程 pending 同步或后台 job 强杀。

## 后续轮次

第一轮为主要领域改造；第二轮只消费其阶段事实，第三轮复用请求来源，第四轮接更多执行结束清理。

## 接口与验收的唯一落点

字段、决议顺序、同步关键提交、审批独立恢复和兼容规则统一见[improve-1 方案](../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-2，对应跨模块议题的 improve-1；编号各自独立，不意味着整项改造进入第 2 轮。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
