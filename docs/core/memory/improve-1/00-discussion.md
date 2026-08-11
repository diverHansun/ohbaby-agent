# 讨论记录与已确认要点

> 第 3 批定稿：清除虚假 memory_* 契约，并将 memory 收缩为真正工作的只读 Memory Core。

## 1. 背景

composition 曾创建一个内部 MemoryManager，但 `memory-tools.ts` 只是没有 `execute` 的静态元数据，且从未注册进 ToolScheduler。agent include、scheduler 映射、permission 分类和旧文档因此制造了虚假的 LLM 工具契约。

## 2. 已确认方案

| 决策项 | 结论 |
|---|---|
| 批次 | Memory 单列第 3 批，独立测试、独立 commit；顺序 MCP → Shell → Memory |
| 运行时名称 | `MemoryLoader` / `createMemoryLoader` |
| 保留 | global/project `OHBABY.md` 读取、发现、合并、Context 主会话注入与 security scan |
| 清理 | `memory-tools.ts`、MemoryTools、MemoryToolDefinition、CRUD/parser/events、旧 agent include 与具体权限映射 |
| 主会话 | 继续加载 memory 并注入 `<memory>` |
| Subagent | 继续不加载 memory |
| 通用类别 | 保留 `ToolCategory: "memory"`，因 goals 工具显式使用；不再与 memory_* 名称绑定 |
| 主动工具 | 本批不新增；未来另行设计 adapter、权限与契约 |
| 统一响应信封 | 不并入 |

## 3. Memory 与 Context

Memory 是三层记忆系统中的长期记忆层，负责持久化文件的读取；Context 是当前 turn 的信息组装、压缩与投影层。Memory 作为 Context 的输入来源，不等于 Context，也不等于 LLM tool surface。

```text
OHBABY.md → MemoryLoader.load → ContextManager → security scan → <memory>
```

## 4. 明确不存在的工具

`memory_list`、`memory_read`、`memory_add`、`memory_update`、`memory_remove` 均不是当前可调用工具，也不应出现在 agent include、scheduler builtin mapping 或 permission 专用分类中。

## 5. 历史文档

active normative docs 按当前实现同步；历史 problem-list/设计记录不强行改写，但不得作为当前运行契约引用。
