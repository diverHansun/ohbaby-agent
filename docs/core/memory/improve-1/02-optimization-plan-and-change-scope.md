# 优化方案与改动面

> 第 3 批执行契约：MemoryLoader 只读化 + ghost memory_* 契约清理。

## 1. 方案总览

```text
保留：MemoryLoader / discovery / MergedMemory
      ContextManager 主会话 load
      serializer security scan + <memory>
      ToolCategory("memory")（goals 使用）

删除：MemoryTools / MemoryToolDefinition
      MemoryManager 的 CRUD
      memory-parser.ts / events.ts 及无生产调用者测试
      agent include、scheduler mapping、permission 专用分类中的 memory_*
```

## 2. 实施步骤

### Phase 1：只读核心

- 将 `MemoryManager/createMemoryManager` 改名为 `MemoryLoader/createMemoryLoader`。
- Loader 只保留 `load(directory)`，不依赖 Bus，不写文件，不发布事件。
- 保留 global/project 发现、兼容读取、内容合并和 warning 语义。

### Phase 2：清除 ghost contract

- 删除 `memory-tools.ts`、`MemoryTools`、`MemoryToolDefinition`。
- 删除 `memory-parser.ts`、`events.ts` 和只覆盖 CRUD/events 的测试。
- 删除四个 builtin agent 的 `memory_list`。
- 删除 scheduler 中 `memory_list/add/update/remove` 的具体映射；保留通用 memory 类别。
- 删除 permission classifier 中 `memory_read` 与 `memory_*` 专用映射。

### Phase 3：文档与回归

- active memory、agent、scheduler、tools、bus 文档改为只读 Loader 事实。
- 历史设计文档保留，但不作为当前运行契约。
- 增加 Loader、主会话注入、subagent 隔离和 ghost surface 回归测试。

## 3. 改动范围

| 区域 | 修改 |
|---|---|
| `core/memory` | manager → loader；删除 CRUD/parser/events/tools |
| `composition` | 注入 `createMemoryLoader()` |
| `context` | 保持 load/security/injection 行为，仅类型名更新 |
| `agents/builtin` | 删除 ghost include |
| `tool-scheduler` | 删除具体 ghost mapping，保留 memory category |
| `permission` | 删除具体 ghost classification |
| `bus` | 删除无生产调用者的 MemoryEvent catalog |
| docs | 同步当前只读边界与 Memory/Context 分工 |

## 4. 非目标

- 不新增 memory LLM tool，不恢复任何旧别名。
- 不新增自动记忆、embedding、向量检索、缓存或截断策略。
- 不删除 scheduler 的通用 `memory` category，不影响 goals。
- 不实现统一工具响应信封。

## 5. 风险与回滚

主要风险是误删 Context 的读取链或误伤 goals 的通用类别。发布门是 Loader integration、Context/serializer、subagent 隔离、goals scheduler 回归、lint/typecheck/build 与全量测试。
