# 02 本模块责任与交接

**拥有**：复用现有 message/part 主键和 `ReasoningPart`，增加可选结束元数据；旧记录无该字段时保持未知。历史查询在 SQL 层按稳定 `(created_at, 唯一键)` 游标限页，保留全部 part 与既有 metadata。旧会话历史不改写，显示用 reasoning 不因此自动进入模型上下文。

**交接**：store 只负责真实保存、分页与一致读取，不自己生成会话版本。应用协调器提交 `pending/saved/failed`；DB 已写入而 `saved` 尚未接纳时，历史页按来源 owner 的同身份状态覆盖或排除新 part，不能给旧 revision 贴新数据。展示保存独立于正文/工具记录保存，不把执行记录写失败改成可忽略。

**边界**：不把分页放到前端 `slice`；不建立第二套持久事件日志。

具体字段、容量、初始化顺序和旧路径清单以[中央 02](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/02-optimization-plan-and-change-scope.md)为实施契约。实施差异在中央 05 验收记录，不把本页当成独立协议。

返回：[本模块索引](README.md)。
