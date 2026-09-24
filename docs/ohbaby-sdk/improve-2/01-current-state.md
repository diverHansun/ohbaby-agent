# 01 当前问题

`ohbaby-sdk/src/client.ts` 现有 `getSnapshot` 返回整页状态；`events.ts` 仍含 `snapshot.replaced`。这些公开形状不能说明会话当前值和后续事件属于同一切点。Web、显式 remote CLI 与默认进程内 TUI 都消费 SDK，但连接行为不同。

受影响的原设计文档：[architecture.md](../architecture.md)、[data-model.md](../data-model.md)、[dfd-interface.md](../dfd-interface.md)、[test.md](../test.md)。这些文件保持原样；全链路原因与基线证据见[中央 01](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/01-problem-analysis-and-current-state.md)。

返回：[本模块索引](README.md)。
