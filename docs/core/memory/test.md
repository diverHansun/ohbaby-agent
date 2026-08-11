# memory 模块 test.md

## 一、测试范围

| 类型 | 验证内容 |
|---|---|
| 单测 | MemoryLoader 类型边界、路径发现与缺失文件语义 |
| 集成 | global/project `OHBABY.md` 读取、向上查找和合并 |
| Context 集成 | 主会话加载、prompt security scan、`<memory>` 注入 |
| 隔离回归 | subagent 不加载 memory |
| 契约回归 | builtin、agent config、scheduler、permission 不包含 ghost memory_* |

## 二、关键场景

### T-M1：global/project 合并

在临时目录创建 global 文件、项目根文件和子目录文件，调用：

```typescript
const memory = await createMemoryLoader({
  globalMemoryPath,
  projectResolver,
}).load(projectSubdirectory);
```

验证最近的项目文件被选择，`global`、`project`、`merged` 都符合来源标记约定。

### T-M2：缺失与路径

验证 global 或 project 文件不存在时返回空字符串；项目路径从当前目录向项目根查找，不越过项目根。

### T-M3：Context 注入

通过 ContextManager 组装主会话，验证 memory 经过 security scan 后进入 `<memory>`；恶意 prompt 内容仍按 serializer 现有策略处理。

### T-M4：subagent 隔离

验证 subagent 的 context 组装不加载、不注入 MemoryLoader 内容。

### T-M5：ghost contract 清理

验证 `createBuiltinTools()`、四个 builtin agent 的 include、ToolScheduler 注册表和 permission classifier 都不把 `memory_list`、`memory_read`、`memory_add`、`memory_update`、`memory_remove` 当作可调用 Memory 工具。

### T-M6：通用 memory category 回归

验证 goals 工具显式声明的 `category: "memory"` 仍保留原有 scheduler wave/concurrency 行为；不要用 ghost 名称测试该类别。

## 三、不测试的内容

- Memory CRUD、parser 和 MemoryEvent：它们已因无生产调用者从本批代码中删除。
- 主动记忆工具、自动记忆策略、embedding、向量检索。
- 统一工具响应 envelope；该议题另行推进。

## 四、发布门

- MemoryLoader focused unit/integration 全绿。
- Context/serializer 与 subagent 隔离回归全绿。
- `rg` 生产代码没有旧 memory_* 工具契约、MemoryTools 或 MemoryToolDefinition。
- 全量 lint、typecheck、build 与既有 e2e 回归通过。
