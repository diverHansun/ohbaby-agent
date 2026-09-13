# llm-client：Responses 迁移 improve-3 改造说明

按用户要求，本轮说明独立存放，不重写上级目录的既有模块文档。目录拼写沿用用户指定名称；不代表 Git 分支更名。

本目录说明 improve-3 实际落地后的 llm-client 合同，不另建一套规划或验收编号。上级旧文档保留历史基线，若涉及本轮已迁移的入口或字段，以本目录及批准的字段合同为准。

- [目标与职责](./goals-duty.md)
- [架构与状态归属](./architecture.md)
- [数据模型](./data-model.md)
- [数据流与接口](./dfd-interface.md)
- [测试边界](./test.md)
- [唯一字段合同](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/design/data-model.md)
- [实际验收与失败历史](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/05-implementation-acceptance.md)

本轮不改变估算数值、cache策略、SQLite格式或context压缩算法。下一轮只先核对估算校准及必要字段/接口，核心算法不改；具体候选见 [后续范围](../../../problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-3/next-stage-candidates.md)。
