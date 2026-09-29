# 01 当前问题

`core/message/database-store.ts` 的 `listBySession` 读取会话完整历史，再由上层裁剪；会话越长，页面初次恢复需要读取的数据越多。message store 已能表达 `ReasoningPart`，但生命周期生产路径没有把展示思考写入。

`core/message/manager.ts` 的 part 写入直接等待 store；若把展示思考的持久化等待照搬进执行推进队列，单次慢写就可能阻塞后续正文。

受影响的原设计文档：[data-model.md](../data-model.md)、[dfd-interface.md](../dfd-interface.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
