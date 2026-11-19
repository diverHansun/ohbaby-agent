# Lifecycle 架构

当前实现由 `lifecycle.ts` 的 `Lifecycle.run` 管理多步循环，私有 `runModelStep` 消费一次模型请求。旧文档中的独立 TurnProcessor/processor.ts 已不存在；本文件按当前源码描述。

## 职责与依赖

| 组件                      | 职责                                               |
| ------------------------- | -------------------------------------------------- |
| RunWorker / RunManager    | 运行调度、取消、持久运行状态与事件分发             |
| Lifecycle                 | 每步准备、接受模型结果、保存、工具执行和下一步判断 |
| ContextManager            | 冻结并计量实际请求；沿用压缩与 overflow 恢复政策   |
| LLMClient / adapter / SDK | 协议转换、流累积、完成校验与临时故障重试决策       |
| MessageManager            | 原始消息和 Parts 持久化；原生模型步骤原子提交      |
| ToolScheduler             | 权限、调度与工具结果；普通业务错误回传模型         |

```mermaid
flowchart TD
  W[RunWorker] --> L[Lifecycle.run]
  L --> C[Context prepareTurn]
  C --> M[runModelStep / streamResponse]
  M --> A[耗尽与校验后接受]
  M -->|stepRetry| B[保存失败消息并等待]
  B -->|未取消，重跑当前步| C
  A --> E[llm:complete / 可信用量]
  E --> S[保存结果与完整调用]
  S --> T[ToolScheduler]
  T --> R[保存工具结果]
  R --> C
  S --> F[无后续工具则结束]
```

## 三个不同边界

1. **模型请求完成**：可靠 provider 终态、流耗尽、解析校验成功，只发布一次事件。
2. **结果保存成功**：原生步骤沿用 commitModelStep 原子事务；普通步骤保持既有保存路径。必要保存失败时工具零执行，运行失败，已接受 usage 保留。
3. **运行结束**：由 LifecycleResult 和取消信号决定 succeeded/failed/cancelled，不能以收到 llm:complete 推断成功。

length/filter 有可靠请求终态，但运行失败，不执行该输出中的工具、不自动续写。工具找不到文件等业务错误属于结果，模型可以接收后继续；协议解析、调度或存储错误不是普通工具业务失败。

## 状态与恢复约束

- 请求准备、校准和用量都配对同一步的 PreparedTurn。
- 接受前取消不形成可信 Step；接受后取消不抹掉已完成步骤和工具事实。
- 上下文超长时，当前步骤最多执行一次强制压缩恢复。重发继续使用已消耗的临时故障预算。
- 切模型通过现有 connectModelInternal，禁止运行中切换，重建 runtime；不改变 session cache 累计账本。
- LLM 层抛出带 `stepRetry` 的中断错误后，Lifecycle 先标记被取代的助手消息，用运行信号控制退避等待，再重新准入输入和准备当前步骤。主会话、子代理和 Side Chat 共用此路径。已完成的工具结果仍进入上下文，失败请求涉及的待处理输入等成功后才确认。整步重来从头请求当前步骤，工具仍在接受完整响应后执行。工具结果和历史沿用现有持久化路径。

## 文件与验证

`lifecycle.ts` 为循环和步骤实现；`types.ts` 定义事件/结果；`token-usage.ts` 管理完整/部分汇总。对外入口通过 `index.ts` 导出。测试覆盖完成竞态、过滤/截断、接受前后取消、持久化失败和工具继续；跨协议与实网限制见 improve-7/05。

## 失败回复的后续历史

Lifecycle 在原助手消息上保存结构化错误，分别记录输出截断、内容过滤、流中断和本地取消。带 `retried: true` 的中断消息保留用于查看，Context 准备模型请求和摘要时排除它。无正文的可投影失败与取消使用同一消息上的单个 synthetic 事实 Part。工具阶段取消只追加事实，并保留已接受的工具调用和结果。

Context 只从已保存 active 可见正文或事实 Part 派生下次请求与摘要；不新建成功消息，也不自动继续生成。已接受模型步骤后的事实存储失败，Lifecycle 返回 `model_state_persistence_failure` 并保留可信用量，不伪报取消事实已保存。
