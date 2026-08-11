# memory improve-1 · 清理虚假 memory_* LLM 工具契约

> 状态：**已实施（第 3 批）**
> 日期：2026-08-09
> 批次：三批次中的第 3 批（MCP → Shell → Memory）
> 落点：docs/core/memory/improve-1/

## 1. 议题

当前 packages/ohbaby-agent/src/core/memory/ 同时存在两类内容：

1. 真实运行中的 memory/context 基础设施：读取全局与项目记忆，并把记忆安全地注入主会话的 system prompt。
2. 没有接入实际 ToolScheduler/builtin 注册链的 memory_* 工具元数据，以及 agent 配置、权限分类和旧文档中的工具契约。

本批清理第二类虚假 LLM 工具面，并把第一类收缩为当前真正使用的只读 MemoryLoader；不改变主会话的 memory/context 注入能力。

## 2. 范围

- 清理 memory_list / memory_add / memory_update / memory_remove 及遗留 memory_read 的虚假可调用契约。
- 对齐 builtin agent 工具清单、ToolScheduler 的具体工具名映射、permission 的具体工具名分类和当前规范文档。
- 保留 `MemoryLoader/createMemoryLoader`、memory discovery、context loading 和 prompt security scan。
- 删除无生产调用者的 CRUD/parser/events；不新增主动 memory 工具。
- 保留通用 ToolCategory 的 memory 类别及其调度逻辑，因为 goals 工具当前也使用该类别；不能把它与 memory_* 虚假工具混为一谈。
- 不新增 memory LLM 工具，不实现 memory/context 与 tools 的新协作协议。
- 不实现统一工具响应信封（status/text/error）；该议题后续另行设计。

## 3. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 已确认决策、边界和仍待调整的选择 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 代码证据、实际数据流和问题清单 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 分阶段改动面、兼容性与实现约束 |
| [03-reference-projects.md](./03-reference-projects.md) | 参考原则与不照搬项 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、集成、E2E 和发布门 |

推荐阅读：00 → 01 → 02 → 03 → 04。实施以 02 + 04 为准。

## 4. 实施契约

本目录对应第 3 个独立批次，实施顺序为 MCP → Shell → Memory；实现已按 `02` 落地，并按 `04` 的自动化门槛验证。
