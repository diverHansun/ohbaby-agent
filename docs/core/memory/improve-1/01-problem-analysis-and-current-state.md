# 现状与问题分析

## 1. 现状结论

Memory 的真实生产链是可用的，问题集中在错误的工具契约和过度保留的无调用代码：

```text
composition
  └─ createMemoryLoader()
       └─ ContextManager.memory
            └─ 主会话 load → serializer security scan → <memory>

ToolScheduler / builtin
  └─ 不注册 memory_* executable Tool

旧 metadata / agent config / docs
  └─ 仍声称 memory_* 可用  ← ghost contract
```

## 2. 代码证据

| 能力 | 代码 | 当前状态 |
|---|---|---|
| 只读加载 | `src/core/memory/memory-loader.ts` | global/project 读取与合并 |
| 文件发现 | `src/core/memory/memory-discovery.ts` | global path、项目向上查找 |
| Context 注入 | `src/core/context/context-manager.ts`、`serializer.ts` | 主会话读取并安全注入 |
| 静态工具元数据 | `memory-tools.ts` | 已删除；没有 execute，也从未注册 |
| CRUD/parser/events | 原 memory manager/parser/events | 已删除；无生产调用者 |
| agent include | builtin agent configs | 已删除 `memory_list` |
| scheduler mapping | `BUILTIN_TOOL_CATEGORIES` | 已删除具体 memory_* 映射 |
| permission mapping | classifier | 已删除 memory_* 专用集合与分支 |

## 3. 保留与清理边界

保留 `MemoryLoader`、`MergedMemory`、ProjectResolver、discovery、Context 的主会话加载和 prompt security。清理 CRUD/parser/events 不会改变当前 production memory 数据流，因为它们没有生产调用者。

`ToolCategory: "memory"` 不是 Memory 模块的工具证明；它是 scheduler 的通用类别，目前由 goals 工具显式声明，必须保留。

## 4. 期望状态

```text
模型可见/可调用工具集合：没有 memory_*
Context assembly：主会话 MemoryLoader → security scan → <memory>
Memory Core：MemoryLoader.load(directory)（只读）
Scheduler generic category：memory 继续服务 goals 等真实工具
```
