# 02 本模块责任与交接

**拥有**：应用层按 workspace/session 维护一份短提交的会话视图；执行写入先做有限 seed，再连续更新真实消息、run、prompt 等事实。查询只取已提交视图和版本；确切 Stop 目标从 runtime 控制 owner 单独纯读。会话服务只提供元数据与查询，不另养业务视图。

**初始化入口**：持久 backend 沿用 `startupReady`，内存 backend 使用同义就绪入口；一次启动 scheduler 并为被选择、创建或执行的会话准备 goal owner/seed。`GoalService.storeFor` 的共享轻量 owner 与懒加载模型 runtime 分开。GET 只等已启动就绪过程，不调用 drain、rebuild 或 `getRuntime`。

**通知替换**：新建、选择、归档只触发会话索引或范围明确的选择更新；模型配置/发现只刷新对应附加数据。旧整页 replacement 的生产清单以中央 02 为准。

具体字段、容量、初始化顺序和旧路径清单以[中央 02](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/02-optimization-plan-and-change-scope.md)为实施契约。实施差异在中央 05 验收记录，不把本页当成独立协议。

返回：[本模块索引](README.md)。
