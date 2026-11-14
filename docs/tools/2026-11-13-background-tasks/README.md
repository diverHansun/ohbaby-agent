# 后台任务：生命周期、自动转换与管理工具

2026-11-13 开启。improve-1～3 的后端规划已收尾，improve-1 已本地集成到开发分支；2026-11-14 按用户指示从该分支建立 `codex/background-tasks-improve-2` 实施第二轮，后端实施与验收已完成，并按用户批准本地合并到开发分支；improve-3 尚未开始。代码勘测基线 `f42608d4`；实际验收以各轮实施报告为准，规划文档中的代码位置是基线快照。

用户先确认显式后台管理，再明确提前讨论自动转换及工具收拢，因此保留三个独立轮次。提前规划不代表前轮已验收。当前只负责后端，前端暂缓。

## 已定范围

| 轮次 | 开启日期 | 实施契约 |
| --- | --- | --- |
| improve-1 | 2026-11-13 | 显式后台默认不限时；准确六状态、持久输出、可靠通知；主代理10/每子代理5独立额度；子代理本次执行结束回收；用户会话树查询和单停后端；保守崩溃恢复、按需复查和用户放弃追踪；活跃跨后端任务只读。 |
| improve-2 | 2026-11-13 | 默认开启自动转后台，默认前台等待120秒；配置及单次可关闭；等待与硬超时独立；转换不重启、不重置timeout；满额停止当前命令并报告capacity-limit。 |
| improve-3 | 2026-11-13 | bash启动，task统一list/output/stop；保留有界等待、六状态筛选和列表分页；不合并子代理运行时；安全删除旧执行入口，保留必要历史/权限兼容。 |

显式后台及自动转换路径的显式 timeout 最长24小时；纯前台默认120秒、最长10分钟。主代理当前轮Stop不杀已后台任务；用户单停和所有者结束遵守既定回收规则。采用 improve-2 后，improve-1 的纯前台验收应显式关闭自动转换，默认路径按 improve-2 验收。

