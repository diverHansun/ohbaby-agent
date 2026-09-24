# 03 本模块验收重点

- **契约（T08、T09、T20、T21、T30）**：in-process/REST/RPC 同义；完整聊天版本与审批版本分别比较，客户端 generation 不作为后端版本；子会话不因此获得主会话操作权。
- **迁移（T24、T25、T31）**：新旧 schema 和远程客户端不静默降级到旧整页替换；旧主动查询可读，新消费者忽略旧 replacement。

场景步骤、阶段门及通过标准见[中央 04](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/04-test-and-acceptance.md)。这里的 T 编号均指全局 improve-1.1；当前仍是规划，尚未运行产品测试。

返回：[本模块索引](README.md)。
