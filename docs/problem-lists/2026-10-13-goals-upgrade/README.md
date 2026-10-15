# goals 模块升级

> 建立日期：2026-10-13。规划复查基线：main / `018a5c96`。
> 规划状态：2026-10-15 已依据代码审查修订总体 plan 与五批 00–04，并完成三个子代理的复核；复核新增的 deadline 重排、Web 执行入口、结算交接与恢复槽竞争已修正并通过定点复核。规划阶段 Pi（github-copilot/claude-opus-5.5，medium）审查已执行；此前受阻的一次尝试不是本次审查结果。文档作为按 1 → 2 → 3 → 4 → 5 推进实施的基线。
>
> 实施状态：improve-1 已在 `codex/goals-upgrade-improve-1` 实现，验收与独立审查结果见 [05](./improve-1/05-implementation-acceptance.md)；看门狗位置疑问、五个参考项目对照及 improve-5 回看条件见 [06](./improve-1/06-request-idle-placement-review.md)。improve-2 已在基于 improve-1 的 `codex/goals-upgrade-improve-2` 实现，交付与验证见 [05](./improve-2/05-implementation-acceptance.md)，阶段模块文档见 [docs/goals/improve-2](../../goals/improve-2/architecture.md)。improve-3 已在基于 improve-2 收尾提交 `fed91056` 的 `codex/goals-upgrade-improve-3` 实现，交付与验证见 [05](./improve-3/05-implementation-acceptance.md)，阶段文档见 [docs/goals/improve-3](../../goals/improve-3/architecture.md)。improve-4 已在基于 improve-3 收尾提交 `a97e07ce` 的 `codex/goals-upgrade-improve-4` 实现并完成本批验收；实际测试映射与审查见 [05](./improve-4/05-implementation-acceptance.md)，阶段架构见 [docs/goals/improve-4](../../goals/improve-4/architecture.md)。原始 goals 文档保留；improve-5 尚未实施，各批尚未合并，等待 improve-5 总体验收。

本议题改进 goals 长任务的执行准入、预算与恢复、请求空闲超时、用户插话及 CLI/Web 展示。保留现有 store/service/runner/scheduler，补齐执行与消息边界。

## 范围与阅读方式

范围包括 goals 状态和统计、adapter 与 prompt scheduler 的共享准入、既有 steer 接入、llm-client 通用空闲看门狗、SDK/CLI/Web 的对应投影与交互。

不改 run-manager 底层并发政策、sandbox 租约、权限决策、数据库引擎或压缩算法；不新增 fork、多目标队列、独立 verifier、语义停滞检测和激活层。

与 [compact-cache-and-tool-output](../2026-10-10-compact-cache-and-tool-output/) 议题独立。复用其消息、压缩和缓存机制，补交互回归，不将本次规划审查称为该议题的全量复审。

面向后续实施和验收的开发者：先读总体 00/02，再读目标批次的 00–04；按该批 02 实施、按 04 验证。所有批次的“前序交付”都是实施前提，不是当前代码事实。

## 总体规划

| 文档 | 内容 |
| --- | --- |
| [plan/00-discussion](./plan/00-discussion.md) | 决议 1–14 的有效结论，7/12 合并，10/11 明确不做 |
| [plan/01-problem-analysis-and-current-state](./plan/01-problem-analysis-and-current-state.md) | 改造前事实、问题与代码依据 |
| [plan/02-optimization-plan-and-change-scope](./plan/02-optimization-plan-and-change-scope.md) | 总体工程约束、跨模块改动面与依赖 |
| [plan/03-reference-projects](./plan/03-reference-projects.md) | 每项决议与五个参考项目的对应、借鉴边界 |
| [plan/04-test-and-acceptance](./plan/04-test-and-acceptance.md) | 全体改造共用的行为验收基线 |

plan 于 2026-10-13 开启，2026-10-15 统一修订。用户随后明确要求提前规划多个 improve，并由子代理撰写、主代理审核。本议题按此要求把 improve-N 用作实施批次；各批内部仍可分 Stage，不再为每个 Stage 新建目录。

## 五批实施地图

五批均于 2026-10-15 开启规划，第 1–4 批的实际交付分别见各批 05。按 **1 → 2 → 3 → 4 → 5** 推进。第 1 批相对独立；第 2 批提供后续执行基础，第 3 批补齐停止和恢复契约，第 4 批接自动插话，第 5 批完成展示与组合回归。

| 批次 | 交付重点 | 前置依赖 | 为何放在一起 |
| --- | --- | --- | --- |
| improve-1 | 通用请求空闲看门狗；建流与各次 next 有界退出；重试、取消和部分输出保护 | 无其他批硬依赖 | 不依赖 goal 状态改造，可先独立验证请求不会无限挂起 |
| improve-2 | 共享执行准入、执行身份、准入计轮、用户队列优先；完成与尾部统计；删除 token 预算和自动提醒中的 token | 无需新增 blocked；与 1 做运行失败回归 | 执行权、计数和旧结果保护不能拆开；统计与完成清理必须在同批闭合 |
| improve-3 | blocked、连续三轮同因审计、双维原子 resume、活跃时间截止；SDK/CLI/Web 状态与恢复入口 | 2；与 1 验证截止竞争 | 后端状态与客户端可见、可恢复能力一起交付，避免 blocked 被旧投影吞掉 |
| improve-4 | accept 后自动 steer；稳定 FIFO、分流幂等；跨 run 未消费输入及显式重发 | 2、3 | 复用已稳定的执行权，再接输入分流和恢复，不另造调度器 |
| improve-5 | 正文与短显示分离、删除 inactive 自动注入、criterion 6000 校验、轮次/时长 UI；最终组合回归 | 2、3、4；回归 1 | 展示与上下文变更依赖前面的身份、事件和恢复契约；收尾测试随功能交付 |

