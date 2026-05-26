# agents 模块 architecture.md

本文档描述 `agents` 服务层在 agents improve-1 后的结构。底层运行原语已经下沉到 `core/agents`，顶层 `agents` 只保留配置和调度服务，不再保留旧 subagent runner/executor API。

---

## 一、Architecture Overview

当前分层：

```text
packages/ohbaby-agent/src/core/agents/
├── runner.ts        # runAgent: agent 执行原语
├── output.ts        # 从消息历史提取最终 assistant 输出
├── types.ts         # AgentRunInput / AgentRunResult / AgentRunCoordinator
└── index.ts

packages/ohbaby-agent/src/agents/
├── registry.ts      # agent 配置 catalog
├── manager.ts       # RuntimeAgent 解析
├── service.ts       # AgentService: Task envelope + 并发控制
├── tasks/           # 长生命周期 agent task 状态机
├── builtin/         # 内置 agent 描述符
└── index.ts
```

核心约束：

- `core/agents` 回答“怎么跑一个 agent”，不 import `agents`、`adapters` 或 `runtime` 的具体实现。
- `agents` 回答“有哪些 agent、谁来调度、Task 工具怎么调用”，消费 `core/agents.runAgent`。
- `runtime` 继续只做 run 生命周期基础设施，不放 subagent 专属编排。
- primary 路径在 improve-1 暂不切换，仍走 composition -> RunWorker -> Lifecycle；切换到 `core/agents.runAgent({ waitMode: "stream" })` 留给 improve-2。

---

## 二、组件职责

| 组件 | 职责 |
|------|------|
| `AgentRegistry` | 合并、存储、验证 agent 描述符配置 |
| `AgentManager` | 将描述符解析为 `RuntimeAgent`，包含提示词、工具和 LLM 参数 |
| `AgentService` | Task 工具的同步 envelope，负责并发限制、child session 准备、调用 `runAgent` |
| `AgentTaskManager` | 长生命周期多轮 agent task 状态机，内部每一轮调用 `runAgent` |
| `core/agents.runAgent` | 统一启动 run、写入初始 user message、等待完成、抽取最终输出、清理 sandbox 环境 |

---

## 三、依赖关系

```text
tools/task
   |
   v
agents.AgentService
   |-- AgentManager.getRuntimeAgent(...)
   |-- services/session.SessionManager
   |-- core/message.MessageManager
   |-- core/tool-scheduler.ToolScheduler
   v
core/agents.runAgent
   |-- AgentRunCoordinator port
   |-- MessageManager port
   |-- ToolScheduler port
   v
runtime/run-manager 或测试替身
```

禁止方向：

- `core/agents` -> `agents`
- `core/agents` -> `adapters`
- `runtime` -> `agents`
- `runtime` -> `core/agents`

这些边界保证“agent 运行底层”和“agent 服务调度”不会再次混成一个杂物间。

---

## 四、关键流程

### 4.1 Task 同步调用

```text
1. tools/task 收到模型工具调用
2. AgentService.executeTask(params)
3. AgentManager.getRuntimeAgent(agentName, { isSubagent: true })
4. SessionManager.get(parentSessionId)
5. SessionManager.create(parent.projectRoot, { parentId, agentName, title })
6. core/agents.runAgent({
     waitMode: "waitForCompletion",
     initialUserPrompt: params.prompt,
     parentSessionId,
     sessionId: childSession.id
   })
7. runAgent 通过 AgentRunCoordinator 创建 run 并等待完成
8. runAgent 从 child session 消息历史提取最终 assistant 文本
9. AgentService 返回 SubagentResult 给 task 工具
```

### 4.2 长生命周期 task

`AgentTaskManager` 负责 open/send/close/get 的状态机。它不再持有旧的 subagent runner、message writer 或 session adapter，而是：

- 通过 `SessionManager` 创建和恢复 child session。
- 通过 `runAgent({ waitMode: "waitForCompletion" })` 执行每一轮。
- 通过内部 store 维护 task 状态、队列、取消和输出。

### 4.3 primary 路径

improve-1 不改 primary 运行路径。primary 仍由 UI runtime composition 构造 RunWorker，再进入 Lifecycle。improve-2 会补齐 stream envelope，让 primary 和 subagent 真正共享 `core/agents.runAgent`。

---

## 五、旧 API 清理

agents improve-1 直接删除旧 subagent API，避免新架构继续背负旧命名：

- `agents/runner.ts`
- `agents/runner.unit.test.ts`
- `agents/executor.ts`
- `SubagentExecutor`
- `SubagentExecutorOptions`
- `createSubagentRunner`
- `CreateSubagentRunnerOptions`
- `SubagentPromptMessageBuilder`
- `SubagentSandboxEnvironmentManager`
- `agents/session-manager.ts`
- `agents/message-writer.ts`
- `RuntimeSubagentSessionManager`
- `SubagentSessionManager`
- `SubagentMessageWriter`
- `createRuntimeSubagentSessionManager`
- `createSubagentMessageWriter`

---

## 六、设计取舍

| 取舍 | 当前选择 | 原因 |
|------|----------|------|
| 是否把 subagent 编排放入 `runtime` | 否 | `runtime` 应保持 run 基础设施身份 |
| 是否复制 primary/subagent 两套执行机制 | 否 | 两者差异主要是 envelope，不是底层机制 |
| improve-1 是否切 primary 路径 | 否 | 降低本轮风险，stream envelope 留 improve-2 |
| 旧 API 是否立刻删除 | 是 | 新架构以 `AgentService` 和 `core/agents.runAgent` 为唯一入口 |

---

## 七、文档自检

- [x] 能解释 `core/agents` 和 `agents` 的职责边界。
- [x] 能追踪 Task 调用到 `runAgent` 的真实数据流。
- [x] 明确了 improve-1 未完成 primary 切换。
- [x] 明确了已删除旧 runner/executor API 与旧辅助层。
- [x] 明确了禁止依赖方向。
