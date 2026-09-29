# 02 本模块责任与交接

**拥有**：从生命周期事件向 worker/bridge/adapter 传真实 run、message、part 身份；不同模型步骤保持不同消息。正在生成的思考按真实 part 身份累计，正常结束、转正文/工具、Stop 和可处理错误都收口已收到文本及结束原因。

**交接**：先向应用读模型提交最终累计值及 `pending`，展示保存 I/O 在执行推进队列外运行；保存结果再短提交 `saved/failed`。每 backend 一个展示 writer 槽，待存已结束文本按中央 D12 有界淘汰并留下缺失事实。只有展示思考保存失败时 run 继续，不重跑模型或工具。

**边界**：模型同轮需要的 reasoning 与供用户查看的热缓存分开；保存展示文本不自动加入后续模型上下文。lifecycle 不实现 Web、server 版本比较或审批策略。

具体字段、容量、初始化顺序和旧路径清单以[中央 02](../../../problem-lists/2026-09-19-execution-reliability/improve-1.1/02-optimization-plan-and-change-scope.md)为实施契约。实施差异在中央 05 验收记录，不把本页当成独立协议。

返回：[本模块索引](README.md)。
