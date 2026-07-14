# Loop 模块设计文档

> **权威范围**：`/loop` 产品能力（会话级周期任务）的模块设计以本目录为准。  
> **闹钟实现细节**：`docs/runtime/scheduler/` 只描述「何时到期」的调度基础设施；与本目录冲突时以本目录为准。

## 文档索引（按阅读顺序）

| 文档 | 作用 |
|------|------|
| [goals-duty.md](./goals-duty.md) | 为什么存在、做什么、刻意不做什么 |
| [architecture.md](./architecture.md) | 内部结构与关键取舍 |
| [data-model.md](./data-model.md) | 核心概念与持久化字段语义 |
| [dfd-interface.md](./dfd-interface.md) | 数据流与对外接口 |
| [use-case.md](./use-case.md) | 关键业务动作编排 |
| [non-functional.md](./non-functional.md) | 可靠性、安全、成本等工程约束 |
| [test.md](./test.md) | 如何验证设计成立 |

## 一句话定位

Loop 让 Web/App（依赖全局 `ohbaby serve`）能为某个主会话登记周期 prompt；到点后把带信封的触发投递进该主会话执行通道，由主 Agent 在空闲时串行执行——对齐 kimi-code / Claude Code 的「注入主会话」交付模型，调度 owner 则放在全局 serve。

## 与 runtime/scheduler 的关系

```text
docs/loop/          产品语义：创建/暂停/投递门控/过期/工具/REST/UI 投影
docs/runtime/scheduler/   基础设施：最小堆 + setTimeout、nextFireTime、持久化 job 行
```

Scheduler 只报「这个 job 到时间了」；是否可投递、如何合并、是否写入主会话，由 Loop 投递门控与现有 `WorkspacePromptScheduler` 完成。
