# 02 本模块责任与交接

**拥有**：REST/RPC 透传 agent 应用视图的会话版本和真实实体 ID；订阅先装 listener 再发 hello。鉴权及绑定在异步等待后复核；Stop 校验确切 runId，不从全量快照猜目标。全局 SSE seq 只负责传输重放和缓冲缺口，不能充当会话版本。

**迁移**：resync-required 触发当前会话重新取基线；删除 remote 客户端自造的整页 replacement。旧 `/v1/snapshot` 只保留主动兼容查询，缺新能力时明确版本不支持。

**边界**：server 不建第二份业务投影，不从 REST/RPC 返回时间猜消息顺序；默认 TUI 不通过 server。

具体字段、容量、初始化顺序和旧路径清单以[中央 02](../../problem-lists/2026-09-19-execution-reliability/improve-1.1/02-optimization-plan-and-change-scope.md)为实施契约。实施差异在中央 05 验收记录，不把本页当成独立协议。

返回：[本模块索引](README.md)。
