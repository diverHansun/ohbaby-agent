# 03 本模块验收重点

- **传输与范围（T08–T10、T21、T30）**：snapshot 等待时流仍读取；传输游标过期和业务版本缺口分开修复，范围切换后的旧响应不得安装。
- **控制与迁移（T13、T17、T18、T31）**：Stop(A) 不误停随后开始的 B；RPC resync 不自造全量 replacement；server 通知失败不重做业务。

场景步骤、阶段门及通过标准见[中央 04](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/04-test-and-acceptance.md)。这里的 T 编号均指全局 improve-1.1；当前仍是规划，尚未运行产品测试。

返回：[本模块索引](README.md)。
