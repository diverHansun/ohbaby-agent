# 0. 讨论记录与边界

> 2026-09-27。来源：本次用户与 Codex 的讨论及用户提供的模块表截图。技术细节是下述文档中的待审方案，不冒充逐条获得用户确认。

## 0.1 用户原话

> 这部分我打算叫做improve-2.1，同意你如图的拆分模块，建议使用plan-code- improvement撰写文档放在：docs/problem-lists/2026-09-19-execution-reliability/improve-2.1 ; docs/ohbaby-web/improve-3 下，文档各司其职，improve-2.1说明2.1阶段主要做什么：new session问题处理+前端拆分+重构+接线 ;docs/ohbaby-web/improve-3 说明ohbaby-web怎么拆分，拆分后的各自的职责，关键改动文件等等。文档相互之间可以使用双向链接来进行引用。

> 我认为拆分模块后前端也不要过度设计，多出来很多独立的代码文件，只在有必要时进行拆分，拆分可复用的模块。遵循swe原则。

> 确认没问题后可以先calling-pi：opencode/opus-5-5，简要说明你的方案，让pi审核一下，opus-5-5模型非常擅长这样的前端优化，然后开始撰写文档，完成后使用子代理审查。先不急开发。

## 0.2 已确认范围

| 事项 | 约束 |
| --- | --- |
| 阶段与路径 | 中央 improve-2.1；Web 模块 improve-3；双向引用且职责不同 |
| 功能模块 | 保留 App 根装配；workspace、session、conversation、composer、commands、permissions、shared、styles 按已确认表组织 |
| 工作内容 | New session 回归处理、前端模块拆分、重构和实际接线；不能只新增未使用的组件 |
| 粒度 | 按内聚职责、真实复用或必要测试边界拆分；不设每文件行数上限、不要求一函数一文件 |
| 关键清单 | Web 模块文档明确关键修改文件及职责、接口变化 |
| 过程 | 先调查和 Pi 方案审核，再写文档，再子代理审查；本次不开发 |

## 0.3 本方案保持的边界

保持现有视觉、交互、React/Vite、SDK 合同及单一事实源。结构调整不引入新状态库、通用 UI 框架或工具渲染插件系统。默认 TUI 保持 in-process；本轮不调整 TUI 文件组织。New session 的必要跨层修复可以涉及 server/SDK/agent，但不借机重写传输、同步或执行调度。

子会话只读页面、Steer、完整子树等仍属于[中央 improve-3](../improve-3/README.md)。本轮只解除 conversation 对输入/根会话操作的绑定，不提前实现这些功能。历史空会话不自动删除、隐藏或归档。

## 0.4 审查输入

采用 SWE 的高内聚、状态单一归属、信息隐藏、可逆改动和 YAGNI。参考项目与不采纳项见 [03](03-reference-projects.md)。Pi 使用本机准确 ID `opencode/claude-opus-5-5` 完成只读方案审查；其完整回复留在会话，本目录只记录核实后的设计决定，不复制原文。Pi 不替代实现后的测试和验收。

返回：[阶段索引](README.md)；对应 [Web 模块规格](../../../ohbaby-web/improve-3/02-change-spec.md)。
