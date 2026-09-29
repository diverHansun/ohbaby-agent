# 现状与问题分析

## 基线

2026-09-29，ohbaby-agent HEAD：`3dc4b72f5a82958d10d64e5898118cb8f76d2bed`。调查时工作区无产品代码改动。本轮为规划，不把下述目标描述成已实现行为。

## 问题

| 编号 | 当前问题 | 方案入口 |
| --- | --- | --- |
| P1 | reasoning 使用原生 details marker，无法形成用户需要的大小两档线条箭头 | 02 的箭头与交互 |
| P2 | 过程与最终正文持续平铺，缺少正常完成后的整轮折叠 | 02 的资格判断与内容划分 |
| P3 | 耗时附在最后一条关联 assistant 消息之后，不在最终正文之前 | 02 的耗时位置 |
| P4 | 流式消息、steer、局部折叠、分页和阅读锚点共存，简单包住一段消息容易误收或打乱顺序 | 02 的身份、状态与阅读行为 |

## Web 现状：七个视角

### 职责

Web 读取 SDK DTO，负责消息呈现和局部交互。整轮折叠属于展示职责，后端无须知道某条消息当前是否被隐藏。

### 结构

[ConversationStream](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.tsx) 负责消息过滤、时间线排序、耗时挂载和滚动；[MessageRow](../../../../apps/ohbaby-web/src/ui/conversation/MessageRow.tsx) 负责正文、reasoning、工具配对与定制派遣入口；[ExecutionProgress](../../../../apps/ohbaby-web/src/ui/conversation/ExecutionProgress.tsx) 显示模型等待与 prompt 总耗时。当前没有整轮过程折叠层。

### 数据模型

[UiMessage / UiRun](../../../../packages/ohbaby-sdk/src/snapshot.ts) 中，消息的 `runId` 可选，message 可携带 `status`、`completedAt`、`finishReason`，没有供本功能直接使用的统一正文 phase。`UiRunStatus` 是 idle/running/waiting-for-permission/error，不能把 idle 当成成功完成。

[UiPromptSubmission](../../../../packages/ohbaby-sdk/src/prompt.ts) 已有 succeeded/failed/cancelled/interrupted 等完成结果、时间戳，以及 `steerReceipt.acceptedTargetRunId`。`steered` 是 prompt 转为当前 run 输入后的提交状态，并不表示整个 run 完成。

[steerQueued](../../../../packages/ohbaby-agent/src/runtime/prompt-scheduler/current-run-inputs.ts) 明确把输入送入 `expectedRunId`，记录来源 `user-steer` 和 receipt；不会因此执行新的 run。前端可读取现有标记，不必按相邻 user 消息猜测。

### 数据流

现有消息、prompt 和 reasoning 投影进入 ConversationStream；过滤内部 `subagent-status` / `subagent-result` 与 Todo 工具噪声后，产生时间线，再渲染 MessageRow。子会话可要求保留原消息顺序。

耗时逻辑读取当前 session 的终态 prompt，按明确 `runId` 找最后一条 assistant 消息，找不到则尝试 prompt 的 userMessageId，最后保留 unattached 显示。这个位置选择只是计时挂载，不足以证明某条 assistant 消息就是最终正文。

### 用例

两种 reasoning 都已有结束后折叠行为：实时 reasoning 投影读取 `folded`，reasoning part 读取 `endReason`。同一条最终 assistant 消息可能同时含 reasoning 和 text，因此“整条消息留在折叠区外”会漏掉最终步骤的思考过程。

工具调用和结果由 MessageRow 配对。子代理入口也从工具呈现路径进入消息行。折叠必须复用这些路径，不能重新拼接一套工具输出。

### 非功能要求

ConversationStream 已维护 sticky-bottom、历史加载高度补偿、`data-message-id` 阅读锚点和显式委派定位。批量隐藏节点会改变高度，必须处理被隐藏的阅读锚点，避免突然跳到顶部或把用户拉回底部。

[messages.css](../../../../apps/ohbaby-web/src/ui/conversation/messages.css) 的工具按钮使用 `gap: 10px`，工具箭头为 14px；摘要 `flex: 1` 会把后续内容推向右侧。因此本需求只参考间距与线条质感，不能直接复制工具整行布局。

### 测试

[ConversationStream.unit.test.tsx](../../../../apps/ohbaby-web/src/ui/conversation/ConversationStream.unit.test.tsx) 已覆盖根/子会话过滤内部输入以及保留普通消息；[ExecutionProgress.unit.test.tsx](../../../../apps/ohbaby-web/src/ui/conversation/ExecutionProgress.unit.test.tsx) 已检查重新接受后的计时起点及恢复时间不冒充真实耗时。

现有测试不能证明正常完成后整轮折叠、最终正文保留、steer 豁免、手动展开保持或折叠后的阅读位置。视觉间距和 hover 布局也不能仅靠 jsdom 判断。测试组织遵循 [docs-test](../../../../docs-test/README.md)，本轮补充范围见 04。

## 与现有文档的关系

| 文档 | 现有描述与代码 | 本轮关系 |
| --- | --- | --- |
| [Web 组件规格](../../../ohbaby-web/ui/components.md) | 消息事实只读；工具局部披露；运行中有 Thinking 指示器 | 补充整轮折叠和 reasoning 箭头；不改变无内容时的三点等待指示器 |
| [Web 测试设计](../../../ohbaby-web/test.md) | 已规定消息顺序、工具配对、子会话锚点等 | 增补外层折叠的验证；沿用已有工具卡默认策略 |
| [早期 reasoning 方案](../../2026-06-24-reasoning-display/02-design-and-implementation.md) | 历史方案称 reasoning 仅走实时通道；当前 MessageRow 同时支持实时投影和 reasoning part | 只作为历史背景，不据此删除当前 part 渲染或改持久化 |
| [Web chrome 优化](../../2026-09-18-web-chrome-polish/improve-1/02-optimization-plan-and-change-scope.md) | 工具箭头 14px、不被挤压 | 工具行保持；新增两档箭头只作用于 thinking 与整轮耗时 |

## SWE 原则与影响面

现有终态和身份字段已经足够表达主要条件。再增加后端“无答案”“归属未知”状态会让一次 UI 改动影响协议、存储和模型适配，没有相应收益。

合理的复杂度集中在三个地方：选择需要保留的正文、只隐藏已关联的过程内容、保护阅读位置。采用前端派生数据和少量局部展开状态即可，不建立通用时间线框架或多段 steer 分组系统。

主要影响在 `apps/ohbaby-web/src/ui/conversation/` 和耗时 CSS；SDK/runtime 仅作为事实来源，保持不变。实施时同步 Web 组件规格和测试设计，不另建模块级改造文档。
