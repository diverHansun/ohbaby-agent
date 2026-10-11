# 实施前讨论与整体规划

> 2026-10-11：已按最新确认重写，不再沿用早期单轮草案。
> 本目录是整体路线；各批详细规划、实施和验收后续分别写入 improve-1～5。

| 文档 | 内容 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 当前已确认的需求、取舍和边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 基线代码的问题与证据 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 目标流程、预算、数据流与五批依赖 |
| [03-reference-projects.md](./03-reference-projects.md) | 参考源码及采用、不采用的理由 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 各批验收、真实 API 探测与审查要求 |
| [context-design/](./context-design/README.md) | Context 模块视角的精简设计 |
| [discussion-notes.md](./discussion-notes.md) | 调查与讨论过程，包含后来撤回的建议；现行规则以 00 和 02 为准。最新确认见 §16～§17 |
| [raw-discussion-01.md](./raw-discussion-01.md) | 原始讨论存档，保留当时原文和旧路径 |

plan 写清问题、规则、数据流、依赖与失败语义。后续各 improve 按实际代码精细化本批规划，记录实施、测试证据与验收；不复制五套相同总方案，也不在 plan 中维护逐文件实施进度。

已撤回的统一工具 8K／批次 20K 配额、均分算法、第二份预览生命周期、所有协议 32K 硬帽和固定 thinking 统一 16K 限制，均不进入方案。

[返回议题入口](../README.md) · [Context 模块记录入口](../../../core/context/improve-7/README.md)
