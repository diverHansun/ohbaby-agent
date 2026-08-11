# memory 模块 goals-duty.md

## 一、模块定位

`memory` 是三层记忆系统中的长期记忆层，负责从全局与项目 `OHBABY.md` 读取稳定信息，为主会话的 Context 组装提供来源内容。

它与 Context 的区别是：Memory 负责“长期事实存在哪里、如何读取与合并”；Context 负责“本次 turn 需要哪些信息、如何压缩并交给模型”。Memory 不是 LLM tool surface。

## 二、Design Goals

### G1：两级文件记忆

- global：用户跨项目偏好与规则。
- project：项目根目录或其祖先路径中的项目约定。
- 合并结果携带来源标记，便于 system prompt 追溯。

### G2：只读、简单、可解释

MemoryLoader 每次从文件系统读取，不维护缓存、不引入数据库、不解析语义。用户直接编辑 Markdown 即可改变下一次 context 加载结果。

### G3：与 Context 清晰分层

ContextManager 只在主会话使用 loader 的结果；serializer 负责 prompt security scan 与 `<memory>` 注入；subagent 不加载 memory。

## 三、Duties

### D1：加载全局记忆

通过 `getGlobalMemoryPath()` 定位 `OHBABY.md`，并保留既有旧路径兼容读取。

### D2：加载项目记忆

通过 ProjectResolver 得到项目根，从当前目录向上找到最近的 `OHBABY.md`。

### D3：合并并返回

`load(directory)` 返回 `{ global, project, merged }`。文件不存在时对应内容为空；Memory 不向 Bus 发布事件。

### D4：提供稳定的 Loader 工厂

公开 `createMemoryLoader()` 与 `MemoryLoader` 类型；不公开任何 memory_* 工具定义、CRUD/parser 类型或工具权限映射。

## 四、Non-Duties

- 不决定何时加载或如何压缩 context。
- 不向模型暴露 `memory_list`、`memory_read`、`memory_add`、`memory_update`、`memory_remove`。
- 不提供写入、更新、删除、事件发布、向量检索或自动记忆策略。
- 不维护 `ToolCategory: "memory"` 的具体调度规则；该通用类别由 ToolScheduler 与 goals 工具负责。

## 五、与其他模块的关系

| 模块 | 关系 | 说明 |
|---|---|---|
| ContextManager | 被依赖 | 主会话调用 `MemoryLoader.load()` |
| serializer / prompt security | 下游 | 扫描后注入 `<memory>` |
| ProjectResolver | 依赖 | 提供项目根路径 |
| ToolScheduler | 不提供工具 | 不注册 MemoryLoader，不接收 memory_* |
| Bus | 不再依赖 | CRUD/events 已清理 |

## 六、三层记忆位置

```text
短期/工作记忆：当前 turn 的输入、工具结果、未持久化工作状态
       ↓ ContextManager 组装与压缩
长期记忆：MemoryLoader 读取的 global/project OHBABY.md  ← 本模块
       ↓ 主会话按需注入
外部/知识记忆：MCP、项目文件、搜索与其它外部来源
```

这里的“长期”表示生命周期跨越会话，不表示本批支持模型主动写入。
