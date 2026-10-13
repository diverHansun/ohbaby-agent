# Compact 缓存与工具输出优化 · improve-2（工具结果稳定回放）

> 第 2 批已实施并完成测试，待用户审查。实施日期 2026-10-13，实际基线为 improve-1 的 `c8be589d`；原规划日期 2026-10-12、调查基线 `c5cfda26`。
> 整体规则以 [plan/02](../plan/02-optimization-plan-and-change-scope.md) 为准，本批只收敛工具结果的存储与投影。

## 本批交付

复用已有 `ToolPart` 正文／metadata、持久化、`serializer` 与 `tool-metadata-projection`，让普通请求和摘要请求共用同一条工具结果投影，并核对分页游标、错误／状态／调用配对、子代理回传口径。不新增单条／批次工具额度，不新增预览生命周期，也不新建通用落盘服务。

## 批次地图与依赖

| 批次 | 与本批的关系 |
| --- | --- |
| improve-1 计数与预算 | 与本批无代码前置依赖，可并行 |
| improve-2（本批） | 工具结果稳定存储与投影 |
| improve-3 摘要请求与缓存 | 依赖本批的稳定投影，取消摘要前改写旧工具结果 |
| improve-4 滚动摘要与切换 | 依赖本批的保留段与投影一致 |
| improve-5 入口贯通与清扫 | 承接本批，删除 mask 与残留压力改写 |

plan 已确认：prune 的移除归第 3 批，mask 的整体清理归第 5 批。本批只保证常规投影不改写已发送结果，不提前删这两条路径。实际变更与验证结果见 [05 实施验收](./05-implementation-acceptance.md)。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [00-discussion](./00-discussion.md) | 本批已确认的结论与边界 |
| [01-problem-analysis-and-current-state](./01-problem-analysis-and-current-state.md) | 工具结果存储／投影的现状与缺口 |
| [02-optimization-plan-and-change-scope](./02-optimization-plan-and-change-scope.md) | 改动面、开发顺序、数据流、兼容回退 |
| [03-reference-projects](./03-reference-projects.md) | 参考项目借鉴与不照搬 |
| [04-test-and-acceptance](./04-test-and-acceptance.md) | 风险测试、测试 ID 映射、实网收尾 |
| [05-implementation-acceptance](./05-implementation-acceptance.md) | 实际实施、单元／集成／真实服务验收、审查与剩余边界 |

[返回议题入口](../README.md) · [整体规划](../plan/README.md)