第 2 批范围较大，但不建议再拆出独立交付批。可在批内按“准入与身份”“完成与统计”分别实现、审查，最终一起验收；否则容易留下已计轮却未获得执行权，或目标先清掉而末轮用量无处结算的中间状态。

## 各批文档入口

| 批次 | 讨论 | 现状 | 方案 | 参考 | 验收契约 |
| --- | --- | --- | --- | --- | --- |
| improve-1 | [00](./improve-1/00-discussion.md) | [01](./improve-1/01-problem-analysis-and-current-state.md) | [02](./improve-1/02-optimization-plan-and-change-scope.md) | [03](./improve-1/03-reference-projects.md) | [04](./improve-1/04-test-and-acceptance.md) |
| improve-2 | [00](./improve-2/00-discussion.md) | [01](./improve-2/01-problem-analysis-and-current-state.md) | [02](./improve-2/02-optimization-plan-and-change-scope.md) | [03](./improve-2/03-reference-projects.md) | [04](./improve-2/04-test-and-acceptance.md) |
| improve-3 | [00](./improve-3/00-discussion.md) | [01](./improve-3/01-problem-analysis-and-current-state.md) | [02](./improve-3/02-optimization-plan-and-change-scope.md) | [03](./improve-3/03-reference-projects.md) | [04](./improve-3/04-test-and-acceptance.md) |
| improve-4 | [00](./improve-4/00-discussion.md) | [01](./improve-4/01-problem-analysis-and-current-state.md) | [02](./improve-4/02-optimization-plan-and-change-scope.md) | [03](./improve-4/03-reference-projects.md) | [04](./improve-4/04-test-and-acceptance.md) |
| improve-5 | [00](./improve-5/00-discussion.md) | [01](./improve-5/01-problem-analysis-and-current-state.md) | [02](./improve-5/02-optimization-plan-and-change-scope.md) | [03](./improve-5/03-reference-projects.md) | [04](./improve-5/04-test-and-acceptance.md) |

各批实施完成后，再独立编写本批 `05-implementation-acceptance.md`。规划阶段不生成 05，也不提前把模块现状文档改成目标行为。

## 批次之间的过渡契约

- **第 2 批后**：普通输入在 goal 忙碌时排队，不打断、不提前 claim；自动 steer 到第 4 批才接入。用户队列清空后 goal 才能继续。轮次和时间在边界到顶暂沿用 paused，第 3 批改为 blocked 并补当轮时间截止。
- **正文与展示**：第 2 批负责从同一准入快照生成正文、轮号和展示值；第 5 批只接 live/replay 展示，不再从旧快照重算正文。
- **执行身份与恢复**：第 2 批负责正文实改失效 epoch（保留 goalId/统计）、工具真实 runId、准备取消、goal root 定点中断与结算失败的现有 recovery 接线（先结算/登记恢复，再释放执行占位）；同代致命失败不自动重驱。第 3、4 批继承这些资格检查。
- **完成与统计**：complete 的持久化、终态守卫、尾部结算、UI 清空和通知去重均属于第 2 批；用量更新事件也在此建立。第 5 批只消费数字，不补救前序记账缺口。
- **token 退出硬限制**：第 2 批同时删除配置、工具单位、预算判断与自动提醒中的 token，并提供旧记录读兼容；总量、缓存和不完整统计仅供查询。第 3 批只处理剩余两轴。
- **状态与交互**：第 3 批的 blocked 与 SDK/CLI/Web 恢复同批交付；第 4 批的未消费提示与重发也同批交付。第 5 批不承担前面遗漏的必要恢复入口。

## 总体验收归属

下表引用 plan/04 的场景 ID，各批 04 再细化用例、文件和命令。共同覆盖表示不同阶段验证不同职责，不要求每批复制同一套测试。

| 总体场景 | 主要负责批次 | 组合检查 |
| --- | --- | --- |
| A1–A10：准入与生命周期 | 2 | 3 的截止/恢复、4 的 accept 分流、5 的显示同快照 |
| B2：token 不再参与预算 | 2 | 3 的两轴计算、5 的查询与显示 |
| B1、B3–B12：状态、预算、审计与恢复 | 3 | 4 的 steer 不新增审计轮；5 的状态投影 |
| C1–C8：完成与统计 | 2 | 3 的 blocked 结算；5 的完成/重连显示 |
| D1–D7：活跃时间截止 | 3 | 1 的 watchdog、4 的用户队列竞争 |
| S1–S12：输入、队列与恢复 | 4；S6/S7 的调度基础先在 2 验收 | 5 的压缩、切换和重连组合 |
| U1–U13：文本、UI、上下文 | 5；U6/U9 的事件与统计基础在 2，U7 的恢复入口在 3 | 5 收齐剩余视觉与上下文回归 |
| W1–W7：请求空闲超时 | 1；W4 的 goal 截止部分在 3 | 5 的整体回归 |

每批实施前核对前序实际 05 与当前源码。如果前序偏离预期接口，先调整本批规划中的衔接，不把预先写好的函数名当成必须照搬的实现。接口和记录存在依赖的批次不得宣称可任意单独回滚，具体边界见各批 02。

规划定稿时的文档检查通过：相对链接、代码围栏、表格连续性、场景编号及空白检查无异常；当时保存的 3096 个源码/指令文件摘要无变化。规划阶段未运行产品验收、未改业务代码、未提交或合并；当时的基线测试不代表方案已实现。后续实施逐批按 04 验收，实际结果以各批 05 为准。
