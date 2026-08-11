# memory 模块 architecture.md

本文档描述当前运行中的 MemoryLoader。Memory 是三层记忆系统中的长期记忆层：它保存跨会话、跨 turn 仍有价值的稳定信息，并在主会话组装 context 时按需加载。

## 一、职责边界

Memory 的运行链只有读取：

```text
MemoryLoader.load(directory)
  ├─ resolve global OHBABY.md（含旧路径兼容读取）
  ├─ 从当前目录向项目根查找最近的 OHBABY.md
  ├─ 读取 global/project 原始 Markdown
  └─ 添加来源标记并返回 MergedMemory
       └─ ContextManager（主会话）
            └─ security scan → <memory> system prompt 注入
```

Memory 不负责决定何时加载、context 如何压缩，也不提供模型可主动调用的工具。

## 二、文件结构

```text
src/core/memory/
├── index.ts              # MemoryLoader 与类型导出
├── types.ts              # MergedMemory、Loader、ProjectResolver 类型
├── constants.ts           # OHBABY.md 常量
├── memory-loader.ts       # 只读加载与 global/project 合并
└── memory-discovery.ts    # 全局路径、项目向上查找
```

`memory-tools.ts`、CRUD/parser/events 已移除：它们没有生产调用者，曾经只是未接入 ToolScheduler 的幽灵契约或为其服务的写入链。

## 三、核心类型与 API

```typescript
interface MergedMemory {
  readonly global: string;
  readonly project: string;
  readonly merged: string;
}

interface MemoryLoader {
  load(directory: string): Promise<MergedMemory>;
}

function createMemoryLoader(
  options?: Partial<MemoryLoaderOptions>,
): MemoryLoader;
```

加载缺失文件返回空字符串；非缺失读取错误通过 `onWarning` 报告后按现有安全语义返回空内容。Loader 无缓存，每次 load 都重新读取文件。

## 四、与 Context 的关系

Memory 是长期记忆的来源，Context 是当前请求可用信息的组装与容量管理层：

| 层 | 负责什么 | 是否持久化 |
|---|---|---|
| Memory | 读取 global/project `OHBABY.md`，合并长期事实 | 文件持久化 |
| Context | 把历史、工具结果、system prompt、memory 组装成当前 turn 输入，并压缩/裁剪 | session/message 事实由其它模块管理 |
| LLM tool surface | 模型本轮可调用的 executable tools | 不等于 Memory |

主会话使用 `ContextManager` 注入 Memory；subagent 保持隔离，不自动加载 Memory。当前没有 `memory_list`、`memory_read`、`memory_add`、`memory_update` 或 `memory_remove` LLM 工具。

## 五、非职责

- 不提供主动记忆 CRUD、事件总线或独立 memory daemon。
- 不实现向量检索、embedding、自动记忆策略或截断策略。
- 不定义统一工具响应信封；该议题另行推进。
- 不删除 `ToolCategory: "memory"`：这是调度器的通用类别，当前由 goals 工具显式使用，与 MemoryLoader 无关。
