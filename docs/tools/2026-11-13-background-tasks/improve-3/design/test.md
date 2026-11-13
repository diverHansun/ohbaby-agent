# 模块测试设计

## Test Scope

覆盖 task 的动作契约、可信 owner、权限、调度、序列化与历史兼容，不重复实现一套 Registry 测试。当前检索未发现独立项目级 test-blueprint；沿用仓库 `*.unit.test.ts`、`*.integration.test.ts` 和 package.json 分层命令，不另创测试规范。

## Critical Scenarios

- 六状态共享枚举、status 筛选与返回一致，timeout/cancelled 区分；旧状态不折叠成 stopped。
- 每个动作的合法输入、必需字段、范围、未知字段与混合动作输入；无效 stop 绝不触发信号。
- 真正的 owner 隔离：主/子、两个子代理、同 session 不同 scope；伪造参数和外部同名工具不能获得管理权。
- output 到期或取消不终止进程；已结束、输出收尾、清理未确认均返回真实事实。
- stop 重复调用、与自然退出竞争；操作反馈与结果状态分开。
- 动作分类和各权限等级的默认行为；initialSnapshot 注入旧 deny 仍生效，不新增审批或动作 pattern 语法。
- list 稳定有界，清理未确认不被 include_finished=false 隐藏，截断可见。

## Integration Points

沿用 shell-job-registry.unit/integration、scheduler.unit、capacity.integration、tool-metadata-projection.unit 和 agents/manager.unit 等现有测试入口。新增用例应验证外部行为，不只验证一个 switch 返回何值。

真实进程集成用例在隔离临时目录启动短命令，以输出事件同步，不睡满 120 秒。等待边界用可控时钟/短等待；终止测试确认进程树和资源释放，而非只断言逻辑 status。旧历史夹具要保留原工具名。

## Verification Strategy

先执行受影响 unit/integration 与类型检查，再按项目要求完成必要回归。文档阶段仅做文档一致性及链接检查，不能写“测试已通过”。验收追踪见 [04](../04-test-and-acceptance.md)，每项需记录实际命令、结果与未验证限制。