三个轮次一起实施时，直接发布最终 bash/task 接口，不先新增临时 task_list 再删除。先建立 improve-1 的状态、管理、通知和回收基础，再接自动转换；工具注册可同步切换。安全删除清单见 [improve-1 的改造方案](improve-1/02-optimization-plan-and-change-scope.md#安全删除与替换验收)。

## 实施顺序与检查

按用户最后确认的分支顺序执行：improve-1（记录与状态 → 归属与回收 → 通知 → 用户后端接口）、improve-2（自动转后台）、improve-3（task 工具表面）。这替代规划期先收拢工具再接自动转换的建议。improve-2 可暂时使用现有管理工具，improve-3 再安全替换；不为过渡阶段新增 task_list 工厂。

集成分支为 `codex/background-tasks-dev-20261113`，各轮在独立本地分支实施。各轮在独立分支完成测试、子代理审查、指定 Pi 审核和修正，再按用户当轮指示处理提交与集成。用户于 2026-11-14 确认：完成精简修复的子代理与 Pi 复审、全量检查后，提交并合并 improve-1 到上述本地集成分支；不推送、不实施前端。随后用户在 2026-11-14 开启 improve-2，并明确本轮完成后分批提交、**先不合并开发分支，等待审查**；该指示替代原自动逐轮合并安排。完成收尾复审后，用户于同日批准将 improve-2 合并到开发分支；已快进合并至 `cf4043c3`，不推送。

每批完成当前能力的单元/集成验证和 preflight；跨后续批次的集成项按 02/04 显式保留待验，不提前宣称通过；失败先修复再进入下一批。检查已通过后只对后续窄修做相关检查，下一整体验收再覆盖全部改动，不无故重复全量运行。

本次收尾进一步简化：先提交启动占位再 spawn；纯前台不周期存输出尾部；task 列表聚焦后台和前台清理异常；删除新权限 pattern 语法、重复 subagent_id 及工作区移动的新限制。保留自动转换的狭窄同步提交接点，因为提前切换后再补偿失败会产生更多状态。

## 文档地图

| 文档职责 | improve-1 | improve-2 | improve-3 |
| --- | --- | --- | --- |
| 用户确认与范围 | [00](improve-1/00-discussion.md) | [00](improve-2/00-discussion.md) | [00](improve-3/00-discussion.md) |
| 代码现状与问题 | [01](improve-1/01-problem-analysis-and-current-state.md) | [01](improve-2/01-problem-analysis-and-current-state.md) | [01](improve-3/01-problem-analysis-and-current-state.md) |
| 改造方案与迁移 | [02](improve-1/02-optimization-plan-and-change-scope.md) | [02](improve-2/02-optimization-plan-and-change-scope.md) | [02](improve-3/02-optimization-plan-and-change-scope.md) |
| 本机参考与取舍 | [03](improve-1/03-reference-projects.md) | [03](improve-2/03-reference-projects.md) | [03](improve-3/03-reference-projects.md) |
| 测试验收契约（实际结果见各轮 05） | [04：T01–T41](improve-1/04-test-and-acceptance.md) | [04：A01–A16](improve-2/04-test-and-acceptance.md) | [04：T01–T18](improve-3/04-test-and-acceptance.md) |
| 模块目标 | [目标职责](improve-1/design/goals-duty.md) | [目标职责](improve-2/design/goals-duty.md) | [目标职责](improve-3/design/goals-duty.md) |
| 模块架构 | [架构](improve-1/design/architecture.md) | [架构](improve-2/design/architecture.md) | [架构](improve-3/design/architecture.md) |
| 数据与不变量 | [数据含义](improve-1/design/data-model.md) | [数据含义](improve-2/design/data-model.md) | [数据含义](improve-3/design/data-model.md) |
| 数据流与接口 | [接口](improve-1/design/dfd-interface.md) | [接口](improve-2/design/dfd-interface.md) | [接口](improve-3/design/dfd-interface.md) |
| 模块测试 | [测试](improve-1/design/test.md) | [测试](improve-2/design/test.md) | [测试](improve-3/design/test.md) |

每轮的 `05-implementation-acceptance.md` 在实际实施时记录验收，不能把规划期的 04 当作已运行结果。阅读顺序为00、01、design、02、04；产品决定以00为准，工程合同如有冲突应先修订，不交给实施者二选一。

## 明确的交付边界

- 后端提供当前主会话及全部子代理任务的筛选/分页、启动者信息、输出读取、逐个停止及版本化失效事件。模型工具仍各自管理自己的任务，用户全树权限不扩大模型权限。
- 前端面板、起始卡片和默认筛选另行实施；主代理优先、全部子任务可查和单停需求保留。UI默认视图不阻塞后端交付。
- 按D28，覆盖已登记任务的保守回收；身份无法核实不发信号。spawn 到 PID/出生身份补写之间的极端强杀窗口、脱离托管的外部服务及OS查验/信号间竞态，不承诺系统级托管保证。恢复平台能力必须实测，不能以秒级ps时间比较冒充强身份核验。
- 不做用户手动转后台、跨服务重启常驻、统一子代理/命令Task运行时，也不新增全会话共享后台总额度。
- 清理无用旧工厂、死配置和旧接线；保留实际仍使用的Registry、进程树清理、资源保护、旧历史读取及权限兼容。文档完成不代表已删除代码。

## 相关文档

- [tools模块设计](../goals-duty.md)、[shell模块设计](../../shell/goals-duty.md)：实施时同步权威契约。
- [子代理可靠投递](../../agents/2026-11-12-subagent-delivery/README.md)：复用输入存储与准入能力，保留独立业务来源。
- [执行可靠性第二轮](../../problem-lists/2026-09-19-execution-reliability/improve-2/00-discussion.md)：本议题修订旧Bash统一寿命上限；普通工具名额与后台任务名额仍分开。

各轮实际结果见 [improve-1 实施与验收](improve-1/05-implementation-acceptance.md)（最终精简修复 8355 项通过，已集成）与 [improve-2 实施与验收](improve-2/05-implementation-acceptance.md)（用户审查后修复四项并完成收尾复审，完整检查 8407 项通过，已本地集成）。本轮未推送，improve-3 等待用户安排。shell-job 相关文件的目录整理延后至 improve-3 完成并验收后，再按最终职责边界单独迁移；迁移提交只移动文件和更新引用，不夹带行为修改。
