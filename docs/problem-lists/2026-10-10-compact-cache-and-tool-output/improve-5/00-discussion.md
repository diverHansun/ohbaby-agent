# 第 5 批已确认结论与来源

> 本文只记**已确认**的结论，不写推理。本批没有新的用户讨论，结论全部来自议题 plan 里已收口并锁定的条目。

## 来源

- [plan/00-discussion.md](../plan/00-discussion.md) §6（触发、重试和失败行为）、§7（文档、实施与范围）
- [plan/02](../plan/02-optimization-plan-and-change-scope.md) §7（手动、自动、重试与失败）、§9（五批实施与依赖）、§9.1（常量归属）
- [plan/04](../plan/04-test-and-acceptance.md) E2／E3／E4／E5
- [discussion-notes](../plan/discussion-notes.md) §16、§17.8、§17.11、§17.12、§17.13
- [context-design/02](../plan/context-design/02-change-spec.md)「退出旧机制」

## 已确认（与本批相关）

1. **手动与自动共用内部压缩核心，各自保留准入方式。** 手动经公开 compact 入口，用已有会话／scope 状态与独占机制判断 busy 和重复请求，仅空闲执行，不暗停工具、不排队。自动与 force 在当前运行的安全请求边界进入内部 runCompaction，不套用手动空闲检查，不重复获取 mutationLane。见 plan/00 §6、plan/02 §7。
2. **失败终止在第 4 批完成，本批只回归。** 自动摘要在允许的内部重试后仍失败，或判定无收益，就结束本次自动运行，保留会话、全部历史和已完成工具结果。自动／overflow／force 不能在同一次运行里另开摘要额度。本批负责把这条行为在**全部入口**上回归，不在这里首次补上终止。见 plan/02 §9、discussion-notes §17.11。
3. **溢出恢复是 force compact 一次。** 一次性标志在调用压缩之前置位、失败也不回滚，防「force 失败 → 溢重现 → 又 force」的死循环。成功后重发的普通请求不挂恢复钩子，第二次再溢出直接结束运行。溢出错误标为不可重试，只进 force 入口。见 plan/02 §7。
4. **mask 随本批整体删除，失用代码一起清。** `MASK_*`、`CompactionThresholds.mask`、遮罩投影、`ContextEvent.Masked` 及其事件登记、`maskEnabled`／`maskConfig` 选项、`decideCompactionRung` 的 `mask` 档及相关测试同批清理，不留临时开关或空壳。见 plan/02 §9.1、discussion-notes §17.13。
5. **删 mask 后，输入预算口径只剩一处。** 自动摘要触发只认完整窗口占用 `currentTokens / contextLimit`，本来就不含输出预留帽；带 50% 帽的 `usageRatio` 只服务于 mask 触发，mask 删掉后它不再用于任何触发判断。见 plan/02 §4.3。
6. **本批不新增框架、永久锁或版本服务，不删旧数据读取兼容。** 清扫依据是「失去引用」，不是「名字看着旧」；工具自身首次返回的分页／限长、`time.compacted`、`commitCompaction` 共用事务、旧摘要与原文读取都保留。见 plan/02 §9、§9.2、discussion-notes §17.12。
7. **每批都不留只能靠后续批次拆除的脚手架。** 本批作为最后一批，必须确认前四批没留下需要本批兜底的临时实现。见 plan/02 §9。

## 发布与范围边界

- 第三至第五批共同完成行为切换，不能把任何不完整中间状态单独当新策略发布。发布完整切换的时点由用户拍板。
- 本批是否触发第六批，按实施时实际新增工作判断，此处不预判。
