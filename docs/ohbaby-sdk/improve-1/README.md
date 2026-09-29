# 来源、终态事件与公共契约：模块改造路线

> 2026-09-19 规划，2026-09-21 按讨论修订，尚未实施。属于[执行可靠性四轮路线](../../problem-lists/2026-09-19-execution-reliability/README.md)。本页说明本模块职责和邻接关系，不是另一份独立实施契约。

## 本轮职责

- UiPermissionRequest 明确实际来源和 root；resolved 保留路由身份与终态。
- 第一轮保留 respondPermission 的 Promise<void>，业务错误及重同步行为见 02。
- 增加独立审批快照与带 epoch/root/revision 的审批事件、轻量会话元数据查询；in-process 与既有 remote 同批接线。
- 同步源类型、事件 schema、消费者及 contract fixtures；全量 getSnapshot 形状保留，新消费者不再用其权限副本覆盖独立审批状态。

## 不承担的职责

- 不实现业务权限、运行时 pending 或会话树数据库查询。
- 不因类型升级改变默认 TUI 拓扑。

## 后续轮次

第二轮扩展工具阶段契约；第三轮增加只读子会话视图契约；每轮独立审查兼容与版本。

## 接口与验收的唯一落点

字段、决议顺序、同步关键提交、审批独立恢复和兼容规则统一见[improve-1 方案](../../problem-lists/2026-09-19-execution-reliability/improve-1/02-optimization-plan-and-change-scope.md)，用例与发布门统一见[04 测试验收](../../problem-lists/2026-09-19-execution-reliability/improve-1/04-test-and-acceptance.md)。不在此复制一套容易漂移的 API 或测试编号。

本目录是本模块 improve-1，对应跨模块议题的 improve-1；模块编号与跨模块轮次编号各自独立，本次恰好同为 1。原模块文档本批不修改；冲突与目标差异在本目录及中央 01/02 中说明。实施结果和验收统一记录到中央 05，不在模块目录另造一份验收结论。
