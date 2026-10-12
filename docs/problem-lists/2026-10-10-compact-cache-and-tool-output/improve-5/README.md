# improve-5 · 入口贯通、旧机制退出与跨入口回归

> 状态：规划稿，**尚未实施**。撰写日期 2026-10-12；代码基线为撰写时的 HEAD `c5cfda26`，业务代码未改。
> 本批是[议题](../README.md)五批实施里的最后一批，按[plan/00](../plan/00-discussion.md)、[plan/02](../plan/02-optimization-plan-and-change-scope.md)、[plan/04](../plan/04-test-and-acceptance.md)与 [context-design/02](../plan/context-design/02-change-spec.md) 细化。
> 规划基线口径：前四批的改动**按设计假定已交付**（见下表），本批不重复它们，只做入口贯通、跨批契约复核和剩余旧机制清扫。

## 一句话

让手动、自动、溢出恢复都使用前四批的内部压缩核心，保留手动空闲准入与运行内自动／force 的区别，完成全入口回归，再删除 mask 及专属配置、事件和测试。

## 依赖与前四批成果（假定已交付）

| 批次 | 本批假定的成果（本批只消费，不重做） |
| --- | --- |
| improve-1 | 计数与预算同源；真实模型能力与普通 `/connect` 偏好分开；删除 `BUILTIN_PROFILE_RULES` 前缀表 |
| improve-2 | 工具结果稳定持久化与投影，引用、错误、配对不丢；不新增批次配额 |
| improve-3 | 复用正常请求生成摘要、缓存接通、独立输出、实际用量、单层重试；90% 默认线与必要容量保护；取消前置 prune／prune-only 并清理 prune 消费者 |
| improve-4 | 一份滚动摘要、固定 20K 尾段、模式 A／B、原子切换；**自动最终失败终止本次运行**；删除每次运行的压缩次数上限与无收益抖动锁，以无进展地板替代；压缩提示与压后占用刷新 |

第 3 批的 prune 清理、第 4 批的次数上限／抖动锁删除**不在本批首次做**；本批只复核它们确实清干净、没有回落。

## 文档地图

| 文档 | 内容 |
| --- | --- |
| [00-discussion.md](./00-discussion.md) | 本批已确认结论与来源（短） |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 现状：入口、信号、mask 机制、跨批遗留与 SWE 审视 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 执行契约：分阶段、改动面、迁移与回滚（最详） |
| [03-reference-projects.md](./03-reference-projects.md) | 参考项目实际做法与本批取舍（真参考，短） |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 跨入口回归、旧库重开、多次压缩、清扫断言与实网收尾 |
| `05-implementation-acceptance.md` | 本批实施完成后由验收会话写入，规划期不存在 |

本批**不建** `05`；实施完成后再走一次本 skill 的验收模式。

## 不在本批

服务端 compact、历史数据库召回、缓存预热、Shell／Bash 独立议题、大规模 Web／TUI 重设计、溢出学习窗口，均不在本批。确有独立新流程或清扫规模过大才考虑第六批，本批不预建。

## 实施契约声明

02 是给后续实施会话／开发者的执行契约，04 是验收契约。本规划会话不改业务代码，不在本目录写自检记录。实网测试是**每批的收尾动作**，本批文档不声称任何新行为已通过。
