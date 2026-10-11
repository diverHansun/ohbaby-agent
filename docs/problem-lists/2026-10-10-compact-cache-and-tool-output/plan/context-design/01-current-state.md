# Context 现状与改造原因

> 基线：`24c70034`，2026-10-11。系统级证据见[议题 01](../01-problem-analysis-and-current-state.md)。尚未实施。

## 职责与现状

Context 从持久化历史、系统材料、工具定义、原生状态和待交付输入准备模型请求，计量并决定是否维护上下文。普通请求已有 prepared messages／tools，但最终 reasoning、输出和 cache 配置还在 streaming 解析，摘要客户端又单独构造短 system 请求。

目前 runCompactionCore 先 prune，再决定是否摘要；mask 另有投影替换。活动视图可同时保留多份旧摘要，而下一摘要输入排除它们。超窗恢复会缩小输入，却可能仍按原候选集合退场。

核心证据：`packages/ohbaby-agent/src/core/context/context-manager.ts`的 assembleModelRequest、getActiveHistory、generateSummaryCandidate、runCompactionCore；`types.ts`的 PreparedModelRequest；`compaction-policy.ts`的 estimateHistoryForCompaction 与 findCutPoint。

## 已有结构可以复用

- TokenCounter、最终消息投影与原生依赖校验，负责实际回传内容的计数和关联。
- ToolPart 存储和 serializer 纯投影，负责工具调用、结果、状态与引用；无需第二份预览生命周期。
- commitCompaction 的 parts 比较与 SQLite 事务，负责全部提交或全部不应用。
- 调度器的输入投递与已有会话停止信号，负责新输入和中断；无需新的维护队列。

## 与现有模块说明的关系

`docs/core/context/goals-duty.md`、`dfd-interface.md`和`test.md`仍描述基线的 95%、prune／mask。新方案会改变这些行为，应随相关批次实施更新，当前不能把代码现状改写为已完成目标。

模块职责仍是请求准备、计量和上下文切换，不接管工具执行策略、Bash 日志系统、用户授权决策或旧信息召回。主要改造是减少重复预算、重复摘要入口和历史改写，目标见[02](./02-change-spec.md)。
