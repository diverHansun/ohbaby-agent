# Context improve-7 · 压缩与工具输出变更记录入口

> 状态：议题 improve-1～5 已实施并记录验收，等待用户审查；improve-6 已实施并完成自动与实网验收，独立审查完成，待用户审查；improve-1～6 集中验收尚待后续进行。全量与实网结果以各批验收记录为准，不由本入口推定通过。更新：2026-10-13。

- [整体规划](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/plan/README.md)
- [Context 模块设计](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/plan/context-design/README.md)
- [当前确认](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/plan/00-discussion.md)
- [议题与实施批次入口](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/README.md)

本目录保留 Context 模块变更记录的职责。improve-7 是模块记录编号，可覆盖议题多个实施批次；实施前规划集中在 plan，后续 improve-1～6 分别细化当批规划并记录实施与验收，不在这里重复维护第二套路线。

- [improve-1 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-1/05-implementation-acceptance.md)：计数与完整预算、可选 reasoning usage、危险缩水分支清理及真实服务验证。
- [improve-2 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-2/05-implementation-acceptance.md)：MCP 错误 metadata 接线、工具结果稳定投影、分页／子代理引用及重启回放验证。
- [improve-3 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-3/05-implementation-acceptance.md)：prepared 摘要分叉、缓存与单一重试、容量提前保护、prune 清理及三协议实网／Pi 审查。
- [improve-4 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-4/05-implementation-acceptance.md)：固定 20,000-token 尾段、单滚动摘要、模式 A/B、成功 requests 与遗漏 metadata 原子落库、Stop／冲突保护、成功地板及自动失败终止；旧次数帽与 thrash lock 已删除。
- [improve-5 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-5/05-implementation-acceptance.md)：入口准入与 Stop 贯通、mask 整条链路退出、原子切换边界回归及真实 Web／三协议验证。第 4 批留到本批的 mask 与全入口贯通已随本批完成。
- [improve-6 实施验收](../../../problem-lists/2026-10-10-compact-cache-and-tool-output/improve-6/05-implementation-acceptance.md)：Web／CLI 子代理标记回放、force／地板关键补测、静态 agent 模型字段清理与文档收尾；沿用通用失败处理。独立选模型与跨 provider、子代理占用视图、归档资源回收均不在本批。**已实施，待用户审查**，实际测试、故障注入与实网边界见 05。
