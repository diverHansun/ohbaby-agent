# improve-3：摘要请求分叉、缓存、重试与触发保护

> 规划日期：2026-10-12。代码基线：`c5cfda26`。状态：仅规划，业务代码未改。

本批是五批实施路线的第 3 批，负责把「正常请求材料分叉生成摘要 + 三协议缓存/输出字段 + 单一重试所有者 + 90% 与必要提前容量保护」接通，并同批取消前置 prune、清掉失用代码。整体规则与依赖见 [plan/02](../plan/02-optimization-plan-and-change-scope.md)，本批只写这一批的规划。

## 依赖与边界

- 上游输入：批 1 的预算解析结果（真实能力、普通/摘要额度分离）与批 2 的稳定工具投影。本批不重新定义这两者，直接消费。
- 下游消费：批 4 消费本批产出的摘要候选与请求记录，接上原子事务、模式 A/B 容量裁剪和最终失败终止。
- 3～5 批共同完成行为切换：**本批结束时的中间态不能单独当完整压缩策略发布**，不新增临时开关或双实现壳。
- `05-implementation-acceptance.md` 待本批实施完成后由验收模式写入，规划期不存在。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 本批结论与来源（短，不复述 plan） |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 基线代码现状与本批要解决的问题 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 本批执行契约：职责、数据流、接口、改动面 |
| [03-reference-projects.md](./03-reference-projects.md) | 参考项目核实与本批不照搬处（短） |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 用例、wire 断言、实网收尾与验收标准 |
| `05-implementation-acceptance.md` | 待实施后写入（预留） |

[返回议题入口](../README.md) · [整体规划](../plan/README.md) · [Context 模块记录](../../../core/context/improve-7/README.md)
