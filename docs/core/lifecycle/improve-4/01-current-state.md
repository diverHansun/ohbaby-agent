# 01 当前问题

`core/lifecycle/lifecycle.ts` 在每次模型步骤创建真实 assistant message，正文 delta 更新该消息的 text part；reasoning delta 带真实消息 ID，却只累计在运行内存。`adapters/ui-runtime/run-stream-adapter.ts` 把正文接到展示用替身消息，导致 live 与重新读取的历史不能按同一 ID 合并。

`activeReasoningByMessageId` 还供同轮模型协议使用，不能为释放展示缓存而清空它。当前不同结束路径会发出 reasoning-end，但尚未保存可查询的 ReasoningPart。

受影响的原设计文档：[dfd-interface.md](../dfd-interface.md)、[data-model.md](../data-model.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
