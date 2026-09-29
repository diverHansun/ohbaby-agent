# 01 当前问题

`app/create-app.ts` 的 `/v1/snapshot` 先 await 后端全量读取，再取 eventBus.latestSeqNum，可能把较新的传输水位贴给较早数据。`protocols/jsonrpc/client.ts` 在 resync-required 后自行调用 getSnapshot，制造 `snapshot.replaced`；客户端视图过滤也不是会话内容的一致性屏障。

受影响的原设计文档：[architecture.md](../architecture.md)、[dfd-interface.md](../dfd-interface.md)、[03-event-replay.md](../hono-app/03-event-replay.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
