# agents 模块 context-isolation.md

本文档描述 primary agent 与 subagent 的上下文隔离机制。agents improve-1 后，隔离由 session、message、context/lifecycle 和 `core/agents.runAgent` 共同完成。

---

## 一、设计概述

ohbaby-agent 采用逻辑隔离：primary 和 subagent 运行在同一进程内，但使用不同 session。subagent 不继承 parent session 的消息历史；它只在自己的 child session 中读取和追加消息。

核心事实：

| 项 | 当前值 |
|----|--------|
| 隔离方式 | child session 逻辑隔离 |
| Memory 继承 | subagent 不继承 parent memory |
| 历史消息 | subagent 只读取 child session 历史 |
| 初始任务输入 | `runAgent({ initialUserPrompt })` 写入 child user message |
| 结果交付 | Task 工具收到 `SubagentResult` 与 metadata |
| 同步 Task 并发 | 默认 3，由 `AgentService` 控制 |
| 长生命周期 task 容量 | 默认全局 12，每个 parent 3，由 `AgentTaskManager` 控制 |

---

## 二、上下文边界

```text
parent session
├── user / assistant messages
├── task tool call
└── tool result:
    ├── output
    └── metadata.subagent.sessionId

child session
├── user message: task prompt
├── assistant messages from child run
└── final assistant text extracted by core/agents.output
```

parent 不直接接收 child transcript。parent 只接收 Task 工具结果、child session id 和摘要字段。这样可以让主会话上下文保持紧凑，同时仍可通过 session id 恢复或检查 child session。

---

## 三、执行隔离流程

```text
1. Task 工具传入 parentSessionId、agentName、prompt
2. AgentService 获取 parent session
3. AgentService 创建 child session:
     parentId = parentSessionId
     agentName = target agent
     isSubagent = true
4. AgentService 调用 core/agents.runAgent
5. runAgent 在 child session 写入 prompt
6. runAgent 调用 buildPromptMessages(childSession.id)
7. context/lifecycle 只基于 child session 准备消息和压缩上下文
8. run 完成后，runAgent 从 child session 提取最终 assistant 输出
9. Task 工具把输出返回给 parent run
```

resume 场景：

```text
1. Task 工具传入 resumeSessionId
2. AgentService 校验该 session:
     isSubagent === true
     parentId === parentSessionId
     agentName === params.agentName
3. runAgent 在同一 child session 追加新的 user prompt
4. child context 包含 child session 自己的历史
```

---

## 四、中断与清理

同步 Task 路径通过 `AbortSignal` 传递取消：

- `runAgent` 在 run 创建后绑定 signal。
- signal abort 时调用 `AgentRunCoordinator.cancel(runId, reason)`。
- run 完成或失败后解除 abort 监听。
- `sandboxManager.setSessionEnvironment(sessionId, undefined)` 在 finally 中执行，避免环境泄漏。

`AgentTaskManager` 的长生命周期 task 也使用同一套 `runAgent` 取消机制。`interrupt=true` 会取消当前 run，并把新输入放到队首。

---

## 五、非目标

以下不是 improve-1 的隔离模型：

- 后台自主 agent。
- team inbox。
- agent 主动抢占任务板。
- parent 实时消费 child transcript。
- primary 通过 `core/agents.runAgent` stream envelope 启动。

这些能力需要新的 API 和状态模型，不能简单扩展同步 Task 工具语义。

---

## 六、文档自检

- [x] 明确 parent/child session 的消息隔离。
- [x] 明确 prompt 写入由 `runAgent` 统一负责。
- [x] 明确 resume session 的校验条件。
- [x] 明确同步 Task 与长生命周期 task 的取消方式。
