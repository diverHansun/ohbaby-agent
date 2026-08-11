# 测试与验收标准

## 1. 测试范围

| 类型 | 覆盖 |
|---|---|
| 单测 | Loader API、路径发现、ghost surface、scheduler memory category |
| 集成 | global/project 文件读取合并、Context prompt 注入 |
| 回归 | subagent 隔离、其它 builtin/MCP/skill/goal 工具 |
| E2E | build 后实际服务/进程的主会话 context 与工具列表 |

## 2. 关键场景

| ID | 场景 | 验证点 |
|---|---|---|
| T-M1 | Loader 读取 global/project | 最近项目文件、来源标记和缺失语义正确 |
| T-M2 | Loader API | 实例只有 `load`，无 CRUD、事件或工具元数据 |
| T-M3 | 主会话 Context | memory 经过 security scan 后注入 `<memory>` |
| T-M4 | subagent Context | 不加载、不注入 memory |
| T-M5 | ghost surface | builtin/agent/scheduler/permission 不把 memory_* 作为现行工具 |
| T-M6 | goals category | 显式 `category: "memory"` 的 goals 工具仍可调度 |
| T-M7 | E2E | 实际构建并启动后，工具列表没有 memory_*，主会话仍能看到 memory |

## 3. 不测试的内容

CRUD、parser 和 MemoryEvent 已随无生产调用者代码一并删除；本批不新增主动 memory tool、自动记忆策略、向量检索或统一响应 envelope。

## 4. 发布门

- focused memory/context/scheduler/permission tests 全绿。
- `rg` 生产代码不再包含 `MemoryTools`、`MemoryToolDefinition`、`createMemoryManager` 或旧 memory_* mapping。
- lint、typecheck、build、integration 与既有 e2e 回归通过。
- 第 3 批 diff 不混入 MCP 或 ShellJobRegistry 功能。
