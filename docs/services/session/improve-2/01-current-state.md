# 01 当前问题

`adapters/ui-inprocess.ts` 的 `readSnapshotWithPermission` 先调用 `promptScheduler.init()`，随后读取全项目快照并同步 goal/todo。调度器的 init 会请求 drain；当模型 runtime 尚未创建时，goal 同步路径可直接 `GoalStore.rebuild`，其正规化过程会写回状态。页面读取因此含执行副作用。

`adapters/ui-persistent.ts` 已有 `startupRecovery/startupReady`。读模型应由应用适配层装配，`services/session` 继续管理会话元数据，不接管模型或 Web 状态。

受影响的原设计文档：[architecture.md](../architecture.md)、[dfd-interface.md](../dfd-interface.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
