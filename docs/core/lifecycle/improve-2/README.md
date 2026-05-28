# lifecycle improve-2 文档集

本目录是 `core/lifecycle/` 模块第二轮优化的文档集。当前时间点（2026-05-28）agents improve-2 已完成：primary 与 task/subagent 都通过 `AgentService -> core/agents.runAgent -> RunManager` 进入执行路径；RunWorker 在 agent 路径上也会使用 `Lifecycle.runSession`。

因此 lifecycle improve-2 不再规划"primary 切到 runAgent"。本轮真正要解决的是：**session-run 的长 tool 链韧性、溢出恢复，以及 `run()` / `runSession()` 双循环债务**。

> 状态：规划文档。本文档只描述待实施范围，不代表代码已经完成。

---

## 文档构成

| 文档 | 职责 | 回答的问题 |
|------|------|----------|
| [problem-analysis.md](./problem-analysis.md) | 问题分析 | 当前 lifecycle 代码中哪些问题仍然真实存在？哪些旧规划已经被 agents improve-2 覆盖？ |
| [implementation-plan.md](./implementation-plan.md) | 实施计划 | 如何分批实现 per-step prepare/compact、overflow recovery、动态 budget 与 legacy run 收敛？ |
| [acceptance.md](./acceptance.md) | 成果验收 | 完成后用哪些测试和 grep 规则证明没有糊弄？ |

---

## 当前代码状态

| 路径 | 现状 | improve-2 判断 |
|------|------|---------------|
| `AgentService.startSession` | 已调用 `runAgent({ waitMode: "stream" })` | agents improve-2 已完成，不在 lifecycle improve-2 重复规划 |
| `AgentService.executeTask` / `AgentTaskManager` | 已调用 `runAgent({ waitMode: "waitForCompletion" })` | agents improve-2 已完成 |
| `RunWorker.createLifecycleLoop` | 有 `messages` 走 legacy `lifecycle.run()`；无 `messages` 走 `lifecycle.runSession()` | agent 路径已走 `runSession`；legacy message path 仍保留 |
| `Lifecycle.runSession` | turn 开始时调用一次 `contextManager.prepareTurn()`；tool step 后只追加内存消息 | P0：长 tool 链可能溢出 |
| `Lifecycle.runModelStep` | LLM overflow 错误直接向上抛 | P0：缺少可恢复错误链路 |
| `Lifecycle.run` 与 `runSession` | 两套 tool loop 大量重复 | P1：DRY 债务，需在 P0 稳定后收敛 |

---

## 本轮目标

### G1：session-run 支持 per-step context 准备

`runSession` 在每次 LLM step 前都具备重新检查 context 压力并触发 `prepareTurn` 的能力。首批实现优先保证正确性，可接受额外的 DB/context 读取；性能优化放后续。

### G2：上下文溢出自动恢复

当 LLM 返回 context overflow 类错误时，`runSession` 应触发强制压缩、重建 provider messages，并重试当前 step。恢复失败时再返回结构化错误。

### G3：动态 completion budget

LLM 调用前根据当前 input usage 与模型 budget 计算可用输出上限，传给 llm-client/provider 层，避免"输入接近上限但仍请求大输出"。

### G4：收敛 legacy `run()` 双路径

在 P0 行为稳定后，将 `run()` 逐步降级为兼容入口或删除。不要在 P0 前做大拆分，以免把行为修复和结构重构绑死。

---

## 非目标

- 不重新设计 agents 模块。`runAgent` / `AgentService` 已完成 improve-2。
- 不引入后台线程或异步压缩 worker。
- 不实现完整 Record/Replay 系统；context 事件溯源由 context improve-2 分批处理。
- 不在首批实现 hooks 系统、branch/fork、RAG、跨会话摘要复用。

---

## 协作关系

| 模块 | lifecycle 需要什么 |
|------|-------------------|
| `core/context` | `prepareTurn` 可安全重复调用；必要时提供 message usage / force compaction 能力 |
| `core/message` | provider message 序列化必须保留 assistant tool calls + tool result 协议 |
| `core/llm-client` | 支持 provider 调用接收动态输出 budget；支持识别 overflow 错误 |
| `runtime/run-manager` | 继续把 agent path 送入 `runSession`；legacy message path 可逐步收口 |
| `adapters/ui-runtime` | 对 `turn:start` / `turn:end` / compaction notice 的重复 step 语义保持稳定展示 |

---

## 推荐执行顺序

1. context/lifecycle 文档对齐并提交。
2. 补 per-step prepare/compact 的 characterization tests。
3. 实现 `runSession` 每 step 前重新准备 context 的最小正确版本。
4. 实现 overflow recovery。
5. 实现动态 completion budget。
6. 在行为稳定后收敛 legacy `run()` 重复循环。

---

## 关联文档

- [context improve-2 README](../../context/improve-2/README.md)
- [agents improve-2 CHANGELOG](../../../agents/improve-2/CHANGELOG.md)
