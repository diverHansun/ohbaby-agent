# 02 本模块责任与交接

**拥有**：声明会话 view/control/history、轻量 index、原提交 receipt 的同义查询和版本事件；共享一个具名聊天版本 `(runtimeEpoch, sessionId, viewGeneration, sessionRevision)` 及必要的小型比较/合并函数。审批仍使用 improve-1 独立版本；传输 seq、客户端请求批次、remote 绑定各守自己的范围。

**兼容**：旧 `getSnapshot` 仅保留主动查询返回形状，不继续驱动仓内整页恢复。旧事件类型可暂保留解码兼容，不能在新消费者全替换状态。schema、生成产物与 mock 一起更新，不能只改 TypeScript 类型。

**边界**：进程内 TUI 不生成 HTTP hello 或 server binding；SDK 不发明第二份业务状态权威。

具体字段、容量、初始化顺序和旧路径清单以[中央 02](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/02-optimization-plan-and-change-scope.md)为实施契约。实施差异在中央 05 验收记录，不把本页当成独立协议。

返回：[本模块索引](README.md)。
