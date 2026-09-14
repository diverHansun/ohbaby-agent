# improve-4 · 用量与校准链路对齐

> 开启日期：2026-09-14。状态：规划草案，等待用户审核；未实施。
> 触发事件：improve-3 主动切出的用量与校准议题，承接其 05 独立技术验收及用户收窄后的范围。不是把实施批次另算一轮。

目标：核对并对齐供应商用量、单步估算和校准之间的数据合同；保留现有估算、统计、占用和压缩算法，以及现有更新时机、作用范围与缺失规则。不以提高估算精度、改变占用数字或精确计费为成果。

## 分支与基线

- 文档分支：`codex/improve-4-usage-calibration`，当前集成基线 `c7572a38`；生产代码与 `734f2ef6` 相同，随后两个提交仅补充 improve-3 验收文档。
- 创建时先从 improve-3 HEAD 建分支。用户随后授权收尾合入，2026-09-14 完整 preflight 复跑通过后，`openai-responses-migration` 已从 `b43a0921` 快进至 `c7572a38`；本分支也已快进对齐。没有重复实现、cherry-pick 或重写历史。实施前仍须核对当时分支和工作区差异。
- 集成目标仅为 `openai-responses-migration`。不合 main、不 push；本轮文档通过审查不等于实施授权。

## 阅读顺序与职责

| 文档                                                                                   | 唯一职责                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| [00-discussion.md](./00-discussion.md)                                                 | 已确认决策与边界，不记实施进度             |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 有代码依据的现状、限制及证据缺口           |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 目标合同、三个实施批次、兼容与关键改动清单 |
| [03-reference-projects.md](./03-reference-projects.md)                                 | 六个本地参考项目的事实、取舍与适用限制     |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md)                               | 测试场景、命令和验收门                     |
| `05-implementation-acceptance.md`                                                      | 实施完成后由独立验收生成；规划期不创建     |

按 plan-module-design 的模块视角分析，但不新造跨模块 TokenManager。01 按职责分析现状；02 描述本轮必要的接口合同；用例及工程约束内嵌，避免重复维护七套文件或字段定义。00 的已确认边界约束 02；04 不得自行增加产品需求。子代理只提供审查意见，正式文档由主代理修改。

## 历史关系

以 [improve-3/05](../improve-3/05-implementation-acceptance.md) 和 [下一阶段候选](../improve-3/next-stage-candidates.md) 为输入。候选中“整轮”在本轮明确为本次 `Lifecycle.run()` 的累计，不等于 Session 总账。原 llm-client 平铺文档、improve-3 的冻结 02/04、context improve-5/6 历史方案不重写。

当前字段与行为的本轮解释见 02；历史模型适配说明仍见 [llm-client improve-3 子目录](../../../core/llm-client/openai-response-miagration-improve-3/README.md)。本轮不更改该目录拼写。

后续候选统一见 02 §2.8：cache 命中议题完成后，再检查窗口占用与压缩；精确估算、原生续接等另排，不提前创建下一轮目录。
