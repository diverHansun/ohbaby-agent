# memory 模块 dfd-interface.md

本文档只描述当前生产数据流。MemoryLoader 是只读的长期记忆来源，不是模型工具。

## 一、主数据流

```text
createUiRuntimeComposition
  └─ createContextManager({ memory: createMemoryLoader() })
       └─ ContextManager.assemble / prepareTurn（仅主会话）
            └─ MemoryLoader.load(directory)
                 ├─ global path → read global OHBABY.md
                 ├─ ProjectResolver → project root
                 ├─ findProjectMemoryPath → 最近的 project OHBABY.md
                 └─ { global, project, merged }
                      └─ serializer security scan
                           └─ <memory> 注入 system prompt
```

## 二、Loader 接口

```typescript
interface MemoryLoader {
  load(directory: string): Promise<{
    global: string;
    project: string;
    merged: string;
  }>;
}

function createMemoryLoader(options?: Partial<MemoryLoaderOptions>): MemoryLoader;
```

`MemoryLoaderOptions` 只包含项目解析器、可选 global path 与 warning callback。读取不到文件返回空字符串；项目文件从当前 directory 向项目 root 向上查找。

## 三、边界

| 调用方/组件 | 行为 |
|---|---|
| ContextManager | 主会话加载并把结果交给 serializer |
| serializer | 对 `merged` 做 security scan，再生成 `<memory>` prompt 片段 |
| subagent | 保持不加载 memory |
| ToolScheduler | 不注册 MemoryLoader，也不存在 memory_* executable Tool |
| Bus | 不接收 memory CRUD/refresh 事件；本批已删除无生产调用者的 events |

## 四、当前不存在的接口

以下名称不是当前可调用工具，也不应出现在 agent include 或权限映射中：

`memory_list`、`memory_read`、`memory_add`、`memory_update`、`memory_remove`。

本批不新增替代工具、不设计主动写入权限，也不引入统一工具响应信封。若未来需要主动记忆管理，应另行设计 LLM adapter、确认流程和数据协议。

## 五、验证要点

- global/project 文件能被读取并按来源合并。
- 缺失文件不阻断 context 组装。
- `<memory>` 注入前仍经过 prompt security scan。
- 主会话有 memory，subagent 没有 memory。
- builtin、agent config、scheduler、permission 和文档均不声称 memory_* 可调用。
