# 03 本模块验收重点

- **初始化与无页面执行（T04、T14）**：startupReady 后 drain 一次；选择/写入前 seed；重复 GET 不推进任务、不重复正规化 goal，不因模型 runtime 未创建而漏初始化。
- **视图切点（T05、T17、T18、T30）**：多来源同会话顺序、局部视图重建换代；健康故障不误报 ready，其他会话与独立审批继续。
- **原提交与通知（T19、T31）**：首条提示词响应丢失仍能查原 receipt；归档/选择与模型更新不靠整页广播。

场景步骤、阶段门及通过标准见[中央 04](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/04-test-and-acceptance.md)。这里的 T 编号均指全局 improve-1.1；当前仍是规划，尚未运行产品测试。

返回：[本模块索引](README.md)。
