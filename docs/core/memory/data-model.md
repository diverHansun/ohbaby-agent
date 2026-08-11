# memory 模块 data-model.md

## 一、长期记忆模型

Memory 的持久事实是两个 Markdown 文件：

| scope | 位置 | 作用 |
|---|---|---|
| global | Ohbaby home 下的 `OHBABY.md` | 跨项目偏好、规则与稳定事实 |
| project | 项目根或祖先目录的 `OHBABY.md` | 当前项目约定与上下文 |

## 二、运行时类型

```typescript
export interface MergedMemory {
  readonly global: string;
  readonly project: string;
  readonly merged: string;
}

export interface MemoryLoader {
  load(directory: string): Promise<MergedMemory>;
}

export interface ProjectInfo {
  readonly id: string;
  readonly rootPath: string;
}

export interface ProjectResolver {
  fromDirectory(directory: string): Promise<ProjectInfo> | ProjectInfo;
}

export interface MemoryLoaderOptions {
  readonly projectResolver: ProjectResolver;
  readonly globalMemoryPath?: string;
  readonly onWarning?: (message: string, error?: unknown) => void;
}
```

## 三、合并结果

`global` 与 `project` 保留文件原文；`merged` 对非空内容添加来源 HTML comment，并使用 `---` 分隔。缺失文件对应字段为空字符串。

## 四、与 LLM 工具面的关系

MemoryLoader 是 Context 的内部依赖，不是 `Tool`，没有 `parametersJsonSchema`、`execute` 或工具权限。当前不导出或注册 `memory_list`、`memory_read`、`memory_add`、`memory_update`、`memory_remove`。

`ToolCategory: "memory"` 仍是 ToolScheduler 的通用类别，由 goals 工具显式声明；它不是 MemoryLoader 的工具注册证明。

## 五、生命周期

```text
OHBABY.md 文件
  └─ MemoryLoader.load(directory)
       └─ ContextManager 的本次组装
            └─ security scan
                 └─ <memory> system prompt 片段
```

MemoryLoader 无缓存、无事件、无写入 API。未来如需主动记忆管理，应新增明确的 adapter，而不是恢复已删除的静态工具元数据。
