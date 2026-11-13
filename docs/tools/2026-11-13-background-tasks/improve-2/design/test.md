# 测试设计

## Test Scope

本轮只增自动转换与调度接线覆盖，复用 improve-1 的持久化、回收与通知测试，不复制测试框架。

## Critical Scenarios

硬截止与等待同刻、退出与转换同刻、最后一个名额竞争、Stop 与提交竞争、转换失败和尾部输出跨模式。对应 [04](../04-test-and-acceptance.md) A01–A16。

## Integration Points

真实 Bash → Scheduler → Registry → SQLite → 输入投递；子代理本次执行结束、会话关闭、回滚、UI 后端查询和 task 管理。

## Verification Strategy

单元用可控时钟穷举顺序；集成用短等待和真实进程组验证不重启、不误杀、不超额及资源释放。默认120秒和24小时只验证参数/时钟契约，常规测试不真的睡满时长。沿用仓库 unit/integration 分类，未运行不得标通过。
