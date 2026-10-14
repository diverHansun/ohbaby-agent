# Compact 缓存与工具输出优化

> 状态：improve-1～6 已完成整体验收、三项最小补修及独立／Pi 审核，已合入本地开发分支 `codex/context-optimization`；六个阶段分支已删除。**main 未合入、未 push，等待用户审查**。整轮证据与已知边界见 [06 整体验收](./06-overall-acceptance.md)，各批历史结果仍见各自 05。
> 开发文档建立日期：2026-10-12。代码调查基线：`c5cfda26`；实施各批前需核对前批实际改动。

本议题改进摘要请求的缓存、计数与输出预算、工具结果稳定回放，以及手动／自动压缩。设计重点是复用已有请求、持久化和调度路径，减少压缩前后对历史的反复改写。

## 文档入口

- [plan/](./plan/README.md)：实施前讨论、现状分析、整体方案、参考调查和验收目标。
- `improve-1/`～`improve-6/`：按批次并行细化的开发文档，入口见下表。目录编号表示批次，不表示已完成六轮实施。
- 各批按 `02-optimization-plan-and-change-scope.md` 开发，按 `04-test-and-acceptance.md` 验证；实施后再创建各自的 `05-implementation-acceptance.md`，记录实际结果。
- [Context 模块记录入口](../../core/context/improve-7/README.md)：模块变更记录编号，不是本议题的第七批实施。

| 计划批次 | 主要交付 | 当前状态 |
| --- | --- | --- |
| [improve-1](./improve-1/README.md) | 计数、实际输出预算、用量记录基础与危险退场分支修复 | 已实施，见 [验收](./improve-1/05-implementation-acceptance.md)，待用户审查 |
| [improve-2](./improve-2/README.md) | 复用已有工具结果，保证模型投影和引用稳定 | 已实施，见 [验收](./improve-2/05-implementation-acceptance.md)，待用户审查 |
| [improve-3](./improve-3/README.md) | 正常请求分叉、缓存、统一重试、触发容量保护与 prune 清理 | 已实施；测试／实网／Pi 审查见 05 |
| [improve-4](./improve-4/README.md) | 滚动摘要、容量兜底、原子切换、失败终止与占用刷新 | 已实施；测试、实网与 Pi 审查见 [05](./improve-4/05-implementation-acceptance.md) |
| [improve-5](./improve-5/README.md) | 入口贯通、旧机制退出、代码清扫与完整验收 | 已实施；入口、Stop、清扫和真实 Web 验收见 [05](./improve-5/05-implementation-acceptance.md) |
| [improve-6](./improve-6/README.md) | 子代理标记回放、关键补测、agent 配置清理与文档收尾 | 已实施；两端回放、补测、配置与实网结果见 [05](./improve-6/05-implementation-acceptance.md)，待用户审查 |

第五批包含 SWE 检查，第六批据此收尾。第六批的来源是 2026-10-13 对 improve-1～5 的「主代理／子代理接入」专项审查。复核确认主、子代理已共用 Context 核心；本批补齐 Web／CLI 子代理标记回放与关键测试，清理四个静态 agent 模型字段，沿用通用子代理失败处理。子代理独立选模型与跨 provider 另开议题；占用视图扩展和归档资源回收本批不做，保留现有行为。

## 后续独立议题

- 子代理独立选模型与跨 provider：2026-10-13 确认从 improve-6 移出，范围与核查依据登记在 [improve-6／02 §2.8](./improve-6/02-optimization-plan-and-change-scope.md#28-后续独立议题)。后续单独讨论预算与实际请求路由的完整方案。

## 其他议题与实施顺序

[Shell／Bash 独立议题](../2026-10-11-shell-and-glob/README.md)与本轮无关，不作为本轮前置。规划文档保留原样；2026-10-13 完成第一批实施、三协议独立服务实网与回归，实际记录写入 improve-1/05。

实施按批次推进。第 1 批的独立修复可以先合入；第 3～5 批共同完成新流程切换，中间成果不能单独宣称完整策略已可发布，第 6 批以第 5 批为前置。后续批次的文档区分当前代码与前批预期交付，开工时只需复核实际差异，不重新讨论已确认的规则。
