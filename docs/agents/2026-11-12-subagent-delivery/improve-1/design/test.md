# 模块测试设计

## Test Scope

验证接收、交付、确认、续跑和恢复的职责边界。完整场景及验收编号集中维护在 [04 测试与验收](../04-test-and-acceptance.md)，本文件不复制场景表。

## Critical Scenarios

稳定身份对应 T01–T02；并发与 Stop 对应 T03–T05；确认与故障窗口对应 T06–T10；恢复所有权及 Goal 对应 T11–T12；界面和主到子兼容对应 T13–T15。

最重要的观察值是持久 execution/input/request/run 关系、模型实际调用次数以及用户可见错误。仅断言 callback 调用次数不足以证明可靠投递。

## Integration Points

保持 co-located `.unit.test.ts`、`.integration.test.ts`、`.contract.test.ts(x)` 风格。纯判定用单元测试；身份冲突、重开存储、崩溃窗口和成功确认使用真实 SQLite/runtime，只有模型使用确定性 fake；SDK 和 Web/TUI 使用既有投影测试入口。

## Verification Strategy

先将真实历史消息冲突做成正式红测试，再修身份路径。以可控阻塞点模拟接收、持久化、确认之间的退出，不用几分钟 sleep 或真实 provider 消耗。测试完成后按包运行相关类型检查和回归套件，再做一条本地端到端流程。实际命令、结果和偏差记到实施时的 05，不把规划检查写成代码验收通过。
